//! Public status pages and wall displays, built from Grafana-style panels on a
//! 24-column grid.
//!
//! Anything served from `/api/public` is anonymous, so a response is assembled
//! field by field from what the page explicitly selected: addresses, hostnames,
//! probe targets and record contents never reach it. Answers come from RAM and are
//! cached for a few seconds, so a traffic spike costs neither disk nor PocketBase.
//!
//! Daily uptime is kept in RAM too, and updated by the regular flush. Each flush also
//! records a heartbeat, so a stopped monitor does not count against the hosts it
//! could not hear. A daily snapshot saves reading a month of rollups at startup,
//! which would pull the whole table through PocketBase's memory.

use crate::{
    probes::ProbeLive,
    state::{host_status, offline_after_s, pct, worst, App, FleetPoint, Host, Point, State as Fleet},
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Uri},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use nyx_proto::sha256_hex;
use nyx_srv::{auth::Session, pb_date, pb_quote, random_hex, ApiError, ApiResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::Arc,
    time::Instant,
};

const DAYS: usize = 30;
const CACHE_S: u64 = 5;
const SPARK_POINTS: usize = 60;
const MAX_PANELS: usize = 64;
const MAX_TEXT: usize = 20_000;
const MAX_LOGO: usize = 350_000; // about 256 KB once decoded
const COLS: i64 = 24;
const PANEL_TYPES: [&str; 12] = ["overall", "services", "tiles", "stat", "gauge", "bars", "timeseries", "alerts", "text", "clock", "tempo", "map"];
const PRESETS: [&str; 3] = ["nyx", "graphite", "light"];
/// The id of the monitor's own heartbeat among the probe rollups.
pub const MONITOR: &str = "_monitor";
/// The key travels in a header because a query string ends up in proxy logs.
const KEY_HEADER: &str = "x-nyx-page-key";
/// Like the default policy, but any site may frame the page. It is anonymous and
/// read-only, so a frame cannot trick a visitor into doing anything.
const EMBED_CSP: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors *; base-uri 'none'; form-action 'self'";

/// Up and total checks per item and day.
#[derive(Default, Serialize, Deserialize)]
pub struct Uptime {
    days: HashMap<String, BTreeMap<NaiveDate, (u32, u32)>>,
}

impl Uptime {
    pub fn add(&mut self, id: &str, day: NaiveDate, up: u32, total: u32) {
        let days = self.days.entry(id.to_string()).or_default();
        let e = days.entry(day).or_default();
        e.0 += up;
        e.1 += total;
        while days.len() > DAYS + 1 {
            days.pop_first();
        }
    }

    /// Items that stopped reporting, such as deleted hosts, leave with the window.
    fn forget_old(&mut self, today: NaiveDate) {
        let oldest = today - Duration::days(DAYS as i64);
        self.days.retain(|_, days| days.last_key_value().is_some_and(|(day, _)| *day >= oldest));
    }

    /// Add what `other` counted since this one was read.
    fn merge(&mut self, other: Self) {
        for (id, days) in other.days {
            for (day, (up, total)) in days {
                self.add(&id, day, up, total);
            }
        }
    }

    /// `(up, total)` of a day. A host only leaves a rollup while it reports, so its
    /// total is what the monitor heard that day: its heartbeats. Its first day counts
    /// from when it appeared.
    fn day(&self, id: &str, day: NaiveDate, host: bool) -> Option<(u32, u32)> {
        let days = self.days.get(id)?;
        let first = *days.keys().next()?;
        if day < first {
            return None;
        }
        let (up, total) = days.get(&day).copied().unwrap_or((0, 0));
        if !host {
            return (total > 0).then_some((up, total));
        }
        if day == first {
            return Some((up, up.max(1)));
        }
        let beats = self.days.get(MONITOR)?.get(&day)?.1;
        (beats > 0).then_some((up.min(beats), beats))
    }

    /// One percentage per day, oldest first. `None` where nothing was measured.
    fn series(&self, id: &str, today: NaiveDate, host: bool) -> Vec<Option<f64>> {
        (0..DAYS as i64).rev().map(|back| {
            self.day(id, today - Duration::days(back), host).map(|(u, t)| round2(u as f64 * 100.0 / t as f64))
        }).collect()
    }

    fn overall(&self, id: &str, today: NaiveDate, host: bool) -> Option<f64> {
        let (up, total) = (0..DAYS as i64)
            .filter_map(|back| self.day(id, today - Duration::days(back), host))
            .fold((0u64, 0u64), |a, d| (a.0 + d.0 as u64, a.1 + d.1 as u64));
        (total > 0).then(|| round2(up as f64 * 100.0 / total as f64))
    }

    /// Share of successful checks across `ids` over the last `days` days.
    pub fn availability<'a>(&self, ids: impl Iterator<Item = &'a String>, today: NaiveDate, days: i64) -> Option<f64> {
        let (up, total) = ids
            .flat_map(|id| (0..days).filter_map(|back| self.day(id, today - Duration::days(back), false)))
            .fold((0u64, 0u64), |a, d| (a.0 + d.0 as u64, a.1 + d.1 as u64));
        (total > 0).then(|| up as f64 * 100.0 / total as f64)
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct Item {
    pub kind: String,
    pub id: String,
    /// Name shown instead of the real one.
    pub label: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct Panel {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub items: Vec<Item>,
    pub metric: String,
    pub text: String,
    pub uptime: bool,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct Config {
    pub title: String,
    pub description: String,
    pub footer: String,
    pub notice: String,
    pub notice_level: String,
    pub logo: String,
    pub preset: String,
    pub accent: String,
    pub refresh_s: u32,
    pub zoom: f32,
    /// Let other sites show this status page in a frame. Walls ignore it.
    pub embed: bool,
    pub panels: Vec<Panel>,
    /// On a wall, the pages shown in turn after this one.
    pub rotate: Vec<String>,
    /// Seconds on each page of the rotation.
    pub rotate_s: u32,
}

/// Trust boundary of page editing: everything stored or shown later passes here.
pub fn clean_config(mut c: Config) -> Result<Config, String> {
    if [&c.title, &c.description, &c.footer, &c.notice].iter().any(|t| t.len() > MAX_TEXT) {
        return Err("text is too long".into());
    }
    // Remote images would make every visitor call a third party.
    if !c.logo.is_empty() && !c.logo.starts_with("data:image/") {
        return Err("the logo must be an uploaded image".into());
    }
    if c.logo.len() > MAX_LOGO {
        return Err("the logo must be under 256 KB".into());
    }
    let hex = c.accent.len() == 7 && c.accent.starts_with('#') && c.accent[1..].chars().all(|h| h.is_ascii_hexdigit());
    if !c.accent.is_empty() && !hex {
        return Err("the accent must be a #rrggbb colour".into());
    }
    if !PRESETS.contains(&c.preset.as_str()) {
        c.preset = PRESETS[0].into();
    }
    if !["", "info", "warn", "crit"].contains(&c.notice_level.as_str()) {
        c.notice_level.clear();
    }
    c.refresh_s = if c.refresh_s == 0 { 30 } else { c.refresh_s.clamp(5, 3600) };
    c.zoom = if c.zoom > 0.0 { c.zoom.clamp(0.5, 4.0) } else { 1.0 };
    c.rotate_s = if c.rotate_s == 0 { 30 } else { c.rotate_s.clamp(5, 3600) };
    c.rotate.truncate(MAX_PANELS);
    if c.panels.len() > MAX_PANELS {
        return Err(format!("at most {MAX_PANELS} panels"));
    }
    for p in &mut c.panels {
        if !PANEL_TYPES.contains(&p.kind.as_str()) {
            return Err(format!("unknown panel type {}", p.kind));
        }
        if p.text.len() > MAX_TEXT || p.title.len() > 200 {
            return Err("panel text is too long".into());
        }
        p.w = p.w.clamp(1, COLS);
        p.x = p.x.clamp(0, COLS - p.w);
        p.y = p.y.clamp(0, 500);
        p.h = p.h.clamp(1, 60);
    }
    Ok(c)
}

#[derive(Clone)]
pub struct Page {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub kind: String,
    pub published: bool,
    pub key: String,
    pub config: Config,
}

impl Page {
    fn from_record(r: &Value) -> Self {
        let s = |k: &str| r[k].as_str().unwrap_or_default().to_string();
        Self {
            id: s("id"),
            name: s("name"),
            slug: s("slug"),
            kind: s("kind"),
            published: r["published"].as_bool().unwrap_or(false),
            key: s("access_key"),
            config: serde_json::from_value(r["config"].clone()).unwrap_or_default(),
        }
    }

    fn admin_json(&self) -> Value {
        json!({"id": self.id, "name": self.name, "slug": self.slug, "kind": self.kind, "published": self.published, "access_key": self.key, "config": self.config})
    }

    /// Walls never: a frame would put their alert texts on someone else's site.
    fn embeddable(&self) -> bool {
        self.published && self.kind == "status" && self.config.embed
    }

    /// A wall can show alert texts and live metrics, so it always needs its key.
    fn readable(&self, key: Option<&str>) -> bool {
        self.published && (self.kind != "wall" || (!self.key.is_empty() && key.is_some_and(|k| sha256_hex(k.as_bytes()) == sha256_hex(self.key.as_bytes()))))
    }
}

#[derive(Default)]
pub struct Pages {
    list: Vec<Page>,
    cache: HashMap<String, (Instant, Bytes)>,
}

impl Pages {
    fn store(&mut self, page: Page) {
        self.cache.clear();
        match self.list.iter_mut().find(|p| p.id == page.id) {
            Some(p) => *p = page,
            None => self.list.push(page),
        }
        self.list.sort_by(|a, b| a.name.cmp(&b.name));
    }

    /// What a page shows in turn, itself first. Only a wall rotates: its key is what
    /// lets it reach other walls, and a public page must never open that door.
    fn rotation<'a>(&'a self, page: &'a Page) -> Vec<&'a Page> {
        let others = page.config.rotate.iter().filter(|_| page.kind == "wall");
        let others = others.filter_map(|id| self.list.iter().find(|p| p.id == *id && p.id != page.id && p.published));
        std::iter::once(page).chain(others).collect()
    }
}

pub async fn load(core: &nyx_srv::Core) -> anyhow::Result<Pages> {
    let mut pages = Pages::default();
    for r in core.pb.list("pages", "", "name").await? {
        pages.store(Page::from_record(&r));
    }
    Ok(pages)
}

fn local_day(t: &str) -> Option<NaiveDate> {
    Some(DateTime::parse_from_rfc3339(&t.replacen(' ', "T", 1)).ok()?.with_timezone(&Local).date_naive())
}

/// What a restart would otherwise rebuild from every rollup of the last 30 days.
#[derive(Deserialize, Default)]
#[serde(default)]
struct History {
    at: String,
    uptime: Uptime,
    fleet: VecDeque<FleetPoint>,
}

/// Once a day, right after a flush: `at` then marks the rollups already counted.
pub async fn save_history(app: &App, at: &str, today: NaiveDate) -> anyhow::Result<()> {
    let snapshot = {
        let st = app.lock();
        if !st.history_day.is_some_and(|day| day < today) {
            return Ok(());
        }
        json!({"at": at, "uptime": st.uptime, "fleet": st.fleet})
    };
    app.core.pb.set_setting("history", &snapshot).await?;
    app.lock().history_day = Some(today);
    Ok(())
}

/// Start from the snapshot, then read the rollups written since. `cutoff` leaves
/// newer rows to the regular flush, which could otherwise be counted twice.
pub async fn load_history(app: Arc<App>) -> anyhow::Result<()> {
    let pb = &app.core.pb;
    let saved: Option<History> = pb.setting("history").await?.and_then(|v| serde_json::from_value(v).ok());
    let saved_day = saved.as_ref().and_then(|h| local_day(&h.at));
    let History { at, mut uptime, fleet } = saved.unwrap_or_default();
    let since = if at.is_empty() { pb_date(Utc::now() - Duration::days(365)) } else { at };
    let filter = format!("t > {} && t < {}", pb_quote(&since), pb_quote(&pb_date(Utc::now())));
    // Rollups of one flush share a timestamp, so it is a natural bucket key.
    let mut flushes: BTreeMap<String, (f64, f64, f64)> = BTreeMap::new();
    pb.each("rollups", &filter, "t", "host,t,n,cpu,mem", |r| {
        let Some(t) = r["t"].as_str() else { return };
        let Some(day) = local_day(t) else { return };
        let merged = r["n"].as_u64().unwrap_or(0).max(1) as u32;
        uptime.add(r["host"].as_str().unwrap_or_default(), day, merged, merged);
        let e = flushes.entry(t.to_string()).or_default();
        e.0 += r["cpu"].as_f64().unwrap_or(0.0);
        e.1 += r["mem"].as_f64().unwrap_or(0.0);
        e.2 += 1.0;
    }).await?;
    pb.each("probe_rollups", &filter, "t", "probe,t,up,total", |r| {
        let Some(day) = r["t"].as_str().and_then(local_day) else { return };
        let count = |k: &str| r[k].as_u64().unwrap_or(0) as u32;
        uptime.add(r["probe"].as_str().unwrap_or_default(), day, count("up"), count("total"));
    }).await?;
    let today = Local::now().date_naive();
    uptime.forget_old(today);
    let mut st = app.lock();
    uptime.merge(std::mem::take(&mut st.uptime));
    st.uptime = uptime;
    let newer = std::mem::replace(&mut st.fleet, fleet);
    for (t, (cpu, mem, n)) in flushes {
        if let Ok(when) = DateTime::parse_from_rfc3339(&t.replacen(' ', "T", 1)) {
            st.add_fleet_point(FleetPoint { t: when.timestamp(), cpu: (cpu / n) as f32, mem: (mem / n) as f32 });
        }
    }
    newer.into_iter().for_each(|p| st.add_fleet_point(p));
    st.history_day = Some(saved_day.unwrap_or(NaiveDate::MIN));
    Ok(())
}

enum Target<'a> {
    Host(&'a Host),
    Probe(&'a ProbeLive),
}

struct Row<'a> {
    label: String,
    id: &'a str,
    state: &'static str,
    target: Target<'a>,
}

struct Ctx<'a> {
    st: &'a Fleet,
    now: i64,
    today: NaiveDate,
    wall: bool,
}

fn probe_state(p: &ProbeLive) -> &'static str {
    let mut s = match p.up {
        None => return "off",
        Some(false) if p.fails >= 2 => "crit",
        Some(false) => "warn",
        Some(true) => "ok",
    };
    if p.cert_days.is_some_and(|d| d <= p.def.warn_days) {
        s = worst(s, "warn");
    }
    p.readings.iter().fold(s, |s, r| worst(s, r.level))
}

fn target_row<'a>(c: &Ctx<'a>, it: &Item) -> Option<Row<'a>> {
    let (id, name, state, target) = match it.kind.as_str() {
        "host" => {
            let (id, h) = c.st.hosts.get_key_value(&it.id)?;
            (id.as_str(), h.name.as_str(), host_status(h, c.now, &c.st.thresholds), Target::Host(h))
        }
        "probe" => {
            let (id, p) = c.st.probes.get_key_value(&it.id)?;
            (id.as_str(), p.def.name.as_str(), probe_state(p), Target::Probe(p))
        }
        _ => return None,
    };
    Some(Row { label: if it.label.is_empty() { name.to_string() } else { it.label.clone() }, id, state, target })
}

/// A status page shows only what was picked, unless its map was told to show it all.
/// On a wall, no selection means everything.
fn rows<'a>(c: &Ctx<'a>, p: &Panel) -> Vec<Row<'a>> {
    if p.items.is_empty() && (c.wall || (p.kind == "map" && p.metric == "all")) {
        let hosts = c.st.hosts.keys().map(|id| Item { kind: "host".into(), id: id.clone(), label: String::new() });
        let probes = c.st.probes.keys().map(|id| Item { kind: "probe".into(), id: id.clone(), label: String::new() });
        let mut all: Vec<Row> = hosts.chain(probes).filter_map(|i| target_row(c, &i)).collect();
        all.sort_by(|a, b| a.label.cmp(&b.label));
        return all;
    }
    p.items.iter().filter_map(|i| target_row(c, i)).collect()
}

/// The nodes of a map with their ids. `parent` is a position in the list: the ids stay
/// here, since a public page has no use for them. With `guests`, VMs without an agent
/// are added under their Proxmox host, as the list of a Proxmox host holds nothing else.
fn map_nodes(c: &Ctx, rows: &[Row], guests: bool) -> Vec<(String, Value)> {
    let place = |id: &str| {
        let at = &c.st.map_layout[id];
        (at["x"].as_f64(), at["y"].as_f64())
    };
    let mut nodes: Vec<(String, Value)> = rows.iter().map(|r| {
        let (kind, parent) = match r.target {
            Target::Host(h) => (if h.is_container() { "ct" } else { h.kind.as_str() }, rows.iter().position(|p| p.id == h.parent)),
            Target::Probe(_) => ("probe", None),
        };
        let (x, y) = place(r.id);
        (r.id.to_string(), json!({"label": r.label, "state": r.state, "type": kind, "parent": parent, "x": x, "y": y}))
    }).collect();
    for (i, r) in rows.iter().enumerate().filter(|_| guests) {
        let Target::Host(h) = r.target else { continue };
        for g in h.live.iter().flat_map(|l| &l.guests) {
            if c.st.hosts.values().any(|o| (o.parent == h.id && o.vmid == g.vmid) || o.name == g.name || o.hostname == g.name) {
                continue;
            }
            let id = format!("{}/{}", h.id, g.vmid);
            let (x, y) = place(&id);
            let (kind, state) = (if g.kind == "lxc" { "ct" } else { "vm" }, if g.status == "running" { "ok" } else { "off" });
            nodes.push((id, json!({"label": g.name, "state": state, "type": kind, "parent": i, "x": x, "y": y})));
        }
    }
    nodes
}

/// The map of the signed-in page: everything, with what a visitor must not see.
pub fn map_json(app: &App) -> Value {
    let now = Local::now();
    let st = app.lock();
    let c = Ctx { st: &st, now: now.timestamp(), today: now.date_naive(), wall: true };
    let all = rows(&c, &Panel::default());
    json!(map_nodes(&c, &all, true).into_iter().map(|(id, mut node)| {
        let row = all.iter().find(|r| r.id == id);
        let figure = |m: &str| row.and_then(|r| metric(&c, r, m)).map(|(v, unit, _)| format!("{v:.0} {unit}"));
        match row.map(|r| &r.target) {
            Some(Target::Host(h)) => {
                node["detail"] = json!({"Address": Some(h.ip.as_str()).filter(|ip| !ip.is_empty()), "CPU": figure("cpu"), "Memory": figure("mem"), "Temperature": figure("temp")});
                node["link"] = format!("/hosts/{id}").into();
            }
            Some(Target::Probe(p)) => {
                node["detail"] = json!({"Target": p.def.target, "Latency": figure("latency")});
                node["link"] = "/network".into();
            }
            None => node["detail"] = json!({"Agent": "None"}),
        }
        node["id"] = id.into();
        node
    }).collect::<Vec<_>>())
}

fn uptime_of(c: &Ctx, r: &Row) -> Option<f64> {
    c.st.uptime.overall(r.id, c.today, matches!(r.target, Target::Host(_)))
}

fn live<'a>(c: &Ctx, h: &'a Host) -> Option<&'a crate::state::Live> {
    h.live.as_ref().filter(|_| c.now - h.last_seen <= offline_after_s())
}

/// `(value, unit, level)` of one metric, or `None` when offline or unknown.
fn metric(c: &Ctx, r: &Row, m: &str) -> Option<(f64, String, &'static str)> {
    let th = &c.st.thresholds;
    let usage = |v: f32| Some((v as f64, "%".to_string(), crate::state::level(v, th.warn, th.crit)));
    if m == "uptime" {
        return uptime_of(c, r).map(|v| (v, "%".into(), if v >= 99.9 { "ok" } else if v >= 95.0 { "warn" } else { "crit" }));
    }
    match &r.target {
        Target::Host(h) => {
            let l = live(c, h)?;
            let rep = &l.report;
            match m {
                "cpu" => usage(rep.cpu_pct),
                "mem" => usage(pct(rep.mem_used, rep.mem_total)),
                "swap" => usage(pct(rep.swap_used, rep.swap_total)),
                "disk" => usage(rep.disks.iter().map(|d| pct(d.used, d.total)).fold(0.0, f32::max)),
                "temp" => rep.temp_c.map(|t| (t as f64, "°C".into(), crate::state::level(t, th.temp_warn, th.temp_crit))),
                "rx" => Some((rep.net_rx_bps as f64 * 8.0 / 1e6, "Mbit/s".into(), "ok")),
                "tx" => Some((rep.net_tx_bps as f64 * 8.0 / 1e6, "Mbit/s".into(), "ok")),
                _ => None,
            }
        }
        Target::Probe(p) => match m {
            "latency" => (p.up == Some(true)).then_some((p.latency_ms, "ms".into(), "ok")),
            "cert_days" => p.cert_days.map(|d| (d as f64, "days".into(), if d <= p.def.warn_days { "warn" } else { "ok" })),
            _ => {
                let label = m.strip_prefix("reading:")?;
                let reading = p.readings.iter().find(|x| x.label == label)?;
                Some((reading.value?, reading.unit.clone(), reading.level))
            }
        },
    }
}

fn series(c: &Ctx, r: &Row, m: &str) -> Vec<Value> {
    match &r.target {
        Target::Host(h) => {
            let pick: fn(&Point) -> f64 = match m {
                "cpu" => |p| p.cpu as f64,
                "mem" => |p| p.mem as f64,
                "disk" => |p| p.disk as f64,
                "temp" => |p| p.temp as f64,
                "rx" => |p| p.rx as f64 * 8.0 / 1e6,
                "tx" => |p| p.tx as f64 * 8.0 / 1e6,
                _ => return vec![],
            };
            live(c, h).map_or(vec![], |l| l.series.iter().map(|p| json!({"t": p.t, "v": pick(p)})).collect())
        }
        Target::Probe(p) if m == "latency" => p.latencies.iter().map(|(t, v)| json!({"t": t, "v": v})).collect(),
        Target::Probe(_) => vec![],
    }
}

fn stat(c: &Ctx, p: &Panel, rows: &[Row]) -> Value {
    let down = rows.iter().filter(|r| matches!(r.state, "off" | "crit")).count();
    let count = |value: usize, level| json!({"value": value, "unit": "", "level": level});
    match p.metric.as_str() {
        "online" => count(rows.len() - down, "ok"),
        "down" => count(down, if down > 0 { "crit" } else { "ok" }),
        "containers" => count(rows.iter().map(|r| match &r.target {
            Target::Host(h) => live(c, h).map_or(0, |l| l.containers.iter().filter(|x| x.state == "running").count()),
            Target::Probe(_) => 0,
        }).sum(), "ok"),
        // Alert texts stay off status pages, and so does their count.
        "alerts" if c.wall => count(c.st.alerts.len(), if c.st.alerts.is_empty() { "ok" } else { "warn" }),
        "availability" => {
            let known: Vec<f64> = rows.iter().filter_map(|r| uptime_of(c, r)).collect();
            if known.is_empty() {
                return Value::Null;
            }
            let v = round2(known.iter().sum::<f64>() / known.len() as f64);
            json!({"value": v, "unit": "%", "level": if v >= 99.9 { "ok" } else if v >= 95.0 { "warn" } else { "crit" }})
        }
        m => rows.first().and_then(|r| {
            let (value, unit, level) = metric(c, r, m)?;
            let points = series(c, r, m);
            let spark: Vec<&Value> = points.iter().skip(points.len().saturating_sub(SPARK_POINTS)).map(|p| &p["v"]).collect();
            Some(json!({"value": value, "unit": unit, "level": level, "spark": spark}))
        }).unwrap_or(Value::Null),
    }
}

fn panel_data(c: &Ctx, p: &Panel) -> Value {
    let rows = rows(c, p);
    match p.kind.as_str() {
        "services" | "tiles" => json!(rows.iter().map(|r| {
            let host = matches!(r.target, Target::Host(_));
            let mut v = json!({"label": r.label, "state": r.state});
            if p.uptime {
                v["days"] = json!(c.st.uptime.series(r.id, c.today, host));
                v["uptime"] = json!(uptime_of(c, r));
            }
            v
        }).collect::<Vec<_>>()),
        "stat" => stat(c, p, &rows),
        "gauge" | "bars" => json!(rows.iter().filter_map(|r| {
            let (value, unit, level) = metric(c, r, &p.metric)?;
            Some(json!({"label": r.label, "value": value, "unit": unit, "level": level}))
        }).collect::<Vec<_>>()),
        "timeseries" => {
            let unit = match p.metric.as_str() { "latency" => "ms", "temp" => "°C", "rx" | "tx" => "Mbit/s", _ => "%" };
            json!({"unit": unit, "series": rows.iter().map(|r| json!({"name": r.label, "values": series(c, r, &p.metric)})).collect::<Vec<_>>()})
        }
        "map" => json!(map_nodes(c, &rows, p.items.is_empty()).into_iter().map(|(_, node)| node).collect::<Vec<_>>()),
        "tempo" => c.st.tempo.as_ref().map_or(Value::Null, |(_, v)| json!({"today": v["today"], "tomorrow": v["tomorrow"], "remaining": v["remaining"]})),
        "alerts" if c.wall => {
            let mut open: Vec<_> = c.st.alerts.values().collect();
            open.sort_by_key(|a| (a.severity != "crit", std::cmp::Reverse(a.opened.clone())));
            json!(open.iter().map(|a| json!({"severity": a.severity, "message": a.message, "since": a.opened})).collect::<Vec<_>>())
        }
        _ => Value::Null,
    }
}

/// The complete anonymous answer. Panels are rebuilt by hand so their item lists
/// and any field added later stay private until listed here.
pub fn build(st: &Fleet, kind: &str, cfg: &Config, now: DateTime<Local>) -> Value {
    let c = Ctx {
        st,
        now: now.timestamp(),
        today: now.date_naive(),
        wall: kind == "wall",
    };
    let panels: Vec<Value> = cfg.panels.iter().map(|p| json!({
        "id": p.id, "type": p.kind, "title": p.title, "x": p.x, "y": p.y, "w": p.w, "h": p.h,
        "text": p.text, "uptime": p.uptime, "metric": p.metric, "data": panel_data(&c, p),
    })).collect();

    let mut selected: Vec<Row> = cfg.panels.iter().flat_map(|p| rows(&c, p)).collect();
    selected.sort_by_key(|r| r.id);
    selected.dedup_by_key(|r| r.id);
    let overall = if selected.is_empty() {
        "off"
    } else {
        selected.iter().fold("ok", |s, r| worst(s, if r.state == "off" { "crit" } else { r.state }))
    };
    json!({
        "kind": kind, "title": cfg.title, "description": cfg.description, "footer": cfg.footer, "notice": cfg.notice,
        "notice_level": cfg.notice_level, "logo": cfg.logo, "preset": cfg.preset, "accent": cfg.accent,
        "refresh_s": cfg.refresh_s, "zoom": cfg.zoom, "overall": overall, "generated": c.now, "panels": panels,
    })
}

/// The app shell of a status page, framable if the page says so.
async fn status_shell(State(app): State<Arc<App>>, Path(slug): Path<String>, uri: Uri) -> Response {
    let embed = app.pages.lock().unwrap().list.iter().any(|p| p.slug == slug && p.embeddable());
    let mut res = nyx_srv::web::spa::<crate::Ui>(uri).await;
    if embed {
        res.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(EMBED_CSP));
    }
    res
}

async fn public(State(app): State<Arc<App>>, Path(slug): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    serve(&app, &slug, 0, &headers)
}

async fn public_step(State(app): State<Arc<App>>, Path((slug, step)): Path<(String, usize)>, headers: HeaderMap) -> ApiResult<Response> {
    serve(&app, &slug, step, &headers)
}

/// Page `step` of what `slug` rotates through. The key is that of `slug`, whichever
/// page comes out: the screen only ever holds its own.
fn serve(app: &App, slug: &str, step: usize, headers: &HeaderMap) -> ApiResult<Response> {
    let key = headers.get(KEY_HEADER).and_then(|k| k.to_str().ok());
    let reply = |body: Bytes| ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-cache")], body).into_response();
    let cached = format!("{slug}/{step}");
    let (page, count, seconds) = {
        let pages = app.pages.lock().unwrap();
        let root = pages.list.iter().find(|p| p.slug == slug && p.readable(key)).ok_or_else(ApiError::not_found)?;
        if let Some((_, body)) = pages.cache.get(&cached).filter(|(at, _)| at.elapsed().as_secs() < CACHE_S) {
            return Ok(reply(body.clone()));
        }
        let chain = pages.rotation(root);
        ((*chain.get(step).ok_or_else(ApiError::not_found)?).clone(), chain.len(), root.config.rotate_s)
    };
    let mut body = build(&app.lock(), &page.kind, &page.config, Local::now());
    if count > 1 {
        body["rotation"] = json!({"count": count, "seconds": seconds});
    }
    let body = Bytes::from(body.to_string());
    app.pages.lock().unwrap().cache.insert(cached, (Instant::now(), body.clone()));
    Ok(reply(body))
}

async fn list(_: Session, State(app): State<Arc<App>>) -> Json<Value> {
    Json(json!(app.pages.lock().unwrap().list.iter().map(Page::admin_json).collect::<Vec<_>>()))
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::bad_request(msg)
}

fn valid_slug(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[derive(Deserialize)]
struct NewPage {
    name: String,
    slug: String,
    kind: String,
    #[serde(default)]
    config: Config,
}

async fn create(_: Session, State(app): State<Arc<App>>, Json(b): Json<NewPage>) -> ApiResult<Json<Value>> {
    if !valid_slug(&b.slug) {
        return Err(bad("the address may only use lowercase letters, digits and -"));
    }
    if !["status", "wall"].contains(&b.kind.as_str()) {
        return Err(bad("unknown page kind"));
    }
    if app.pages.lock().unwrap().list.iter().any(|p| p.slug == b.slug) {
        return Err(bad("this address is already used"));
    }
    let config = clean_config(b.config).map_err(bad)?;
    let key = if b.kind == "wall" { random_hex(16) } else { String::new() };
    let body = json!({"name": b.name, "slug": b.slug, "kind": b.kind, "published": false, "access_key": key, "config": config});
    let page = Page::from_record(&app.core.pb.create("pages", &body).await.map_err(|e| bad(format!("{e:#}")))?);
    let out = page.admin_json();
    app.pages.lock().unwrap().store(page);
    Ok(Json(out))
}

async fn update(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let mut patch = Map::new();
    if let Some(slug) = b.get("slug").and_then(Value::as_str) {
        if !valid_slug(slug) {
            return Err(bad("the address may only use lowercase letters, digits and -"));
        }
        if app.pages.lock().unwrap().list.iter().any(|p| p.slug == slug && p.id != id) {
            return Err(bad("this address is already used"));
        }
        patch.insert("slug".into(), slug.into());
    }
    for k in ["name", "published"] {
        if let Some(v) = b.get(k) {
            patch.insert(k.into(), v.clone());
        }
    }
    if let Some(c) = b.get("config") {
        let config = serde_json::from_value(c.clone()).map_err(|e| bad(e.to_string()))?;
        patch.insert("config".into(), json!(clean_config(config).map_err(bad)?));
    }
    let page = Page::from_record(&app.core.pb.update("pages", &id, &Value::Object(patch)).await.map_err(|e| bad(format!("{e:#}")))?);
    let out = page.admin_json();
    app.pages.lock().unwrap().store(page);
    Ok(Json(out))
}

async fn remove(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    app.core.pb.delete("pages", &id).await.map_err(|e| bad(format!("{e:#}")))?;
    let mut pages = app.pages.lock().unwrap();
    pages.list.retain(|p| p.id != id);
    pages.cache.clear();
    Ok(Json(Value::Null))
}

/// Replacing the key cuts off every screen using the old link.
async fn rotate_key(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let rec = app.core.pb.update("pages", &id, &json!({"access_key": random_hex(16)})).await.map_err(|e| bad(format!("{e:#}")))?;
    let page = Page::from_record(&rec);
    let out = page.admin_json();
    app.pages.lock().unwrap().store(page);
    Ok(Json(out))
}

#[derive(Deserialize)]
struct Preview {
    kind: String,
    config: Config,
}

/// What a page would show, for the editor. Not saved.
async fn preview(_: Session, State(app): State<Arc<App>>, Json(b): Json<Preview>) -> ApiResult<Json<Value>> {
    let config = clean_config(b.config).map_err(bad)?;
    let kind = if b.kind == "wall" { "wall" } else { "status" };
    let out = build(&app.lock(), kind, &config, Local::now());
    Ok(Json(out))
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/status/{slug}", get(status_shell))
        .route("/api/public/pages/{slug}", get(public))
        .route("/api/public/pages/{slug}/{step}", get(public_step))
        .route("/api/pages", get(list).post(create))
        .route("/api/pages/preview", post(preview))
        .route("/api/pages/{id}", patch(update).delete(remove))
        .route("/api/pages/{id}/key", post(rotate_key))
        .with_state(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{probes::ProbeDef, state::OpenAlert};
    use nyx_proto::{Disk, HostKind, Report};

    fn fleet(now: i64) -> Fleet {
        let mut st = Fleet::default();
        st.hosts.insert("h1".into(), Host::from_record(&json!({"id": "h1", "name": "pve-secret", "hostname": "pve.lan", "ip": "192.0.2.10", "token": "tok", "key": "k"})));
        st.apply("h1", Report { cpu_pct: 42.0, mem_used: 50, mem_total: 100, disks: vec![Disk { mount: "/data/private".into(), used: 10, total: 100, ..Disk::default() }], kind: HostKind::Vm, ..Report::default() }, now);
        let def = ProbeDef { id: "p1".into(), name: "Website".into(), kind: "http".into(), target: "https://internal.example.lan/admin".into(), interval_s: 60, dns_server: String::new(), watch_cert: false, warn_days: 14, expect_status: 200, snmp: None };
        let mut p = ProbeLive::new(def);
        p.up = Some(true);
        p.latency_ms = 12.0;
        p.message = "200 from internal.example.lan".into();
        st.probes.insert("p1".into(), p);
        st.alerts.insert("a".into(), OpenAlert { id: "a".into(), severity: "crit".into(), message: "disk full on pve-secret".into(), opened: "2026-11-05".into() });
        st
    }

    fn panel(kind: &str, items: &[(&str, &str, &str)], metric: &str) -> Panel {
        Panel { id: kind.into(), kind: kind.into(), w: 12, h: 4, metric: metric.into(), uptime: true, items: items.iter().map(|(k, i, l)| Item { kind: (*k).into(), id: (*i).into(), label: (*l).into() }).collect(), ..Panel::default() }
    }

    fn page(kind: &str, panels: Vec<Panel>) -> Value {
        let now = Local::now();
        let cfg = clean_config(Config { panels, ..Config::default() }).unwrap();
        build(&fleet(now.timestamp()), kind, &cfg, now)
    }

    #[test]
    fn anonymous_answers_carry_no_private_details() {
        let items = [("host", "h1", "Main server"), ("probe", "p1", "")];
        let out = page("status", ["services", "tiles", "stat", "gauge", "timeseries", "alerts"].iter().map(|k| panel(k, &items, "cpu")).collect()).to_string();
        for private in ["192.0.2.10", "pve.lan", "pve-secret", "tok", "internal.example.lan", "/data/private", "\"h1\"", "\"p1\"", "disk full"] {
            assert!(!out.contains(private), "{private} leaked: {out}");
        }
        assert!(out.contains("Main server") && out.contains("Website"));
    }

    #[test]
    fn status_pages_show_only_what_was_picked_and_walls_default_to_everything() {
        let empty = [panel("services", &[], "")];
        let status = page("status", empty.to_vec());
        assert_eq!(status["panels"][0]["data"], json!([]));
        assert_eq!(status["overall"], "off");
        let wall = page("wall", empty.to_vec());
        assert_eq!(wall["panels"][0]["data"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn alerts_exist_on_walls_only() {
        let wall = page("wall", vec![panel("alerts", &[], ""), panel("stat", &[], "alerts")]);
        assert_eq!(wall["panels"][0]["data"][0]["message"], "disk full on pve-secret");
        assert_eq!(wall["panels"][1]["data"]["value"], 1);
        let status = page("status", vec![panel("alerts", &[], ""), panel("stat", &[], "alerts")]);
        assert_eq!(status["panels"][0]["data"], Value::Null);
        assert_eq!(status["panels"][1]["data"], Value::Null);
    }

    #[test]
    fn a_tempo_panel_shows_the_latest_days_once_rte_gave_them() {
        let now = Local::now();
        let cfg = Config { panels: vec![panel("tempo", &[], "")], ..Config::default() };
        let mut st = fleet(now.timestamp());
        assert!(build(&st, "wall", &cfg, now)["panels"][0]["data"].is_null());
        st.tempo = Some((std::time::Instant::now(), json!({"date": "2026-11-06", "configured": true, "today": "BLUE", "tomorrow": null, "remaining": {"blue": 299}})));
        assert_eq!(build(&st, "wall", &cfg, now)["panels"][0]["data"], json!({"today": "BLUE", "tomorrow": null, "remaining": {"blue": 299}}));
    }

    #[test]
    fn metrics_and_stats_are_computed() {
        let host = [("host", "h1", "")];
        let v = page("status", vec![panel("stat", &host, "cpu"), panel("gauge", &host, "mem"), panel("stat", &[("host", "h1", ""), ("host", "gone", "")], "online")]);
        assert_eq!(v["panels"][0]["data"]["value"], 42.0);
        assert_eq!(v["panels"][1]["data"][0]["value"], 50.0);
        assert_eq!(v["panels"][2]["data"]["value"], 1, "deleted items are skipped");
        assert_eq!(v["overall"], "ok");
    }

    #[test]
    fn overall_counts_offline_as_an_outage() {
        let now = Local::now();
        let mut st = fleet(now.timestamp());
        st.probes.get_mut("p1").unwrap().up = None;
        let cfg = Config { panels: vec![panel("services", &[("probe", "p1", "")], "")], ..Config::default() };
        assert_eq!(build(&st, "status", &cfg, now)["overall"], "crit");
    }

    fn wall(key: &str, published: bool) -> Page {
        Page { id: "i".into(), name: "n".into(), slug: "s".into(), kind: "wall".into(), published, key: key.into(), config: Config::default() }
    }

    #[test]
    fn walls_require_their_key_and_drafts_are_invisible() {
        assert!(wall("k", true).readable(Some("k")));
        assert!(!wall("k", true).readable(Some("other")) && !wall("k", true).readable(None));
        assert!(!wall("", true).readable(Some("")), "a wall without a key is never open");
        assert!(!wall("k", false).readable(Some("k")));
        let status = Page { kind: "status".into(), ..wall("", true) };
        assert!(status.readable(None) && !Page { published: false, ..status }.readable(None));
    }

    #[test]
    fn config_is_checked_at_the_boundary() {
        let cfg = |f: fn(&mut Config)| { let mut c = Config::default(); f(&mut c); clean_config(c) };
        assert!(cfg(|c| c.logo = "https://tracker.example/a.png".into()).is_err());
        assert!(cfg(|c| c.logo = format!("data:image/png;base64,{}", "A".repeat(MAX_LOGO))).is_err());
        assert!(cfg(|c| c.logo = "data:image/png;base64,AAAA".into()).is_ok());
        assert!(cfg(|c| c.accent = "red;}".into()).is_err());
        assert!(cfg(|c| c.panels = vec![Panel { kind: "script".into(), ..Panel::default() }]).is_err());
        let c = cfg(|c| { c.refresh_s = 1; c.zoom = 99.0; c.preset = "x".into(); c.panels = vec![Panel { kind: "text".into(), x: 30, w: 50, ..Panel::default() }] }).unwrap();
        assert_eq!((c.refresh_s, c.zoom, c.preset.as_str(), c.panels[0].x, c.panels[0].w), (5, 4.0, "nyx", 0, 24));
    }

    #[test]
    fn slugs_stay_url_safe() {
        assert!(valid_slug("home-lab-2") && !valid_slug("") && !valid_slug("A") && !valid_slug("a/b") && !valid_slug("../x"));
    }

    fn day(n: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, n).unwrap()
    }

    #[test]
    fn probe_uptime_averages_checks_and_leaves_gaps_empty() {
        let mut u = Uptime::default();
        u.add("p", day(4), 9, 10);
        u.add("p", day(4), 10, 10);
        let s = u.series("p", day(5), false);
        assert_eq!(s.len(), DAYS);
        assert_eq!((s[DAYS - 2], s[DAYS - 1], s[0]), (Some(95.0), None, None));
        assert_eq!(u.overall("p", day(5), false), Some(95.0));
        assert_eq!(u.overall("unknown", day(5), false), None);
    }

    #[test]
    fn host_uptime_counts_what_the_monitor_heard_except_on_its_first_day() {
        let mut u = Uptime::default();
        u.add("h", day(3), 10, 10); // appeared late that day
        u.add("h", day(4), 72, 72); // silent half of the day
        u.add("h", day(5), 20, 20); // the monitor itself was stopped most of the day
        for (d, beats) in [(3, 288), (4, 144), (5, 20)] {
            u.add(MONITOR, day(d), beats, beats);
        }
        let s = u.series("h", day(6), true);
        assert_eq!(&s[DAYS - 4..DAYS - 1], &[Some(100.0), Some(50.0), Some(100.0)]);
        assert_eq!(s[DAYS - 1], None, "no heartbeat means nothing was measured, not an outage");
    }

    #[test]
    fn availability_only_sums_the_requested_items_and_days() {
        let mut u = Uptime::default();
        u.add("a", day(5), 9, 10);
        u.add("a", day(1), 0, 90); // outside the window
        u.add("b", day(5), 10, 10);
        u.add("other", day(5), 0, 1000);
        let ids = ["a".to_string(), "b".to_string()];
        assert_eq!(u.availability(ids.iter(), day(5), 3), Some(95.0));
        assert_eq!(u.availability([].iter(), day(5), 3), None);
    }

    #[test]
    fn a_saved_history_survives_the_round_trip_and_drops_stale_items() {
        let mut u = Uptime::default();
        u.add("kept", day(5), 3, 4);
        u.add("deleted", day(1) - Duration::days(40), 1, 1);
        let saved = json!({"at": "2026-01-05 10:00:00.000Z", "uptime": u, "fleet": [{"t": 1, "cpu": 2.0, "mem": 3.0}]});
        let mut back: History = serde_json::from_value(saved).unwrap();
        back.uptime.forget_old(day(5));
        assert_eq!(back.uptime.days["kept"][&day(5)], (3, 4));
        assert!(!back.uptime.days.contains_key("deleted"));
        assert_eq!(back.fleet[0].t, 1);
    }

    #[test]
    fn counts_added_during_the_history_read_are_kept() {
        let (mut read, mut live) = (Uptime::default(), Uptime::default());
        read.add("h", day(4), 5, 5);
        live.add("h", day(4), 1, 1);
        read.merge(live);
        assert_eq!(read.days["h"][&day(4)], (6, 6));
    }

    #[test]
    fn only_published_status_pages_can_be_framed() {
        let status = Page { kind: "status".into(), config: Config { embed: true, ..Config::default() }, ..wall("", true) };
        assert!(status.embeddable());
        assert!(!Page { published: false, ..status.clone() }.embeddable());
        assert!(!Page { kind: "wall".into(), ..status }.embeddable());
    }

    #[test]
    fn uptime_memory_stays_bounded() {
        let mut u = Uptime::default();
        for i in 0..120 {
            u.add("p", day(1) + Duration::days(i), 1, 1);
        }
        assert_eq!(u.days["p"].len(), DAYS + 1);
    }

    fn map_page(metric: &str, items: Vec<Item>) -> Config {
        clean_config(Config { panels: vec![Panel { id: "m".into(), kind: "map".into(), metric: metric.into(), items, ..Panel::default() }], ..Config::default() }).unwrap()
    }

    fn map_of(st: &Fleet, kind: &str, cfg: &Config) -> Vec<Value> {
        build(st, kind, cfg, Local::now())["panels"][0]["data"].as_array().unwrap().clone()
    }

    fn pick(id: &str, kind: &str, label: &str) -> Item {
        Item { kind: kind.into(), id: id.into(), label: label.into() }
    }

    #[test]
    fn a_public_map_shows_only_what_was_picked_under_the_chosen_name() {
        let st = fleet(Local::now().timestamp());
        assert!(map_of(&st, "status", &map_page("", vec![])).is_empty());
        let nodes = map_of(&st, "status", &map_page("", vec![pick("h1", "host", "Home server")]));
        assert_eq!(nodes.len(), 1);
        assert_eq!((nodes[0]["label"].as_str(), nodes[0]["state"].as_str()), (Some("Home server"), Some("ok")));
        let text = serde_json::to_string(&nodes).unwrap();
        for private in ["pve-secret", "192.0.2.10", "h1", "pve.lan", "internal.example"] {
            assert!(!text.contains(private), "{private} leaked: {text}");
        }
    }

    #[test]
    fn a_status_map_shows_all_only_when_told_to_and_a_wall_by_default() {
        let st = fleet(Local::now().timestamp());
        assert_eq!(map_of(&st, "status", &map_page("all", vec![])).len(), 2);
        assert_eq!(map_of(&st, "wall", &map_page("", vec![])).len(), 2);
    }

    #[test]
    fn children_point_at_their_parent_and_keep_their_saved_place() {
        let now = Local::now().timestamp();
        let mut st = fleet(now);
        st.hosts.insert("c1".into(), Host::from_record(&json!({"id": "c1", "name": "web", "parent": "h1", "kind": "lxc", "vmid": 101})));
        st.map_layout = json!({"c1": {"x": 12.0, "y": -4.0}});
        let nodes = map_of(&st, "wall", &map_page("", vec![]));
        let index = |label: &str| nodes.iter().position(|n| n["label"] == label).unwrap();
        let web = &nodes[index("web")];
        assert_eq!((web["parent"].as_u64(), web["type"].as_str()), (Some(index("pve-secret") as u64), Some("ct")));
        assert_eq!((web["x"].as_f64(), web["y"].as_f64()), (Some(12.0), Some(-4.0)));
        assert!(nodes[index("pve-secret")]["x"].is_null());
    }

    #[test]
    fn a_vm_without_an_agent_hangs_under_its_node_but_only_when_everything_is_shown() {
        let now = Local::now().timestamp();
        let mut st = fleet(now);
        let guest = |vmid, name: &str| nyx_proto::Guest { vmid, name: name.into(), kind: "qemu".into(), status: "stopped".into(), ..nyx_proto::Guest::default() };
        st.hosts.get_mut("h1").unwrap().live.as_mut().unwrap().guests = vec![guest(100, "db"), guest(101, "Website")];
        st.hosts.insert("v".into(), Host::from_record(&json!({"id": "v", "name": "known", "parent": "h1", "vmid": 101})));
        let nodes = map_of(&st, "wall", &map_page("", vec![]));
        assert_eq!(nodes.iter().filter(|n| n["type"] == "vm" && n["label"] == "db" && n["state"] == "off" && !n["parent"].is_null()).count(), 1);
        assert_eq!(nodes.iter().filter(|n| n["label"] == "Website").count(), 1, "a guest with a host is that host");
        assert!(!serde_json::to_string(&map_of(&st, "status", &map_page("", vec![pick("h1", "host", "")]))).unwrap().contains("db"));
    }

    fn in_rotation(id: &str, kind: &str, published: bool, rotate: &[&str]) -> Page {
        Page { id: id.into(), name: id.into(), slug: id.into(), kind: kind.into(), published, key: "k".into(), config: Config { rotate: rotate.iter().map(|s| s.to_string()).collect(), ..Config::default() } }
    }

    #[test]
    fn a_wall_rotates_through_published_pages_in_the_chosen_order() {
        let mut pages = Pages::default();
        for p in [in_rotation("wall", "wall", true, &["c", "b", "draft", "gone", "wall"]), in_rotation("b", "wall", true, &[]), in_rotation("c", "status", true, &[]), in_rotation("draft", "wall", false, &[])] {
            pages.store(p);
        }
        let wall = pages.list.iter().find(|p| p.id == "wall").unwrap();
        assert_eq!(pages.rotation(wall).iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["wall", "c", "b"]);
    }

    #[test]
    fn a_public_page_cannot_reach_a_wall_through_a_rotation() {
        let mut pages = Pages::default();
        pages.store(in_rotation("wall", "wall", true, &[]));
        pages.store(in_rotation("public", "status", true, &["wall"]));
        let public = pages.list.iter().find(|p| p.id == "public").unwrap();
        assert_eq!(pages.rotation(public).len(), 1);
    }

    #[test]
    fn the_rotation_delay_stays_within_its_bounds() {
        let delay = |rotate_s| clean_config(Config { rotate_s, ..Config::default() }).unwrap().rotate_s;
        assert_eq!((delay(0), delay(1), delay(45), delay(99_999)), (30, 5, 45, 3600));
    }
}

//! In-memory view of the fleet. All live metrics, logs and series are here; the
//! lock is never held across an await.

use anyhow::Context;
use chrono::{Duration, Local, NaiveDate, Timelike, Utc};
use nyx_proto::*;
use nyx_srv::{notify, pb_date, Core};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

/// One hour of samples at the default 15 s interval.
pub const RAM_POINTS: usize = 240;
/// Logs are kept in RAM only, so collecting them costs the server no disk I/O.
pub const LOG_LINES: usize = 500;
pub const REPORT_INTERVAL_S: u64 = 15;
/// Report pace while nobody looks at the monitor: 4 times fewer requests.
pub const IDLE_INTERVAL_S: u64 = 60;
/// How long a request to the monitor's API keeps agents at [`REPORT_INTERVAL_S`].
pub const VIEW_S: i64 = 120;
/// Report pace while an update runs, so that its bar moves.
pub const UPDATE_INTERVAL_S: u64 = 5;
/// An update without a result by then lost its agent, which keeps its queue in memory.
const UPDATE_TIMEOUT_S: i64 = 3600;
/// Lines of a live view kept in memory, and how long one request keeps it running.
pub const TAIL_LINES: usize = 1000;
pub const LIVE_WATCH_S: i64 = 15;
/// Points (percent or °C) a metric must recede before an alert eases.
const HYSTERESIS: f32 = 3.0;
const VPN_FORGET_S: i64 = 86400;

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(default)]
pub struct Thresholds {
    pub warn: f32,
    pub crit: f32,
    pub temp_warn: f32,
    pub temp_crit: f32,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self { warn: 75.0, crit: 90.0, temp_warn: 80.0, temp_crit: 90.0 }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Maintenance {
    /// Local hour of the daily update check.
    pub check_hour: u32,
    pub agent_auto_update: bool,
    /// Agents take the newest release from GitHub, not the one this server ships.
    pub agent_beta: bool,
    /// How long metrics and resolved alerts are kept.
    pub retention_days: u32,
}

impl Default for Maintenance {
    fn default() -> Self {
        Self { check_hour: 4, agent_auto_update: true, agent_beta: false, retention_days: MIN_RETENTION_DAYS }
    }
}

impl Maintenance {
    fn retention(&self) -> i64 {
        self.retention_days.clamp(MIN_RETENTION_DAYS, MAX_RETENTION_DAYS) as i64
    }
}

#[derive(Serialize, Clone, Copy)]
pub struct Point {
    pub t: i64,
    pub cpu: f32,
    pub mem: f32,
    pub disk: f32,
    pub temp: f32,
    pub rx: u64,
    pub tx: u64,
}

/// Running average for the current rollup window.
#[derive(Default)]
pub struct Acc {
    n: u32,
    cpu: f64,
    mem: f64,
    disk: f64,
    temp: f64,
    rx: f64,
    tx: f64,
}

impl Acc {
    fn add(&mut self, p: &Point) {
        self.n += 1;
        self.cpu += p.cpu as f64;
        self.mem += p.mem as f64;
        self.disk += p.disk as f64;
        self.temp += p.temp as f64;
        self.rx += p.rx as f64;
        self.tx += p.tx as f64;
    }

    fn take(&mut self) -> Option<[f64; 6]> {
        let n = self.n as f64;
        let out = (self.n > 0).then(|| [self.cpu / n, self.mem / n, self.disk / n, self.temp / n, self.rx / n, self.tx / n]);
        *self = Self::default();
        out
    }
}

#[derive(Default)]
pub struct Live {
    pub report: Report,
    pub containers: Vec<Container>,
    pub smart: Vec<SmartDisk>,
    pub updates: Vec<PackageUpdate>,
    pub node: Option<NodeInfo>,
    pub guests: Vec<Guest>,
    pub vpn: Vec<VpnLink>,
    pub firewall: Option<nyx_proto::Firewall>,
    pub logs: VecDeque<String>,
    pub series: VecDeque<Point>,
}

/// Log lines of a host someone is watching. In memory only, dropped when they leave.
#[derive(Default)]
pub struct Tail {
    lines: VecDeque<String>,
    pub seq: u64,
}

impl Tail {
    pub fn push(&mut self, lines: Vec<String>) {
        for line in lines {
            if self.lines.len() == TAIL_LINES { self.lines.pop_front(); }
            self.lines.push_back(line);
            self.seq += 1;
        }
    }

    pub fn clear(&mut self) {
        self.lines.clear();
    }

    /// Lines after position `after`. A position past the end means the monitor restarted.
    pub fn since(&self, after: u64) -> Vec<&str> {
        let after = if after > self.seq { 0 } else { after };
        let skip = self.lines.len().saturating_sub((self.seq - after) as usize);
        self.lines.iter().skip(skip).map(String::as_str).collect()
    }
}

pub struct Host {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub token: String,
    pub key: String,
    pub parent: String,
    pub vmid: u32,
    pub ct_autoinstall: bool,
    pub hostname: String,
    pub ip: String,
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub agent_version: String,
    pub pve_node: String,
    /// Kept out of alerts and their notifications, still measured and shown.
    pub muted: bool,
    pub last_seen: i64,
    pub live: Option<Live>,
    pub queue: Vec<Command>,
    pub update: Option<Update>,
    pub acc: Acc,
    pub tail: Tail,
    pub watched_until: i64,
    pub tail_seen: i64,
    /// Pace given in the last reply. 0 until then, as after a restart: taken as idle.
    pub interval_s: u64,
    /// When the Proxmox host was last asked to put an agent in this container. Memory only.
    pub ct_install_at: i64,
}

impl Host {
    /// Still reporting at the pace it was given.
    pub fn online(&self, now: i64) -> bool {
        let pace = if self.interval_s == 0 { IDLE_INTERVAL_S } else { self.interval_s.max(REPORT_INTERVAL_S) };
        now - self.last_seen <= offline_after(pace)
    }
}

/// The latest update sent to a host. In memory only, like the commands themselves.
pub struct Update {
    pub started: i64,
    total: usize,
    /// Commands without a result yet.
    waiting: Vec<String>,
    errors: Vec<String>,
}

impl Update {
    fn lost(&self, now: i64, last_seen: i64) -> bool {
        !self.waiting.is_empty() && (now - last_seen > offline_after_s() || now - self.started > UPDATE_TIMEOUT_S)
    }

    fn finish(&mut self, res: &CommandResult) {
        if let Some(i) = self.waiting.iter().position(|id| *id == res.id) {
            self.waiting.remove(i);
            if !res.ok {
                self.errors.push(res.output.clone());
            }
        }
    }

    pub fn to_json(&self, now: i64, last_seen: i64, progress: Option<&Progress>) -> Value {
        let lost = self.lost(now, last_seen);
        let done = self.waiting.is_empty() || lost;
        let finished = self.total - self.waiting.len();
        let pct = if done { 100 } else { (finished * 100 + progress.map_or(0, |p| p.pct as usize)) / self.total };
        let mut errors = self.errors.clone();
        if lost {
            errors.push("The agent stopped answering before the end.".into());
        }
        json!({"started": self.started, "done": done, "pct": pct, "step": progress.map(|p| &p.step), "error": errors.join("\n")})
    }
}

impl Host {
    /// Containers belong to their node: an agent in one is the only sign it is a host at all.
    pub fn is_container(&self) -> bool {
        self.kind == "lxc" || self.vmid > 0
    }

    pub fn updating(&self, now: i64) -> bool {
        self.update.as_ref().is_some_and(|u| !u.waiting.is_empty() && !u.lost(now, self.last_seen))
    }

    /// Queue `actions` in order, unless an update is running: a second one could
    /// restart the agent under the first. Returns the id of the first command.
    pub fn start_update(&mut self, actions: Vec<Action>, now: i64) -> Option<String> {
        if self.updating(now) {
            return None;
        }
        let commands: Vec<Command> = actions.into_iter().map(|action| Command { id: nyx_srv::random_hex(8), action }).collect();
        let waiting: Vec<String> = commands.iter().map(|c| c.id.clone()).collect();
        let first = waiting.first().cloned();
        self.update = Some(Update { started: now, total: waiting.len(), waiting, errors: vec![] });
        self.queue.extend(commands);
        first
    }

    pub fn from_record(r: &Value) -> Self {
        let s = |k: &str| r[k].as_str().unwrap_or_default().to_string();
        Self {
            id: s("id"),
            name: s("name"),
            kind: s("kind"),
            token: s("token"),
            key: s("key"),
            parent: s("parent"),
            vmid: r["vmid"].as_u64().unwrap_or(0) as u32,
            ct_autoinstall: r["ct_autoinstall"].as_bool().unwrap_or(false),
            hostname: s("hostname"),
            ip: Some(s("ip")).filter(|ip| !is_vpn_ip(ip)).unwrap_or_default(),
            os: s("os"),
            kernel: s("kernel"),
            arch: s("arch"),
            agent_version: s("agent_version"),
            pve_node: s("pve_node"),
            muted: r["muted"].as_bool().unwrap_or(false),
            last_seen: chrono::DateTime::parse_from_rfc3339(&s("last_seen").replacen(' ', "T", 1)).map_or(0, |d| d.timestamp()),
            live: None,
            queue: vec![],
            update: None,
            acc: Acc::default(),
            tail: Tail::default(),
            watched_until: 0,
            tail_seen: 0,
            interval_s: 0,
            ct_install_at: 0,
        }
    }
}

pub fn pct(used: u64, total: u64) -> f32 {
    if total == 0 { 0.0 } else { used as f32 * 100.0 / total as f32 }
}

pub fn level(value: f32, warn: f32, crit: f32) -> &'static str {
    if value >= crit { "crit" } else if value >= warn { "warn" } else { "ok" }
}

pub fn worst(a: &'static str, b: &'static str) -> &'static str {
    let rank = |s| ["ok", "warn", "crit"].iter().position(|l| *l == s).unwrap_or(0);
    if rank(b) > rank(a) { b } else { a }
}

pub fn offline_after_s() -> i64 {
    offline_after(REPORT_INTERVAL_S)
}

/// Two missed reports, plus slack for a slow network.
pub fn offline_after(interval_s: u64) -> i64 {
    (interval_s as i64 * 2 + 30).max(60)
}

/// Health of a host: `off` when silent, otherwise its worst metric.
pub fn host_status(h: &Host, now: i64, th: &Thresholds) -> &'static str {
    let Some(live) = h.live.as_ref().filter(|_| h.online(now)) else { return "off" };
    let r = &live.report;
    let mut s = level(r.cpu_pct, th.warn, th.crit);
    s = worst(s, level(pct(r.mem_used, r.mem_total), th.warn, th.crit));
    for d in &r.disks {
        s = worst(s, level(pct(d.used, d.total), th.warn, th.crit));
    }
    if let Some(t) = r.temp_c {
        s = worst(s, level(t, th.temp_warn, th.temp_crit));
    }
    for d in &live.smart {
        s = worst(s, match d.health { Health::Ok => "ok", Health::Warn => "warn", Health::Crit => "crit" });
    }
    s
}

pub struct OpenAlert {
    pub id: String,
    pub severity: String,
    /// Kept here so wall displays never need a database read.
    pub message: String,
    pub opened: String,
}

/// A problem that should currently be open.
pub struct Wanted {
    pub key: String,
    pub kind: &'static str,
    pub severity: &'static str,
    pub message: String,
    pub host: String,
}

pub struct Applied {
    /// Static fields to persist, when any changed.
    pub patch: Option<Value>,
    /// First report since this monitor started.
    pub first: bool,
    pub new_updates: bool,
}

const MIN_RETENTION_DAYS: u32 = 30;
const MAX_RETENTION_DAYS: u32 = 365;
/// Five-minute points for the raw week, hourly ones for the rest of a year.
const FLEET_POINTS: usize = 2016 + 8760;

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct FleetPoint {
    pub t: i64,
    pub cpu: f32,
    pub mem: f32,
}

#[derive(Default)]
pub struct State {
    /// Latest EDF Tempo summary, and when RTE gave it.
    pub tempo: Option<(std::time::Instant, Value)>,
    pub hosts: HashMap<String, Host>,
    pub by_token: HashMap<String, String>,
    pub alerts: HashMap<String, OpenAlert>,
    pub probes: HashMap<String, crate::probes::ProbeLive>,
    pub pipelines: HashMap<String, crate::pipelines::Live>,
    pub results: VecDeque<Value>,
    pub thresholds: Thresholds,
    pub maintenance: Maintenance,
    pub last_check_day: i64,
    pub power: HashMap<String, f64>,
    /// Plugs that could not be read, with the reason, by name.
    pub power_problems: HashMap<String, String>,
    /// Where nodes were placed on the map, by id. In memory as public pages read it.
    pub map_layout: Value,
    /// Version of the agents fetched from GitHub, while beta agents are on.
    pub beta_agent: Option<String>,
    pub uptime: crate::pages::Uptime,
    /// Fleet-wide average of each flush, so that the overview chart needs no read
    /// of every host's rollups.
    pub fleet: VecDeque<FleetPoint>,
    /// Day of the last history snapshot. `None` until the history is loaded, as
    /// saving before that would overwrite it with a partial one.
    pub history_day: Option<NaiveDate>,
    /// Until when someone is using the monitor, see [`VIEW_S`].
    pub viewed_until: i64,
}

pub struct App {
    pub core: Arc<Core>,
    pub st: Mutex<State>,
    pub http: reqwest::Client,
    pub agent_dir: String,
    pub probes: crate::probes::Shared,
    pub pages: Mutex<crate::pages::Pages>,
    started: std::time::Instant,
}

impl App {
    pub async fn load(core: Arc<Core>) -> anyhow::Result<Self> {
        let mut st = State::default();
        for r in core.pb.list("hosts", "", "name").await? {
            let h = Host::from_record(&r);
            st.by_token.insert(h.token.clone(), h.id.clone());
            st.hosts.insert(h.id.clone(), h);
        }
        for r in core.pb.list("alerts", "open = true", "").await? {
            let s = |k: &str| r[k].as_str().unwrap_or_default().to_string();
            st.alerts.insert(s("key"), OpenAlert { id: s("id"), severity: s("severity"), message: s("message"), opened: s("created") });
        }
        let pages = crate::pages::load(&core).await?;
        let app = Self {
            core,
            st: Mutex::new(st),
            http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build()?,
            agent_dir: std::env::var("NYX_AGENT_DIR").unwrap_or_else(|_| "/usr/share/nyx/agents".into()),
            probes: crate::probes::Shared::new()?,
            pages: Mutex::new(pages),
            started: std::time::Instant::now(),
        };
        app.reload_settings().await?;
        crate::probes::reload(&app).await?;
        Ok(app)
    }

    /// After a restart `last_seen` is stale for everyone: nothing can be told about a
    /// host before agents had one full window to report.
    pub fn settled(&self) -> bool {
        self.started.elapsed().as_secs() >= offline_after(IDLE_INTERVAL_S) as u64
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.st.lock().expect("state lock poisoned")
    }

    pub async fn reload_settings(&self) -> anyhow::Result<()> {
        let thresholds = self.core.pb.setting("thresholds").await?.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        let maintenance = self.core.pb.setting("maintenance").await?.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        let map_layout = self.core.pb.setting("map_layout").await?.unwrap_or_default();
        let mut st = self.lock();
        st.map_layout = map_layout;
        st.thresholds = thresholds;
        st.maintenance = maintenance;
        Ok(())
    }

    pub fn enqueue(&self, host: &str, action: Action) -> Option<String> {
        let id = nyx_srv::random_hex(8);
        self.lock().hosts.get_mut(host)?.queue.push(Command { id: id.clone(), action });
        Some(id)
    }

    /// Make open alerts under `prefix` match `wanted`, writing only the differences.
    pub async fn reconcile(&self, prefix: &str, wanted: Vec<Wanted>) -> anyhow::Result<()> {
        let (resolved, changed): (Vec<(String, String)>, Vec<(Wanted, Option<String>)>) = {
            let mut st = self.lock();
            let resolved: Vec<String> = st.alerts.keys().filter(|k| k.starts_with(prefix) && !wanted.iter().any(|w| w.key == **k)).cloned().collect();
            let resolved = resolved.into_iter().filter_map(|k| st.alerts.remove(&k).map(|a| (k, a.id))).collect();
            let changed = wanted
                .into_iter()
                .filter_map(|w| match st.alerts.get(&w.key) {
                    Some(a) if a.severity == w.severity => None,
                    Some(a) => { let id = a.id.clone(); Some((w, Some(id))) }
                    None => Some((w, None)),
                })
                .collect();
            (resolved, changed)
        };
        let pb = &self.core.pb;
        for (key, id) in resolved {
            let row = pb.update("alerts", &id, &json!({"open": false, "resolved_at": pb_date(Utc::now())})).await?;
            let (kind, msg, host) = (row["type"].as_str().unwrap_or("state"), row["message"].as_str().unwrap_or(&key), row["host"].as_str().unwrap_or(""));
            notify::emit(&self.core, kind, "ok", &format!("Resolved: {msg}"), "", host).await;
        }
        for (w, existing) in changed {
            let body = json!({"key": w.key, "type": w.kind, "severity": w.severity, "message": w.message, "host": w.host, "open": true});
            let id = match existing {
                Some(id) => pb.update("alerts", &id, &body).await?["id"].as_str().unwrap_or_default().to_string(),
                None => pb.create("alerts", &body).await?["id"].as_str().unwrap_or_default().to_string(),
            };
            self.lock().alerts.insert(w.key.clone(), OpenAlert { id, severity: w.severity.to_string(), message: w.message.clone(), opened: pb_date(Utc::now()) });
            notify::emit(&self.core, w.kind, w.severity, &w.message, "", &w.host).await;
        }
        Ok(())
    }

    /// Closes the open alerts of a host without telling anyone: muting it is no recovery.
    pub async fn silence(&self, id: &str) -> anyhow::Result<()> {
        let ids: Vec<String> = {
            let mut st = self.lock();
            let (state, prefix) = (format!("offline:{id}"), format!("host:{id}:"));
            let keys: Vec<String> = st.alerts.keys().filter(|k| **k == state || k.starts_with(&prefix)).cloned().collect();
            keys.iter().filter_map(|k| st.alerts.remove(k)).map(|a| a.id).collect()
        };
        for aid in ids {
            self.core.pb.update("alerts", &aid, &json!({"open": false, "resolved_at": pb_date(Utc::now())})).await?;
        }
        Ok(())
    }

    pub async fn sweep_offline(&self) -> anyhow::Result<()> {
        if !self.settled() {
            return Ok(());
        }
        let now = Utc::now().timestamp();
        let hosts: Vec<(String, String, bool)> = {
            let st = self.lock();
            // A host that never reported is pending installation, not down.
            st.hosts.values().filter(|h| h.last_seen > 0).map(|h| (h.id.clone(), h.name.clone(), !h.muted && !h.online(now))).collect()
        };
        for (id, name, down) in hosts {
            let wanted = down.then(|| Wanted { key: format!("offline:{id}"), kind: "state", severity: "crit", message: format!("{name} is not responding"), host: name.clone() });
            self.reconcile(&format!("offline:{id}"), wanted.into_iter().collect()).await?;
        }
        Ok(())
    }

    /// The one periodic write: a rollup per host and the `last_seen` stamps, in a
    /// single transaction.
    pub async fn flush(&self) -> anyhow::Result<()> {
        let now = Utc::now();
        let t = pb_date(now);
        let today = Local::now().date_naive();
        // The heartbeat tells "this host was silent" from "nobody was listening".
        let mut reqs = vec![json!({"method": "POST", "url": "/api/collections/probe_rollups/records",
            "body": {"probe": crate::pages::MONITOR, "t": t, "up": 1, "total": 1}})];
        {
            let mut guard = self.lock();
            let st = &mut *guard;
            st.uptime.add(crate::pages::MONITOR, today, 1, 1);
            let (mut cpu_sum, mut mem_sum, mut reporting) = (0.0, 0.0, 0.0);
            for h in st.hosts.values_mut() {
                let Some([cpu, mem, disk, temp, rx, tx]) = h.acc.take() else { continue };
                st.uptime.add(&h.id, today, 1, 1);
                cpu_sum += cpu;
                mem_sum += mem;
                reporting += 1.0;
                reqs.push(json!({"method": "POST", "url": "/api/collections/rollups/records",
                    "body": {"host": h.id, "t": t, "cpu": cpu, "mem": mem, "disk": disk, "temp": temp, "rx": rx, "tx": tx}}));
                let seen = chrono::DateTime::from_timestamp(h.last_seen, 0).map(pb_date);
                reqs.push(json!({"method": "PATCH", "url": format!("/api/collections/hosts/records/{}", h.id), "body": {"last_seen": seen}}));
            }
            for (id, p) in st.probes.iter_mut() {
                let (up, total, latency, values) = p.take_rollup();
                if total > 0 {
                    st.uptime.add(id, today, up, total);
                    reqs.push(json!({"method": "POST", "url": "/api/collections/probe_rollups/records",
                        "body": {"probe": id, "t": t, "up": up, "total": total, "latency_ms": latency, "values": values}}));
                }
            }
            for (plug, watts) in &st.power {
                reqs.push(json!({"method": "POST", "url": "/api/collections/power_samples/records", "body": {"plug": plug, "t": t, "watts": watts}}));
            }
            if reporting > 0.0 {
                st.add_fleet_point(FleetPoint { t: now.timestamp(), cpu: (cpu_sum / reporting) as f32, mem: (mem_sum / reporting) as f32 });
            }
        }
        self.core.pb.batch(reqs).await.context("rollup batch")?;
        crate::pages::save_history(self, &t, today).await
    }

    /// Once a day at the chosen hour: ask agents to check for updates and offer
    /// them the agent version they should run.
    pub async fn maintenance(&self) -> anyhow::Result<()> {
        self.reload_settings().await?;
        let now = Local::now();
        let day = now.timestamp().div_euclid(86400);
        let mut st = self.lock();
        if now.hour() != st.maintenance.check_hour || st.last_check_day == day {
            return Ok(());
        }
        st.last_check_day = day;
        let auto = st.maintenance.agent_auto_update;
        let target = st.agent_target();
        // A queue for a dead host would only grow, so it waits for the next day.
        for h in st.hosts.values_mut().filter(|h| h.online(now.timestamp()) && !h.agent_version.is_empty()) {
            h.queue.push(Command { id: nyx_srv::random_hex(8), action: Action::CheckUpdates });
            if auto && h.agent_version != target {
                h.queue.push(Command { id: nyx_srv::random_hex(8), action: Action::UpdateAgent });
            }
        }
        Ok(())
    }

    pub async fn retention(&self) -> anyhow::Result<()> {
        self.reload_settings().await?;
        let now = Utc::now();
        let days = self.lock().maintenance.retention();
        let cutoff = now - Duration::days(days);
        let pb = &self.core.pb;
        for tier in &crate::compact::TIERS {
            crate::compact::compact(pb, tier, now).await?;
        }
        self.lock().thin_fleet(now.timestamp(), days);
        pb.prune("rollups", "t", cutoff).await?;
        pb.prune("probe_rollups", "t", cutoff).await?;
        pb.prune("power_samples", "t", cutoff).await?;
        pb.prune("alerts", "resolved_at", cutoff).await
    }
}

impl State {
    /// The fetched beta, for as long as beta agents are on.
    pub fn beta(&self) -> Option<&str> {
        self.beta_agent.as_deref().filter(|_| self.maintenance.agent_beta)
    }

    /// The version agents should run.
    pub fn agent_target(&self) -> String {
        self.beta().unwrap_or(env!("CARGO_PKG_VERSION")).to_string()
    }

    /// Upgrade every host in contact, then bring its agent to the wanted version: in
    /// that order, as replacing the agent restarts it and drops what it has queued.
    pub fn update_all(&mut self, now: i64) -> usize {
        let target = self.agent_target();
        let online = self.hosts.values_mut().filter(|h| h.online(now) && !h.agent_version.is_empty());
        online
            .filter_map(|h| {
                let stale = h.agent_version != target;
                h.start_update(if stale { vec![Action::UpdateSystem, Action::UpdateAgent] } else { vec![Action::UpdateSystem] }, now)
            })
            .count()
    }

    pub fn add_fleet_point(&mut self, p: FleetPoint) {
        self.fleet.push_back(p);
        while self.fleet.len() > FLEET_POINTS {
            self.fleet.pop_front();
        }
    }

    /// The fleet chart ages like the rollups: hourly past the raw week, gone past
    /// the retention.
    fn thin_fleet(&mut self, now: i64, days: i64) {
        let (keep, hourly) = (now - days * 86400, now - crate::compact::RAW_DAYS * 86400);
        let mut out = VecDeque::<FleetPoint>::new();
        let mut merged = 1.0;
        for p in self.fleet.drain(..).filter(|p| p.t >= keep) {
            let hour = p.t - p.t.rem_euclid(3600);
            match out.back_mut() {
                Some(last) if p.t < hourly && last.t == hour => {
                    merged += 1.0;
                    last.cpu += (p.cpu - last.cpu) / merged;
                    last.mem += (p.mem - last.mem) / merged;
                }
                _ if p.t < hourly => {
                    merged = 1.0;
                    out.push_back(FleetPoint { t: hour, ..p });
                }
                _ => out.push_back(p),
            }
        }
        self.fleet = out;
    }

    /// Merge a report into the live view.
    pub fn apply(&mut self, id: &str, mut r: Report, now: i64) -> Option<Applied> {
        let h = self.hosts.get_mut(id)?;
        let first = h.live.is_none();
        let live = h.live.get_or_insert_with(Live::default);
        h.last_seen = now;

        let mut new_updates = false;
        if let Some(c) = r.containers.take() { live.containers = c; }
        if let Some(s) = r.smart.take() { live.smart = s; }
        if let Some(n) = r.node.take() { live.node = Some(n); }
        if let Some(f) = r.firewall.take() { live.firewall = Some(f); }
        if let Some(mut g) = r.guests.take() {
            if !r.ct_autoinstall { g.retain(|g| g.kind != "lxc"); } // Older agents always list them.
            live.guests = g;
        }
        if let Some(u) = r.updates.take() {
            new_updates = !u.is_empty() && u != live.updates;
            live.updates = u;
        }
        for line in r.logs.drain(..) {
            if live.logs.len() == LOG_LINES { live.logs.pop_front(); }
            live.logs.push_back(line);
        }
        for res in r.results.drain(..) {
            if let Some(u) = &mut h.update { u.finish(&res); }
            if self.results.len() == 200 { self.results.pop_front(); }
            self.results.push_back(json!({"id": res.id, "host": h.id, "ok": res.ok, "output": res.output, "t": now}));
        }

        if is_vpn_ip(&r.ip) { r.ip.clear(); } // Older agents can report a mesh address.
        merge_vpn(&mut live.vpn, std::mem::take(&mut r.vpn), now);

        let disk = r.disks.iter().map(|d| pct(d.used, d.total)).fold(0.0, f32::max);
        let point = Point { t: now, cpu: r.cpu_pct, mem: pct(r.mem_used, r.mem_total), disk, temp: r.temp_c.unwrap_or(0.0), rx: r.net_rx_bps, tx: r.net_tx_bps };
        if live.series.len() == RAM_POINTS { live.series.pop_front(); }
        live.series.push_back(point);
        h.acc.add(&point);

        let kind = r.kind.as_str();
        let dirty = h.hostname != r.hostname || h.ip != r.ip || h.os != r.os || h.kernel != r.kernel || h.arch != r.arch
            || h.agent_version != r.agent_version || h.kind != kind || h.ct_autoinstall != r.ct_autoinstall;
        (h.hostname, h.ip, h.os, h.kernel, h.arch, h.agent_version) = (r.hostname.clone(), r.ip.clone(), r.os.clone(), r.kernel.clone(), r.arch.clone(), r.agent_version.clone());
        h.kind = kind.to_string();
        h.ct_autoinstall = r.ct_autoinstall;
        live.report = r;
        let patch = dirty.then(|| {
            json!({"hostname": h.hostname, "ip": h.ip, "os": h.os, "kernel": h.kernel, "arch": h.arch,
                "agent_version": h.agent_version, "kind": h.kind, "ct_autoinstall": h.ct_autoinstall})
        });
        Some(Applied { patch, first, new_updates })
    }
}

/// Latest tunnels, plus those that vanished, as down. A day later a missing tunnel
/// counts as removed on purpose, which also closes its alert.
fn merge_vpn(known: &mut Vec<VpnLink>, fresh: Vec<VpnLink>, now: i64) {
    let mut merged: Vec<VpnLink> = fresh
        .into_iter()
        .map(|mut f| {
            f.seen = if f.up { now } else { known.iter().find(|k| k.iface == f.iface).map_or(now, |k| k.seen) };
            f
        })
        .collect();
    for mut k in known.drain(..) {
        if now - k.seen < VPN_FORGET_S && !merged.iter().any(|m| m.iface == k.iface) {
            (k.up, k.rx_bps, k.tx_bps) = (false, 0, 0);
            merged.push(k);
        }
    }
    *known = merged;
}

/// Level for an alert already open at `current`: it only eases once the value is
/// clearly past the threshold, so a metric hovering on it cannot flap.
fn held_level(value: f32, warn: f32, crit: f32, current: Option<&str>) -> &'static str {
    match (level(value, warn, crit), current) {
        ("crit", _) => "crit",
        (_, Some("crit")) if value >= crit - HYSTERESIS => "crit",
        ("ok", Some(_)) if value >= warn - HYSTERESIS => "warn",
        (l, _) => l,
    }
}

/// What is wrong with a container, if anything. A container stopped on purpose is no problem,
/// but one that exited with an error in the last day is, as is one that keeps restarting.
pub fn container_problem(c: &Container) -> Option<(&'static str, &'static str)> {
    if c.state == "restarting" {
        return Some(("crit", "keeps restarting"));
    }
    if c.status.contains("(unhealthy)") {
        return Some(("warn", "is unhealthy"));
    }
    let code = c.status.strip_prefix("Exited (")?.split(')').next()?;
    let old = ["day", "week", "month", "year"].iter().any(|u| c.status.contains(u));
    (code != "0" && !old).then_some(("warn", "stopped with an error"))
}

/// Alerts a host's latest data should have open.
pub fn evaluate(h: &Host, th: &Thresholds, open: &HashMap<String, OpenAlert>) -> Vec<Wanted> {
    let Some(live) = &h.live else { return vec![] };
    let r = &live.report;
    let mut out = vec![];
    let held = |suffix: &str, value: f32, warn: f32, crit: f32| {
        held_level(value, warn, crit, open.get(&format!("host:{}:{suffix}", h.id)).map(|a| a.severity.as_str()))
    };
    let mut push = |suffix: String, kind, severity: &'static str, message: String| {
        if severity != "ok" {
            out.push(Wanted { key: format!("host:{}:{suffix}", h.id), kind, severity, message, host: h.name.clone() });
        }
    };
    let mem = pct(r.mem_used, r.mem_total);
    push("mem".into(), "state", held("mem", mem, th.warn, th.crit), format!("{}: memory at {mem:.0}%", h.name));
    for d in &r.disks {
        let p = pct(d.used, d.total);
        push(format!("disk:{}", d.mount), "state", held(&format!("disk:{}", d.mount), p, th.warn, th.crit), format!("{}: {} at {p:.0}%", h.name, d.mount));
    }
    if let Some(t) = r.temp_c {
        push("temp".into(), "temperature", held("temp", t, th.temp_warn, th.temp_crit), format!("{}: {t:.0} °C", h.name));
    }
    for v in live.vpn.iter().filter(|v| !v.up) {
        push(format!("vpn:{}", v.iface), "state", "warn", format!("{}: VPN {} ({}) is down", h.name, v.iface, v.kind));
    }
    for c in &live.containers {
        if let Some((severity, what)) = container_problem(c) {
            push(format!("ct:{}", c.name), "state", severity, format!("{}: container {} {what}", h.name, c.name));
        }
        // Only with an explicit limit: without one Docker reports the memory of the host.
        if c.mem_limit > 0 && c.mem_limit < r.mem_total {
            let (suffix, p) = (format!("ct:{}:mem", c.name), pct(c.mem_used, c.mem_limit));
            push(suffix.clone(), "state", held(&suffix, p, th.warn, th.crit), format!("{}: container {} uses {p:.0}% of its memory limit", h.name, c.name));
        }
    }
    for d in &live.smart {
        let severity = match d.health { Health::Ok => "ok", Health::Warn => "warn", Health::Crit => "crit" };
        push(format!("smart:{}", d.device), "smart", severity, format!("{}: {} {}", h.name, d.device, d.reason));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> Host {
        Host::from_record(&json!({"id": "h1", "name": "pve-01", "token": "t", "key": "k"}))
    }

    fn report(cpu: f32, mem_pct: u64, disk_pct: u64) -> Report {
        Report { cpu_pct: cpu, mem_used: mem_pct, mem_total: 100, disks: vec![Disk { mount: "/".into(), used: disk_pct, total: 100, ..Disk::default() }], kind: HostKind::Vm, ..Report::default() }
    }

    fn result(id: &str, ok: bool) -> CommandResult {
        CommandResult { id: id.into(), ok, output: "out".into() }
    }

    #[test]
    fn an_update_tracks_its_commands_and_refuses_a_second_one() {
        let mut h = Host { last_seen: 100, ..host() };
        h.start_update(vec![Action::UpdateSystem, Action::UpdateAgent], 100).unwrap();
        assert!(h.start_update(vec![Action::UpdateAgent], 100).is_none());
        assert_eq!(h.queue.len(), 2);
        assert!(matches!(h.queue[0].action, Action::UpdateSystem), "the agent replaces itself last");
        let (first, second) = (h.queue[0].id.clone(), h.queue[1].id.clone());
        fn json(h: &Host, p: Option<&Progress>) -> Value {
            h.update.as_ref().unwrap().to_json(100, 100, p)
        }

        assert_eq!(json(&h, Some(&Progress { pct: 50, step: "x".into() }))["pct"], 25);
        h.update.as_mut().unwrap().finish(&result("someone-else", true));
        h.update.as_mut().unwrap().finish(&result(&first, true));
        assert_eq!(json(&h, None)["pct"], 50);
        h.update.as_mut().unwrap().finish(&result(&second, false));
        let end = json(&h, None);
        assert_eq!((&end["done"], &end["pct"], &end["error"]), (&json!(true), &json!(100), &json!("out")));
        assert!(!h.updating(100) && h.start_update(vec![Action::UpdateAgent], 100).is_some());
    }

    #[test]
    fn an_update_whose_agent_goes_quiet_ends_and_can_be_retried() {
        let mut h = Host { last_seen: 100, ..host() };
        h.start_update(vec![Action::UpdateSystem], 100);
        assert!(h.updating(100 + offline_after_s()));
        let now = 101 + offline_after_s();
        assert!(!h.updating(now));
        let json = h.update.as_ref().unwrap().to_json(now, h.last_seen, None);
        assert_eq!(json["done"], true);
        assert!(json["error"].as_str().unwrap().contains("stopped answering"));
        h.last_seen = now;
        assert!(h.updating(now), "still within the time an upgrade can take");
        assert!(!h.updating(100 + UPDATE_TIMEOUT_S + 1));
    }

    #[test]
    fn update_all_skips_silent_hosts_and_agents_already_current() {
        let mut st = State::default();
        let add = |st: &mut State, id: &str, last_seen, version: &str| {
            st.hosts.insert(id.into(), Host { last_seen, agent_version: version.into(), ..Host::from_record(&json!({"id": id})) });
        };
        add(&mut st, "old", 1000, "0.0.1");
        add(&mut st, "current", 1000, env!("CARGO_PKG_VERSION"));
        add(&mut st, "silent", 0, "0.0.1");
        assert_eq!(st.update_all(1000), 2);
        assert_eq!((st.hosts["old"].queue.len(), st.hosts["current"].queue.len(), st.hosts["silent"].queue.len()), (2, 1, 0));
        assert_eq!(st.update_all(1000), 0, "pressing twice changes nothing");
    }

    #[test]
    fn hosts_measured_by_their_node_have_no_agent_to_update() {
        let mut st = State::default();
        st.hosts.insert("ct".into(), Host { last_seen: 1000, ..Host::from_record(&json!({"id": "ct", "kind": "lxc"})) });
        assert_eq!(st.update_all(1000), 0);
        assert!(st.hosts["ct"].queue.is_empty());
    }

    #[test]
    fn beta_agents_are_the_target_while_they_are_on() {
        let mut st = State::default();
        st.beta_agent = Some("9.9.9-beta.1".into());
        assert_eq!(st.agent_target(), env!("CARGO_PKG_VERSION"), "ticked off, the fetched files are ignored");
        st.maintenance.agent_beta = true;
        assert_eq!(st.agent_target(), "9.9.9-beta.1");
        st.hosts.insert("h".into(), Host { last_seen: 1000, agent_version: env!("CARGO_PKG_VERSION").into(), ..Host::from_record(&json!({"id": "h"})) });
        st.update_all(1000);
        assert_eq!(st.hosts["h"].queue.len(), 2, "an agent on the bundled version is behind");
    }

    #[test]
    fn containers_of_an_unwatched_node_stay_out_of_view() {
        let mut st = state();
        let guests = vec![Guest { vmid: 101, kind: "lxc".into(), ..Guest::default() }, Guest { vmid: 100, kind: "qemu".into(), ..Guest::default() }];
        st.apply("h1", Report { guests: Some(guests.clone()), ..Report::default() }, 1);
        assert_eq!(st.hosts["h1"].live.as_ref().unwrap().guests.iter().map(|g| g.vmid).collect::<Vec<_>>(), [100]);
        st.apply("h1", Report { guests: Some(guests), ct_autoinstall: true, ..Report::default() }, 2);
        assert_eq!(st.hosts["h1"].live.as_ref().unwrap().guests.len(), 2);
    }

    #[test]
    fn retention_stays_within_its_bounds() {
        let days = |retention_days| Maintenance { retention_days, ..Maintenance::default() }.retention();
        assert_eq!((days(0), days(90), days(9999)), (30, 90, 365));
    }

    #[test]
    fn the_fleet_chart_turns_hourly_after_a_week_and_ends_with_the_retention() {
        let now = 400 * 86400;
        let point = |t, cpu| FleetPoint { t, cpu, mem: cpu };
        let hour = (now - 10 * 86400) / 3600 * 3600;
        let mut st = State::default();
        st.fleet = [point(now - 40 * 86400, 1.0), point(hour, 10.0), point(hour + 300, 20.0), point(hour + 600, 30.0), point(now - 60, 50.0)].into();
        st.thin_fleet(now, 30);
        let kept: Vec<(i64, f32)> = st.fleet.iter().map(|p| (p.t, p.cpu)).collect();
        assert_eq!(kept, [(hour, 20.0), (now - 60, 50.0)]);
        st.thin_fleet(now, 30);
        assert_eq!(st.fleet.len(), 2, "running it again changes nothing");
    }

    fn state() -> State {
        let mut st = State::default();
        st.hosts.insert("h1".into(), host());
        st
    }

    #[test]
    fn container_problems_are_loops_errors_and_unhealthy_ones_but_not_a_clean_stop() {
        let c = |state: &str, status: &str| Container { name: "web".into(), image: String::new(), state: state.into(), status: status.into(), ..Container::default() };
        assert_eq!(container_problem(&c("restarting", "Restarting (1) 3 seconds ago")), Some(("crit", "keeps restarting")));
        assert_eq!(container_problem(&c("running", "Up 2 hours (unhealthy)")), Some(("warn", "is unhealthy")));
        assert_eq!(container_problem(&c("exited", "Exited (137) 5 minutes ago")), Some(("warn", "stopped with an error")));
        assert_eq!(container_problem(&c("exited", "Exited (0) 5 minutes ago")), None);
        assert_eq!(container_problem(&c("exited", "Exited (1) 3 weeks ago")), None, "an old failure is no news");
        assert_eq!(container_problem(&c("running", "Up 2 hours")), None);
    }

    #[test]
    fn status_uses_worst_metric_and_goes_off_when_silent() {
        let mut st = state();
        let th = Thresholds::default();
        assert_eq!(host_status(&st.hosts["h1"], 1000, &th), "off", "never reported");
        st.apply("h1", report(10.0, 10, 10), 1000);
        assert_eq!(host_status(&st.hosts["h1"], 1000, &th), "ok");
        st.apply("h1", report(10.0, 80, 10), 1000);
        assert_eq!(host_status(&st.hosts["h1"], 1000, &th), "warn");
        st.apply("h1", report(10.0, 80, 95), 1000);
        assert_eq!(host_status(&st.hosts["h1"], 1000, &th), "crit");
        assert_eq!(host_status(&st.hosts["h1"], 1000 + offline_after(IDLE_INTERVAL_S) + 1, &th), "off");
    }

    #[test]
    fn offline_follows_the_pace_each_host_was_given() {
        let mut st = state();
        st.apply("h1", report(10.0, 10, 10), 1000);
        let h = st.hosts.get_mut("h1").unwrap();
        h.interval_s = REPORT_INTERVAL_S;
        assert!(h.online(1060) && !h.online(1061), "fast pace: same 60 s as before");
        h.interval_s = IDLE_INTERVAL_S;
        assert!(h.online(1150) && !h.online(1151), "idle pace: two missed reports");
        h.interval_s = UPDATE_INTERVAL_S;
        assert!(h.online(1060), "an update's quick pace never shortens the wait");
    }

    #[test]
    fn change_only_fields_survive_an_empty_report() {
        let mut st = state();
        let c = Container { name: "web".into(), image: "i".into(), state: "running".into(), status: "Up".into(), ..Container::default() };
        st.apply("h1", Report { containers: Some(vec![c]), ..report(1.0, 1, 1) }, 1);
        st.apply("h1", report(1.0, 1, 1), 2);
        assert_eq!(st.hosts["h1"].live.as_ref().unwrap().containers.len(), 1);
    }

    #[test]
    fn ring_buffers_are_bounded() {
        let mut st = state();
        for i in 0..(RAM_POINTS + 10) as i64 {
            st.apply("h1", Report { logs: vec!["x".into(); 10], ..report(1.0, 1, 1) }, i);
        }
        let live = st.hosts["h1"].live.as_ref().unwrap();
        assert_eq!((live.series.len(), live.logs.len()), (RAM_POINTS, LOG_LINES));
    }

    #[test]
    fn rollup_averages_then_resets() {
        let mut st = state();
        st.apply("h1", report(10.0, 1, 1), 1);
        st.apply("h1", report(30.0, 1, 1), 2);
        let h = st.hosts.get_mut("h1").unwrap();
        assert_eq!(h.acc.take().unwrap()[0], 20.0);
        assert!(h.acc.take().is_none());
    }

    #[test]
    fn static_changes_are_flagged_once() {
        let mut st = state();
        let r = Report { hostname: "a".into(), ..report(1.0, 1, 1) };
        assert!(st.apply("h1", r.clone(), 1).unwrap().patch.is_some());
        assert!(st.apply("h1", r, 2).unwrap().patch.is_none());
    }

    #[test]
    fn alerts_do_not_flap_around_a_threshold() {
        assert_eq!(held_level(74.0, 75.0, 90.0, None), "ok", "nothing open yet");
        assert_eq!(held_level(74.0, 75.0, 90.0, Some("warn")), "warn", "held just below");
        assert_eq!(held_level(71.0, 75.0, 90.0, Some("warn")), "ok", "clearly recovered");
        assert_eq!(held_level(89.0, 75.0, 90.0, Some("crit")), "crit");
        assert_eq!(held_level(86.0, 75.0, 90.0, Some("crit")), "warn", "eases one step");
        assert_eq!(held_level(91.0, 75.0, 90.0, Some("warn")), "crit", "worsening is immediate");
    }

    #[test]
    fn tail_serves_new_lines_and_survives_overflow_and_restart() {
        let mut t = Tail::default();
        t.push(vec!["a".into(), "b".into()]);
        assert_eq!(t.since(0), ["a", "b"]);
        assert_eq!(t.since(1), ["b"]);
        assert!(t.since(2).is_empty());
        assert_eq!(t.since(99), ["a", "b"]);
        t.push((0..TAIL_LINES).map(|i| i.to_string()).collect());
        assert_eq!(t.since(0).len(), TAIL_LINES); // older lines are gone, not an error
        t.clear();
        assert!(t.since(0).is_empty());
    }

    #[test]
    fn a_vanished_tunnel_stays_down_for_a_day_then_is_forgotten() {
        let up = || VpnLink { iface: "wg0".into(), kind: "WireGuard".into(), ip: "10.8.0.1".into(), up: true, rx_bps: 5, ..VpnLink::default() };
        let mut known = vec![];
        merge_vpn(&mut known, vec![up()], 100);
        assert!(known[0].up && known[0].seen == 100);
        merge_vpn(&mut known, vec![], 200);
        assert!(!known[0].up && known[0].rx_bps == 0 && known[0].seen == 100);
        merge_vpn(&mut known, vec![], 100 + VPN_FORGET_S);
        assert!(known.is_empty());

        merge_vpn(&mut known, vec![up()], 300);
        merge_vpn(&mut known, vec![VpnLink { up: false, ..up() }], 400);
        assert_eq!((known.len(), known[0].up, known[0].seen), (1, false, 300));
    }

    #[test]
    fn mesh_addresses_never_become_the_host_address() {
        let mut st = state();
        st.apply("h1", Report { ip: "100.100.1.2".into(), ..report(1.0, 1, 1) }, 1).unwrap();
        assert_eq!(st.hosts["h1"].ip, "");
    }

    #[test]
    fn evaluate_opens_expected_alerts() {
        let mut st = state();
        let r = Report {
            temp_c: Some(95.0),
            smart: Some(vec![SmartDisk { device: "/dev/sda".into(), model: "m".into(), health: Health::Warn, reason: "8 bad sectors".into(), ..Default::default() }]),
            ..report(1.0, 80, 10)
        };
        st.apply("h1", r, 1);
        let w = evaluate(&st.hosts["h1"], &Thresholds::default(), &HashMap::new());
        let keys: Vec<(&str, &str)> = w.iter().map(|w| (w.key.as_str(), w.severity)).collect();
        assert_eq!(keys, [("host:h1:mem", "warn"), ("host:h1:temp", "crit"), ("host:h1:smart:/dev/sda", "warn")]);
    }
}

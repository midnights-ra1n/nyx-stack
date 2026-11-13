//! Browser-facing API and MCP tools.

use crate::{
    ingest,
    state::{host_status, pct, App, Host},
};
use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use chrono::{Duration, Local, Utc};
use nyx_proto::{Action, HostKind};
use nyx_srv::{auth::Session, mcp, pb_date, pb_quote, ApiError, ApiResult};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const SETTINGS: [&str; 8] = ["thresholds", "maintenance", "tempo", "tempo_calendar", "meross", "proxmox", "updates", "map_layout"];
const MAX_POINTS: usize = 400;

fn summary(h: &Host, now: i64, st: &crate::state::State) -> Value {
    let th = &st.thresholds;
    let live = h.live.as_ref();
    let parent = st.hosts.get(&h.parent).and_then(|p| p.live.as_ref());
    let r = live.map(|l| &l.report);
    json!({
        "id": h.id, "name": h.name, "kind": h.kind, "parent": h.parent, "vmid": h.vmid, "hostname": h.hostname, "ip": h.ip,
        "os": h.os, "kernel": h.kernel, "arch": h.arch, "agent_version": h.agent_version, "pve_node": h.pve_node, "muted": h.muted,
        "ct_autoinstall": h.ct_autoinstall, "last_seen": h.last_seen, "status": host_status(h, now, th),
        "installed": h.last_seen > 0,
        "oci": parent.is_some_and(|p| p.guests.iter().any(|g| g.vmid == h.vmid && g.oci)),
        "cpu": r.map(|r| r.cpu_pct), "mem": r.map(|r| pct(r.mem_used, r.mem_total)),
        "swap": r.map(|r| pct(r.swap_used, r.swap_total)), "uptime_s": r.map(|r| r.uptime_s), "temp": r.and_then(|r| r.temp_c),
        "rx": r.map(|r| r.net_rx_bps), "tx": r.map(|r| r.net_tx_bps),
        "updates": live.map_or(0, |l| l.updates.len()),
        "reboot_required": r.is_some_and(|r| r.reboot_required),
        "update": h.update.as_ref().map(|u| u.to_json(now, h.last_seen, r.and_then(|r| r.progress.as_ref()))),
        "containers_running": live.map_or(0, |l| l.containers.iter().filter(|c| c.state == "running").count()),
        "containers_total": live.map_or(0, |l| l.containers.len()),
        "guests": live.map_or(vec![], |l| l.guests.clone()),
        "vpn": live.map_or(vec![], |l| l.vpn.clone()),
    })
}

pub fn hosts_json(app: &App) -> Vec<Value> {
    let now = Utc::now().timestamp();
    let st = app.lock();
    let mut v: Vec<&Host> = st.hosts.values().collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v.iter().map(|h| summary(h, now, &st)).collect()
}

async fn map(_: Session, State(app): State<Arc<App>>) -> Json<Value> {
    Json(crate::pages::map_json(&app))
}

async fn hosts(_: Session, State(app): State<Arc<App>>) -> Json<Vec<Value>> {
    Json(hosts_json(&app))
}

pub fn overview_json(app: &App) -> Value {
    let now = Utc::now().timestamp();
    let st = app.lock();
    let online = st.hosts.values().filter(|h| host_status(h, now, &st.thresholds) != "off").count();
    let (mut running, mut total) = (0, 0);
    let (mut cpu, mut mem, mut n) = (0.0, 0.0, 0.0);
    let mut storage = vec![];
    for h in st.hosts.values() {
        let Some(l) = h.live.as_ref().filter(|_| h.online(now)) else { continue };
        running += l.containers.iter().filter(|c| c.state == "running").count();
        total += l.containers.len();
        cpu += l.report.cpu_pct;
        mem += pct(l.report.mem_used, l.report.mem_total);
        n += 1.0;
        for d in &l.report.disks {
            storage.push(json!({"host": h.name, "host_id": h.id, "mount": d.mount, "used": d.used, "total": d.total, "pct": pct(d.used, d.total)}));
        }
    }
    let crit = st.alerts.values().filter(|a| a.severity == "crit").count();
    json!({
        "hosts_online": online, "hosts_total": st.hosts.len(),
        "alerts": st.alerts.len(), "alerts_crit": crit,
        "containers_running": running, "containers_total": total,
        "availability_7d": st.uptime.availability(st.probes.keys(), Local::now().date_naive(), 7),
        "cpu": if n > 0.0 { cpu / n } else { 0.0 }, "mem": if n > 0.0 { mem / n } else { 0.0 },
        "storage": storage, "thresholds": st.thresholds,
    })
}

async fn overview(_: Session, State(app): State<Arc<App>>) -> Json<Value> {
    Json(overview_json(&app))
}

pub fn host_json(app: &App, id: &str) -> Option<Value> {
    let now = Utc::now().timestamp();
    let st = app.lock();
    let h = st.hosts.get(id)?;
    let mut v = summary(h, now, &st);
    if let Some(l) = &h.live {
        v["disks"] = json!(l.report.disks);
        v["containers"] = json!(l.containers);
        v["smart"] = json!(l.smart);
        v["update_list"] = json!(l.updates);
        v["node"] = json!(l.node);
        v["firewall"] = json!(l.firewall);
        v["guests"] = json!(l.guests);
        v["logs"] = json!(l.logs);
    }
    v["results"] = st.results.iter().filter(|r| r["host"] == id).cloned().collect();
    Some(v)
}

async fn host(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    host_json(&app, &id).map(Json).ok_or_else(ApiError::not_found)
}

#[derive(Deserialize)]
struct NewHost {
    name: String,
    kind: String,
    #[serde(default)]
    parent: String,
    #[serde(default)]
    ct_autoinstall: bool,
}

fn install_info(public_url: &str, token: &str, key: &str, kind: &str, ct: bool) -> Value {
    let flag = if ct { " --ct-autoinstall" } else { "" };
    json!({
        "curl": format!("curl -fsSL {public_url}/install.sh | sudo sh -s -- --url {public_url} --token {token} --key {key} --kind {kind}{flag}"),
        "ansible": {"nyx_agent_url": public_url, "nyx_agent_token": token, "nyx_agent_key": key, "nyx_agent_kind": kind, "nyx_agent_ct_autoinstall": ct},
    })
}

async fn add_host(_: Session, State(app): State<Arc<App>>, Json(b): Json<NewHost>) -> ApiResult<Json<Value>> {
    let kind = HostKind::parse(&b.kind).ok_or_else(|| ApiError::bad_request("unknown deployment type"))?;
    if b.name.trim().is_empty() {
        return Err(ApiError::bad_request("name is required"));
    }
    if app.lock().hosts.values().any(|h| h.name.eq_ignore_ascii_case(b.name.trim())) {
        return Err(ApiError::bad_request("a host has this name already: open it to see its install command"));
    }
    let ct = b.ct_autoinstall && kind == HostKind::Proxmox;
    if !b.parent.is_empty() && !app.lock().hosts.get(&b.parent).is_some_and(|p| HostKind::parse(&p.kind).is_some_and(HostKind::has_physical_disks)) {
        return Err(ApiError::bad_request("a host can only run on a physical server"));
    }
    let (token, key, id) = ingest::create_host(&app, b.name.trim(), kind.as_str(), &b.parent, 0, ct, "").await?;
    let mut info = install_info(&app.core.env.public_url, &token, &key, kind.as_str(), ct);
    info["id"] = id.into();
    Ok(Json(info))
}

#[derive(Deserialize)]
struct InstallQuery {
    url: Option<String>,
}

/// The address ends up in a shell command, so it may only hold what a URL needs.
fn agent_url(given: Option<&str>, default: &str) -> ApiResult<String> {
    let Some(url) = given.map(|u| u.trim().trim_end_matches('/')).filter(|u| !u.is_empty()) else { return Ok(default.into()) };
    let safe = url.chars().all(|c| c.is_ascii_alphanumeric() || "-._~:/[]%".contains(c));
    let parsed = reqwest::Url::parse(url).ok().filter(|u| ["http", "https"].contains(&u.scheme()) && u.host().is_some());
    if !safe || parsed.is_none() {
        return Err(ApiError::bad_request("enter a full address, such as https://monitor.example.org"));
    }
    Ok(url.into())
}

async fn install_line(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>, Query(q): Query<InstallQuery>) -> ApiResult<Json<Value>> {
    let url = agent_url(q.url.as_deref(), &app.core.env.public_url)?;
    let st = app.lock();
    let h = st.hosts.get(&id).ok_or_else(ApiError::not_found)?;
    Ok(Json(install_info(&url, &h.token, &h.key, &h.kind, h.ct_autoinstall)))
}

async fn delete_host(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    // Containers go with their node. A VM has its own agent and stays, at the top level.
    let (containers, others): (Vec<String>, Vec<String>) = {
        let mut st = app.lock();
        if !st.hosts.contains_key(&id) {
            return Err(ApiError::not_found());
        }
        let (containers, others): (Vec<&mut Host>, Vec<&mut Host>) = st.hosts.values_mut().filter(|c| c.parent == id).partition(|c| c.is_container());
        (containers.iter().map(|c| c.id.clone()).collect(), others.into_iter().map(|c| { c.parent.clear(); c.id.clone() }).collect())
    };
    for c in others {
        app.core.pb.update("hosts", &c, &json!({"parent": ""})).await?;
    }
    for c in containers {
        ingest::forget_host(&app, &c).await?;
    }
    ingest::forget_host(&app, &id).await?;
    Ok(Json(Value::Null))
}

#[derive(Deserialize)]
struct HostPatch {
    muted: bool,
}

/// Keeps a host out of alerts and notifications, or brings it back. Its open alerts
/// close quietly; unmuted, it alerts again from its next report.
async fn patch_host(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>, Json(b): Json<HostPatch>) -> ApiResult<Json<Value>> {
    app.lock().hosts.get_mut(&id).ok_or_else(ApiError::not_found)?.muted = b.muted;
    app.core.pb.update("hosts", &id, &json!({"muted": b.muted})).await?;
    if b.muted {
        app.silence(&id).await?;
    }
    Ok(Json(Value::Null))
}

#[derive(Deserialize)]
struct CommandReq {
    action: String,
    kind: Option<String>,
    ct_autoinstall: Option<bool>,
    /// For `firewall`: `add` or `delete`, and the rule.
    op: Option<String>,
    rule: Option<nyx_proto::FwRule>,
    /// For `container`: its name.
    name: Option<String>,
}

async fn command(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>, Json(b): Json<CommandReq>) -> ApiResult<Json<Value>> {
    let action = match b.action.as_str() {
        "check_updates" => Action::CheckUpdates,
        "update_system" => Action::UpdateSystem,
        "update_agent" => Action::UpdateAgent,
        "set_kind" => Action::SetKind {
            kind: b.kind.as_deref().and_then(HostKind::parse).ok_or_else(|| ApiError::bad_request("unknown deployment type"))?,
            ct_autoinstall: b.ct_autoinstall.unwrap_or(false),
        },
        "firewall" => {
            let change = nyx_proto::FirewallChange { op: b.op.unwrap_or_default(), rule: b.rule.unwrap_or_default() };
            change.check().map_err(ApiError::bad_request)?;
            Action::Firewall(change)
        }
        "container" => {
            let (op, name) = (b.op.unwrap_or_default(), b.name.unwrap_or_default());
            if !["start", "stop", "restart", "logs"].contains(&op.as_str()) || !nyx_proto::container_name_ok(&name) {
                return Err(ApiError::bad_request("unknown operation or invalid container name"));
            }
            Action::Container { op, name }
        }
        _ => return Err(ApiError::bad_request("unknown action")),
    };
    let cmd = if matches!(action, Action::UpdateSystem | Action::UpdateAgent) {
        let mut st = app.lock();
        let h = st.hosts.get_mut(&id).ok_or_else(ApiError::not_found)?;
        h.start_update(vec![action], Utc::now().timestamp()).ok_or_else(|| ApiError::bad_request("an update is already running on this host"))?
    } else {
        app.enqueue(&id, action).ok_or_else(ApiError::not_found)?
    };
    Ok(Json(json!({"id": cmd})))
}

async fn update_all(_: Session, State(app): State<Arc<App>>) -> Json<Value> {
    Json(json!({"started": app.lock().update_all(Utc::now().timestamp())}))
}

#[derive(Deserialize)]
struct SeriesQuery {
    host: Option<String>,
    range: Option<String>,
}

fn thin(mut points: Vec<Value>) -> Vec<Value> {
    if points.len() > MAX_POINTS {
        let step = points.len().div_ceil(MAX_POINTS);
        points = points.into_iter().step_by(step).collect();
    }
    points
}

/// The fleet average comes from RAM, and so does the last hour of a host. Longer
/// ranges of a host come from its rollups.
async fn series(_: Session, State(app): State<Arc<App>>, Query(q): Query<SeriesQuery>) -> ApiResult<Json<Value>> {
    let range = q.range.as_deref().unwrap_or("24h");
    let host = q.host.filter(|h| !h.is_empty());
    let since = Utc::now() - Duration::hours(range_hours(range)?);
    let Some(id) = host else {
        let st = app.lock();
        let points = st.fleet.iter().filter(|p| p.t >= since.timestamp()).map(|p| json!({"t": p.t, "cpu": p.cpu, "mem": p.mem}));
        return Ok(Json(json!(thin(points.collect()))));
    };
    if range == "1h" {
        let st = app.lock();
        let points: Vec<Value> = st.hosts.get(&id).and_then(|h| h.live.as_ref()).map_or(vec![], |l| l.series.iter().filter(|p| p.t >= since.timestamp()).map(|p| json!(p)).collect()); // idle pace: the buffer spans 4 h
        return Ok(Json(json!(points)));
    }
    let filter = format!("t >= {} && host = {}", pb_quote(&pb_date(since)), pb_quote(&id));
    let mut points = vec![];
    app.core.pb.each("rollups", &filter, "t", "t,cpu,mem", |r| points.extend(rollup_time(&r).map(|t| json!({"t": t, "cpu": r["cpu"], "mem": r["mem"]})))).await?;
    Ok(Json(json!(thin(points))))
}

fn range_hours(range: &str) -> ApiResult<i64> {
    match range {
        "1h" => Ok(1),
        "24h" => Ok(24),
        "7d" => Ok(168),
        "30d" => Ok(720),
        "90d" => Ok(2160),
        "180d" => Ok(4320),
        "365d" => Ok(8760),
        _ => Err(ApiError::bad_request("unknown range")),
    }
}

fn rollup_time(r: &Value) -> Option<i64> {
    Some(chrono::DateTime::parse_from_rfc3339(&r["t"].as_str()?.replacen(' ', "T", 1)).ok()?.timestamp())
}

async fn containers(_: Session, State(app): State<Arc<App>>) -> Json<Value> {
    let st = app.lock();
    let rows: Vec<Value> = st.hosts.values().filter_map(|h| Some((h, h.live.as_ref()?)))
        .flat_map(|(h, l)| l.containers.iter().map(|c| json!({"host": h.name, "host_id": h.id, "name": c.name, "image": c.image, "state": c.state, "status": c.status, "cpu_pct": c.cpu_pct, "mem_used": c.mem_used, "mem_limit": c.mem_limit, "mem_pct": pct(c.mem_used, c.mem_limit), "id": c.id})))
        .collect();
    Json(json!(rows))
}

async fn storage(_: Session, State(app): State<Arc<App>>) -> Json<Value> {
    let st = app.lock();
    let now = Utc::now().timestamp();
    let mut disks = vec![];
    let mut smart = vec![];
    for (id, h) in &st.hosts {
        let Some(l) = &h.live else { continue };
        let online = host_status(h, now, &st.thresholds) != "off"; // figures of an offline host are its last known ones
        disks.extend(l.report.disks.iter().map(|d| json!({
            "host": h.name, "host_id": id, "online": online, "mount": d.mount, "fs": d.fs, "device": d.device,
            "used": d.used, "total": d.total, "pct": pct(d.used, d.total),
        })));
        smart.extend(l.smart.iter().map(|d| { let mut v = json!(d); v["host"] = json!(h.name); v["host_id"] = json!(id); v }));
    }
    Json(json!({"disks": disks, "smart": smart, "thresholds": st.thresholds}))
}

#[derive(Deserialize)]
struct LogQuery {
    host: Option<String>,
    q: Option<String>,
}

async fn logs(_: Session, State(app): State<Arc<App>>, Query(q): Query<LogQuery>) -> Json<Value> {
    let st = app.lock();
    let needle = q.q.unwrap_or_default().to_lowercase();
    let mut lines: Vec<(&str, &str)> = st.hosts.values()
        .filter(|h| q.host.as_ref().is_none_or(|id| id.is_empty() || *id == h.id))
        .filter_map(|h| Some((h, h.live.as_ref()?)))
        .flat_map(|(h, l)| l.logs.iter().map(|line| (h.name.as_str(), line.as_str())))
        .filter(|(_, line)| needle.is_empty() || line.to_lowercase().contains(&needle))
        .collect();
    lines.sort_by(|a, b| b.1.cmp(a.1)); // lines start with a timestamp
    lines.truncate(500);
    Json(json!(lines.iter().map(|(h, l)| json!({"host": h, "line": l})).collect::<Vec<_>>()))
}

#[derive(Deserialize)]
struct LiveQuery {
    after: Option<u64>,
}

/// Asking is what keeps the agent sending: it stops soon after the last request.
async fn live_logs(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>, Query(q): Query<LiveQuery>) -> ApiResult<Json<Value>> {
    let now = Utc::now().timestamp();
    let mut st = app.lock();
    let h = st.hosts.get_mut(&id).ok_or_else(ApiError::not_found)?;
    h.watched_until = now + crate::state::LIVE_WATCH_S;
    let lines = h.tail.since(q.after.unwrap_or(0));
    Ok(Json(json!({"seq": h.tail.seq, "lines": lines, "connected": now - h.tail_seen <= crate::state::LIVE_WATCH_S})))
}

async fn probes(_: Session, State(app): State<Arc<App>>) -> Json<Vec<Value>> {
    Json(crate::probes::snapshot(&app))
}

#[derive(Deserialize)]
struct ProbeSeriesQuery {
    metric: Option<String>,
    range: Option<String>,
}

/// History of one probe: latency, or an SNMP value by label.
async fn probe_series(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>, Query(q): Query<ProbeSeriesQuery>) -> ApiResult<Json<Value>> {
    let hours = range_hours(q.range.as_deref().unwrap_or("24h"))?;
    let filter = format!("probe = {} && t >= {}", pb_quote(&id), pb_quote(&pb_date(Utc::now() - Duration::hours(hours))));
    let metric = q.metric.unwrap_or_default();
    let mut points = vec![];
    app.core.pb.each("probe_rollups", &filter, "t", "t,latency_ms,values", |r| {
        let v = if metric.is_empty() { r["latency_ms"].as_f64() } else { r["values"][&metric].as_f64() };
        points.extend(rollup_time(&r).zip(v).map(|(t, v)| json!({"t": t, "v": v})));
    }).await?;
    Ok(Json(json!(thin(points))))
}

async fn probes_changed(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    crate::probes::reload(&app).await?;
    Ok(Json(Value::Null))
}

fn check_setting(key: &str) -> ApiResult<()> {
    if SETTINGS.contains(&key) { Ok(()) } else { Err(ApiError::not_found()) }
}

async fn get_setting(_: Session, State(app): State<Arc<App>>, Path(key): Path<String>) -> ApiResult<Json<Value>> {
    check_setting(&key)?;
    let value = app.core.pb.setting(&key).await?;
    Ok(Json(match (value, key.as_str()) {
        (Some(v), _) => v,
        (None, "thresholds") => json!(crate::state::Thresholds::default()),
        (None, "maintenance") => json!(crate::state::Maintenance::default()),
        _ => json!({}),
    }))
}

async fn put_setting(_: Session, State(app): State<Arc<App>>, Path(key): Path<String>, Json(v): Json<Value>) -> ApiResult<Json<Value>> {
    check_setting(&key)?;
    app.core.pb.set_setting(&key, &v).await?;
    if key == "tempo" {
        app.lock().tempo = None; // New keys must be tried right away.
    }
    app.reload_settings().await?;
    if key == "maintenance" {
        ingest::refresh_beta_agents(&app).await.map_err(|e| ApiError::bad_request(format!("Saved, but the beta agents could not be fetched: {e:#}")))?;
    }
    Ok(Json(Value::Null))
}

/// Someone uses the monitor: agents report at full pace for a while, see `ingest::report`.
async fn viewed(State(app): State<Arc<App>>, req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    app.lock().viewed_until = Utc::now().timestamp() + crate::state::VIEW_S;
    next.run(req).await
}

async fn pipelines(_: Session, State(app): State<Arc<App>>) -> Json<Value> {
    Json(json!(crate::pipelines::snapshot(&app)))
}

/// After adding or editing a pipeline: ask the forges now instead of at the next round.
async fn pipelines_refresh(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    crate::pipelines::tick(&app).await?;
    Ok(Json(Value::Null))
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/api/overview", get(overview))
        .route("/api/map", get(map))
        .route("/api/hosts", get(hosts).post(add_host))
        .route("/api/hosts/update-all", post(update_all))
        .route("/api/hosts/{id}", get(host).patch(patch_host).delete(delete_host))
        .route("/api/hosts/{id}/install", get(install_line))
        .route("/api/hosts/{id}/command", post(command))
        .route("/api/hosts/{id}/logs/live", get(live_logs))
        .route("/api/series", get(series))
        .route("/api/containers", get(containers))
        .route("/api/storage", get(storage))
        .route("/api/logs", get(logs))
        .route("/api/probes", get(probes))
        .route("/api/probes/reload", post(probes_changed))
        .route("/api/probes/{id}/series", get(probe_series))
        .route("/api/pipelines", get(pipelines))
        .route("/api/pipelines/refresh", post(pipelines_refresh))
        .route("/api/settings/{key}", get(get_setting).put(put_setting))
        .route_layer(axum::middleware::from_fn_with_state(app.clone(), viewed))
        .with_state(app)
}

pub fn mcp_tools(app: Arc<App>) -> mcp::Tools {
    let empty = json!({"type": "object", "properties": {}});
    mcp::Tools {
        list: vec![
            ("infrastructure_status", "Overall health: hosts online, open alerts, containers, availability, average CPU and memory.", empty.clone()),
            ("list_hosts", "Every monitored host with status, address, CPU, memory, temperature, pending updates and whether it needs a restart.", empty.clone()),
            ("get_host", "Full details of one host, by name.", json!({"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]})),
            ("list_alerts", "Currently open alerts.", empty.clone()),
            ("list_probes", "Ping, HTTP, DNS, certificate and SNMP probes with their latest result and readings.", empty.clone()),
            ("list_pipelines", "CI/CD pipelines (GitHub, GitLab, Forgejo, Gitea) with the state of their latest run.", empty),
        ],
        call: Box::new(move |name, args| {
            let app = app.clone();
            Box::pin(async move {
                match name.as_str() {
                    "infrastructure_status" => Ok(overview_json(&app)),
                    "list_hosts" => Ok(json!(hosts_json(&app))),
                    "get_host" => {
                        let wanted = args["name"].as_str().unwrap_or_default();
                        let id = app.lock().hosts.values().find(|h| h.name == wanted || h.hostname == wanted).map(|h| h.id.clone());
                        id.and_then(|id| host_json(&app, &id)).ok_or_else(|| anyhow::anyhow!("no host named {wanted}"))
                    }
                    "list_alerts" => Ok(json!(app.core.pb.list("alerts", "open = true", "-created").await?.iter()
                        .map(|a| json!({"severity": a["severity"], "message": a["message"], "host": a["host"], "since": a["created"]})).collect::<Vec<_>>())),
                    "list_probes" => Ok(json!(crate::probes::snapshot(&app))),
                    "list_pipelines" => Ok(json!(crate::pipelines::snapshot(&app))),
                    other => anyhow::bail!("unknown tool {other}"),
                }
            })
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_address_is_a_url_and_nothing_a_shell_would_run() {
        let url = |u: &str| agent_url(Some(u), "http://default:8081").ok();
        assert_eq!(url(" https://monitor.example.org:8443/ ").as_deref(), Some("https://monitor.example.org:8443"));
        assert_eq!(url("http://[fd00::1]:8081").as_deref(), Some("http://[fd00::1]:8081"));
        assert_eq!(url("").as_deref(), Some("http://default:8081"));
        assert_eq!(agent_url(None, "http://default:8081").ok().as_deref(), Some("http://default:8081"));
        for bad in ["monitor.example.org", "ftp://host", "http://", "http://a;reboot", "http://$(id)", "http://a b", "http://a|sh", "http://a'b"] {
            assert!(url(bad).is_none(), "{bad}");
        }
    }
}

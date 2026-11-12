//! Agent-facing endpoints: signed reports, install script, binary downloads.

use crate::state::{evaluate, App, Host, IDLE_INTERVAL_S, REPORT_INTERVAL_S, UPDATE_INTERVAL_S};
use anyhow::Context;
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use nyx_proto::*;
use nyx_srv::{notify, random_hex, system, ApiError, ApiResult};
use serde_json::json;
use std::{collections::HashMap, sync::Arc, time::Duration};

const INSTALL_SH: &str = include_str!("../../../packaging/install.sh");
const CLOCK_SKEW_S: i64 = 300;
const AGENT_BINARIES: [&str; 2] = ["nyx-agent-linux-x86_64", "nyx-agent-linux-aarch64"];
const RELEASE_FILES: &str = "https://github.com/midnights-ra1n/nyx-stack/releases/download";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

fn header<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name)?.to_str().ok()
}

/// Check token, timestamp window and signature over `payload`. Returns the host id
/// and key.
fn authenticate(app: &App, h: &HeaderMap, payload: &[u8]) -> Result<(String, String), ApiError> {
    let denied = || ApiError::new(StatusCode::UNAUTHORIZED, "bad signature");
    let token = header(h, "x-nyx-token").ok_or_else(denied)?;
    let ts: u64 = header(h, "x-nyx-ts").and_then(|t| t.parse().ok()).ok_or_else(denied)?;
    let sig = header(h, "x-nyx-sig").ok_or_else(denied)?;
    if (Utc::now().timestamp() - ts as i64).abs() > CLOCK_SKEW_S {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "clock skew too large"));
    }
    let st = app.lock();
    let host = st.by_token.get(token).and_then(|id| st.hosts.get(id)).ok_or_else(denied)?;
    if !verify(&host.key, ts, payload, sig) {
        return Err(denied());
    }
    Ok((host.id.clone(), host.key.clone()))
}

async fn report(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> ApiResult<Json<Reply>> {
    let (id, _) = authenticate(&app, &headers, &body)?;
    let report: Report = serde_json::from_slice(&body).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let guests = report.guests.clone();
    let first = absorb(&app, &id, report).await?;
    if let Some(guests) = guests {
        watch_containers(&app, &id, &guests).await?;
    }
    let now = Utc::now().timestamp();
    let mut st = app.lock();
    let st_viewed = st.viewed_until;
    let h = st.hosts.get_mut(&id).ok_or_else(ApiError::not_found)?;
    let live_logs = h.watched_until > now;
    if !live_logs { h.tail.clear(); }
    let interval_s = if h.updating(now) {
        UPDATE_INTERVAL_S
    } else if live_logs || st_viewed > now {
        REPORT_INTERVAL_S
    } else {
        IDLE_INTERVAL_S
    };
    h.interval_s = interval_s;
    Ok(Json(Reply { interval_s, resync: first, commands: std::mem::take(&mut h.queue), live_logs }))
}

/// Takes a report into the live view, then brings alerts and the database in line.
/// Returns whether it is the first one since this monitor started.
async fn absorb(app: &App, id: &str, report: Report) -> ApiResult<bool> {
    let pending_updates = report.updates.as_ref().map(|u| (u.len(), u.iter().filter(|p| p.security).count()));
    let (applied, wanted, name, muted) = {
        let mut st = app.lock();
        let applied = st.apply(id, report, Utc::now().timestamp()).ok_or_else(ApiError::not_found)?;
        let th = st.thresholds;
        let h = st.hosts.get(id).ok_or_else(ApiError::not_found)?;
        let wanted = if h.muted { vec![] } else { evaluate(h, &th, &st.alerts) };
        (applied, wanted, h.name.clone(), h.muted)
    };
    if let Some(patch) = &applied.patch {
        app.core.pb.update("hosts", id, patch).await?;
    }
    app.reconcile(&format!("offline:{id}"), vec![]).await?;
    app.reconcile(&format!("host:{id}:"), wanted).await?;
    if let (true, false, Some((n, security))) = (applied.new_updates, muted, pending_updates) {
        notify::emit(&app.core, "update", "info", &format!("{name}: {n} updates available"), &format!("{security} security updates"), &name).await;
    }
    Ok(applied.first)
}

/// Log lines of a host someone is watching. Nothing here reaches the database.
async fn live_logs(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> ApiResult<Json<LiveReply>> {
    let (id, _) = authenticate(&app, &headers, &body)?;
    let logs: LiveLogs = serde_json::from_slice(&body).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let now = Utc::now().timestamp();
    let mut st = app.lock();
    let h = st.hosts.get_mut(&id).ok_or_else(ApiError::not_found)?;
    let live = h.watched_until > now;
    h.tail_seen = now;
    if live { h.tail.push(logs.lines); }
    Ok(Json(LiveReply { live }))
}

/// What to do for the containers of one Proxmox host, after a new list of its guests.
#[derive(Default)]
struct Watch {
    /// Hosts of containers that are gone or no longer watched.
    forget: Vec<String>,
    /// Hosts that are not tied to their container yet.
    link: Vec<(String, u32, String)>,
    create: Vec<Guest>,
    measure: Vec<(String, Guest)>,
}

/// The host of a container: by ID once it is tied to its node, by name until then, or
/// when that node was deleted before it took its containers along. A name alone must
/// not catch an unrelated host, so it has to be a container or a child.
fn is_host_of(h: &Host, parent: &str, g: &Guest) -> bool {
    if h.vmid != 0 && !h.parent.is_empty() {
        return h.parent == parent && h.vmid == g.vmid;
    }
    (h.parent == parent || h.is_container()) && (h.name == g.name || h.hostname == g.name)
}

fn plan_watch(hosts: &HashMap<String, Host>, parent: &Host, guests: &[Guest], now: i64) -> Watch {
    let mut plan = Watch::default();
    let watching = parent.kind == "proxmox" && parent.ct_autoinstall;
    let containers: Vec<&Guest> = guests.iter().filter(|g| g.kind == "lxc").collect();
    // An agent inside knows more than the node, for as long as it reports.
    let own_agent = |h: &Host| !h.agent_version.is_empty() && h.online(now);
    for h in hosts.values().filter(|h| h.parent == parent.id && h.vmid > 0) {
        let listed = containers.iter().any(|g| g.vmid == h.vmid);
        // An empty list can be Proxmox restarting, which is no reason to lose a history.
        let gone = if watching { !listed && !guests.is_empty() && !own_agent(h) } else { h.agent_version.is_empty() };
        if gone {
            plan.forget.push(h.id.clone());
        }
    }
    if !watching {
        return plan;
    }
    for g in containers {
        let Some(h) = hosts.values().find(|h| h.id != parent.id && is_host_of(h, &parent.id, g)) else {
            plan.create.push(g.clone());
            continue;
        };
        if h.vmid == 0 || h.parent != parent.id {
            plan.link.push((h.id.clone(), g.vmid, g.node.clone()));
        }
        if !own_agent(h) {
            plan.measure.push((h.id.clone(), g.clone()));
        }
    }
    plan
}

/// A report in the name of a container, from what its node measured. Running through
/// the same path as an agent's, it gets the same alerts, history and status.
fn container_report(g: Guest) -> Report {
    Report {
        kind: HostKind::Lxc,
        hostname: g.name,
        os: g.os,
        ip: g.ip,
        uptime_s: g.uptime_s,
        cpu_pct: g.cpu_pct,
        mem_used: g.mem_used,
        mem_total: g.mem_total,
        net_rx_bps: g.rx_bps,
        net_tx_bps: g.tx_bps,
        disks: vec![Disk { mount: "/".into(), used: g.disk_used, total: g.disk_total, ..Disk::default() }],
        ..Report::default()
    }
}

/// Keeps one host per watched container of a Proxmox host, fed by that host.
async fn watch_containers(app: &App, parent: &str, guests: &[Guest]) -> ApiResult<()> {
    if !app.settled() {
        return Ok(());
    }
    let mut plan = {
        let st = app.lock();
        let Some(p) = st.hosts.get(parent) else { return Ok(()) };
        plan_watch(&st.hosts, p, guests, Utc::now().timestamp())
    };
    for id in plan.forget {
        forget_host(app, &id).await?;
    }
    for (id, vmid, node) in plan.link {
        if let Some(h) = app.lock().hosts.get_mut(&id) {
            (h.parent, h.vmid, h.pve_node) = (parent.to_string(), vmid, node.clone());
        }
        app.core.pb.update("hosts", &id, &json!({"parent": parent, "vmid": vmid, "pve_node": node})).await?;
    }
    for g in plan.create {
        let (_, _, id) = create_host(app, &g.name, "lxc", parent, g.vmid, false, &g.node).await?;
        plan.measure.push((id, g));
    }
    // Older agents send no figures: nothing to show until they update.
    for (id, g) in plan.measure.into_iter().filter(|(_, g)| g.status == "running" && g.mem_total > 0) {
        absorb(app, &id, container_report(g)).await?;
    }
    Ok(())
}

/// Removes a host, its open alerts and its record. Its history ages out with the retention.
pub async fn forget_host(app: &App, id: &str) -> anyhow::Result<()> {
    {
        let mut st = app.lock();
        if let Some(h) = st.hosts.remove(id) {
            st.by_token.remove(&h.token);
        }
    }
    app.reconcile(&format!("offline:{id}"), vec![]).await?;
    app.reconcile(&format!("host:{id}:"), vec![]).await?;
    app.core.pb.delete("hosts", id).await
}

/// Create a host record and register it live. Returns `(token, key, id)`.
pub async fn create_host(app: &App, name: &str, kind: &str, parent: &str, vmid: u32, ct_autoinstall: bool, pve_node: &str) -> anyhow::Result<(String, String, String)> {
    let (token, key) = (random_hex(16), random_hex(32));
    let rec = app.core.pb.create("hosts", &json!({"name": name, "kind": kind, "token": token, "key": key, "parent": parent,
        "vmid": vmid, "ct_autoinstall": ct_autoinstall, "pve_node": pve_node})).await?;
    let host = Host::from_record(&rec);
    let id = host.id.clone();
    let mut st = app.lock();
    st.by_token.insert(token.clone(), id.clone());
    st.hosts.insert(id.clone(), host);
    Ok((token, key, id))
}

async fn install_script() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/x-shellscript; charset=utf-8")], INSTALL_SH)
}

/// Public so `install.sh` can fetch it. When the request is signed by an agent the
/// response is signed back, which is what `UpdateAgent` requires.
async fn binary(State(app): State<Arc<App>>, Path(name): Path<String>, headers: HeaderMap) -> Result<Response, ApiError> {
    if !AGENT_BINARIES.contains(&name.as_str()) {
        return Err(ApiError::not_found());
    }
    let path = format!("/agent/v1/binary/{name}");
    let signed = authenticate(&app, &headers, path.as_bytes());
    // A new install takes the bundled agent, and the next update moves it to beta.
    let beta = signed.as_ref().ok().and_then(|_| app.lock().beta().map(|v| beta_dir(&app).join(v).join(&name)));
    let file = beta.unwrap_or_else(|| format!("{}/{name}", app.agent_dir).into());
    let bytes = tokio::fs::read(file).await.map_err(|_| ApiError::not_found())?;
    let mut res = ([(header::CONTENT_TYPE, "application/octet-stream")], bytes.clone()).into_response();
    if let Ok((_, key)) = signed {
        let ts = Utc::now().timestamp() as u64;
        let sha = sha256_hex(&bytes);
        let sig = sign(&key, ts, sha.as_bytes());
        let h = res.headers_mut();
        h.insert("x-nyx-sha256", sha.parse().map_err(anyhow::Error::from)?);
        h.insert("x-nyx-ts", ts.to_string().parse().map_err(anyhow::Error::from)?);
        h.insert("x-nyx-sig", sig.parse().map_err(anyhow::Error::from)?);
    }
    Ok(res)
}

fn beta_dir(app: &App) -> std::path::PathBuf {
    app.core.env.data_dir.join("agents-beta")
}

/// The sum of `name` in a `SHA256SUMS` file.
fn checksum<'a>(sums: &'a str, name: &str) -> Option<&'a str> {
    sums.lines().find_map(|l| {
        let (sum, file) = l.split_once(char::is_whitespace)?;
        (file.trim_start_matches([' ', '*']) == name).then_some(sum)
    })
}

/// While beta agents are on, keeps the newest release's agents next to the database, as
/// the bundled ones cannot change. A stable release counts: it replaces its betas.
pub async fn refresh_beta_agents(app: &App) -> anyhow::Result<()> {
    if !app.lock().maintenance.agent_beta {
        return Ok(());
    }
    let tag = system::newest_release().await.context("cannot reach GitHub")?;
    if !system::is_newer(&tag, env!("CARGO_PKG_VERSION")) {
        app.lock().beta_agent = None;
        return Ok(());
    }
    let version = tag.trim_start_matches('v');
    let dir = beta_dir(app).join(version);
    if !dir.join(AGENT_BINARIES[1]).exists() {
        let get = |file: &str| app.http.get(format!("{RELEASE_FILES}/{tag}/{file}")).timeout(DOWNLOAD_TIMEOUT).send();
        let sums = get("SHA256SUMS").await?.error_for_status()?.text().await?;
        app.lock().beta_agent = None; // Agents take the bundled one until this is done.
        let _ = tokio::fs::remove_dir_all(beta_dir(app)).await;
        tokio::fs::create_dir_all(&dir).await?;
        for name in AGENT_BINARIES {
            let bytes = get(name).await?.error_for_status().with_context(|| format!("{tag} has no {name}"))?.bytes().await?;
            anyhow::ensure!(checksum(&sums, name) == Some(sha256_hex(&bytes).as_str()), "{name} does not match its checksum");
            tokio::fs::write(dir.join(name), &bytes).await?;
        }
    }
    app.lock().beta_agent = Some(version.to_string());
    Ok(())
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/agent/v1/report", post(report))
        .route("/agent/v1/logs", post(live_logs))
        .route("/agent/v1/binary/{name}", get(binary))
        .route("/install.sh", get(install_script))
        .with_state(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 100_000;

    fn host(id: &str, f: serde_json::Value) -> (String, Host) {
        let mut rec = json!({"id": id, "name": id, "token": id, "key": "k"});
        rec.as_object_mut().unwrap().extend(f.as_object().unwrap().clone());
        (id.to_string(), Host::from_record(&rec))
    }

    fn pve(watching: bool) -> Host {
        host("pve", json!({"kind": "proxmox", "ct_autoinstall": watching})).1
    }

    fn ct(vmid: u32, name: &str) -> Guest {
        Guest { vmid, name: name.into(), kind: "lxc".into(), status: "running".into(), node: "pve".into(), mem_total: 1024, ..Guest::default() }
    }

    fn fed(id: &str, vmid: u32) -> (String, Host) {
        host(id, json!({"kind": "lxc", "parent": "pve", "vmid": vmid, "name": id}))
    }

    fn with_agent((id, h): (String, Host), last_seen: i64) -> (String, Host) {
        (id, Host { agent_version: "0.1.0".into(), last_seen, ..h })
    }

    fn plan(hosts: Vec<(String, Host)>, watching: bool, guests: &[Guest]) -> Watch {
        plan_watch(&hosts.into_iter().collect(), &pve(watching), guests, NOW)
    }

    fn ids(list: &[(String, Guest)]) -> Vec<&str> {
        list.iter().map(|x| x.0.as_str()).collect()
    }

    #[test]
    fn an_unwatched_node_gets_no_container_hosts() {
        let p = plan(vec![], false, &[ct(101, "web")]);
        assert!(p.create.is_empty() && p.measure.is_empty());
    }

    #[test]
    fn unticking_forgets_watched_containers_but_keeps_real_agents() {
        let agent = with_agent(fed("legacy", 102), 0); // Silent: a stopped container is no reason to lose it.
        let p = plan(vec![fed("web", 101), agent], false, &[ct(101, "web"), ct(102, "legacy")]);
        assert_eq!(p.forget, ["web"]);
    }

    #[test]
    fn a_watched_container_is_created_once_then_measured() {
        let p = plan(vec![], true, &[ct(101, "web")]);
        assert_eq!(p.create.len(), 1);
        let p = plan(vec![fed("web", 101)], true, &[ct(101, "web")]);
        assert!(p.create.is_empty() && p.forget.is_empty());
        assert_eq!(ids(&p.measure), ["web"]);
    }

    #[test]
    fn an_agent_inside_wins_until_it_goes_quiet() {
        let live = plan(vec![with_agent(fed("web", 101), NOW - 5)], true, &[ct(101, "web")]);
        assert!(live.measure.is_empty() && live.create.is_empty());
        let quiet = plan(vec![with_agent(fed("web", 101), NOW - 3600)], true, &[ct(101, "web")]);
        assert_eq!(ids(&quiet.measure), ["web"]);
    }

    #[test]
    fn an_agent_installed_by_hand_is_no_second_host() {
        let hand = with_agent(host("c1", json!({"kind": "lxc", "hostname": "web"})), NOW);
        let p = plan(vec![hand], true, &[ct(101, "web")]);
        assert!(p.create.is_empty());
        assert_eq!(p.link, [("c1".to_string(), 101, "pve".to_string())]);
    }

    #[test]
    fn a_host_left_over_from_a_deleted_node_is_taken_back() {
        let orphan = host("web", json!({"kind": "vm", "vmid": 101}));
        let p = plan(vec![orphan], true, &[ct(201, "web")]);
        assert!(p.create.is_empty());
        assert_eq!(p.link, [("web".to_string(), 201, "pve".to_string())]);
    }

    #[test]
    fn a_vm_of_the_same_name_elsewhere_is_not_the_container() {
        let vm = with_agent(host("web", json!({"kind": "vm"})), NOW);
        assert_eq!(plan(vec![vm], true, &[ct(101, "web")]).create.len(), 1);
    }

    #[test]
    fn a_destroyed_container_goes_unless_its_agent_still_reports() {
        let guests = [ct(103, "other")];
        let p = plan(vec![fed("gone", 101), with_agent(fed("alive", 102), NOW), with_agent(fed("dead", 104), 0)], true, &guests);
        let mut forget = p.forget;
        forget.sort();
        assert_eq!(forget, ["dead", "gone"]);
    }

    #[test]
    fn an_empty_list_forgets_nothing() {
        assert!(plan(vec![fed("web", 101)], true, &[]).forget.is_empty());
    }

    #[test]
    fn a_vm_with_its_own_agent_is_left_alone() {
        let vm = with_agent(host("db", json!({"kind": "vm", "parent": "pve"})), NOW);
        let qemu = Guest { kind: "qemu".into(), ..ct(100, "db") };
        let p = plan(vec![vm], true, &[qemu]);
        assert!(p.forget.is_empty() && p.create.is_empty() && p.measure.is_empty() && p.link.is_empty());
    }

    #[test]
    fn a_container_reports_what_its_node_measured() {
        let r = container_report(Guest { disk_used: 10, disk_total: 100, cpu_pct: 12.0, rx_bps: 7, ..ct(101, "web") });
        assert_eq!((r.kind, r.hostname.as_str(), r.cpu_pct, r.net_rx_bps, r.agent_version.as_str()), (HostKind::Lxc, "web", 12.0, 7, ""));
        assert_eq!((r.disks[0].mount.as_str(), r.disks[0].used, r.disks[0].total), ("/", 10, 100));
    }

    #[test]
    fn sums_are_found_by_file_name() {
        let sums = "abc  nyx-agent-linux-x86_64\ndef *nyx-agent-linux-aarch64\n";
        assert_eq!(checksum(sums, "nyx-agent-linux-x86_64"), Some("abc"));
        assert_eq!(checksum(sums, "nyx-agent-linux-aarch64"), Some("def"));
        assert_eq!(checksum(sums, "other"), None);
    }
}

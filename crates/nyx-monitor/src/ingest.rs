//! Agent-facing endpoints: signed reports, install script, binary downloads.

use crate::state::{evaluate, App, Host, REPORT_INTERVAL_S, UPDATE_INTERVAL_S};
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
use nyx_srv::{notify, random_hex, ApiError, ApiResult};
use serde_json::json;
use std::sync::Arc;

const INSTALL_SH: &str = include_str!("../../../packaging/install.sh");
const CLOCK_SKEW_S: i64 = 300;
const AGENT_BINARIES: [&str; 2] = ["nyx-agent-linux-x86_64", "nyx-agent-linux-aarch64"];

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
    let pending_updates = report.updates.as_ref().map(|u| (u.len(), u.iter().filter(|p| p.security).count()));
    let guests = report.guests.clone();

    let (applied, wanted, name, commands, live_logs, interval_s) = {
        let mut st = app.lock();
        let now = Utc::now().timestamp();
        let applied = st.apply(&id, report, now).ok_or_else(ApiError::not_found)?;
        let th = st.thresholds;
        let wanted = evaluate(st.hosts.get(&id).ok_or_else(ApiError::not_found)?, &th, &st.alerts);
        let h = st.hosts.get_mut(&id).ok_or_else(ApiError::not_found)?;
        let live_logs = h.watched_until > now;
        if !live_logs { h.tail.clear(); }
        let interval_s = if h.updating(now) { UPDATE_INTERVAL_S } else { REPORT_INTERVAL_S };
        (applied, wanted, h.name.clone(), std::mem::take(&mut h.queue), live_logs, interval_s)
    };

    if let Some(patch) = &applied.patch {
        app.core.pb.update("hosts", &id, patch).await?;
    }
    app.reconcile(&format!("offline:{id}"), vec![]).await?;
    app.reconcile(&format!("host:{id}:"), wanted).await?;
    if let (true, Some((n, security))) = (applied.new_updates, pending_updates) {
        notify::emit(&app.core, "update", "info", &format!("{name}: {n} updates available"), &format!("{security} security updates"), &name).await;
    }
    if let Some(guests) = guests {
        adopt_containers(&app, &id, &guests).await?;
    }
    Ok(Json(Reply { interval_s, resync: applied.first, commands, live_logs }))
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

/// Create a child host and queue the install for each new running container of a
/// Proxmox host with auto-install enabled. OCI containers cannot run the agent.
async fn adopt_containers(app: &App, parent: &str, guests: &[Guest]) -> anyhow::Result<()> {
    let to_adopt: Vec<Guest> = {
        let st = app.lock();
        let Some(p) = st.hosts.get(parent).filter(|p| p.ct_autoinstall) else { return Ok(()) };
        guests
            .iter()
            .filter(|g| g.kind == "lxc" && g.status == "running" && !g.oci)
            .filter(|g| !st.hosts.values().any(|h| h.parent == p.id && h.vmid == g.vmid))
            .cloned()
            .collect()
    };
    for g in to_adopt {
        let host = create_host(app, &g.name, "vm", parent, g.vmid, false, &g.node).await?;
        app.enqueue(parent, Action::InstallInCt { vmid: g.vmid, token: host.0, key: host.1 });
    }
    Ok(())
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
    let bytes = tokio::fs::read(format!("{}/{name}", app.agent_dir)).await.map_err(|_| ApiError::not_found())?;
    let path = format!("/agent/v1/binary/{name}");
    let mut res = ([(header::CONTENT_TYPE, "application/octet-stream")], bytes.clone()).into_response();
    if let Ok((_, key)) = authenticate(&app, &headers, path.as_bytes()) {
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

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/agent/v1/report", post(report))
        .route("/agent/v1/logs", post(live_logs))
        .route("/agent/v1/binary/{name}", get(binary))
        .route("/install.sh", get(install_script))
        .with_state(app)
}

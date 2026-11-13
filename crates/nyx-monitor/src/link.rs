//! Optional link used by nyx-manager, authenticated with a bearer token.

use crate::{api, integrations, state::App};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use nyx_proto::{sha256_hex, Action, Deploy, SiteControl};
use nyx_srv::{auth::Session, random_hex, ApiError, ApiResult};
use serde_json::{json, Value};
use std::sync::Arc;

async fn authorize(app: &App, headers: &HeaderMap) -> ApiResult<()> {
    let denied = || ApiError::new(StatusCode::UNAUTHORIZED, "invalid link token");
    let given = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).ok_or_else(denied)?;
    let stored = app.core.pb.setting("link_token_hash").await?.ok_or_else(denied)?;
    if stored.as_str() == Some(sha256_hex(given.as_bytes()).as_str()) { Ok(()) } else { Err(denied()) }
}

async fn hosts(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    authorize(&app, &headers).await?;
    let list: Vec<Value> = api::hosts_json(&app)
        .into_iter()
        .map(|mut h| {
            let detail = h["id"].as_str().and_then(|id| api::host_json(&app, id));
            if let Some(d) = detail {
                h["guests"] = d["guests"].clone();
                h["node"] = d["node"].clone();
                h["containers"] = d["containers"].clone();
            }
            h
        })
        .collect();
    Ok(Json(json!(list)))
}

/// Fleet health for the manager's dashboard.
async fn overview(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    authorize(&app, &headers).await?;
    let mut v = api::overview_json(&app);
    v["storage"] = Value::Null; // the manager shows counts, not every mount point
    Ok(Json(v))
}

async fn tempo(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    authorize(&app, &headers).await?;
    integrations::tempo_now(&app).await.map(Json).map_err(|e| ApiError::bad_request(format!("{e:#}")))
}

async fn pipelines(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    authorize(&app, &headers).await?;
    Ok(Json(json!(crate::pipelines::snapshot(&app))))
}

async fn deploy(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>, Json(d): Json<Deploy>) -> ApiResult<Json<Value>> {
    authorize(&app, &headers).await?;
    let cmd = app.enqueue(&id, Action::Deploy(d)).ok_or_else(ApiError::not_found)?;
    Ok(Json(json!({"id": cmd})))
}

/// Restart, stop, start or read the logs of a Node.js site on a host.
async fn site(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>, Json(c): Json<SiteControl>) -> ApiResult<Json<Value>> {
    authorize(&app, &headers).await?;
    let cmd = app.enqueue(&id, Action::Site(c)).ok_or_else(ApiError::not_found)?;
    Ok(Json(json!({"id": cmd})))
}

async fn result(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    authorize(&app, &headers).await?;
    let st = app.lock();
    st.results.iter().find(|r| r["id"] == id).cloned().map(Json).ok_or_else(ApiError::not_found)
}

/// Shown once; only the hash is kept.
async fn new_token(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    let token = random_hex(32);
    app.core.pb.set_setting("link_token_hash", &sha256_hex(token.as_bytes()).into()).await?;
    Ok(Json(json!({"token": token})))
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/api/link/hosts", get(hosts))
        .route("/api/link/overview", get(overview))
        .route("/api/link/tempo", get(tempo))
        .route("/api/link/pipelines", get(pipelines))
        .route("/api/link/hosts/{id}/deploy", post(deploy))
        .route("/api/link/hosts/{id}/site", post(site))
        .route("/api/link/results/{id}", get(result))
        .route("/api/link/token", post(new_token))
        .with_state(app)
}

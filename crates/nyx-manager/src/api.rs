//! Browser-facing API, task reminders and MCP tools.

use crate::{ipam, link, map, nextcloud, App};
use axum::{
    extract::{Path, State},
    http::header,
    response::IntoResponse,
    routing::{get, patch, post},
    Json, Router,
};
use chrono::{Duration, Utc};
use nyx_srv::{auth::Session, mcp, notify, pb_date, pb_quote, ApiError, ApiResult};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const SETTINGS: [&str; 5] = ["link", "nextcloud", "proxmox", "updates", "reminders"];

/// Days from the `reminders` setting, kept above zero so a blank field keeps the default.
async fn lead_days(app: &App, key: &str, default: i64) -> anyhow::Result<i64> {
    Ok(app.core.pb.setting("reminders").await?.and_then(|s| s[key].as_i64()).filter(|d| *d > 0).unwrap_or(default))
}

async fn ipam_data(app: &App) -> anyhow::Result<(Vec<Value>, Vec<Value>, Vec<Value>)> {
    let pb = &app.core.pb;
    Ok((pb.list("subnets", "", "name").await?, pb.list("ip_addresses", "", "").await?, pb.list("routes", "", "").await?))
}

async fn ipam_report(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    let (subnets, addresses, _) = ipam_data(&app).await?;
    Ok(Json(ipam::report(&subnets, &addresses)))
}

async fn next_free(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (subnets, addresses, _) = ipam_data(&app).await?;
    let subnet = subnets.iter().find(|s| s["id"] == id.as_str()).ok_or_else(ApiError::not_found)?;
    Ok(Json(json!({"address": ipam::next_free(subnet, &addresses)})))
}

#[derive(Deserialize)]
struct Simulate {
    from: String,
    destination: String,
}

async fn simulate(_: Session, State(app): State<Arc<App>>, Json(b): Json<Simulate>) -> ApiResult<Json<Value>> {
    let dest = b.destination.trim().parse().map_err(|_| ApiError::bad_request("destination must be an IP address"))?;
    let (subnets, addresses, routes) = ipam_data(&app).await?;
    Ok(Json(ipam::simulate(&b.from, dest, &routes, &addresses, &subnets)))
}

async fn map_export(_: Session, State(app): State<Arc<App>>, Path(format): Path<String>) -> ApiResult<impl IntoResponse> {
    let nodes = app.core.pb.list("map_nodes", "", "").await?;
    let links = app.core.pb.list("map_links", "", "").await?;
    let (body, mime, ext) = map::export(&format, &nodes, &links).ok_or_else(ApiError::not_found)?;
    Ok(([(header::CONTENT_TYPE, mime.to_string()), (header::CONTENT_DISPOSITION, format!("attachment; filename=\"nyx-network.{ext}\""))], body))
}

/// Add monitored hosts to the map, linking guests to their parent.
async fn map_import(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    let hosts = link::hosts(&app).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?.ok_or_else(|| ApiError::bad_request("no monitor linked"))?;
    let pb = &app.core.pb;
    let mut known = pb.list("map_nodes", "", "").await?;
    let mut added = 0;
    for (i, h) in hosts.iter().enumerate() {
        if !known.iter().any(|n| n["name"] == h["name"]) {
            let (x, y) = (20 + (i % 5) * 180, 20 + (i / 5) * 120);
            known.push(pb.create("map_nodes", &json!({"name": h["name"], "ip": h["ip"], "type": h["kind"], "x": x, "y": y})).await?);
            added += 1;
        }
    }
    let id_of = |name: &Value| known.iter().find(|n| n["name"] == *name).and_then(|n| n["id"].as_str());
    let links = pb.list("map_links", "", "").await?;
    for h in hosts.iter().filter(|h| h["parent"].as_str().is_some_and(|p| !p.is_empty())) {
        let parent = hosts.iter().find(|p| p["id"] == h["parent"]);
        if let (Some(a), Some(b)) = (id_of(&h["name"]), parent.and_then(|p| id_of(&p["name"]))) {
            if !links.iter().any(|l| l["source"] == a && l["target"] == b) {
                pb.create("map_links", &json!({"source": a, "target": b})).await?;
            }
        }
    }
    Ok(Json(json!({"added": added})))
}

async fn overview(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    let pb = &app.core.pb;
    let count = |c: &'static str, f: &'static str| async move { pb.list_page(c, &[("filter", f), ("perPage", "1")]).await.map(|v| v["totalItems"].clone()) };
    let (subnets, addresses, _) = ipam_data(&app).await?;
    let report = ipam::report(&subnets, &addresses);
    let soon = pb_date(Utc::now() + Duration::days(7));
    let tasks = pb.list_page("tasks", &[("filter", &format!("done = false && due != '' && due <= {}", pb_quote(&soon))), ("sort", "due"), ("perPage", "6")]).await?;
    let deployments = pb.list_page("deployments", &[("sort", "-created"), ("perPage", "6")]).await?;
    let warranty = pb.list_page("hardware", &[("filter", &format!("warranty_until != '' && warranty_until <= {}", pb_quote(&pb_date(Utc::now() + Duration::days(lead_days(&app, "warranty_days", 60).await?))))), ("perPage", "6")]).await?;
    Ok(Json(json!({
        "hardware": count("hardware", "").await?, "virtual": count("virtual_assets", "").await?, "sites": count("sites", "").await?,
        "open_tasks": count("tasks", "done = false").await?,
        "subnets": report["subnets"], "conflicts": report["conflicts"], "tasks": tasks["items"], "deployments": deployments["items"], "warranty": warranty["items"],
        "linked": link::config(&app).await?.is_some(),
    })))
}

#[derive(Deserialize)]
struct TaskBody {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    due: String,
    #[serde(default)]
    done: bool,
}

/// Tasks skip the generic CRUD: every write must reach Nextcloud right away.
async fn tasks(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    let rows = app.core.pb.list("tasks", "", "done,due").await?;
    Ok(Json(json!(rows)))
}

async fn create_task(_: Session, State(app): State<Arc<App>>, Json(b): Json<TaskBody>) -> ApiResult<Json<Value>> {
    let rec = app.core.pb.create("tasks", &json!({"title": b.title, "description": b.description, "due": b.due, "done": b.done, "kind": "task"})).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    nextcloud::push_now(&app, &rec).await;
    Ok(Json(rec))
}

/// Calendar events are shown but owned by Nextcloud: writing one back would turn it into a task.
async fn writable_task(app: &App, id: &str) -> ApiResult<Value> {
    let task = nextcloud::find_task(app, id).await?.ok_or_else(ApiError::not_found)?;
    if task["kind"] == "event" {
        return Err(ApiError::bad_request("calendar events are edited in Nextcloud"));
    }
    Ok(task)
}

async fn update_task(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>, Json(b): Json<TaskBody>) -> ApiResult<Json<Value>> {
    writable_task(&app, &id).await?;
    let rec = app.core.pb.update("tasks", &id, &json!({"title": b.title, "description": b.description, "due": b.due, "done": b.done, "etag": ""})).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    nextcloud::push_now(&app, &rec).await;
    Ok(Json(rec))
}

async fn delete_task(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let task = writable_task(&app, &id).await?;
    nextcloud::delete_remote(&app, &task).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    app.core.pb.delete("tasks", &id).await?;
    Ok(Json(Value::Null))
}

async fn sync_now(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    nextcloud::sync(&app).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    link::sync(&app).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(Value::Null))
}

async fn monitor_hosts(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(link::hosts(&app).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?)))
}

async fn get_setting(_: Session, State(app): State<Arc<App>>, Path(key): Path<String>) -> ApiResult<Json<Value>> {
    if !SETTINGS.contains(&key.as_str()) {
        return Err(ApiError::not_found());
    }
    Ok(Json(app.core.pb.setting(&key).await?.unwrap_or(json!({}))))
}

async fn put_setting(_: Session, State(app): State<Arc<App>>, Path(key): Path<String>, Json(v): Json<Value>) -> ApiResult<Json<Value>> {
    if !SETTINGS.contains(&key.as_str()) {
        return Err(ApiError::not_found());
    }
    app.core.pb.set_setting(&key, &v).await?;
    Ok(Json(Value::Null))
}

/// One reminder ahead of time, for tasks and planned deployments.
pub async fn reminders(app: &App) -> anyhow::Result<()> {
    let pb = &app.core.pb;
    let now = pb_date(Utc::now());
    let soon = pb_quote(&pb_date(Utc::now() + Duration::days(lead_days(app, "task_days", 1).await?)));
    for t in pb.list("tasks", &format!("done = false && due != '' && due <= {soon} && reminded_at = ''"), "").await? {
        notify::emit(&app.core, "task", "info", &format!("Task due: {}", t["title"].as_str().unwrap_or_default()), t["due"].as_str().unwrap_or_default(), "").await;
        pb.update("tasks", t["id"].as_str().unwrap_or_default(), &json!({"reminded_at": now})).await?;
    }
    for d in pb.list("deployments", &format!("status = 'planned' && scheduled_at != '' && scheduled_at <= {soon} && reminded_at = ''"), "").await? {
        notify::emit(&app.core, "task", "info", &format!("Deployment planned: {}", d["name"].as_str().unwrap_or_default()), d["scheduled_at"].as_str().unwrap_or_default(), d["target"].as_str().unwrap_or_default()).await;
        pb.update("deployments", d["id"].as_str().unwrap_or_default(), &json!({"reminded_at": now})).await?;
    }
    Ok(())
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/api/overview", get(overview))
        .route("/api/ipam/report", get(ipam_report))
        .route("/api/ipam/next/{subnet}", get(next_free))
        .route("/api/ipam/simulate", post(simulate))
        .route("/api/map/export/{format}", get(map_export))
        .route("/api/map/import", post(map_import))
        .route("/api/tasks", get(tasks).post(create_task))
        .route("/api/tasks/{id}", patch(update_task).delete(delete_task))
        .route("/api/sync", post(sync_now))
        .route("/api/monitor/hosts", get(monitor_hosts))
        .route("/api/settings/{key}", get(get_setting).put(put_setting))
        .with_state(app)
}

pub fn mcp_tools(app: Arc<App>) -> mcp::Tools {
    let empty = json!({"type": "object", "properties": {}});
    mcp::Tools {
        list: vec![
            ("list_hardware", "Physical inventory: servers, network gear, warranty dates.", empty.clone()),
            ("list_virtual", "Virtual machines, containers and Docker services.", empty.clone()),
            ("ipam_report", "Subnet usage and addressing conflicts.", empty.clone()),
            ("list_deployments", "Recent and planned deployments.", empty.clone()),
            ("list_tasks", "Open tasks and upcoming events.", empty.clone()),
            ("trace_route", "Simulate the path from a device to an IP address.", json!({"type": "object", "properties": {"from": {"type": "string"}, "destination": {"type": "string"}}, "required": ["from", "destination"]})),
        ],
        call: Box::new(move |name, args| {
            let app = app.clone();
            Box::pin(async move {
                let pb = &app.core.pb;
                match name.as_str() {
                    "list_hardware" => Ok(json!(pb.list("hardware", "", "name").await?)),
                    "list_virtual" => Ok(json!(pb.list("virtual_assets", "", "name").await?)),
                    "ipam_report" => { let (s, a, _) = ipam_data(&app).await?; Ok(ipam::report(&s, &a)) }
                    "list_deployments" => Ok(pb.list_page("deployments", &[("sort", "-created"), ("perPage", "50")]).await?["items"].clone()),
                    "list_tasks" => Ok(json!(pb.list("tasks", "done = false", "due").await?)),
                    "trace_route" => {
                        let (s, a, r) = ipam_data(&app).await?;
                        let dest = args["destination"].as_str().unwrap_or_default().parse()?;
                        Ok(ipam::simulate(args["from"].as_str().unwrap_or_default(), dest, &r, &a, &s))
                    }
                    other => anyhow::bail!("unknown tool {other}"),
                }
            })
        }),
    }
}

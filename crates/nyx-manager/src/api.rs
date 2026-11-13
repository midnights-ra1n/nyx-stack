//! Browser-facing API, task reminders and MCP tools.

use crate::{ipam, link, map, nextcloud, App};
use axum::{
    extract::{Path, Query, State},
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

const SETTINGS: [&str; 6] = ["link", "nextcloud", "proxmox", "updates", "reminders", "dashboard"];

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

/// Addresses other records give inside a subnet that the IPAM does not list yet.
async fn seen_elsewhere(app: &App, recorded: &[Value]) -> anyhow::Result<Vec<Value>> {
    let pb = &app.core.pb;
    let mut out: Vec<Value> = vec![];
    for (coll, ip, name) in [("virtual_assets", "ip", "name"), ("map_nodes", "ip", "name")] {
        for r in pb.list(coll, &format!("{ip} != ''"), "").await? {
            let addr = r[ip].as_str().unwrap_or_default();
            if !recorded.iter().any(|a| a["address"] == addr) && !out.iter().any(|o| o["address"] == addr) {
                out.push(json!({"address": addr, "device": r[name], "from": coll}));
            }
        }
    }
    Ok(out)
}

async fn subnet_detail(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (subnets, addresses, _) = ipam_data(&app).await?;
    let subnet = subnets.iter().find(|s| s["id"] == id.as_str()).ok_or_else(ApiError::not_found)?;
    let mut d = ipam::detail(subnet, &subnets, &addresses).ok_or_else(|| ApiError::bad_request("invalid CIDR"))?;
    let net: ipnet::IpNet = subnet["cidr"].as_str().unwrap_or_default().parse().map_err(|_| ApiError::bad_request("invalid CIDR"))?;
    let seen = seen_elsewhere(&app, &addresses).await?;
    d["seen"] = seen.into_iter().filter(|r| r["address"].as_str().and_then(|a| a.parse::<std::net::IpAddr>().ok()).is_some_and(|ip| net.contains(&ip))).collect();
    Ok(Json(d))
}

#[derive(Deserialize)]
struct CalcQuery {
    cidr: String,
}

/// Subnet calculator for any prefix, recorded or not.
async fn calc(_: Session, Query(q): Query<CalcQuery>) -> ApiResult<Json<Value>> {
    let d = ipam::detail(&json!({"cidr": q.cidr.trim()}), &[], &[]).ok_or_else(|| ApiError::bad_request("not a prefix: write it like 192.168.1.0/24"))?;
    Ok(Json(d["calc"].clone()))
}

/// Pings every address of a small IPv4 subnet once. Answers stamp `last_seen` on the
/// addresses already recorded; the others are returned for the user to add.
async fn scan(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (subnets, addresses, _) = ipam_data(&app).await?;
    let subnet = subnets.iter().find(|s| s["id"] == id.as_str()).ok_or_else(ApiError::not_found)?;
    let targets = ipam::scan_targets(subnet).map_err(ApiError::bad_request)?;
    let client = surge_ping::Client::new(&surge_ping::Config::default())
        .map_err(|e| ApiError::bad_request(format!("ICMP socket unavailable ({e}), see the deployment docs")))?;
    let mut set = tokio::task::JoinSet::new();
    for (i, ip) in targets.into_iter().enumerate() {
        let client = client.clone();
        set.spawn(async move {
            let mut pinger = client.pinger(ip, surge_ping::PingIdentifier(i as u16)).await;
            pinger.timeout(std::time::Duration::from_millis(1500));
            pinger.ping(surge_ping::PingSequence(0), &[0; 16]).await.ok().map(|_| ip)
        });
    }
    let mut alive: Vec<std::net::IpAddr> = set.join_all().await.into_iter().flatten().collect();
    alive.sort();
    let now = pb_date(Utc::now());
    for r in addresses.iter().filter(|r| r["address"].as_str().and_then(|a| a.parse().ok()).is_some_and(|ip| alive.contains(&ip))) {
        app.core.pb.update("ip_addresses", r["id"].as_str().unwrap_or_default(), &json!({"last_seen": now})).await?;
    }
    Ok(Json(json!({"alive": alive, "at": now})))
}

/// Fleet health, EDF Tempo or CI/CD pipelines from the linked monitor, `null` without a link.
async fn from_monitor(_: Session, State(app): State<Arc<App>>, Path(what): Path<String>) -> ApiResult<Json<Value>> {
    if !["overview", "tempo", "pipelines"].contains(&what.as_str()) {
        return Err(ApiError::not_found());
    }
    Ok(Json(link::get(&app, &what).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?.unwrap_or(Value::Null)))
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
    let links = map::with_vpn(&nodes, &app.core.pb.list("map_links", "", "").await?, &app.core.pb.list("vpn_links", "", "").await?);
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
    let mut categories: std::collections::BTreeMap<String, (u64, u64)> = Default::default();
    for h in pb.list("hardware", "", "").await? {
        let c = categories.entry(h["category"].as_str().filter(|c| !c.is_empty()).unwrap_or("Other").to_string()).or_default();
        c.0 += 1;
        c.1 += u64::from(h["status"] == "In service" || h["status"].as_str().is_none_or(str::is_empty));
    }
    Ok(Json(json!({
        "categories": categories.into_iter().map(|(name, (total, active))| json!({"name": name, "total": total, "in_service": active})).collect::<Vec<_>>(),
        "addresses": addresses.len(), "vlans": count("vlans", "").await?, "running_deploys": count("deployments", "status = 'running'").await?,
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
    /// `todo`, `doing`, `done` or `cancelled`. Without it, `done` decides.
    #[serde(default)]
    status: String,
    /// Comma separated, as iCalendar categories are.
    #[serde(default)]
    tags: String,
}

impl TaskBody {
    /// The fields of a task, with `done` following its state: a cancelled task needs no reminder.
    fn fields(&self) -> ApiResult<Value> {
        let status = match self.status.as_str() {
            "" if self.done => "done",
            "" => "todo",
            s @ ("todo" | "doing" | "done" | "cancelled") => s,
            _ => return Err(ApiError::bad_request("unknown task state")),
        };
        let tags = self.tags.split(',').map(str::trim).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(",");
        Ok(json!({"title": self.title, "description": self.description, "due": self.due, "done": matches!(status, "done" | "cancelled"), "status": status, "tags": tags}))
    }
}

/// Tasks skip the generic CRUD: every write must reach Nextcloud right away.
async fn tasks(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    let rows = app.core.pb.list("tasks", "", "done,due").await?;
    Ok(Json(json!(rows)))
}

async fn create_task(_: Session, State(app): State<Arc<App>>, Json(b): Json<TaskBody>) -> ApiResult<Json<Value>> {
    let mut body = b.fields()?;
    body["kind"] = "task".into();
    let rec = app.core.pb.create("tasks", &body).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
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
    let mut body = b.fields()?;
    body["etag"] = "".into();
    let rec = app.core.pb.update("tasks", &id, &body).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
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
        .route("/api/ipam/subnet/{id}", get(subnet_detail))
        .route("/api/ipam/scan/{id}", post(scan))
        .route("/api/ipam/calc", get(calc))
        .route("/api/monitor/{what}", get(from_monitor))
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
            ("list_vpn_links", "VPN links between sites and devices.", empty.clone()),
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
                    "list_vpn_links" => Ok(json!(pb.list("vpn_links", "", "name").await?)),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn body(status: &str, done: bool, tags: &str) -> TaskBody {
        TaskBody { title: "t".into(), description: String::new(), due: String::new(), done, status: status.into(), tags: tags.into() }
    }

    #[test]
    fn a_task_state_decides_whether_it_is_closed() {
        for (status, done, closed, kept) in [("doing", false, false, "doing"), ("done", false, true, "done"), ("cancelled", false, true, "cancelled"), ("", true, true, "done"), ("", false, false, "todo")] {
            let f = body(status, done, "").fields().ok().unwrap();
            assert_eq!((f["done"].as_bool(), f["status"].as_str()), (Some(closed), Some(kept)));
        }
        assert!(body("nonsense", false, "").fields().is_err());
    }

    #[test]
    fn tags_are_tidied() {
        assert_eq!(body("", false, " web, ,urgent ").fields().ok().unwrap()["tags"], "web,urgent");
    }
}

//! Generic, allow-listed proxy to PocketBase collections, so inventory-style
//! pages need no bespoke endpoints.

use crate::{auth::Session, ApiError, ApiResult, Core};
use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use serde_json::{Map, Value};
use std::{collections::HashMap, sync::Arc};

pub struct Spec {
    pub name: &'static str,
    /// Never returned to the browser and never writable from it.
    pub hidden: &'static [&'static str],
    /// Keep a history of the changes made from the web interface, shown on the record's page.
    pub history: bool,
}

fn spec(core: &Core, name: &str) -> ApiResult<&'static Spec> {
    core.crud.iter().find(|s| s.name == name).ok_or_else(ApiError::not_found)
}

fn strip(mut v: Value, s: &Spec) -> Value {
    if let Some(o) = v.as_object_mut() {
        s.hidden.iter().for_each(|f| drop(o.remove(*f)));
        o.remove("collectionId");
        o.remove("collectionName");
    }
    v
}

fn writable(body: Map<String, Value>, s: &Spec) -> Value {
    Value::Object(body.into_iter().filter(|(k, _)| !s.hidden.contains(&k.as_str())).collect())
}

/// Fields set on the request that the save actually changed, with their values before and after.
fn diff(old: &Value, new: &Value, keys: &[String]) -> Vec<Value> {
    // Notes can be long; the history only needs to show what moved.
    let short = |v: &Value| match v.as_str() {
        Some(t) if t.chars().count() > 200 => Value::String(t.chars().take(200).chain("…".chars()).collect()),
        _ => v.clone(),
    };
    keys.iter().filter(|k| old[k.as_str()] != new[k.as_str()]).map(|k| serde_json::json!({"field": k, "from": short(&old[k.as_str()]), "to": short(&new[k.as_str()])})).collect()
}

fn title(v: &Value) -> &str {
    ["name", "title", "address"].iter().find_map(|k| v[*k].as_str().filter(|t| !t.is_empty())).unwrap_or_default()
}

/// One line of history. Written only when a person saves, so it adds no background disk writes.
async fn record(core: &Core, s: &Spec, rec: &Value, action: &str, changes: Vec<Value>) {
    if !s.history {
        return;
    }
    let row = serde_json::json!({"coll": s.name, "record": rec["id"], "name": title(rec), "action": action, "changes": changes});
    if let Err(e) = core.pb.create("history", &row).await {
        eprintln!("cannot record history of {}: {e:#}", s.name);
    }
}

async fn list(_: Session, State(core): State<Arc<Core>>, Path(coll): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let s = spec(&core, &coll)?;
    let pick = |k: &str, d: &'static str| q.get(k).map_or(d, String::as_str);
    let res = core
        .pb
        .list_page(s.name, &[("filter", pick("filter", "")), ("sort", pick("sort", "")), ("page", pick("page", "1")), ("perPage", pick("perPage", "200"))])
        .await
        .map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    let items: Vec<Value> = res["items"].as_array().cloned().unwrap_or_default().into_iter().map(|v| strip(v, s)).collect();
    Ok(Json(serde_json::json!({"items": items, "totalItems": res["totalItems"]})))
}

async fn create(_: Session, State(core): State<Arc<Core>>, Path(coll): Path<String>, Json(body): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let s = spec(&core, &coll)?;
    let rec = core.pb.create(s.name, &writable(body, s)).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    record(&core, s, &rec, "create", vec![]).await;
    Ok(Json(strip(rec, s)))
}

async fn one(_: Session, State(core): State<Arc<Core>>, Path((coll, id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let s = spec(&core, &coll)?;
    let rec = core.pb.get(s.name, &id).await.map_err(|_| ApiError::not_found())?;
    Ok(Json(strip(rec, s)))
}

async fn update(_: Session, State(core): State<Arc<Core>>, Path((coll, id)): Path<(String, String)>, Json(body): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let s = spec(&core, &coll)?;
    let body = writable(body, s);
    let old = if s.history { core.pb.get(s.name, &id).await.map_err(|_| ApiError::not_found())? } else { Value::Null };
    let rec = core.pb.update(s.name, &id, &body).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    let keys: Vec<String> = body.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    let changes = diff(&old, &rec, &keys);
    if !changes.is_empty() {
        record(&core, s, &rec, "update", changes).await;
    }
    Ok(Json(strip(rec, s)))
}

async fn remove(_: Session, State(core): State<Arc<Core>>, Path((coll, id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let s = spec(&core, &coll)?;
    core.pb.delete(s.name, &id).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(Value::Null))
}

/// Changes of one record, newest first.
async fn history(_: Session, State(core): State<Arc<Core>>, Path((coll, id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let s = spec(&core, &coll)?;
    if !s.history || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ApiError::not_found());
    }
    let filter = format!("coll = {} && record = {}", crate::pb_quote(s.name), crate::pb_quote(&id));
    let res = core.pb.list_page("history", &[("filter", &filter), ("sort", "-created"), ("perPage", "200")]).await?;
    Ok(Json(res["items"].clone()))
}

pub fn router() -> Router<Arc<Core>> {
    Router::new().route("/api/c/{coll}", get(list).post(create)).route("/api/c/{coll}/{id}", get(one).patch(update).delete(remove)).route("/api/c/{coll}/{id}/history", get(history))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hidden_fields_never_cross_the_boundary() {
        let s = Spec { name: "hosts", hidden: &["key"], history: false };
        assert_eq!(strip(json!({"id": "1", "key": "secret", "collectionId": "x"}), &s), json!({"id": "1"}));
        let Value::Object(body) = json!({"name": "a", "key": "attack"}) else { unreachable!() };
        assert_eq!(writable(body, &s), json!({"name": "a"}));
    }

    #[test]
    fn history_keeps_only_what_the_save_changed() {
        let keys = ["name".to_string(), "status".to_string(), "notes".to_string()];
        let long = "x".repeat(300);
        let old = json!({"name": "nas", "status": "Spare", "notes": "", "updated": "a"});
        let new = json!({"name": "nas", "status": "In service", "notes": long, "updated": "b"});
        let d = diff(&old, &new, &keys);
        assert_eq!(d.len(), 2, "unchanged and unsent fields stay out: {d:?}");
        assert_eq!(d[0], json!({"field": "status", "from": "Spare", "to": "In service"}));
        assert_eq!(d[1]["to"].as_str().unwrap().chars().count(), 201);
        assert!(diff(&old, &old, &keys).is_empty());
    }
}

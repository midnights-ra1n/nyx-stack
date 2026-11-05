//! Generic, allow-listed proxy to PocketBase collections, so inventory-style
//! pages need no bespoke endpoints.

use crate::{auth::Session, ApiError, ApiResult, Core};
use axum::{
    extract::{Path, Query, State},
    routing::{get, patch},
    Json, Router,
};
use serde_json::{Map, Value};
use std::{collections::HashMap, sync::Arc};

pub struct Spec {
    pub name: &'static str,
    /// Never returned to the browser and never writable from it.
    pub hidden: &'static [&'static str],
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
    Ok(Json(strip(rec, s)))
}

async fn update(_: Session, State(core): State<Arc<Core>>, Path((coll, id)): Path<(String, String)>, Json(body): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let s = spec(&core, &coll)?;
    let rec = core.pb.update(s.name, &id, &writable(body, s)).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(strip(rec, s)))
}

async fn remove(_: Session, State(core): State<Arc<Core>>, Path((coll, id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let s = spec(&core, &coll)?;
    core.pb.delete(s.name, &id).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(Value::Null))
}

pub fn router() -> Router<Arc<Core>> {
    Router::new().route("/api/c/{coll}", get(list).post(create)).route("/api/c/{coll}/{id}", patch(update).delete(remove))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hidden_fields_never_cross_the_boundary() {
        let s = Spec { name: "hosts", hidden: &["key"] };
        assert_eq!(strip(json!({"id": "1", "key": "secret", "collectionId": "x"}), &s), json!({"id": "1"}));
        let Value::Object(body) = json!({"name": "a", "key": "attack"}) else { unreachable!() };
        assert_eq!(writable(body, &s), json!({"name": "a"}));
    }
}

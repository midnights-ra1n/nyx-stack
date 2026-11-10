//! Full backup and restore: every record of every collection, ids included, so that a
//! reinstalled server finds its hosts, agent tokens and keys, probes, integrations and
//! notification channels again, and agents reconnect without being touched.
//!
//! Accounts are left out: PocketBase never hands out password hashes. A restore is
//! therefore part of creating the first account, see [`crate::auth`].

use crate::{auth::Session, pb_date, ApiError, ApiResult, Core, Pb};
use axum::{
    extract::{Query, State},
    http::header,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const FORMAT: u64 = 1;
/// Short-lived claims, worthless on another install.
const SKIP_COLLECTIONS: &[&str] = &["notif_claims"];
/// The new install keeps its own: replacing it would sign the restorer out.
const SKIP_SETTINGS: &[&str] = &["session_secret"];
/// Metrics history: optional, as it makes most of the file.
const HISTORY: &[&str] = &["rollups", "probe_rollups", "power_samples", "notif_events"];

/// Every collection that holds Nyx data, system and auth ones excluded.
async fn collections(pb: &Pb) -> anyhow::Result<Vec<String>> {
    let res = pb.req(Method::GET, "/api/collections", &[("perPage", "500"), ("skipTotal", "1")], None).await?;
    let items = res["items"].as_array().into_iter().flatten();
    let base = items.filter(|c| c["type"] == "base" && c["system"] != true);
    Ok(base.filter_map(|c| c["name"].as_str()).filter(|n| !SKIP_COLLECTIONS.contains(n)).map(String::from).collect())
}

fn kept(coll: &str, r: &Value) -> bool {
    coll != "settings" || !r["key"].as_str().is_some_and(|k| SKIP_SETTINGS.contains(&k))
}

#[derive(Deserialize)]
struct ExportQuery {
    #[serde(default)]
    history: bool,
}

/// Written page by page into one buffer, so memory holds the file once and never
/// the whole history as JSON values.
async fn export(_: Session, State(core): State<Arc<Core>>, Query(q): Query<ExportQuery>) -> ApiResult<Response> {
    let now = chrono::Utc::now();
    let mut buf = serde_json::to_vec(&json!({"format": FORMAT, "version": env!("CARGO_PKG_VERSION"), "created": pb_date(now)}))?;
    buf.pop(); // reopen the object for "collections"
    buf.extend(br#","collections":{"#);
    let names = collections(&core.pb).await?;
    for (i, name) in names.iter().filter(|n| q.history || !HISTORY.contains(&n.as_str())).enumerate() {
        if i > 0 {
            buf.push(b',');
        }
        serde_json::to_writer(&mut buf, name)?;
        buf.extend(b":[");
        let mut first = true;
        let mut failed = None;
        core.pb
            .each(name, "", "", "*", |mut r| {
                if !kept(name, &r) {
                    return;
                }
                if let Some(o) = r.as_object_mut() {
                    o.remove("collectionId");
                    o.remove("collectionName");
                }
                if !std::mem::take(&mut first) {
                    buf.push(b',');
                }
                if let Err(e) = serde_json::to_writer(&mut buf, &r) {
                    failed = Some(e);
                }
            })
            .await?;
        if let Some(e) = failed {
            return Err(e.into());
        }
        buf.push(b']');
    }
    buf.extend(b"}}");
    let file = format!("attachment; filename=\"nyx-backup-{}.json\"", now.format("%Y%m%d-%H%M"));
    Ok(([(header::CONTENT_TYPE, "application/json".to_string()), (header::CONTENT_DISPOSITION, file)], buf).into_response())
}

/// Writes a backup into this database. Records keep their ids and are upserted, so a
/// restore that failed half way can simply be run again.
pub async fn restore(pb: &Pb, backup: &Value) -> ApiResult<()> {
    let invalid = || ApiError::bad_request("This file is not a Nyx backup.");
    if backup["format"].as_u64() != Some(FORMAT) {
        return Err(invalid());
    }
    let colls = backup["collections"].as_object().ok_or_else(invalid)?;
    let known = collections(pb).await?;
    let failed = |e: anyhow::Error| ApiError::bad_request(format!("Restore failed: {e:#}"));
    for (name, rows) in colls {
        // Made by a newer version: nothing here could use it.
        if !known.contains(name) {
            continue;
        }
        let rows = rows.as_array().ok_or_else(invalid)?;
        if rows.iter().any(|r| !r["id"].is_string()) {
            return Err(invalid());
        }
        if name == "settings" {
            // Keyed: the new install already wrote some of them under other ids.
            for r in rows.iter().filter(|r| kept(name, r)) {
                pb.set_setting(r["key"].as_str().ok_or_else(invalid)?, &r["value"]).await.map_err(failed)?;
            }
            continue;
        }
        let url = format!("/api/collections/{name}/records");
        pb.batch(rows.iter().map(|r| json!({"method": "PUT", "url": url, "body": r})).collect()).await.map_err(failed)?;
    }
    Ok(())
}

/// Passkeys restored from a backup belonged to an account that no longer exists.
pub async fn adopt_passkeys(pb: &Pb, uid: &str) -> anyhow::Result<()> {
    let keys = pb.list("passkeys", "", "").await?;
    let reqs = keys.iter().map(|r| {
        json!({"method": "PATCH", "url": format!("/api/collections/passkeys/records/{}", r["id"].as_str().unwrap_or_default()), "body": {"user": uid}})
    });
    pb.batch(reqs.collect()).await
}

pub fn router() -> Router<Arc<Core>> {
    Router::new().route("/api/backup", get(export))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_secret_stays_with_the_install() {
        assert!(!kept("settings", &json!({"key": "session_secret"})));
        assert!(kept("settings", &json!({"key": "meross"})));
        assert!(kept("hosts", &json!({"key": "session_secret"})), "only settings are keyed");
    }
}

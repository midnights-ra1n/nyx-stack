//! External services: RTE Tempo calendar and Meross smart plugs (local network).

use crate::state::App;
use anyhow::Context;
use axum::{extract::State, routing::get, Json, Router};
use chrono::{Datelike, Days, FixedOffset, NaiveDate, Utc};
use md5::{Digest, Md5};
use nyx_srv::{auth::Session, random_hex, ApiError, ApiResult};
use serde_json::{json, Value};
use std::{sync::Arc, time::{Duration, Instant}};

const RTE: &str = "https://digital.iservices.rte-france.com";
/// Quotas of a Tempo season (1 September to 31 August).
const QUOTAS: [(&str, i64); 3] = [("BLUE", 300), ("WHITE", 43), ("RED", 22)];
/// RTE publishes tomorrow around 11:00 and rate-limits; a refresh per hour is plenty.
const TEMPO_TTL: Duration = Duration::from_secs(3600);

fn season_start(today: NaiveDate) -> NaiveDate {
    let year = if today.month() >= 9 { today.year() } else { today.year() - 1 };
    NaiveDate::from_ymd_opt(year, 9, 1).expect("valid date")
}

/// Reduce the RTE calendar to today, tomorrow and days left per colour. Days are
/// taken from `start_date` so a timezone offset cannot shift them.
pub fn summarize(calendar: &Value, today: NaiveDate) -> Value {
    let days: Vec<(NaiveDate, &str)> = calendar["tempo_like_calendars"]["values"]
        .as_array()
        .map_or(vec![], |a| {
            a.iter()
                .filter_map(|v| Some((NaiveDate::parse_from_str(v["start_date"].as_str()?.get(..10)?, "%Y-%m-%d").ok()?, v["value"].as_str()?)))
                .collect()
        });
    let colour = |d: Option<NaiveDate>| d.and_then(|d| days.iter().find(|x| x.0 == d)).map(|x| x.1);
    let start = season_start(today);
    let remaining: Value = QUOTAS
        .iter()
        .map(|(c, quota)| (c.to_lowercase(), json!(quota - days.iter().filter(|d| d.0 >= start && d.1 == *c).count() as i64)))
        .collect::<serde_json::Map<_, _>>()
        .into();
    json!({"today": colour(Some(today)), "tomorrow": colour(today.succ_opt()), "remaining": remaining})
}

fn paris_midnight(d: NaiveDate) -> String {
    // RTE wants an explicit offset; the day boundary, not the exact DST offset, matters.
    format!("{d}T00:00:00+01:00")
}

async fn fetch_tempo(app: &App, cfg: &Value) -> anyhow::Result<Value> {
    let (id, secret) = (cfg["client_id"].as_str().context("client_id")?, cfg["client_secret"].as_str().context("client_secret")?);
    let token: Value = app.http.post(format!("{RTE}/token/oauth/")).basic_auth(id, Some(secret)).send().await?.error_for_status()?.json().await?;
    let today = Utc::now().with_timezone(&FixedOffset::east_opt(3600).expect("offset")).date_naive();
    let end = today.checked_add_days(Days::new(2)).context("date")?;
    let cal: Value = app
        .http
        .get(format!("{RTE}/open_api/tempo_like_supply_contract/v1/tempo_like_calendars"))
        .bearer_auth(token["access_token"].as_str().context("no access token")?)
        .header("accept", "application/json")
        .query(&[("start_date", paris_midnight(season_start(today))), ("end_date", paris_midnight(end))])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(summarize(&cal, today))
}

async fn tempo(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    if let Some((at, v)) = app.tempo_cache.lock().unwrap().as_ref() {
        if at.elapsed() < TEMPO_TTL {
            return Ok(Json(v.clone()));
        }
    }
    let Some(cfg) = app.core.pb.setting("tempo").await?.filter(|c| c["client_id"].is_string()) else {
        return Ok(Json(json!({"configured": false})));
    };
    let mut v = fetch_tempo(&app, &cfg).await.map_err(|e| ApiError::bad_request(format!("RTE: {e:#}")))?;
    v["configured"] = true.into();
    *app.tempo_cache.lock().unwrap() = Some((Instant::now(), v.clone()));
    Ok(Json(v))
}

/// Meross signs local requests with md5(messageId + key + timestamp).
fn meross_request(key: &str, message_id: &str, ts: i64) -> Value {
    let sign = nyx_proto::hex(&Md5::digest(format!("{message_id}{key}{ts}")));
    json!({
        "header": {"from": "/nyx", "messageId": message_id, "method": "GET", "namespace": "Appliance.Control.Electricity",
            "payloadVersion": 1, "sign": sign, "timestamp": ts},
        "payload": {"electricity": {"channel": 0}},
    })
}

/// The plug reports milliwatts.
fn watts(reply: &Value) -> Option<f64> {
    Some(reply["payload"]["electricity"]["power"].as_f64()? / 1000.0)
}

/// Local HTTP only, so readings never leave the LAN.
pub async fn poll_power(app: &App) -> anyhow::Result<()> {
    let Some(cfg) = app.core.pb.setting("meross").await? else { return Ok(()) };
    let key = cfg["key"].as_str().unwrap_or_default();
    let mut readings = vec![];
    for plug in cfg["plugs"].as_array().into_iter().flatten() {
        let (name, ip) = (plug["name"].as_str().unwrap_or("plug"), plug["ip"].as_str().unwrap_or_default());
        let body = meross_request(key, &random_hex(16), Utc::now().timestamp());
        let res = app.http.post(format!("http://{ip}/config")).json(&body).timeout(Duration::from_secs(5)).send().await;
        match res {
            Ok(r) => match r.json::<Value>().await.ok().as_ref().and_then(watts) {
                Some(w) => readings.push((name.to_string(), w)),
                None => eprintln!("meross {name}: unexpected reply"),
            },
            Err(e) => eprintln!("meross {name}: {e}"),
        }
    }
    let mut st = app.lock();
    st.power = readings.into_iter().collect();
    Ok(())
}

async fn power(_: Session, State(app): State<Arc<App>>) -> Json<Value> {
    let st = app.lock();
    let mut plugs: Vec<Value> = st.power.iter().map(|(n, w)| json!({"name": n, "watts": w})).collect();
    plugs.sort_by_key(|p| p["name"].as_str().unwrap_or_default().to_string());
    Json(json!({"plugs": plugs, "total": st.power.values().sum::<f64>()}))
}

pub fn router(app: Arc<App>) -> Router {
    Router::new().route("/api/integrations/tempo", get(tempo)).route("/api/integrations/power", get(power)).with_state(app)
}


#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn tempo_summary_counts_the_current_season_only() {
        let cal = json!({"tempo_like_calendars": {"values": [
            {"start_date": "2026-11-06T00:00:00+01:00", "value": "RED"},
            {"start_date": "2026-11-05T00:00:00+01:00", "value": "WHITE"},
            {"start_date": "2026-09-01T00:00:00+02:00", "value": "BLUE"},
            {"start_date": "2026-08-31T00:00:00+02:00", "value": "RED"},
        ]}});
        let s = summarize(&cal, d("2026-11-05"));
        assert_eq!((s["today"].as_str(), s["tomorrow"].as_str()), (Some("WHITE"), Some("RED")));
        assert_eq!((s["remaining"]["blue"].as_i64(), s["remaining"]["white"].as_i64(), s["remaining"]["red"].as_i64()), (Some(299), Some(42), Some(21)));
    }

    #[test]
    fn tomorrow_unknown_until_published() {
        let cal = json!({"tempo_like_calendars": {"values": [{"start_date": "2026-11-05T00:00:00+01:00", "value": "BLUE"}]}});
        assert!(summarize(&cal, d("2026-11-05"))["tomorrow"].is_null());
    }

    #[test]
    fn season_rolls_over_in_september() {
        assert_eq!(season_start(d("2026-08-31")), d("2025-09-01"));
        assert_eq!(season_start(d("2026-09-01")), d("2026-09-01"));
    }

    #[test]
    fn meross_signature_and_power_units() {
        let r = meross_request("k", "m", 1);
        assert_eq!(r["header"]["sign"], nyx_proto::hex(&Md5::digest("mk1")));
        assert_eq!(watts(&json!({"payload": {"electricity": {"power": 12500}}})), Some(12.5));
        assert_eq!(watts(&json!({"payload": {}})), None);
    }
}

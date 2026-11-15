//! NextDNS analytics: queries, blocked queries and the most blocked domains of one
//! profile over the last days.
//! Shared by the manager and the monitor; each keeps its own `nextdns` setting.

use crate::{auth::Session, ApiError, ApiResult, Core};
use anyhow::Context;
use axum::{extract::{Query, State}, routing, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::{Arc, Mutex, OnceLock}, time::{Duration, Instant}};

const API: &str = "https://api.nextdns.io";

/// A finer step for short periods, so the curve keeps a useful shape.
fn interval(days: u32) -> u32 {
    match days {
        0..=2 => 3600,
        3..=14 => 6 * 3600,
        _ => 86400,
    }
}

/// Sums the `status;series` answer into totals and two curves: every query and the blocked ones.
fn summarize(reply: &Value) -> Value {
    let times: Vec<i64> = reply["meta"]["series"]["times"].as_array().map_or(vec![], |a| {
        a.iter().filter_map(|t| chrono::DateTime::parse_from_rfc3339(t.as_str()?).ok()).map(|t| t.timestamp()).collect()
    });
    let (mut total, mut blocked) = (vec![0u64; times.len()], vec![0u64; times.len()]);
    for s in reply["data"].as_array().into_iter().flatten() {
        let is_blocked = s["status"] == "blocked";
        for (i, q) in s["queries"].as_array().into_iter().flatten().take(times.len()).enumerate() {
            let q = q.as_u64().unwrap_or(0);
            total[i] += q;
            if is_blocked {
                blocked[i] += q;
            }
        }
    }
    let sum = |v: &[u64]| v.iter().sum::<u64>();
    json!({"configured": true, "total": sum(&total), "blocked": sum(&blocked), "times": times, "series_total": total, "series_blocked": blocked})
}

fn explain(status: u16) -> String {
    match status {
        401 | 403 => "NextDNS refused the API key. Copy it again from my.nextdns.io, under Account.".into(),
        404 => "NextDNS does not know this profile ID. It is the code in the address of the profile, such as abc123.".into(),
        429 => "NextDNS is limiting requests. Try again in a minute.".into(),
        s => format!("NextDNS answered with status {s}."),
    }
}

#[derive(Deserialize)]
struct Period {
    days: Option<u32>,
}

/// Every open panel refreshes on its own; this keeps NextDNS at one call per period
/// and per profile every few minutes, whatever the number of viewers.
const TTL: Duration = Duration::from_secs(300);
const KEEP: Duration = Duration::from_secs(3600);
type Cache = Mutex<HashMap<String, (Instant, Value)>>;
static CACHE: OnceLock<Cache> = OnceLock::new();

async fn get_json(http: &reqwest::Client, key: &str, url: String, query: &[(&str, String)]) -> anyhow::Result<Value> {
    let res = http.get(url).header("x-api-key", key).query(query).timeout(Duration::from_secs(15)).send().await.context("cannot reach NextDNS")?;
    anyhow::ensure!(res.status().is_success(), explain(res.status().as_u16()));
    res.json().await.context("unexpected answer from NextDNS")
}

async fn fetch(key: &str, profile: &str, days: u32) -> anyhow::Result<Value> {
    let (http, base, from) = (reqwest::Client::new(), format!("{API}/profiles/{profile}/analytics"), ("from", format!("-{days}d")));
    let series_q = [from.clone(), ("interval", interval(days).to_string())];
    let domains_q = [from, ("status", "blocked".into()), ("limit", "10".into())];
    let (series, domains) = tokio::try_join!(
        get_json(&http, key, format!("{base}/status;series"), &series_q),
        get_json(&http, key, format!("{base}/domains"), &domains_q),
    )?;
    let mut v = summarize(&series);
    v["top_blocked"] = top(&domains);
    v["days"] = days.into();
    Ok(v)
}

/// `[{domain, queries}]` of the `/domains` answer, most blocked first as NextDNS sends them.
fn top(reply: &Value) -> Value {
    reply["data"].as_array().into_iter().flatten().filter_map(|d| Some(json!({"domain": d["domain"].as_str()?, "queries": d["queries"].as_u64().unwrap_or(0)}))).collect()
}

/// The profile's analytics over `days`, from memory while fresh. Also refreshed in the
/// background by the monitor for the wall panels, which have no session to ask.
pub async fn get(core: &Core, days: u32) -> Result<Value, ApiError> {
    let cfg = core.pb.setting("nextdns").await?.unwrap_or_default();
    let field = |k: &str| cfg[k].as_str().map(str::trim).filter(|s| !s.is_empty());
    let (Some(key), Some(profile)) = (field("api_key"), field("profile")) else {
        return Ok(json!({"configured": false}));
    };
    // The profile goes into the path of the request.
    if !profile.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ApiError::bad_request("The profile ID only has letters and digits, such as abc123."));
    }
    let days = days.clamp(1, 365);
    // The key is part of the entry, so new settings never get an answer meant for old ones.
    let id = format!("{key}/{profile}/{days}");
    let cache = CACHE.get_or_init(Default::default);
    if let Some((_, v)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&id).filter(|(at, _)| at.elapsed() < TTL) {
        return Ok(v.clone());
    }
    let v = fetch(key, profile, days).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    let mut c = cache.lock().unwrap_or_else(|e| e.into_inner());
    // Stale entries stay a while: walls show them rather than nothing if NextDNS is down.
    c.retain(|_, (at, _)| at.elapsed() < KEEP);
    c.insert(id, (Instant::now(), v.clone()));
    Ok(v)
}

/// The newest answer for `days`, however old, without calling NextDNS.
pub fn latest(days: u32) -> Option<Value> {
    let suffix = format!("/{}", days.clamp(1, 365));
    let cache = CACHE.get()?.lock().unwrap_or_else(|e| e.into_inner());
    cache.iter().filter(|(k, _)| k.ends_with(&suffix)).max_by_key(|(_, (at, _))| *at).map(|(_, (_, v))| v.clone())
}

async fn analytics(_: Session, State(core): State<Arc<Core>>, Query(p): Query<Period>) -> ApiResult<Json<Value>> {
    get(&core, p.days.unwrap_or(7)).await.map(Json)
}

pub fn router() -> Router<Arc<Core>> {
    Router::new().route("/api/nextdns", routing::get(analytics))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_add_up_and_only_blocked_ones_count_as_blocked() {
        let reply = json!({
            "data": [
                {"status": "default", "queries": [10, 20]},
                {"status": "blocked", "queries": [3, 4]},
                {"status": "allowed", "queries": [1, 0]}
            ],
            "meta": {"series": {"times": ["2026-11-14T00:00:00Z", "2026-11-15T00:00:00Z"]}}
        });
        let v = summarize(&reply);
        assert_eq!(v["total"], 38);
        assert_eq!(v["blocked"], 7);
        assert_eq!(v["series_total"], json!([14, 24]));
        assert_eq!(v["series_blocked"], json!([3, 4]));
        assert_eq!(v["times"][1], 1794700800);
    }

    #[test]
    fn top_domains_keep_the_order_and_skip_broken_rows() {
        let v = top(&json!({"data": [{"domain": "ads.example", "root": "example", "queries": 9}, {"queries": 3}, {"domain": "t.co", "queries": 2}]}));
        assert_eq!(v, json!([{"domain": "ads.example", "queries": 9}, {"domain": "t.co", "queries": 2}]));
    }

    #[test]
    fn an_empty_answer_gives_zeros() {
        let v = summarize(&json!({}));
        assert_eq!(v["total"], 0);
        assert_eq!(v["times"], json!([]));
    }

    #[test]
    fn short_periods_get_a_finer_step() {
        assert_eq!(interval(1), 3600);
        assert_eq!(interval(7), 21600);
        assert_eq!(interval(90), 86400);
    }
}

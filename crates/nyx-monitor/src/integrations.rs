//! External services: RTE Tempo calendar, its copy in a Nextcloud calendar, and Meross
//! smart plugs (local network).

use crate::state::App;
use anyhow::Context;
use axum::{extract::State, routing::{get, post}, Json, Router};
use chrono::{DateTime, Datelike, Days, NaiveDate, TimeDelta, Utc};
use md5::{Digest, Md5};
use nyx_srv::{auth::Session, notify, random_hex, ApiError, ApiResult};
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

fn tempo_days(calendar: &Value) -> Vec<(NaiveDate, &str)> {
    calendar["tempo_like_calendars"]["values"].as_array().map_or(vec![], |a| {
        a.iter()
            .filter_map(|v| Some((NaiveDate::parse_from_str(v["start_date"].as_str()?.get(..10)?, "%Y-%m-%d").ok()?, v["value"].as_str()?)))
            .collect()
    })
}

/// Reduce the RTE calendar to today, tomorrow and days left per colour. Days are
/// taken from `start_date` so a timezone offset cannot shift them.
pub fn summarize(calendar: &Value, today: NaiveDate) -> Value {
    let days = tempo_days(calendar);
    // RTE can list a day as NON_DEFINED until it is decided.
    let colour = |d: Option<NaiveDate>| d.and_then(|d| days.iter().find(|x| x.0 == d)).map(|x| x.1).filter(|c| QUOTAS.iter().any(|q| q.0 == *c));
    let start = season_start(today);
    let remaining: Value = QUOTAS
        .iter()
        .map(|(c, quota)| (c.to_lowercase(), json!(quota - days.iter().filter(|d| d.0 >= start && d.1 == *c).count() as i64)))
        .collect::<serde_json::Map<_, _>>()
        .into();
    json!({"date": today, "today": colour(Some(today)), "tomorrow": colour(today.succ_opt()), "remaining": remaining})
}

fn last_sunday(year: i32, month: u32) -> NaiveDate {
    let last = NaiveDate::from_ymd_opt(year, month, 31).expect("March and October have 31 days");
    last - Days::new(last.weekday().num_days_from_sunday().into())
}

/// Hours ahead of UTC in France, which is on summer time from the last Sunday of March
/// to the last Sunday of October. Costs less than a time zone database for one zone.
fn paris_hours(d: NaiveDate) -> i64 {
    if d >= last_sunday(d.year(), 3) && d < last_sunday(d.year(), 10) { 2 } else { 1 }
}

/// With the wrong offset this is 01:00 in summer, past RTE's limit of two days ahead.
fn paris_midnight(d: NaiveDate) -> String {
    format!("{d}T00:00:00+0{}:00", paris_hours(d))
}

fn paris_today(now: DateTime<Utc>) -> NaiveDate {
    (now + TimeDelta::hours(paris_hours(now.date_naive()))).date_naive()
}

/// The season so far, plus tomorrow. RTE refuses more than 366 days, which only a leap
/// year reaches, on 31 August: that one day then counts the first day of the season as left.
fn calendar_window(today: NaiveDate) -> (NaiveDate, NaiveDate) {
    let end = today + Days::new(2);
    (season_start(today).max(end - Days::new(366)), end)
}

fn credentials(cfg: &Value) -> Option<(&str, &str)> {
    // Pasted values often bring a space or a line break, and RTE then refuses them.
    let field = |k: &str| cfg.get(k)?.as_str().map(str::trim).filter(|s| !s.is_empty());
    Some((field("client_id")?, field("client_secret")?))
}

/// RTE says what is wrong in JSON, which the status alone would hide.
fn explain(status: u16, body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or_default();
    match (status, v["error"].as_str()) {
        (_, Some("invalid_client")) | (401, _) => "RTE refused the client ID or secret. Copy them again from your application on data.rte-france.com.".into(),
        (403, _) => "Your RTE application is not subscribed to the Tempo Like Supply Contract API. Subscribe it on data.rte-france.com.".into(),
        (429, _) => "RTE is limiting requests. Try again in a few minutes.".into(),
        _ => v["error_description"].as_str().map_or_else(|| format!("RTE answered with status {status}."), |d| format!("RTE: {d}")),
    }
}

async fn checked(res: reqwest::Response) -> anyhow::Result<reqwest::Response> {
    if res.status().is_success() {
        return Ok(res);
    }
    let status = res.status().as_u16();
    anyhow::bail!(explain(status, &res.text().await.unwrap_or_default()))
}

async fn fetch_calendar(app: &App, id: &str, secret: &str, today: NaiveDate) -> anyhow::Result<Value> {
    let res = app.http.post(format!("{RTE}/token/oauth/")).basic_auth(id, Some(secret)).send().await.context("cannot reach RTE")?;
    let token: Value = checked(res).await?.json().await?;
    let (start, end) = calendar_window(today);
    let res = app
        .http
        .get(format!("{RTE}/open_api/tempo_like_supply_contract/v1/tempo_like_calendars"))
        .bearer_auth(token["access_token"].as_str().context("RTE sent no access token")?)
        .header("accept", "application/json")
        .query(&[("start_date", paris_midnight(start)), ("end_date", paris_midnight(end))])
        .send()
        .await
        .context("cannot reach RTE")?;
    Ok(checked(res).await?.json().await?)
}

async fn fetch_tempo(app: &App, id: &str, secret: &str) -> anyhow::Result<Value> {
    let today = paris_today(Utc::now());
    Ok(summarize(&fetch_calendar(app, id, secret, today).await?, today))
}

async fn refresh_tempo(app: &App) -> anyhow::Result<Value> {
    let cfg = app.core.pb.setting("tempo").await?.unwrap_or_default();
    let Some((id, secret)) = credentials(&cfg) else {
        return Ok(json!({"configured": false}));
    };
    let mut v = fetch_tempo(app, id, secret).await?;
    v["configured"] = true.into();
    app.lock().tempo = Some((Instant::now(), v.clone()));
    Ok(v)
}

async fn tempo(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    let today = paris_today(Utc::now()).to_string();
    let fresh = app.lock().tempo.as_ref().filter(|(at, v)| at.elapsed() < TEMPO_TTL && v["date"] == today.as_str()).map(|(_, v)| v.clone());
    match fresh {
        Some(v) => Ok(Json(v)),
        None => refresh_tempo(&app).await.map(Json).map_err(|e| ApiError::bad_request(format!("{e:#}"))),
    }
}

/// `(severity, title, message)` of the notification for tomorrow's colour.
fn tomorrow_notice(v: &Value) -> Option<(&'static str, String, String)> {
    let (severity, name) = match v["tomorrow"].as_str()? {
        "BLUE" => ("info", "🔵 Blue"),
        "WHITE" => ("info", "⚪️ White"),
        "RED" => ("warn", "🔴 Red"),
        _ => return None,
    };
    let left = &v["remaining"];
    Some((severity, format!("EDF Tempo tomorrow: {name}"), format!("Days left: {} blue, {} white, {} red", left["blue"], left["white"], left["red"])))
}

/// Keeps the days fresh for display pages and tells tomorrow's colour once, as soon as
/// RTE has it. A published day never changes, so RTE is left alone until the next day.
pub async fn tempo_tick(app: &App) -> anyhow::Result<()> {
    let today = paris_today(Utc::now());
    let known = app.lock().tempo.as_ref().map(|(_, v)| v.clone()).filter(|v| v["date"] == today.to_string().as_str() && !v["tomorrow"].is_null());
    let v = match known {
        Some(v) => v,
        None => refresh_tempo(app).await?,
    };
    let Some((severity, title, message)) = tomorrow_notice(&v) else { return Ok(()) };
    let day = today + Days::new(1);
    let pb = &app.core.pb;
    if pb.setting("tempo_told").await?.is_some_and(|s| s["day"] == day.to_string().as_str()) {
        return Ok(());
    }
    notify::emit(&app.core, "tempo", severity, &title, &message, "").await;
    pb.set_setting("tempo_told", &json!({"day": day})).await
}

/// The Nextcloud calendar that receives the Tempo days.
struct Calendar {
    url: String,
    user: String,
    password: String,
}

fn calendar(cfg: &Value) -> Option<Calendar> {
    let field = |k: &str| cfg.get(k)?.as_str().map(str::trim).filter(|s| !s.is_empty());
    let (origin, user, name) = (field("url")?.trim_end_matches('/'), field("user")?, field("calendar")?);
    Some(Calendar { url: format!("{origin}/remote.php/dav/calendars/{user}/{name}"), user: user.into(), password: field("password")?.into() })
}

/// An all-day event that leaves the day free. Nothing in it depends on when it is sent,
/// so sending a day twice changes nothing.
fn tempo_event(day: NaiveDate, colour: &str) -> Option<String> {
    let (summary, css) = match colour {
        "BLUE" => ("🔵 Bleu", "blue"),
        "WHITE" => ("⚪️ Blanc", "white"),
        "RED" => ("🔴 Rouge", "red"),
        _ => return None,
    };
    let (start, end) = (day.format("%Y%m%d"), (day + Days::new(1)).format("%Y%m%d"));
    Some(format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Nyx//Tempo//EN\r\nBEGIN:VEVENT\r\nUID:nyx-tempo-{day}\r\nDTSTAMP:{start}T000000Z\r\nDTSTART;VALUE=DATE:{start}\r\nDTEND;VALUE=DATE:{end}\r\nSUMMARY:{summary}\r\nCOLOR:{css}\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    ))
}

/// Oldest first, so that the last one tells how far the calendar goes.
fn new_days(mut days: Vec<(NaiveDate, &str)>, last: Option<NaiveDate>) -> Vec<(NaiveDate, &str)> {
    days.retain(|d| last.is_none_or(|l| d.0 > l));
    days.sort();
    days
}

async fn send_days(http: &reqwest::Client, cal: &Calendar, days: &[(NaiveDate, &str)]) -> anyhow::Result<usize> {
    let mut sent = 0;
    for (day, colour) in days {
        let Some(event) = tempo_event(*day, colour) else { continue };
        let res = http
            .put(format!("{}/nyx-tempo-{day}.ics", cal.url))
            .basic_auth(&cal.user, Some(&cal.password))
            .header("content-type", "text/calendar; charset=utf-8")
            .body(event)
            .send()
            .await
            .context("cannot reach Nextcloud")?;
        match res.status().as_u16() {
            200..=299 => sent += 1,
            401 => anyhow::bail!("Nextcloud refused the user or app password."),
            404 => anyhow::bail!("Nextcloud has no calendar at this address. Use the name in the calendar's link."),
            status => anyhow::bail!("Nextcloud answered with status {status}."),
        }
    }
    Ok(sent)
}

/// Copies the published Tempo days to the calendar and returns how many were sent. A
/// published day never changes, so only new ones go out unless `all` asks for the whole
/// season. Once tomorrow is there, RTE is not even asked until the next day.
pub async fn sync_tempo_calendar(app: &App, all: bool) -> anyhow::Result<usize> {
    let pb = &app.core.pb;
    let Some(cal) = pb.setting("tempo_calendar").await?.as_ref().and_then(calendar) else {
        anyhow::ensure!(!all, "Fill in the Nextcloud calendar first.");
        return Ok(0);
    };
    let rte = pb.setting("tempo").await?.unwrap_or_default();
    let Some((id, secret)) = credentials(&rte) else {
        anyhow::ensure!(!all, "Fill in the RTE client ID and secret first.");
        return Ok(0);
    };
    let synced = pb.setting("tempo_synced").await?.unwrap_or_default();
    let last = (!all && synced["calendar"] == cal.url).then(|| synced["last"].as_str()?.parse::<NaiveDate>().ok()).flatten();
    let today = paris_today(Utc::now());
    if last.is_some_and(|d| d > today) {
        return Ok(0);
    }
    let published = fetch_calendar(app, id, secret, today).await?;
    let days = new_days(tempo_days(&published), last);
    let sent = send_days(&app.http, &cal, &days).await?;
    if let Some(latest) = days.last() {
        pb.set_setting("tempo_synced", &json!({"calendar": cal.url, "last": latest.0})).await?;
    }
    Ok(sent)
}

async fn tempo_calendar_now(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    let sent = sync_tempo_calendar(&app, true).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(json!({"sent": sent})))
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
    Router::new()
        .route("/api/integrations/tempo", get(tempo))
        .route("/api/integrations/tempo/calendar", post(tempo_calendar_now))
        .route("/api/integrations/power", get(power))
        .with_state(app)
}


#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn paris_offset_follows_summer_time() {
        // 2026: from Sunday 29 March to Sunday 25 October.
        assert_eq!(paris_midnight(d("2026-03-28")), "2026-03-28T00:00:00+01:00");
        assert_eq!(paris_midnight(d("2026-03-29")), "2026-03-29T00:00:00+02:00");
        assert_eq!(paris_midnight(d("2026-09-01")), "2026-09-01T00:00:00+02:00");
        assert_eq!(paris_midnight(d("2026-10-24")), "2026-10-24T00:00:00+02:00");
        assert_eq!(paris_midnight(d("2026-10-25")), "2026-10-25T00:00:00+01:00");
        assert_eq!(paris_midnight(d("2026-11-06")), "2026-11-06T00:00:00+01:00");
    }

    #[test]
    fn today_changes_at_midnight_in_paris() {
        let utc = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().to_utc();
        assert_eq!(paris_today(utc("2026-07-01T22:30:00Z")), d("2026-07-02"));
        assert_eq!(paris_today(utc("2026-12-01T22:30:00Z")), d("2026-12-01"));
    }

    #[test]
    fn calendar_window_stays_within_what_rte_accepts() {
        assert_eq!(calendar_window(d("2026-11-06")), (d("2026-09-01"), d("2026-11-08")));
        for today in [d("2027-08-31"), d("2028-08-31")] {
            let (start, end) = calendar_window(today);
            assert!((end - start).num_days() <= 366, "{today}");
        }
    }

    #[test]
    fn tempo_days_become_all_day_events_that_leave_the_day_free() {
        let e = tempo_event(d("2026-12-31"), "RED").unwrap();
        assert!(e.contains("SUMMARY:🔴 Rouge\r\n") && e.contains("COLOR:red\r\n") && e.contains("TRANSP:TRANSPARENT\r\n"), "{e}");
        assert!(e.contains("DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101\r\n"), "{e}");
        assert!(e.contains("UID:nyx-tempo-2026-12-31\r\n"), "{e}");
        assert!(tempo_event(d("2026-12-31"), "BLUE").unwrap().contains("SUMMARY:🔵 Bleu\r\n"));
        assert!(tempo_event(d("2026-12-31"), "WHITE").unwrap().contains("SUMMARY:⚪️ Blanc\r\n"));
        assert!(tempo_event(d("2026-12-31"), "NON_DEFINED").is_none());
    }

    #[test]
    fn only_days_after_the_last_one_sent_go_out_oldest_first() {
        let days = || vec![(d("2026-11-08"), "RED"), (d("2026-11-06"), "BLUE"), (d("2026-11-07"), "WHITE")];
        assert_eq!(new_days(days(), None).iter().map(|x| x.1).collect::<Vec<_>>(), ["BLUE", "WHITE", "RED"]);
        assert_eq!(new_days(days(), Some(d("2026-11-07"))), [(d("2026-11-08"), "RED")]);
        assert!(new_days(days(), Some(d("2026-11-08"))).is_empty());
    }

    #[test]
    fn calendar_needs_every_field_and_builds_the_caldav_address() {
        let cfg = json!({"url": "https://cloud.home.lan/ ", "user": "me", "password": "app", "calendar": "tempo"});
        assert_eq!(calendar(&cfg).unwrap().url, "https://cloud.home.lan/remote.php/dav/calendars/me/tempo");
        assert!(calendar(&json!({"url": "https://cloud.home.lan", "user": "me", "calendar": "tempo"})).is_none());
    }

    #[tokio::test]
    async fn events_reach_nextcloud_and_a_refusal_is_explained() {
        use axum::{extract::Path, http::{HeaderMap, StatusCode}, routing::put};
        let seen = Arc::new(std::sync::Mutex::new(vec![]));
        let log = seen.clone();
        let fake = Router::new().route("/remote.php/dav/calendars/me/{name}/{file}", put(move |Path((name, file)): Path<(String, String)>, h: HeaderMap, body: String| {
            let log = log.clone();
            async move {
                log.lock().unwrap().push((file, h["authorization"].to_str().unwrap().to_string(), body));
                if name == "tempo" { StatusCode::CREATED } else { StatusCode::NOT_FOUND }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, fake).await.unwrap() });

        let http = reqwest::Client::new();
        let cal = |name: &str| calendar(&json!({"url": format!("http://{addr}"), "user": "me", "password": "app", "calendar": name})).unwrap();
        let days = [(d("2026-11-06"), "BLUE"), (d("2026-11-07"), "NON_DEFINED"), (d("2026-11-08"), "RED")];
        assert_eq!(send_days(&http, &cal("tempo"), &days).await.unwrap(), 2);
        {
            let seen = seen.lock().unwrap();
            assert_eq!(seen[0].0, "nyx-tempo-2026-11-06.ics");
            assert_eq!(seen[0].1, "Basic bWU6YXBw");
            assert!(seen[1].2.contains("SUMMARY:🔴 Rouge"));
        }
        assert!(send_days(&http, &cal("missing"), &days).await.unwrap_err().to_string().contains("no calendar"));
    }

    #[test]
    fn credentials_need_both_values_and_lose_stray_spaces() {
        assert_eq!(credentials(&json!({"client_id": " id\n", "client_secret": "secret "})), Some(("id", "secret")));
        assert_eq!(credentials(&json!({"client_id": "id", "client_secret": "  "})), None);
        assert_eq!(credentials(&json!({"client_id": "id"})), None);
        assert_eq!(credentials(&json!({})), None);
    }

    #[test]
    fn rte_errors_become_a_reason_to_act_on() {
        assert!(explain(400, r#"{"error":"invalid_client"}"#).contains("client ID or secret"));
        assert!(explain(403, "").contains("not subscribed"));
        assert_eq!(explain(400, r#"{"error":"TMPLIKSUPCON_TMPLIKCAL_F04","error_description":"bad end_date"}"#), "RTE: bad end_date");
        assert_eq!(explain(503, "<html>"), "RTE answered with status 503.");
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
        let cal = json!({"tempo_like_calendars": {"values": [{"start_date": "2026-11-05T00:00:00+01:00", "value": "BLUE"}, {"start_date": "2026-11-06T00:00:00+01:00", "value": "NON_DEFINED"}]}});
        assert!(summarize(&cal, d("2026-11-05"))["tomorrow"].is_null());
    }

    #[test]
    fn tomorrow_notice_gives_the_colour_and_the_days_left() {
        let left = json!({"blue": 299, "white": 42, "red": 21});
        let (severity, title, message) = tomorrow_notice(&json!({"tomorrow": "RED", "remaining": left})).unwrap();
        assert_eq!((severity, title.as_str()), ("warn", "EDF Tempo tomorrow: 🔴 Red"));
        assert_eq!(message, "Days left: 299 blue, 42 white, 21 red");
        assert_eq!(tomorrow_notice(&json!({"tomorrow": "BLUE", "remaining": left})).unwrap().0, "info");
        assert!(tomorrow_notice(&json!({"tomorrow": null})).is_none());
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

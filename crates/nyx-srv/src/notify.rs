//! Notification engine. Anything worth telling lands in `notif_events`; rules
//! decide when a channel receives a digest. There is no per-event send path, so
//! grouping and quiet periods are not features to bypass, they are the only flow.

use crate::{auth::Session, pb_date, pb_quote, ApiError, ApiResult, Core};
use anyhow::{bail, Context};
use axum::{
    extract::{Path, State},
    routing::post,
    Json, Router,
};
use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Utc};
use minijinja::{context, Environment};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{process::Stdio, sync::Arc};
use tokio::io::AsyncWriteExt;

pub const EVENT_TYPES: [&str; 7] = ["state", "update", "smart", "temperature", "task", "tempo", "pipeline"];
pub const DEFAULT_TITLE: &str = "{{ icon }} Nyx: {{ count }} event{{ 's' if count != 1 }}";
// One line per event: Discord turns each line into its own embed.
pub const DEFAULT_BODY: &str = "{% for e in events %}{{ e.icon }} {{ e.type_icon }} {{ e.title }}{% if e.host and e.host not in e.title %} ({{ e.host }}){% endif %}{% if e.message %} · {{ e.message }}{% endif %}\n{% endfor %}";

fn severity_icon(severity: &str) -> &'static str {
    match severity {
        "crit" => "🔴",
        "warn" => "🟠",
        "ok" => "🟢",
        _ => "🔵",
    }
}

fn type_icon(kind: &str) -> &'static str {
    match kind {
        "state" => "📡",
        "update" => "📦",
        "smart" => "💽",
        "temperature" => "🌡️",
        "tempo" => "⚡",
        "pipeline" => "🔧",
        _ => "📋",
    }
}

/// Record an event. Failures are logged, not fatal: monitoring must keep going.
pub async fn emit(core: &Core, kind: &str, severity: &str, title: &str, message: &str, host: &str) {
    let body = json!({"type": kind, "severity": severity, "title": title, "message": message, "host": host});
    if let Err(e) = core.pb.create("notif_events", &body).await {
        eprintln!("cannot record notification event: {e:#}");
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Default)]
pub struct Timing {
    #[serde(default)]
    pub schedule: String,
    #[serde(default)]
    pub min_gap_s: i64,
    #[serde(default)]
    pub hour: u32,
    #[serde(default)]
    pub day: u32,
}

/// Most recent scheduled instant at or before `now`, for periodic rules.
fn last_slot<Tz: TimeZone>(t: &Timing, now: &DateTime<Tz>) -> Option<DateTime<Tz>> {
    let at_hour = |d: chrono::NaiveDate| now.timezone().from_local_datetime(&d.and_hms_opt(t.hour.min(23), 0, 0)?).earliest();
    let today = now.date_naive();
    let slot_on = |back_days: i64| at_hour(today - Duration::days(back_days));
    match t.schedule.as_str() {
        "daily" => slot_on(0).filter(|s| s <= now).or_else(|| slot_on(1)),
        "weekly" => {
            // `day`: 1 = Monday ... 7 = Sunday.
            let back = (today.weekday().number_from_monday() as i64 - t.day.clamp(1, 7) as i64).rem_euclid(7);
            slot_on(back).filter(|s| s <= now).or_else(|| slot_on(back + 7))
        }
        "monthly" => {
            // Clamp to 28 so February does not silently skip a digest.
            let day = t.day.clamp(1, 28);
            let this = at_hour(today.with_day(day)?).filter(|s| s <= now);
            this.or_else(|| {
                let first = today.with_day(1)?;
                at_hour((first - Duration::days(1)).with_day(day)?)
            })
        }
        _ => None,
    }
}

/// Should this rule send now, given when it last sent?
pub fn is_due<Tz: TimeZone>(t: &Timing, now: &DateTime<Tz>, last_sent: Option<DateTime<Utc>>) -> bool {
    let Some(last) = last_sent else {
        return t.schedule.is_empty() || t.schedule == "instant" || last_slot(t, now).is_some();
    };
    match t.schedule.as_str() {
        "" | "instant" => now.to_utc() - last >= Duration::seconds(t.min_gap_s),
        _ => last_slot(t, now).is_some_and(|slot| slot.to_utc() > last),
    }
}

/// Render `(title, body)`. Autoescape only for HTML mails.
pub fn render(title_tpl: &str, body_tpl: &str, html: bool, events: &[Value]) -> anyhow::Result<(String, String)> {
    let mut env = Environment::new();
    env.set_auto_escape_callback(move |_| if html { minijinja::AutoEscape::Html } else { minijinja::AutoEscape::None });
    let worst = ["crit", "warn", "info"].into_iter().find(|s| events.iter().any(|e| e["severity"] == *s)).unwrap_or("ok");
    let events: Vec<Value> = events
        .iter()
        .cloned()
        .map(|mut e| {
            if let Some(o) = e.as_object_mut() {
                let (icon, kind) = (severity_icon(o.get("severity").and_then(Value::as_str).unwrap_or_default()), type_icon(o.get("type").and_then(Value::as_str).unwrap_or_default()));
                o.insert("icon".into(), icon.into());
                o.insert("type_icon".into(), kind.into());
            }
            e
        })
        .collect();
    let ctx = context! { events => events, count => events.len(), icon => severity_icon(worst) };
    let title_tpl = if title_tpl.is_empty() { DEFAULT_TITLE } else { title_tpl };
    let body_tpl = if body_tpl.is_empty() { DEFAULT_BODY } else { body_tpl };
    Ok((env.render_str(title_tpl, &ctx)?, env.render_str(body_tpl, &ctx)?))
}

/// One `nyx-notify` process per delivery: nothing stays resident between digests.
pub async fn deliver(core: &Core, url: &str, html: bool, title: &str, message: &str) -> anyhow::Result<()> {
    let url = if html && url.starts_with("smtp://") { add_param(url, "usehtml=yes") } else { url.to_string() };
    let mut child = tokio::process::Command::new(&core.env.notifier_bin)
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .with_context(|| format!("cannot start {}", core.env.notifier_bin))?;
    let payload = serde_json::to_vec(&json!({"url": url, "title": title, "message": message}))?;
    child.stdin.take().context("notifier stdin")?.write_all(&payload).await?;
    let out = child.wait_with_output().await?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

fn add_param(url: &str, param: &str) -> String {
    format!("{url}{}{param}", if url.contains('?') { '&' } else { '?' })
}

fn parse_date(v: &Value) -> Option<DateTime<Utc>> {
    let s = v.as_str().filter(|s| !s.is_empty())?;
    DateTime::parse_from_rfc3339(&s.replacen(' ', "T", 1)).ok().map(|d| d.to_utc())
}

/// Periodic pass: send every digest that is due.
pub async fn tick(core: &Core) -> anyhow::Result<()> {
    let now = Local::now();
    if core.shared {
        // Older than any delivery: only a server that died while sending leaves one behind.
        core.pb.prune("notif_claims", "created", now.to_utc() - Duration::minutes(10)).await?;
    }
    for rule in core.pb.list("notif_rules", "", "").await? {
        let timing: Timing = serde_json::from_value(rule.clone()).unwrap_or_default();
        let last = parse_date(&rule["last_sent"]);
        if !is_due(&timing, &now, last) {
            continue;
        }
        let id = rule["id"].as_str().unwrap_or_default();
        let since = last.unwrap_or(now.to_utc() - Duration::days(1));
        let kinds: Vec<&str> = rule["events"].as_array().map_or(vec![], |a| a.iter().filter_map(Value::as_str).collect());
        let kinds = kinds.iter().map(|k| format!("type = {}", pb_quote(k))).collect::<Vec<_>>().join(" || ");
        if kinds.is_empty() {
            continue;
        }
        let filter = format!("created > {} && ({kinds})", pb_quote(&pb_date(since)));
        let events = core.pb.list("notif_events", &filter, "created").await?;
        let sent_at = pb_date(now.to_utc());
        if events.is_empty() {
            // A periodic slot passed with nothing to say: mark it consumed.
            if !matches!(timing.schedule.as_str(), "" | "instant") {
                core.pb.update("notif_rules", id, &json!({"last_sent": sent_at, "last_error": ""})).await?;
            }
            continue;
        }
        // Both servers run this loop on a shared database. The key is unique, and
        // `last_sent` changes with each digest, so exactly one of them sends this one.
        let claim = if core.shared {
            let key = format!("{id}:{}", rule["last_sent"].as_str().unwrap_or_default());
            let Ok(claim) = core.pb.create("notif_claims", &json!({"key": key})).await else { continue };
            Some(claim)
        } else {
            None
        };
        let result = send_digest(core, &rule, &events).await;
        if let (Err(_), Some(claim)) = (&result, &claim) {
            core.pb.delete("notif_claims", claim["id"].as_str().unwrap_or_default()).await?;
        }
        // On failure last_sent stays put, so the same events go out on a later tick.
        let patch = match &result {
            Ok(()) => json!({"last_sent": sent_at, "last_error": ""}),
            Err(e) => json!({"last_error": format!("{e:#}")}),
        };
        core.pb.update("notif_rules", id, &patch).await?;
    }
    Ok(())
}

async fn send_digest(core: &Core, rule: &Value, events: &[Value]) -> anyhow::Result<()> {
    let channel = core.pb.get("notif_channels", rule["channel"].as_str().unwrap_or_default()).await?;
    let html = channel["html"].as_bool().unwrap_or(false);
    let (title, body) = render(channel["title_tpl"].as_str().unwrap_or(""), channel["body_tpl"].as_str().unwrap_or(""), html, events)?;
    deliver(core, channel["url"].as_str().unwrap_or_default(), html, &title, &body).await
}

/// Start the digest loop and event retention.
pub fn spawn(core: Arc<Core>) {
    let c = core.clone();
    crate::web::every(std::time::Duration::from_secs(60), "notifications", move || {
        let c = c.clone();
        async move { tick(&c).await }
    });
    crate::web::every(std::time::Duration::from_secs(86400), "notification retention", move || {
        let c = core.clone();
        async move { c.pb.prune("notif_events", "created", Utc::now() - Duration::days(40)).await }
    });
}

fn sample_events() -> Vec<Value> {
    vec![
        json!({"type": "state", "severity": "crit", "title": "backup-01 is not responding", "message": "No report for 5 minutes", "host": "backup-01", "created": "2026-11-05 14:32:00.000Z"}),
        json!({"type": "smart", "severity": "warn", "title": "/dev/sda: 8 bad sectors", "message": "Plan a replacement", "host": "nas-01", "created": "2026-11-05 14:20:00.000Z"}),
        json!({"type": "temperature", "severity": "warn", "title": "pve-01: CPU at 84 °C", "message": "", "host": "pve-01", "created": "2026-11-05 13:05:00.000Z"}),
        json!({"type": "update", "severity": "info", "title": "12 updates available", "message": "3 security updates", "host": "docker-01", "created": "2026-11-05 04:00:00.000Z"}),
        json!({"type": "state", "severity": "ok", "title": "Resolved: web-01 is responding", "message": "", "host": "web-01", "created": "2026-11-05 03:12:00.000Z"}),
    ]
}

#[derive(Deserialize)]
struct Preview {
    #[serde(default)]
    title_tpl: String,
    #[serde(default)]
    body_tpl: String,
    #[serde(default)]
    html: bool,
}

async fn preview(_: Session, Json(p): Json<Preview>) -> ApiResult<Json<Value>> {
    let (title, body) = render(&p.title_tpl, &p.body_tpl, p.html, &sample_events()).map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(json!({"title": title, "body": body})))
}

async fn test_channel(_: Session, State(core): State<Arc<Core>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let c = core.pb.get("notif_channels", &id).await.map_err(|_| ApiError::not_found())?;
    let html = c["html"].as_bool().unwrap_or(false);
    let (title, body) = render(c["title_tpl"].as_str().unwrap_or(""), c["body_tpl"].as_str().unwrap_or(""), html, &sample_events()).map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    deliver(&core, c["url"].as_str().unwrap_or_default(), html, &title, &body).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(Value::Null))
}

pub fn router() -> Router<Arc<Core>> {
    Router::new().route("/api/notify/preview", post(preview)).route("/api/notify/test/{id}", post(test_channel))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn at(s: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(s).unwrap()
    }
    fn utc(s: &str) -> Option<DateTime<Utc>> {
        Some(at(s).to_utc())
    }
    fn timing(schedule: &str, hour: u32, day: u32) -> Timing {
        Timing { schedule: schedule.into(), min_gap_s: 0, hour, day }
    }

    #[test]
    fn instant_rule_respects_the_gap() {
        let t = Timing { min_gap_s: 600, ..Timing::default() };
        let now = at("2026-11-05T10:00:00Z");
        assert!(is_due(&t, &now, None));
        assert!(!is_due(&t, &now, utc("2026-11-05T09:55:00Z")));
        assert!(is_due(&t, &now, utc("2026-11-05T09:50:00Z")));
    }

    #[test]
    fn daily_rule_fires_once_per_slot() {
        let t = timing("daily", 8, 0);
        assert!(is_due(&t, &at("2026-11-05T08:01:00Z"), utc("2026-11-04T08:01:00Z")));
        assert!(!is_due(&t, &at("2026-11-05T08:02:00Z"), utc("2026-11-05T08:01:00Z")));
        assert!(!is_due(&t, &at("2026-11-05T07:59:00Z"), utc("2026-11-04T08:01:00Z")));
    }

    #[test]
    fn weekly_rule_targets_the_chosen_weekday() {
        let t = timing("weekly", 9, 1); // 2026-11-02 is a Monday
        assert!(is_due(&t, &at("2026-11-02T09:00:00Z"), utc("2026-10-26T09:00:00Z")));
        assert!(!is_due(&t, &at("2026-11-04T12:00:00Z"), utc("2026-11-02T09:00:00Z")));
        assert!(is_due(&t, &at("2026-11-09T09:30:00Z"), utc("2026-11-02T09:00:00Z")));
    }

    #[test]
    fn monthly_rule_survives_month_boundaries() {
        let t = timing("monthly", 9, 31); // clamped to the 28th
        assert!(is_due(&t, &at("2027-02-28T09:00:00Z"), utc("2027-01-28T09:00:00Z")));
        assert!(!is_due(&t, &at("2027-03-01T09:00:00Z"), utc("2027-02-28T09:00:00Z")));
        let t = timing("monthly", 9, 15);
        assert!(!is_due(&t, &at("2027-01-10T09:00:00Z"), utc("2026-12-15T09:00:00Z")));
        assert!(is_due(&t, &at("2027-01-10T09:00:00Z"), utc("2026-11-15T09:00:00Z")), "missed slot still fires");
    }

    #[test]
    fn templates_escape_html_only_in_html_mode() {
        let ev = [json!({"title": "<b>x</b>", "severity": "crit", "host": ""})];
        let (_, plain) = render("", "{{ events[0].title }}", false, &ev).unwrap();
        let (title, html) = render("", "{{ events[0].title }}", true, &ev).unwrap();
        assert_eq!((plain.as_str(), title.as_str()), ("<b>x</b>", "🔴 Nyx: 1 event"));
        assert!(html.contains("&lt;b&gt;"));
        assert!(render("{{", "", false, &ev).is_err());
    }

    #[test]
    fn default_body_has_one_line_per_event_and_does_not_repeat_the_host() {
        let ev = [
            json!({"type": "smart", "severity": "warn", "title": "nas: /dev/sda failing", "message": "Replace it", "host": "nas"}),
            json!({"type": "update", "severity": "info", "title": "12 updates", "message": "", "host": "web"}),
        ];
        let (title, body) = render("", "", false, &ev).unwrap();
        assert_eq!(title, "🟠 Nyx: 2 events");
        assert_eq!(body, "🟠 💽 nas: /dev/sda failing · Replace it\n🔵 📦 12 updates (web)\n");
    }

    #[test]
    fn smtp_html_param_is_appended() {
        assert_eq!(add_param("smtp://a/?to=b", "usehtml=yes"), "smtp://a/?to=b&usehtml=yes");
        assert_eq!(add_param("smtp://a/", "usehtml=yes"), "smtp://a/?usehtml=yes");
    }

    #[test]
    fn dates_from_pocketbase_parse() {
        assert!(parse_date(&json!("2026-11-05 10:00:00.000Z")).is_some());
        assert!(parse_date(&json!("")).is_none());
    }

}

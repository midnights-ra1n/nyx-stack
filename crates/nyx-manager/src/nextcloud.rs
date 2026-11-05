//! Two-way task sync with Nextcloud over CalDAV.
//!
//! Local edits are pushed at once. CalDAV has no push towards clients, so remote
//! edits are picked up by a 30 s poll, which only asks for data when the
//! calendar's ctag changed.

use crate::App;
use anyhow::{bail, Context};
use nyx_srv::{pb_quote, random_hex};
use reqwest::Method;
use serde_json::{json, Value};

const REPORT_BODY: &str = r#"<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"/></c:filter></c:calendar-query>"#;
const CTAG_BODY: &str = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:getctag/></d:prop></d:propfind>"#;

#[derive(Debug, PartialEq, Default)]
pub struct Entry {
    pub uid: String,
    pub title: String,
    pub description: String,
    pub due: String,
    pub done: bool,
    pub kind: String,
}

fn unescape(v: &str) -> String {
    v.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",").replace(r"\;", ";").replace("\\\\", "\\")
}

fn escape(v: &str) -> String {
    v.replace('\\', "\\\\").replace(';', r"\;").replace(',', "\\,").replace('\n', "\\n")
}

/// `20261105T100000Z` or `20261105` to PocketBase's format.
/// shortcut: TZID local times are read as UTC, resolve them if offsets become visible in reminders.
fn ics_date(v: &str) -> String {
    let d: String = v.chars().filter(char::is_ascii_digit).collect();
    if d.len() < 8 {
        return String::new();
    }
    let t = if d.len() >= 14 { format!("{}:{}:{}", &d[8..10], &d[10..12], &d[12..14]) } else { "00:00:00".into() };
    format!("{}-{}-{} {t}.000Z", &d[..4], &d[4..6], &d[6..8])
}

fn pb_to_ics(v: &str) -> String {
    let d: String = v.chars().filter(char::is_ascii_digit).take(14).collect();
    if d.len() == 14 { format!("{}T{}Z", &d[..8], &d[8..]) } else { String::new() }
}

/// First VTODO or VEVENT of a calendar object.
pub fn parse_ics(text: &str) -> Option<Entry> {
    let unfolded = text.replace("\r\n", "\n").replace("\n ", "").replace("\n\t", "");
    let mut e = Entry::default();
    let mut inside = false;
    for line in unfolded.lines() {
        match line {
            "BEGIN:VTODO" => { inside = true; e.kind = "task".into(); continue }
            "BEGIN:VEVENT" => { inside = true; e.kind = "event".into(); continue }
            "END:VTODO" | "END:VEVENT" => break,
            _ => {}
        }
        if !inside {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        match key.split(';').next().unwrap_or(key) {
            "UID" => e.uid = value.into(),
            "SUMMARY" => e.title = unescape(value),
            "DESCRIPTION" => e.description = unescape(value),
            "DUE" => e.due = ics_date(value),
            "DTSTART" if e.due.is_empty() => e.due = ics_date(value),
            "STATUS" => e.done = value == "COMPLETED",
            _ => {}
        }
    }
    (!e.uid.is_empty()).then_some(e)
}

pub fn build_vtodo(uid: &str, title: &str, description: &str, due: &str, done: bool) -> String {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let mut lines = vec!["BEGIN:VCALENDAR".to_string(), "VERSION:2.0".into(), "PRODID:-//Nyx//Manager//EN".into(), "BEGIN:VTODO".into(), format!("UID:{uid}"), format!("DTSTAMP:{stamp}"), format!("SUMMARY:{}", escape(title))];
    if !description.is_empty() {
        lines.push(format!("DESCRIPTION:{}", escape(description)));
    }
    let due = pb_to_ics(due);
    if !due.is_empty() {
        lines.push(format!("DUE:{due}"));
    }
    lines.push(format!("STATUS:{}", if done { "COMPLETED" } else { "NEEDS-ACTION" }));
    lines.extend(["END:VTODO".to_string(), "END:VCALENDAR".into(), String::new()]);
    lines.join("\r\n")
}

/// `(href, etag, calendar-data)` from a multistatus response.
pub fn parse_multistatus(xml: &str) -> anyhow::Result<Vec<(String, String, String)>> {
    let doc = roxmltree::Document::parse(xml)?;
    let text = |n: roxmltree::Node, name: &str| n.descendants().find(|d| d.has_tag_name(name)).and_then(|d| d.text()).unwrap_or_default().to_string();
    Ok(doc.descendants().filter(|n| n.has_tag_name("response")).map(|r| (text(r, "href"), text(r, "getetag"), text(r, "calendar-data"))).filter(|x| !x.2.is_empty()).collect())
}

fn parse_ctag(xml: &str) -> Option<String> {
    let doc = roxmltree::Document::parse(xml).ok()?;
    let found = doc.descendants().find(|n| n.has_tag_name("getctag"))?.text()?.to_string();
    Some(found)
}

struct Dav {
    base: String,
    origin: String,
    user: String,
    password: String,
}

async fn dav(app: &App) -> anyhow::Result<Option<Dav>> {
    let Some(c) = app.core.pb.setting("nextcloud").await? else { return Ok(None) };
    let get = |k: &str| c[k].as_str().unwrap_or_default().to_string();
    let (url, user, password, calendar) = (get("url"), get("user"), get("password"), get("calendar"));
    if url.is_empty() || user.is_empty() || calendar.is_empty() {
        return Ok(None);
    }
    let origin = url.trim_end_matches('/').to_string();
    Ok(Some(Dav { base: format!("{origin}/remote.php/dav/calendars/{user}/{calendar}/"), origin, user, password }))
}

async fn request(app: &App, d: &Dav, method: &[u8], url: &str, depth: &str, body: String) -> anyhow::Result<String> {
    let res = app.http.request(Method::from_bytes(method)?, url).basic_auth(&d.user, Some(&d.password)).header("depth", depth).header("content-type", "application/xml; charset=utf-8").body(body).send().await?;
    let status = res.status();
    let text = res.text().await?;
    if !status.is_success() {
        bail!("Nextcloud answered {status}");
    }
    Ok(text)
}

/// Pull remote changes. Tasks with an empty etag are local edits awaiting upload.
pub async fn sync(app: &App) -> anyhow::Result<()> {
    let Some(d) = dav(app).await? else { return Ok(()) };
    let pb = &app.core.pb;
    for t in pb.list("tasks", "etag = ''", "").await? {
        push(app, &d, &t).await?;
    }
    let ctag = parse_ctag(&request(app, &d, b"PROPFIND", &d.base, "0", CTAG_BODY.into()).await?).context("no ctag")?;
    let mut last = app.ctag.lock().await;
    if *last == ctag {
        return Ok(());
    }
    let items = parse_multistatus(&request(app, &d, b"REPORT", &d.base, "1", REPORT_BODY.into()).await?)?;
    let local = pb.list("tasks", "uid != ''", "").await?;
    let mut remote_uids = vec![];
    for (href, etag, ics) in items {
        let Some(e) = parse_ics(&ics) else { continue };
        remote_uids.push(e.uid.clone());
        let body = json!({"title": e.title, "description": e.description, "due": e.due, "done": e.done, "uid": e.uid, "etag": etag, "href": href, "kind": e.kind});
        match local.iter().find(|t| t["uid"] == e.uid.as_str()) {
            Some(t) if t["etag"] == etag.as_str() => {}
            Some(t) => { pb.update("tasks", t["id"].as_str().unwrap_or_default(), &body).await?; }
            None => { pb.create("tasks", &body).await?; }
        }
    }
    for t in local.iter().filter(|t| !remote_uids.iter().any(|u| t["uid"] == u.as_str())) {
        pb.delete("tasks", t["id"].as_str().unwrap_or_default()).await?;
    }
    *last = ctag;
    Ok(())
}

async fn push(app: &App, d: &Dav, t: &Value) -> anyhow::Result<()> {
    let s = |k: &str| t[k].as_str().unwrap_or_default();
    let uid = if s("uid").is_empty() { random_hex(16) } else { s("uid").to_string() };
    let href = if s("href").is_empty() { format!("{}{uid}.ics", d.base) } else { format!("{}{}", d.origin, s("href")) };
    let ics = build_vtodo(&uid, s("title"), s("description"), s("due"), t["done"].as_bool().unwrap_or(false));
    let res = app.http.put(&href).basic_auth(&d.user, Some(&d.password)).header("content-type", "text/calendar; charset=utf-8").body(ics).send().await?;
    if !res.status().is_success() {
        bail!("Nextcloud refused the task: {}", res.status());
    }
    let etag = res.headers().get("etag").and_then(|v| v.to_str().ok()).unwrap_or("pending").to_string();
    let path = reqwest::Url::parse(&href)?.path().to_string();
    app.core.pb.update("tasks", s("id"), &json!({"uid": uid, "etag": etag, "href": path})).await?;
    Ok(())
}

/// Called after a local create or edit. A failure is not lost: the empty etag
/// makes the next sync retry.
pub async fn push_now(app: &App, task: &Value) {
    match dav(app).await {
        Ok(Some(d)) => {
            if let Err(e) = push(app, &d, task).await {
                eprintln!("nextcloud push: {e:#}");
            }
        }
        Ok(None) => {}
        Err(e) => eprintln!("nextcloud: {e:#}"),
    }
}

pub async fn delete_remote(app: &App, task: &Value) -> anyhow::Result<()> {
    let (Some(d), Some(href)) = (dav(app).await?, task["href"].as_str().filter(|h| !h.is_empty())) else { return Ok(()) };
    request(app, &d, b"DELETE", &format!("{}{href}", d.origin), "0", String::new()).await.map(drop)
}

pub async fn find_task(app: &App, id: &str) -> anyhow::Result<Option<Value>> {
    app.core.pb.first("tasks", &format!("id = {}", pb_quote(id))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_folded_escaped_vtodo() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:abc\r\nSUMMARY:Replace\\, the\r\n  disk\r\nDESCRIPTION:line1\\nline2\r\nDUE;VALUE=DATE:20261110\r\nSTATUS:COMPLETED\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
        let e = parse_ics(ics).unwrap();
        assert_eq!(e, Entry { uid: "abc".into(), title: "Replace, the disk".into(), description: "line1\nline2".into(), due: "2026-11-10 00:00:00.000Z".into(), done: true, kind: "task".into() });
    }

    #[test]
    fn events_use_their_start_and_timezone_params_are_ignored() {
        let e = parse_ics("BEGIN:VEVENT\nUID:e\nSUMMARY:Maintenance\nDTSTART;TZID=Europe/Paris:20261105T100000\nEND:VEVENT\n").unwrap();
        assert_eq!((e.kind.as_str(), e.due.as_str()), ("event", "2026-11-05 10:00:00.000Z"));
        assert!(parse_ics("BEGIN:VCALENDAR\nEND:VCALENDAR").is_none());
    }

    #[test]
    fn built_vtodo_parses_back() {
        let ics = build_vtodo("u1", "A, b; c", "x\ny", "2026-11-10 08:30:00.000Z", false);
        let e = parse_ics(&ics).unwrap();
        assert_eq!((e.title.as_str(), e.description.as_str(), e.due.as_str(), e.done), ("A, b; c", "x\ny", "2026-11-10 08:30:00.000Z", false));
        assert!(ics.contains("\r\n"));
    }

    #[test]
    fn reads_multistatus_and_ctag() {
        let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/a.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><cal:calendar-data>BEGIN:VCALENDAR</cal:calendar-data></d:prop></d:propstat></d:response></d:multistatus>"#;
        assert_eq!(parse_multistatus(xml).unwrap(), [("/dav/a.ics".into(), "\"1\"".into(), "BEGIN:VCALENDAR".into())]);
        let c = r#"<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:response><d:propstat><d:prop><cs:getctag>7</cs:getctag></d:prop></d:propstat></d:response></d:multistatus>"#;
        assert_eq!(parse_ctag(c).as_deref(), Some("7"));
    }
}

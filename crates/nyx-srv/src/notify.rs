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
use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Timelike, Utc};
use minijinja::{context, Environment};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{process::Stdio, sync::Arc};
use tokio::io::AsyncWriteExt;

pub const EVENT_TYPES: [&str; 7] = ["state", "update", "smart", "temperature", "task", "tempo", "pipeline"];
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

/// Card colours, the interface's own.
fn severity_color(severity: &str) -> u32 {
    match severity {
        "crit" => 0xfb909e,
        "warn" => 0xf2cf6d,
        "ok" => 0x91e3ae,
        "info" => 0x87d7f7,
        _ => 0xe38b4f,
    }
}

/// What a layout can put in an event's small print, in the order it lists them.
const SMALL: [(&str, &str); 4] = [
    ("host", r#"(e.host if e.host not in e.title else "")"#),
    ("type", "e.type_label"),
    ("when", "e.when"),
    ("severity", "e.severity_label"),
];

/// The title and body templates of a visual layout, as the web editor saves it, in the
/// channel's language. Null is the default layout: one card per event, worst first.
pub fn design_templates(d: &Value, lang: &str) -> (String, String) {
    let fr = lang == "fr";
    let flag = |k: &str| d[k].as_bool().unwrap_or(true);
    let text = |k: &str, or: &str| d[k].as_str().unwrap_or(or).trim().to_string();
    let mut parts: Vec<(String, bool)> = serde_json::from_value(d["parts"].clone()).unwrap_or_default();
    // Layouts saved before cards put a severity icon on every line: they start afresh.
    if parts.is_empty() || parts.iter().any(|(k, _)| k == "icon") {
        parts = [("type_icon", false), ("message", true), ("host", true), ("type", true), ("when", true), ("severity", false)].map(|(k, on)| (k.to_string(), on)).into();
    }
    let on = |k: &str| parts.iter().any(|(p, v)| p == k && *v);
    let sep = serde_json::to_string(d["sep"].as_str().unwrap_or(" · ")).unwrap_or_default();
    let small: Vec<&str> = parts.iter().filter(|(_, v)| *v).filter_map(|(k, _)| SMALL.iter().find(|(s, _)| s == k).map(|(_, e)| *e)).collect();
    let small = if small.is_empty() { r#"{% set s = "" %}"#.to_string() } else { ["{% set s = [", &small.join(", "), "]|select|join(", &sep, ") %}"].concat() };
    let (events, more, colon) = if fr {
        ("{{ count }} événement{{ 's' if count != 1 }}", "… et {{ count - N }} de plus", " : ")
    } else {
        ("{{ count }} event{{ 's' if count != 1 }}", "… and {{ count - N }} more", ": ")
    };

    let name = text("title", "Nyx");
    let title = [name.as_str(), if flag("count") { events } else { "" }].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(colon);
    let title = if flag("icon") { ["{{ icon }} ", &title].concat().trim_end().to_string() } else { title };

    let sorted = match d["order"].as_str().unwrap_or("worst") {
        "old" => "events",
        "new" => "events|reverse",
        _ => r#"events|sort(attribute="rank")"#,
    };
    let limit = d["limit"].as_f64().unwrap_or(0.0).max(0.0) as usize;
    let heading = if on("type_icon") { "{{ e.type_icon }} {{ e.title }}" } else { "{{ e.title }}" };
    let message = |before: &str, after: &str| if on("message") { ["{% if e.message %}", before, "{{ e.message }}", after, "{% endif %}"].concat() } else { String::new() };
    let mut body = text("header", "");
    if !body.is_empty() {
        body.push('\n');
    }
    body += &["{% set shown = (", sorted, ")", &if limit > 0 { format!("[:{limit}]") } else { String::new() }, " %}"].concat();
    body += &match d["group"].as_str().unwrap_or_default() {
        group @ ("host" | "type" | "rank") => {
            let head = match group {
                "host" => r#"{{ g.grouper or "—" }}"#,
                "type" => "{{ g.list[0].type_icon }} {{ g.list[0].type_label }}",
                _ => "{{ g.list[0].severity_label }}",
            };
            // One card per group, in the colour of its worst event, one line per event.
            let sep_out = ["{{ ", &sep, " }}"].concat();
            [
                r#"{% for g in shown|groupby(""#, group, r#"") %}::: {{ (g.list|sort(attribute="rank")|first).severity }}"#, "\n**", head, "**\n",
                "{% for e in g.list %}", &small, "{{ e.icon }} **", heading, "**", &message(&sep_out, ""), "{% if s %}", &sep_out, "{{ s }}{% endif %}\n{% endfor %}{% endfor %}",
            ]
            .concat()
        }
        _ => ["{% for e in shown %}::: {{ e.severity }}\n**", heading, "**\n", &message("", "\n"), &small, "{% if s %}-# {{ s }}\n{% endif %}{% endfor %}"].concat(),
    };
    if limit > 0 {
        body += &format!("{{% if count > {limit} %}}:::\n{}\n{{% endif %}}", more.replace('N', &limit.to_string()));
    }
    let footer = text("footer", "");
    if !footer.is_empty() {
        body += &[":::\n", &footer].concat();
    }
    (title, body)
}

/// A channel's templates: its visual layout when it has one, else those written by hand.
fn templates_of(c: &Value) -> (String, String) {
    let s = |k: &str| c[k].as_str().unwrap_or_default().to_string();
    if c["design"].is_object() { design_templates(&c["design"], &s("lang")) } else { (s("title_tpl"), s("body_tpl")) }
}

/// One event, or one group of them, drawn in the colour of its severity.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Card {
    pub severity: String,
    pub title: String,
    pub lines: Vec<String>,
    pub small: Vec<String>,
}

/// A rendered body: its cards, and the free text before and after them.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Message {
    pub head: Vec<String>,
    pub cards: Vec<Card>,
    pub tail: Vec<String>,
}

/// `::: crit` (or warn, info, ok) opens a card and `:::` alone closes it. In a card, a
/// first line in `**…**` is its title and `-# …` lines its small print, as on Discord.
/// Blank lines inside cards are dropped, so templates need not mind their whitespace.
pub fn parse(body: &str) -> Message {
    let mut m = Message::default();
    let mut open: Option<Card> = None;
    for line in body.lines() {
        let l = line.trim();
        if let Some(severity) = l.strip_prefix(":::") {
            m.cards.extend(open.take());
            let severity = severity.trim();
            open = (!severity.is_empty()).then(|| Card { severity: severity.into(), ..Card::default() });
            continue;
        }
        let Some(c) = open.as_mut() else {
            (if m.cards.is_empty() { &mut m.head } else { &mut m.tail }).push(line.trim_end().into());
            continue;
        };
        let title = (c.title.is_empty() && c.lines.is_empty()).then(|| l.strip_prefix("**")?.strip_suffix("**")).flatten();
        if l.is_empty() {
        } else if let Some(small) = l.strip_prefix("-#") {
            c.small.push(small.trim().into());
        } else if let Some(t) = title.filter(|t| !t.is_empty() && !t.contains("**")) {
            c.title = t.into();
        } else {
            c.lines.push(l.into());
        }
    }
    m.cards.extend(open);
    for text in [&mut m.head, &mut m.tail] {
        while text.last().is_some_and(|l| l.trim().is_empty()) {
            text.pop();
        }
        let blank = text.iter().take_while(|l| l.trim().is_empty()).count();
        text.drain(..blank);
    }
    m
}

/// `**bold**` in another markup. A `**` without a partner stays as it is.
fn bold(s: &str, open: &str, close: &str) -> String {
    let parts: Vec<&str> = s.split("**").collect();
    let paired = (parts.len() - 1) / 2 * 2;
    let mut out = parts[0].to_string();
    for (i, p) in parts[1..].iter().enumerate() {
        out += if i >= paired { "**" } else if i % 2 == 0 { open } else { close };
        out += p;
    }
    out
}

fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.into() } else { s.chars().take(max - 1).collect::<String>() + "…" }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn same(s: &str) -> String {
    s.into()
}

/// How a text app writes bold and small print, breaks a line inside a card, and
/// separates cards. Without colours, the severity icon leads each card.
struct Markup {
    bold: (&'static str, &'static str),
    small: (&'static str, &'static str),
    br: &'static str,
    gap: &'static str,
    esc: fn(&str) -> String,
}

const PLAIN: Markup = Markup { bold: ("", ""), small: ("", ""), br: "\n", gap: "\n\n", esc: same };

fn text(m: &Message, k: &Markup) -> String {
    let line = |s: &str| bold(&(k.esc)(s), k.bold.0, k.bold.1);
    let nl = if k.br.contains('\n') { k.br } else { "\n" };
    let free = |t: &[String]| t.iter().map(|l| line(l)).collect::<Vec<_>>().join(nl);
    let mut blocks = vec![free(&m.head)];
    for c in &m.cards {
        let mut out = vec![];
        if !c.title.is_empty() {
            out.push([k.bold.0, &(k.esc)(&c.title), k.bold.1].concat());
        }
        out.extend(c.lines.iter().map(|l| line(l)));
        out.extend(c.small.iter().map(|l| [k.small.0, &(k.esc)(l), k.small.1].concat()));
        if let Some(first) = out.first_mut() {
            *first = format!("{} {first}", severity_icon(&c.severity));
        }
        blocks.push(out.join(k.br));
    }
    blocks.push(free(&m.tail));
    blocks.retain(|b| !b.is_empty());
    blocks.join(k.gap)
}

/// A Discord webhook payload: the title in bold, then an embed per card in its colour,
/// its small print as the footer. At most 10 embeds and 6000 characters: what does not
/// fit is listed in a last embed.
fn discord(title: &str, m: &Message) -> String {
    let embed = |c: &Card| {
        let mut e = json!({ "color": severity_color(&c.severity) });
        if !c.title.is_empty() {
            e["title"] = cut(&c.title, 190).into();
        }
        if !c.lines.is_empty() {
            e["description"] = cut(&c.lines.join("\n"), 300).into();
        }
        if !c.small.is_empty() {
            e["footer"] = json!({ "text": cut(&c.small.join("\n"), 100) });
        }
        e
    };
    let note = |lines: Vec<String>| json!({ "description": cut(&lines.join("\n"), 590) });
    let mut embeds = vec![];
    if !m.head.is_empty() {
        embeds.push(note(m.head.clone()));
    }
    let room = 10 - embeds.len();
    let n = if m.tail.is_empty() && m.cards.len() <= room { m.cards.len() } else { m.cards.len().min(room - 1) };
    embeds.extend(m.cards[..n].iter().map(embed));
    let mut rest: Vec<String> = m.cards[n..].iter().map(|c| format!("{} {}", severity_icon(&c.severity), if c.title.is_empty() { c.lines.first().map_or("", String::as_str) } else { &c.title })).collect();
    rest.extend(m.tail.iter().cloned());
    if !rest.is_empty() {
        embeds.push(note(rest));
    }
    // Event texts come from hosts: they must not ping anyone.
    json!({ "content": format!("**{}**", cut(title, 250)), "embeds": embeds, "allowed_mentions": { "parse": [] } }).to_string()
}

/// An HTML mail: a card per event with its colour on the left. The template engine
/// escaped the text already.
fn email(title: &str, m: &Message) -> String {
    let p = |lines: &[String], style: &str| {
        if lines.is_empty() {
            return String::new();
        }
        let lines: Vec<String> = lines.iter().map(|l| bold(l, "<strong>", "</strong>")).collect();
        format!(r#"<p style="{style}">{}</p>"#, lines.join("<br>"))
    };
    let cards: String = m
        .cards
        .iter()
        .map(|c| {
            let title = if c.title.is_empty() { String::new() } else { format!(r#"<div style="font-weight:600;font-size:15px">{}</div>"#, c.title) };
            format!(
                r#"<div style="background:#222b36;border-left:4px solid #{:06x};border-radius:12px;padding:12px 16px;margin-top:10px">{title}{}{}</div>"#,
                severity_color(&c.severity),
                p(&c.lines, "margin:4px 0 0;color:#d3dae3"),
                p(&c.small, "margin:6px 0 0;color:#8b96a3;font-size:12px"),
            )
        })
        .collect();
    format!(
        r#"<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#141a22;color:#edf1f6;padding:32px 16px"><div style="max-width:560px;margin:auto;background:#1b232d;border-radius:24px;padding:28px"><h2 style="margin:0;font-size:20px">{title}</h2>{}{cards}{}</div></div>"#,
        p(&m.head, "margin:6px 0 4px;color:#bcc6d2"),
        p(&m.tail, "margin:16px 0 0;color:#8b96a3;font-size:13px"),
    )
}

/// What `nyx-notify` gets: the URL with the options the look needs, the message as the
/// app shows it best, and an HTML version for encrypted Matrix.
#[derive(Debug, PartialEq)]
pub struct Out {
    pub url: String,
    pub message: String,
    pub html: String,
}

// {"client::display": {"contentType": "text/markdown"}}
const GOTIFY_MARKDOWN: &str = "extras=%7B%22client%3A%3Adisplay%22%3A%7B%22contentType%22%3A%22text%2Fmarkdown%22%7D%7D";

pub fn compose(url: &str, html: bool, title: &str, body: &str) -> Out {
    let m = parse(body);
    let lower = url.to_ascii_lowercase();
    let has = |k: &str| lower.contains(&format!("{k}="));
    let out = |url: String, message: String| Out { url, message, html: String::new() };
    let md = |br| Markup { bold: ("**", "**"), small: ("_", "_"), br, gap: "\n\n", esc: same };
    match lower.split(':').next().unwrap_or_default() {
        "smtp" if html => out(add_param(url, "usehtml=yes"), if m.cards.is_empty() { body.into() } else { email(title, &m) }),
        "discord" if !has("json") && !lower.contains("/raw") => out(add_param(url, "json=yes"), discord(title, &m)),
        "telegram" if !has("parsemode") => out(add_param(url, "parsemode=HTML"), text(&m, &Markup { bold: ("<b>", "</b>"), small: ("<i>", "</i>"), esc, ..PLAIN })),
        "slack" => out(url.into(), text(&m, &Markup { bold: ("*", "*"), small: ("_", "_"), br: " · ", gap: "\n", esc: same })),
        "teams" => out(url.into(), text(&m, &md("\n"))),
        "gotify" if !has("extras") => out(add_param(url, GOTIFY_MARKDOWN), text(&m, &md("  \n"))),
        "matrix" => Out { url: url.into(), message: text(&m, &PLAIN), html: text(&m, &Markup { bold: ("<strong>", "</strong>"), small: ("<em>", "</em>"), esc, ..PLAIN }) },
        _ => out(url.into(), text(&m, &PLAIN)),
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

/// What a rule lets through, and what holds an instant digest back, beyond its timing.
#[derive(Debug, Deserialize, Default)]
pub struct Filter {
    /// Empty: every severity. `ok` is a problem that resolved.
    #[serde(default)]
    pub severities: Option<Vec<String>>,
    /// Comma-separated host names. Empty: every host, and events without one.
    #[serde(default)]
    pub hosts: String,
    /// Local hours, from included to excluded; equal hours mean none.
    #[serde(default)]
    pub quiet_from: u32,
    #[serde(default)]
    pub quiet_to: u32,
    /// Critical events still go out in quiet hours.
    #[serde(default)]
    pub quiet_crit: bool,
    /// Waits this long after the first event, to send the ones that follow with it.
    #[serde(default)]
    pub delay_s: i64,
    /// A problem that resolved before the digest left is not told at all.
    #[serde(default)]
    pub skip_resolved: bool,
}

impl Filter {
    /// PocketBase filter clauses, appended to the event types.
    fn query(&self) -> String {
        let any = |field: &str, values: Vec<&str>| {
            if values.is_empty() {
                return String::new();
            }
            format!(" && ({})", values.iter().map(|v| format!("{field} = {}", pb_quote(v))).collect::<Vec<_>>().join(" || "))
        };
        let severities = self.severities.iter().flatten().map(String::as_str).filter(|s| SEVERITIES.contains(s)).collect();
        let hosts = self.hosts.split(',').map(str::trim).filter(|h| !h.is_empty()).collect();
        any("severity", severities) + &any("host", hosts)
    }

    pub fn quiet(&self, hour: u32) -> bool {
        let (from, to) = (self.quiet_from, self.quiet_to);
        if from < to { (from..to).contains(&hour) } else { from != to && (hour >= from || hour < to) }
    }
}

/// Drops each problem that resolved within the same digest, and its "Resolved".
pub fn skip_resolved(events: Vec<Value>) -> Vec<Value> {
    let mut gone = vec![false; events.len()];
    for (i, e) in events.iter().enumerate() {
        let Some(problem) = e["title"].as_str().and_then(|t| t.strip_prefix("Resolved: ")) else { continue };
        let open = (0..i).rev().find(|&j| !gone[j] && events[j]["title"] == problem && events[j]["host"] == e["host"]);
        if let Some(j) = open {
            (gone[i], gone[j]) = (true, true);
        }
    }
    events.into_iter().zip(gone).filter(|(_, g)| !g).map(|(e, _)| e).collect()
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

const SEVERITIES: [&str; 4] = ["crit", "warn", "info", "ok"];

/// Render `(title, body)` in the channel's language. Autoescape only for HTML mails.
pub fn render(title_tpl: &str, body_tpl: &str, html: bool, lang: &str, events: &[Value]) -> anyhow::Result<(String, String)> {
    let mut env = Environment::new();
    env.set_auto_escape_callback(move |_| if html { minijinja::AutoEscape::Html } else { minijinja::AutoEscape::None });
    let worst = SEVERITIES[..3].iter().copied().find(|s| events.iter().any(|e| e["severity"] == *s)).unwrap_or("ok");
    let events: Vec<Value> = events.iter().map(|e| event_context(e, lang)).collect();
    let count = |s: &str| events.iter().filter(|e| e["severity"] == s).count();
    let mut hosts: Vec<&str> = events.iter().filter_map(|e| e["host"].as_str()).filter(|h| !h.is_empty()).collect();
    hosts.sort_unstable();
    hosts.dedup();
    let ctx = context! { events, count => events.len(), icon => severity_icon(worst), crit => count("crit"), warn => count("warn"), hosts, lang };
    let (default_title, default_body) = design_templates(&Value::Null, lang);
    let title_tpl = if title_tpl.is_empty() { &default_title } else { title_tpl };
    let body_tpl = if body_tpl.is_empty() { &default_body } else { body_tpl };
    Ok((env.render_str(title_tpl, &ctx)?, env.render_str(body_tpl, &ctx)?))
}

/// An event as templates see it: translated, with its icons, labels and local time.
fn event_context(e: &Value, lang: &str) -> Value {
    let mut e = e.clone();
    let Some(o) = e.as_object_mut() else { return e };
    let text = |o: &serde_json::Map<String, Value>, k: &str| o.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let (severity, kind) = (text(o, "severity"), text(o, "type"));
    let at = parse_date(o.get("created").unwrap_or(&Value::Null)).map(|d| d.with_timezone(&Local));
    let extra = [
        ("title", crate::lang::tr(lang, &text(o, "title"))),
        ("message", crate::lang::tr(lang, &text(o, "message"))),
        ("icon", severity_icon(&severity).into()),
        ("type_icon", type_icon(&kind).into()),
        ("type_label", crate::lang::word(lang, &kind).into()),
        ("severity_label", crate::lang::word(lang, &severity).into()),
        ("time", at.map(|d| d.format("%H:%M").to_string()).unwrap_or_default()),
        ("when", at.map(|d| d.format(if lang == "fr" { "%d/%m %H:%M" } else { "%b %-d, %H:%M" }).to_string()).unwrap_or_default()),
    ];
    for (k, v) in extra {
        o.insert(k.into(), v.into());
    }
    o.insert("rank".into(), SEVERITIES.iter().position(|s| *s == severity).unwrap_or(2).into());
    e
}

/// One `nyx-notify` process per delivery: nothing stays resident between digests.
pub async fn deliver(core: &Core, url: &str, html: bool, title: &str, body: &str) -> anyhow::Result<()> {
    let out = compose(url, html, title, body);
    let mut child = tokio::process::Command::new(&core.env.notifier_bin)
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .with_context(|| format!("cannot start {}", core.env.notifier_bin))?;
    // Encrypted Matrix keeps its device in the data folder.
    let payload = serde_json::to_vec(&json!({"url": out.url, "title": title, "message": out.message, "html": out.html, "state_dir": core.env.data_dir}))?;
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
        let f: Filter = serde_json::from_value(rule.clone()).unwrap_or_default();
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
        let filter = format!("created > {} && ({kinds}){}", pb_quote(&pb_date(since)), f.query());
        let mut events = core.pb.list("notif_events", &filter, "created").await?;
        if f.skip_resolved {
            events = skip_resolved(events);
        }
        if matches!(timing.schedule.as_str(), "" | "instant") && !events.is_empty() {
            // Held, not dropped: they go out with the first digest that leaves.
            let first = parse_date(&events[0]["created"]).unwrap_or(now.to_utc());
            let crit = f.quiet_crit && events.iter().any(|e| e["severity"] == "crit");
            if now.to_utc() - first < Duration::seconds(f.delay_s) || (f.quiet(now.hour()) && !crit) {
                continue;
            }
        }
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
    let (title_tpl, body_tpl) = templates_of(&channel);
    let (title, body) = render(&title_tpl, &body_tpl, html, channel["lang"].as_str().unwrap_or(""), events)?;
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

/// Oldest first, as a digest gets them.
fn sample_events() -> Vec<Value> {
    vec![
        json!({"type": "state", "severity": "ok", "title": "Resolved: web-01: memory at 93%", "message": "", "host": "web-01", "created": "2026-11-05 03:12:00.000Z"}),
        json!({"type": "update", "severity": "info", "title": "docker-01: 12 updates available", "message": "3 security updates", "host": "docker-01", "created": "2026-11-05 04:00:00.000Z"}),
        json!({"type": "temperature", "severity": "warn", "title": "pve-01: 84 °C", "message": "", "host": "pve-01", "created": "2026-11-05 13:05:00.000Z"}),
        json!({"type": "smart", "severity": "warn", "title": "nas-01: /dev/sda 8 bad sectors", "message": "", "host": "nas-01", "created": "2026-11-05 14:20:00.000Z"}),
        json!({"type": "state", "severity": "crit", "title": "backup-01 is not responding", "message": "", "host": "backup-01", "created": "2026-11-05 14:32:00.000Z"}),
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
    #[serde(default)]
    lang: String,
    #[serde(default)]
    design: Value,
}

/// The sample digest as cards, its plain text and HTML mail, and the templates of the layout.
async fn preview(_: Session, Json(p): Json<Preview>) -> ApiResult<Json<Value>> {
    let (title_tpl, body_tpl) = templates_of(&json!({"design": p.design, "lang": p.lang, "title_tpl": p.title_tpl, "body_tpl": p.body_tpl}));
    let (title, body) = render(&title_tpl, &body_tpl, p.html, &p.lang, &sample_events()).map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    let m = parse(&body);
    let plain = compose("generic://", false, &title, &body).message;
    let email = p.html.then(|| compose("smtp://", true, &title, &body).message);
    Ok(Json(json!({"title": title, "head": m.head, "cards": m.cards, "tail": m.tail, "plain": plain, "email": email, "title_tpl": title_tpl, "body_tpl": body_tpl})))
}

async fn test_channel(_: Session, State(core): State<Arc<Core>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let c = core.pb.get("notif_channels", &id).await.map_err(|_| ApiError::not_found())?;
    let html = c["html"].as_bool().unwrap_or(false);
    let (title_tpl, body_tpl) = templates_of(&c);
    let (title, body) = render(&title_tpl, &body_tpl, html, c["lang"].as_str().unwrap_or(""), &sample_events()).map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
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
        let (_, plain) = render("", "{{ events[0].title }}", false, "", &ev).unwrap();
        let (title, html) = render("", "{{ events[0].title }}", true, "", &ev).unwrap();
        assert_eq!((plain.as_str(), title.as_str()), ("<b>x</b>", "🔴 Nyx: 1 event"));
        assert!(html.contains("&lt;b&gt;"));
        assert!(render("{{", "", false, "", &ev).is_err());
    }

    fn card(severity: &str, title: &str, lines: &[&str], small: &[&str]) -> Card {
        let own = |v: &[&str]| v.iter().map(|s| s.to_string()).collect();
        Card { severity: severity.into(), title: title.into(), lines: own(lines), small: own(small) }
    }

    #[test]
    fn default_layout_is_a_card_per_event_worst_first_without_repeating_the_host() {
        let ev = [
            json!({"type": "update", "severity": "info", "title": "12 updates", "message": "", "host": "web"}),
            json!({"type": "smart", "severity": "warn", "title": "nas: /dev/sda failing", "message": "Replace it", "host": "nas"}),
        ];
        let (title, body) = render("", "", false, "", &ev).unwrap();
        assert_eq!(title, "🟠 Nyx: 2 events");
        let m = parse(&body);
        assert_eq!(m.cards, [card("warn", "nas: /dev/sda failing", &["Replace it"], &["SMART"]), card("info", "12 updates", &[], &["web · Updates"])]);
        assert!(m.head.is_empty() && m.tail.is_empty(), "{body:?}");
    }

    #[test]
    fn layouts_group_cap_and_frame_the_cards() {
        let ev: Vec<Value> = ["a", "b", "a"].iter().enumerate().map(|(i, h)| json!({"type": "state", "severity": (["warn", "info", "crit"][i]), "title": format!("{h} {i}"), "message": "", "host": h})).collect();
        let d = json!({"group": "host", "limit": 2, "order": "old", "header": "Hello", "footer": "Bye", "parts": [["type", true]]});
        let (_, body_tpl) = design_templates(&d, "fr");
        let (_, body) = render("x", &body_tpl, false, "fr", &ev).unwrap();
        let m = parse(&body);
        assert_eq!(m.head, ["Hello"]);
        assert_eq!(m.cards, [card("warn", "a", &["🟠 **a 0** · État"], &[]), card("info", "b", &["🔵 **b 1** · État"], &[])]);
        assert_eq!(m.tail, ["… et 1 de plus", "Bye"]);
        let (title, _) = design_templates(&json!({"icon": false, "count": false, "title": "Homelab"}), "fr");
        assert_eq!(title, "Homelab");
    }

    #[test]
    fn cards_have_a_title_lines_and_small_print() {
        let m = parse("Intro\n\n::: crit\n**web down**\n\nsince 10:00 **now**\n-# State · 10:02\n::: ok\n**a** and **b**\n:::\nBye\n");
        assert_eq!(m.head, ["Intro"]);
        assert_eq!(m.cards, [card("crit", "web down", &["since 10:00 **now**"], &["State · 10:02"]), card("ok", "", &["**a** and **b**"], &[])]);
        assert_eq!(m.tail, ["Bye"]);
        assert_eq!(parse("just text\nno cards").head, ["just text", "no cards"]);
    }

    #[test]
    fn each_app_gets_its_own_markup() {
        let body = "::: crit\n**web <down>**\nsince **10:00**\n-# State\n::: ok\n**db back**\n";
        let discord = compose("discord://t@1", false, "Nyx: 2 events", body);
        assert_eq!(discord.url, "discord://t@1?json=yes");
        let v: Value = serde_json::from_str(&discord.message).unwrap();
        assert_eq!(v["content"], "**Nyx: 2 events**");
        assert_eq!(v["embeds"][0], json!({"color": 0xfb909e, "title": "web <down>", "description": "since **10:00**", "footer": {"text": "State"}}));
        assert_eq!(v["embeds"][1]["color"], 0x91e3ae);
        assert_eq!(v["allowed_mentions"], json!({"parse": []}));

        let tg = compose("telegram://x@telegram?chats=1", false, "t", body);
        assert_eq!(tg.url, "telegram://x@telegram?chats=1&parsemode=HTML");
        assert_eq!(tg.message, "🔴 <b>web &lt;down&gt;</b>\nsince <b>10:00</b>\n<i>State</i>\n\n🟢 <b>db back</b>");
        assert_eq!(compose("slack://x", false, "t", body).message, "🔴 *web <down>* · since *10:00* · _State_\n🟢 *db back*");
        assert_eq!(compose("ntfy://x", false, "t", body).message, "🔴 web <down>\nsince 10:00\nState\n\n🟢 db back");
        let matrix = compose("matrix://x", false, "t", body);
        assert!(matrix.html.starts_with("🔴 <strong>web &lt;down&gt;</strong>\n") && matrix.html.contains("<em>State</em>"), "{}", matrix.html);
        assert!(compose("gotify://x/t", false, "t", body).url.contains("extras=%7B"));

        let mail = compose("smtp://a/?to=b", true, "Nyx", body);
        assert_eq!(mail.url, "smtp://a/?to=b&usehtml=yes");
        assert!(mail.message.contains("border-left:4px solid #fb909e") && mail.message.contains("since <strong>10:00</strong>"));
        assert_eq!(compose("smtp://a/", true, "t", "<p>hand written</p>").message, "<p>hand written</p>");
    }

    #[test]
    fn discord_keeps_to_ten_embeds() {
        let body: String = (0..14).map(|i| format!("::: warn\n**event {i}**\n")).collect();
        let v: Value = serde_json::from_str(&compose("discord://t@1", false, "t", &body).message).unwrap();
        let embeds = v["embeds"].as_array().unwrap();
        assert_eq!(embeds.len(), 10);
        assert_eq!(embeds[9]["description"], "🟠 event 9\n🟠 event 10\n🟠 event 11\n🟠 event 12\n🟠 event 13");
        assert_eq!(bold("a ** b", "<b>", "</b>"), "a ** b");
        assert_eq!(bold("**a** **b", "<b>", "</b>"), "<b>a</b> **b");
    }

    #[test]
    fn channels_in_french_get_french_messages() {
        let ev = [json!({"type": "smart", "severity": "warn", "title": "nas: /dev/sda 8 bad sectors", "message": "", "host": "nas", "created": "2026-11-05 14:20:00.000Z"})];
        let (title, body) = render("", "{{ events[0].type_label }} · {{ events[0].severity_label }}: {{ events[0].title }}", false, "fr", &ev).unwrap();
        assert_eq!((title.as_str(), body.as_str()), ("🟠 Nyx : 1 événement", "SMART · Attention: nas : /dev/sda 8 secteurs défectueux"));
    }

    #[test]
    fn rules_filter_by_severity_and_host() {
        let f = Filter { severities: Some(vec!["crit".into(), "bogus".into()]), hosts: "nas, web".into(), ..Filter::default() };
        assert_eq!(f.query(), " && (severity = 'crit') && (host = 'nas' || host = 'web')");
        assert_eq!(Filter::default().query(), "");
        let rule: Filter = serde_json::from_value(json!({"severities": null, "hosts": "", "quiet_from": 22, "quiet_to": 7})).unwrap();
        assert!(rule.quiet(23) && rule.quiet(3) && !rule.quiet(7) && !rule.quiet(12));
        assert!(Filter { quiet_from: 12, quiet_to: 14, ..Filter::default() }.quiet(13));
        assert!(!Filter { quiet_from: 9, quiet_to: 9, ..Filter::default() }.quiet(9));
    }

    #[test]
    fn a_problem_that_resolved_in_the_same_digest_is_not_told() {
        let e = |title: &str, host: &str| json!({"title": title, "host": host});
        let kept = skip_resolved(vec![e("web: memory at 91%", "web"), e("nas is not responding", "nas"), e("Resolved: web: memory at 91%", "web"), e("Resolved: db is not responding", "db")]);
        assert_eq!(kept, [e("nas is not responding", "nas"), e("Resolved: db is not responding", "db")]);
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

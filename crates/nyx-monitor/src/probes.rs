//! Active checks: ICMP, HTTP(S), DNS, TLS certificate expiry and SNMP.
//!
//! Hundreds of probes must stay cheap: start times are spread out, at most
//! [`MAX_CONCURRENT`] run at once, and sockets and HTTP clients are shared.

use crate::{
    snmp,
    state::{App, Wanted},
};
use anyhow::{bail, Context};
use chrono::Utc;
use hickory_resolver::{
    config::{NameServerConfig, ResolverConfig},
    net::runtime::TokioRuntimeProvider,
    Resolver,
};
use serde_json::{json, Value};
use tokio::sync::Semaphore;
use std::{
    collections::{HashMap, VecDeque},
    net::IpAddr,
    sync::Arc,
    time::{Duration, Instant},
};

const HISTORY: usize = 60;
/// Consecutive failures before alerting, so one lost packet stays silent.
const FAILS_TO_ALERT: u32 = 2;
const CERT_CRIT_DAYS: i64 = 7;
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const SNMP_TIMEOUT: Duration = Duration::from_secs(25);
const DEFAULT_INTERVAL_S: u64 = 60;
const MAX_CONCURRENT: usize = 32;
/// Upper bound of the start offset that keeps probes from firing together.
const MAX_STAGGER_S: u64 = 30;

/// Long-lived handles shared by every probe.
pub struct Shared {
    limit: Semaphore,
    icmp4: Option<surge_ping::Client>,
    icmp6: Option<surge_ping::Client>,
    /// Accepts any certificate, so expired ones can still be measured.
    cert_http: reqwest::Client,
}

impl Shared {
    pub fn new() -> anyhow::Result<Self> {
        let icmp = |kind| surge_ping::Client::new(&surge_ping::Config::builder().kind(kind).build()).map_err(|e| eprintln!("ICMP socket unavailable ({kind:?}): {e}")).ok();
        Ok(Self {
            limit: Semaphore::new(MAX_CONCURRENT),
            icmp4: icmp(surge_ping::ICMP::V4),
            icmp6: icmp(surge_ping::ICMP::V6),
            cert_http: reqwest::Client::builder().tls_danger_accept_invalid_certs(true).tls_info(true).timeout(CHECK_TIMEOUT).redirect(reqwest::redirect::Policy::none()).build()?,
        })
    }
}

#[derive(Clone)]
pub struct ProbeDef {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub target: String,
    pub interval_s: u64,
    pub dns_server: String,
    pub warn_days: i64,
    pub expect_status: u16,
    /// An `https://` website probe also follows its certificate.
    pub watch_cert: bool,
    pub snmp: Option<Arc<snmp::Config>>,
}

pub struct ProbeLive {
    pub def: ProbeDef,
    pub next: Instant,
    pub running: bool,
    pub up: Option<bool>,
    pub latency_ms: f64,
    pub message: String,
    pub cert_days: Option<i64>,
    pub fails: u32,
    pub history: VecDeque<bool>,
    /// `(unix time, ms)`, for charts on wall displays.
    pub latencies: VecDeque<(i64, f32)>,
    pub readings: Vec<snmp::Reading>,
    counters: HashMap<String, (f64, Instant)>,
    window_up: u32,
    window_total: u32,
    window_latency: f64,
    /// Sum and sample count per SNMP value since the last rollup.
    window_values: HashMap<String, (f64, u32)>,
}

impl ProbeLive {
    pub(crate) fn new(def: ProbeDef) -> Self {
        let spread = def.interval_s.min(MAX_STAGGER_S).max(1);
        let offset = def.id.bytes().map(u64::from).sum::<u64>() % spread;
        Self {
            def, next: Instant::now() + Duration::from_secs(offset), running: false, up: None, latency_ms: 0.0, message: String::new(), cert_days: None,
            fails: 0, history: VecDeque::new(), latencies: VecDeque::new(), readings: vec![], counters: HashMap::new(), window_up: 0, window_total: 0, window_latency: 0.0, window_values: HashMap::new(),
        }
    }

    /// `(up, total, mean latency, mean SNMP values)` since the last call.
    pub fn take_rollup(&mut self) -> (u32, u32, f64, Value) {
        let latency = if self.window_up > 0 { self.window_latency / self.window_up as f64 } else { 0.0 };
        let values: serde_json::Map<String, Value> = self.window_values.drain().map(|(k, (sum, n))| (k, json!(sum / n as f64))).collect();
        let out = (self.window_up, self.window_total, latency, Value::Object(values));
        (self.window_up, self.window_total, self.window_latency) = (0, 0, 0.0);
        out
    }

    fn record(&mut self, result: anyhow::Result<Outcome>) {
        let up = result.is_ok();
        self.up = Some(up);
        self.fails = if up { 0 } else { self.fails + 1 };
        if self.history.len() == HISTORY {
            self.history.pop_front();
        }
        self.history.push_back(up);
        self.window_total += 1;
        match result {
            Ok(o) => {
                self.window_up += 1;
                self.window_latency += o.latency_ms;
                self.latency_ms = o.latency_ms;
                if self.latencies.len() == crate::state::RAM_POINTS {
                    self.latencies.pop_front();
                }
                self.latencies.push_back((chrono::Utc::now().timestamp(), o.latency_ms as f32));
                self.message = o.message;
                self.cert_days = o.cert_days;
                if let Some(cfg) = &self.def.snmp {
                    self.readings = snmp::readings(&cfg.items, o.snmp, &mut self.counters, Instant::now());
                    for r in &self.readings {
                        if let Some(v) = r.value {
                            let e = self.window_values.entry(r.label.clone()).or_default();
                            e.0 += v;
                            e.1 += 1;
                        }
                    }
                }
            }
            Err(e) => self.message = format!("{e:#}"),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({"id": self.def.id, "name": self.def.name, "type": self.def.kind, "target": self.def.target, "up": self.up,
            "latency_ms": self.latency_ms, "message": self.message, "cert_days": self.cert_days, "warn_days": self.def.warn_days,
            "readings": self.readings, "history": self.history.iter().collect::<Vec<_>>()})
    }
}

#[derive(Default)]
pub struct Outcome {
    latency_ms: f64,
    message: String,
    cert_days: Option<i64>,
    snmp: Vec<snmp::Val>,
}

fn parse_def(r: &Value) -> ProbeDef {
    let s = |k: &str| r[k].as_str().unwrap_or_default().to_string();
    let n = |k: &str| r[k].as_u64().unwrap_or(0);
    ProbeDef {
        id: s("id"),
        name: s("name"),
        kind: s("type"),
        target: s("target"),
        interval_s: Some(n("interval_s")).filter(|i| *i > 0).unwrap_or(DEFAULT_INTERVAL_S).max(10),
        dns_server: s("dns_server"),
        warn_days: Some(n("warn_days") as i64).filter(|d| *d > 0).unwrap_or(21),
        expect_status: n("expect_status") as u16,
        watch_cert: s("target").starts_with("https://"),
        snmp: (r["type"] == "snmp").then(|| serde_json::from_value(r["snmp"].clone()).unwrap_or_default()).map(Arc::new),
    }
}

/// Sync the running set with the `probes` collection.
pub async fn reload(app: &App) -> anyhow::Result<()> {
    let defs: Vec<ProbeDef> = app.core.pb.list("probes", "enabled = true", "").await?.iter().map(parse_def).collect();
    let mut st = app.lock();
    st.probes.retain(|id, _| defs.iter().any(|d| d.id == *id));
    for d in defs {
        match st.probes.get_mut(&d.id) {
            Some(p) => p.def = d,
            None => {
                st.probes.insert(d.id.clone(), ProbeLive::new(d));
            }
        }
    }
    Ok(())
}

/// Start every probe that is due; each runs detached so one slow target never
/// delays the others.
pub async fn tick(app: &Arc<App>) -> anyhow::Result<()> {
    let due: Vec<ProbeDef> = {
        let mut st = app.lock();
        let now = Instant::now();
        st.probes
            .values_mut()
            .filter(|p| !p.running && p.next <= now)
            .map(|p| {
                p.running = true;
                p.next = now + Duration::from_secs(p.def.interval_s);
                p.def.clone()
            })
            .collect()
    };
    for def in due {
        let app = app.clone();
        tokio::spawn(async move {
            let Ok(_slot) = app.probes.limit.acquire().await else { return };
            let started = Instant::now();
            let limit = if def.snmp.is_some() { SNMP_TIMEOUT } else { CHECK_TIMEOUT };
            let result = tokio::time::timeout(limit, check(&app, &def, started)).await.unwrap_or_else(|_| Err(anyhow::anyhow!("timed out")));
            if let Err(e) = conclude(&app, &def, result).await {
                eprintln!("probe {}: {e:#}", def.name);
            }
        });
    }
    Ok(())
}

async fn conclude(app: &App, def: &ProbeDef, result: anyhow::Result<Outcome>) -> anyhow::Result<()> {
    let wanted = {
        let mut st = app.lock();
        let Some(p) = st.probes.get_mut(&def.id) else { return Ok(()) };
        p.running = false;
        p.record(result);
        alerts_for(p)
    };
    app.reconcile(&format!("probe:{}", def.id), wanted).await
}

fn alerts_for(p: &ProbeLive) -> Vec<Wanted> {
    let d = &p.def;
    let mut out = vec![];
    if p.fails >= FAILS_TO_ALERT {
        out.push(Wanted { key: format!("probe:{}", d.id), kind: "state", severity: "crit", message: format!("{} is down: {}", d.name, p.message), host: d.target.clone() });
    }
    if let (Some(days), true) = (p.cert_days, p.up == Some(true)) {
        if days <= d.warn_days {
            let severity = if days <= CERT_CRIT_DAYS { "crit" } else { "warn" };
            out.push(Wanted { key: format!("probe:{}:cert", d.id), kind: "state", severity, message: format!("{}: certificate expires in {days} days", d.name), host: d.target.clone() });
        }
    }
    // Stale readings mean nothing while the device is unreachable.
    if p.up == Some(true) {
        for r in p.readings.iter().filter(|r| r.level != "ok") {
            let value = r.value.map_or(String::new(), |v| format!("{v:.1}"));
            out.push(Wanted { key: format!("probe:{}:snmp:{}", d.id, r.label), kind: "state", severity: r.level, message: format!("{}: {} is {value} {}", d.name, r.label, r.unit).trim_end().to_string(), host: d.target.clone() });
        }
    }
    out
}

async fn check(app: &App, def: &ProbeDef, started: Instant) -> anyhow::Result<Outcome> {
    let ms = || started.elapsed().as_secs_f64() * 1000.0;
    match def.kind.as_str() {
        "ping" => {
            let ip = resolve(&def.target).await?;
            let client = if ip.is_ipv4() { &app.probes.icmp4 } else { &app.probes.icmp6 };
            let client = client.as_ref().context("ICMP socket unavailable, see the deployment docs")?;
            let id = surge_ping::PingIdentifier(started.elapsed().subsec_nanos() as u16);
            let mut pinger = client.pinger(ip, id).await;
            pinger.timeout(Duration::from_secs(3));
            let (_, rtt) = pinger.ping(surge_ping::PingSequence(0), &[0; 32]).await.context("no reply")?;
            Ok(Outcome { latency_ms: rtt.as_secs_f64() * 1000.0, message: format!("reply from {ip}"), ..Outcome::default() })
        }
        "http" => {
            let res = app.http.get(&def.target).send().await.context("request failed")?;
            let code = res.status().as_u16();
            let ok = if def.expect_status > 0 { code == def.expect_status } else { res.status().is_success() || res.status().is_redirection() };
            if !ok {
                bail!("HTTP {code}");
            }
            let latency_ms = ms();
            // A failure here says nothing about the site, which just answered.
            let cert_days = if def.watch_cert { cert_days_left(&app.probes.cert_http, &def.target).await.ok() } else { None };
            let message = cert_days.map_or(format!("HTTP {code}"), |d| format!("HTTP {code}, certificate expires in {d} days"));
            Ok(Outcome { latency_ms, message, cert_days, ..Outcome::default() })
        }
        "dns" => {
            let message = dns_lookup(&def.target, &def.dns_server).await?;
            Ok(Outcome { latency_ms: ms(), message, ..Outcome::default() })
        }
        "cert" => {
            let days = cert_days_left(&app.probes.cert_http, &def.target).await?;
            Ok(Outcome { latency_ms: ms(), message: format!("expires in {days} days"), cert_days: Some(days), ..Outcome::default() })
        }
        "snmp" => {
            let cfg = def.snmp.as_ref().context("SNMP settings missing")?;
            let vals = snmp::poll(&def.target, cfg).await?;
            let shown = vals.iter().filter(|v| !matches!(v, snmp::Val::Missing)).count();
            Ok(Outcome { latency_ms: ms(), message: format!("{shown} of {} values read", vals.len()), snmp: vals, ..Outcome::default() })
        }
        other => bail!("unknown probe type {other}"),
    }
}

async fn resolve(target: &str) -> anyhow::Result<IpAddr> {
    if let Ok(ip) = target.parse() {
        return Ok(ip);
    }
    tokio::net::lookup_host((target, 0)).await.context("cannot resolve")?.next().map(|a| a.ip()).context("no address")
}

async fn dns_lookup(name: &str, server: &str) -> anyhow::Result<String> {
    let provider = TokioRuntimeProvider::default();
    let builder = if server.is_empty() {
        Resolver::builder(provider)?
    } else {
        let ip: IpAddr = server.parse().context("DNS server must be an IP address")?;
        Resolver::builder_with_config(ResolverConfig::from_parts(None, vec![], vec![NameServerConfig::udp_and_tcp(ip)]), provider)
    };
    let ips = builder.build()?.lookup_ip(name).await.context("DNS lookup failed")?;
    let first = ips.iter().next().context("empty answer")?;
    Ok(first.to_string())
}

/// `target` is a host, `host:port`, or URL. Connects without validating so an
/// already expired or self-signed certificate is still measured and reported.
async fn cert_days_left(client: &reqwest::Client, target: &str) -> anyhow::Result<i64> {
    let url = if target.contains("://") { target.to_string() } else { format!("https://{target}") };
    let res = client.head(&url).send().await.context("TLS connection failed")?;
    let info = res.extensions().get::<reqwest::tls::TlsInfo>().context("no TLS info")?;
    let der = info.peer_certificate().context("no peer certificate")?;
    let (_, cert) = x509_parser::parse_x509_certificate(der).context("bad certificate")?;
    Ok((cert.validity().not_after.timestamp() - Utc::now().timestamp()).div_euclid(86400))
}

/// Latest state of every probe, for the UI.
pub fn snapshot(app: &App) -> Vec<Value> {
    let st = app.lock();
    let mut v: Vec<&ProbeLive> = st.probes.values().collect();
    v.sort_by(|a, b| a.def.name.cmp(&b.def.name));
    v.iter().map(|p| p.to_json()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(warn_days: u64) -> ProbeLive {
        ProbeLive::new(parse_def(&json!({"id": "p", "name": "site", "type": "cert", "target": "x", "warn_days": warn_days})))
    }

    fn ok(cert_days: Option<i64>) -> anyhow::Result<Outcome> {
        Ok(Outcome { latency_ms: 10.0, message: "ok".into(), cert_days, ..Outcome::default() })
    }

    #[test]
    fn single_failure_stays_quiet_two_alert_recovery_clears() {
        let mut p = probe(21);
        p.record(Err(anyhow::anyhow!("x")));
        assert!(alerts_for(&p).is_empty());
        p.record(Err(anyhow::anyhow!("x")));
        assert_eq!(alerts_for(&p)[0].severity, "crit");
        p.record(ok(None));
        assert!(alerts_for(&p).is_empty());
    }

    #[test]
    fn certificate_severity_follows_days_left() {
        let mut p = probe(21);
        p.record(ok(Some(30)));
        assert!(alerts_for(&p).is_empty());
        p.record(ok(Some(20)));
        assert_eq!(alerts_for(&p)[0].severity, "warn");
        p.record(ok(Some(3)));
        assert_eq!(alerts_for(&p)[0].severity, "crit");
    }

    #[test]
    fn only_an_https_website_can_watch_its_certificate() {
        let def = |target: &str| parse_def(&json!({"type": "http", "target": target})).watch_cert;
        assert!(def("https://cloud.home.lan"));
        assert!(!def("http://cloud.home.lan"));
    }

    #[test]
    fn rollup_counts_and_resets() {
        let mut p = probe(21);
        p.record(ok(None));
        p.record(ok(None));
        p.record(Err(anyhow::anyhow!("x")));
        let (up, total, latency, _) = p.take_rollup();
        assert_eq!((up, total, latency), (2, 3, 10.0));
        assert_eq!(p.take_rollup().1, 0);
    }

    #[test]
    fn snmp_readings_alert_only_while_the_device_answers() {
        let items = vec![snmp::Item { label: "Battery".into(), unit: "%".into(), low: true, crit: Some(20.0), ..snmp::Item::default() }];
        let mut p = probe(21);
        p.def.snmp = Some(Arc::new(snmp::Config { items, ..snmp::Config::default() }));
        p.record(Ok(Outcome { snmp: vec![snmp::Val::Num(12.0)], ..Outcome::default() }));
        let a = alerts_for(&p);
        assert_eq!((a[0].severity, a[0].message.as_str()), ("crit", "site: Battery is 12.0 %"));
        assert_eq!(p.take_rollup().3["Battery"], 12.0);
        p.record(Err(anyhow::anyhow!("x")));
        assert!(alerts_for(&p).is_empty(), "one failed poll is silent and hides stale values");
    }

    #[test]
    fn start_offsets_stay_within_the_interval() {
        let p = ProbeLive::new(parse_def(&json!({"id": "zzzzzz", "interval_s": 10})));
        assert!(p.next <= Instant::now() + Duration::from_secs(10));
    }

    #[test]
    fn interval_has_a_floor_and_a_default() {
        assert_eq!(parse_def(&json!({"interval_s": 1})).interval_s, 10);
        assert_eq!(parse_def(&json!({})).interval_s, DEFAULT_INTERVAL_S);
    }
}

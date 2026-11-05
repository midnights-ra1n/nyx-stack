//! SNMP v1/v2c/v3 polling. There is no per-device code: an equipment profile is a
//! list of [`Item`]s, so switches, UPSes, printers or NAS boxes are all just data.

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use snmp2::{
    v3::{Auth, AuthProtocol, Cipher, Security},
    AsyncSession, Oid, Pdu, Value,
};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::time::timeout;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
/// UDP loses packets; one retry avoids most false "down" results.
const ATTEMPTS: usize = 2;
/// OIDs per GET, small enough to stay under a typical device's PDU limit.
const GET_CHUNK: usize = 20;
const BULK_REPETITIONS: u32 = 25;
/// Bound a walk so a typo pointing at a huge subtree cannot hammer a device.
const MAX_WALK_ROWS: usize = 2000;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Item {
    pub oid: String,
    pub label: String,
    pub unit: String,
    /// Walk a table instead of reading one value.
    pub walk: bool,
    /// How a walk becomes one number: `sum`, `min`, `max`, `avg`, `count`.
    pub agg: String,
    /// With `count`, only count rows equal to this.
    pub matches: Option<f64>,
    /// The value is a counter: report its per-second rate.
    pub rate: bool,
    /// Multiply the value; 0 means 1.
    pub scale: f64,
    pub warn: Option<f64>,
    pub crit: Option<f64>,
    /// Low values are the bad ones (battery, toner).
    pub low: bool,
    /// Critical unless the value equals this (status enums).
    pub expect: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Config {
    pub version: String,
    pub community: String,
    pub user: String,
    pub auth_proto: String,
    pub auth_pass: String,
    pub priv_proto: String,
    pub priv_pass: String,
    pub items: Vec<Item>,
}

/// One polled value before rates and thresholds.
#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Num(f64),
    Text(String),
    Missing,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Reading {
    pub label: String,
    pub unit: String,
    pub value: Option<f64>,
    pub text: String,
    pub level: &'static str,
}

fn to_val(v: &Value<'_>) -> Val {
    match v {
        Value::Integer(n) => Val::Num(*n as f64),
        Value::Counter32(n) | Value::Unsigned32(n) | Value::Timeticks(n) => Val::Num(*n as f64),
        Value::Counter64(n) => Val::Num(*n as f64),
        Value::Boolean(b) => Val::Num(*b as u8 as f64),
        Value::OctetString(s) => {
            // Many vendors publish numbers as strings.
            let text = String::from_utf8_lossy(s).trim().to_string();
            text.parse().map_or(Val::Text(text), Val::Num)
        }
        Value::IpAddress(a) => Val::Text(std::net::Ipv4Addr::from(*a).to_string()),
        _ => Val::Missing,
    }
}

fn parse_oid(s: &str) -> anyhow::Result<Oid<'static>> {
    let arcs: Vec<u64> = s.trim().trim_start_matches('.').split('.').map(str::parse).collect::<Result<_, _>>().with_context(|| format!("invalid OID {s}"))?;
    Oid::from(&arcs).map_err(|_| anyhow!("invalid OID {s}"))
}

fn rows(pdu: Pdu<'_>) -> Vec<(String, Val, bool)> {
    pdu.varbinds.map(|(oid, v)| (oid.to_id_string(), to_val(&v), matches!(v, Value::EndOfMibView))).collect()
}

async fn open(target: &str, c: &Config) -> anyhow::Result<AsyncSession> {
    let addr = if target.contains(':') { target.to_string() } else { format!("{target}:161") };
    let community = c.community.as_bytes();
    Ok(match c.version.as_str() {
        "v1" => AsyncSession::new_v1(addr, community, 0).await?,
        "" | "v2c" => AsyncSession::new_v2c(addr, community, 0).await?,
        "v3" => {
            let proto = match c.auth_proto.as_str() {
                "md5" => AuthProtocol::Md5,
                "sha1" | "" => AuthProtocol::Sha1,
                "sha256" => AuthProtocol::Sha256,
                "sha512" => AuthProtocol::Sha512,
                other => bail!("unknown auth protocol {other}"),
            };
            let cipher = match c.priv_proto.as_str() {
                "" => None,
                "des" => Some(Cipher::Des),
                "aes" | "aes128" => Some(Cipher::Aes128),
                "aes192" => Some(Cipher::Aes192),
                "aes256" => Some(Cipher::Aes256),
                other => bail!("unknown privacy protocol {other}"),
            };
            let auth = match cipher {
                Some(cipher) => Auth::AuthPriv { cipher, privacy_password: c.priv_pass.clone().into_bytes() },
                None if c.auth_pass.is_empty() => Auth::NoAuthNoPriv,
                None => Auth::AuthNoPriv,
            };
            let sec = Security::new(c.user.as_bytes(), c.auth_pass.as_bytes()).with_auth(auth).with_auth_protocol(proto);
            let mut s = AsyncSession::new_v3(addr, 0, sec).await?;
            timeout(REQUEST_TIMEOUT, s.init()).await.map_err(|_| anyhow!("no reply"))?.map_err(|e| anyhow!("SNMPv3 handshake failed: {e:?}"))?;
            s
        }
        other => bail!("unknown SNMP version {other}"),
    })
}

async fn get_chunk(s: &mut AsyncSession, oids: &[Oid<'static>]) -> anyhow::Result<Vec<(String, Val, bool)>> {
    let refs: Vec<&Oid<'_>> = oids.iter().collect();
    let mut last = anyhow!("no reply");
    for _ in 0..ATTEMPTS {
        match timeout(REQUEST_TIMEOUT, s.get_many(&refs)).await {
            Ok(Ok(pdu)) => return Ok(rows(pdu)),
            Ok(Err(e)) => last = anyhow!("SNMP error: {e:?}"),
            Err(_) => last = anyhow!("no reply"),
        }
    }
    Err(last)
}

async fn next_rows(s: &mut AsyncSession, bulk: bool, oid: &Oid<'static>) -> anyhow::Result<Vec<(String, Val, bool)>> {
    let mut last = anyhow!("no reply");
    for _ in 0..ATTEMPTS {
        let res = if bulk { timeout(REQUEST_TIMEOUT, s.getbulk(&[oid], 0, BULK_REPETITIONS)).await } else { timeout(REQUEST_TIMEOUT, s.getnext(oid)).await };
        match res {
            Ok(Ok(pdu)) => return Ok(rows(pdu)),
            Ok(Err(e)) => last = anyhow!("SNMP error: {e:?}"),
            Err(_) => last = anyhow!("no reply"),
        }
    }
    Err(last)
}

async fn walk(s: &mut AsyncSession, bulk: bool, root: &str) -> anyhow::Result<Vec<f64>> {
    let root = root.trim().trim_start_matches('.');
    let prefix = format!("{root}.");
    let mut cursor = parse_oid(root)?;
    let mut out = vec![];
    loop {
        let batch = next_rows(s, bulk, &cursor).await?;
        let Some(last) = batch.last().map(|r| r.0.clone()) else { return Ok(out) };
        for (oid, val, end) in batch {
            if end || !oid.starts_with(&prefix) {
                return Ok(out);
            }
            if let Val::Num(n) = val {
                out.push(n);
            }
        }
        if out.len() >= MAX_WALK_ROWS {
            return Ok(out);
        }
        cursor = parse_oid(&last)?;
    }
}

pub fn aggregate(values: &[f64], item: &Item) -> Val {
    if item.agg == "count" {
        let n = values.iter().filter(|v| item.matches.is_none_or(|m| **v == m)).count();
        return Val::Num(n as f64);
    }
    if values.is_empty() {
        return Val::Missing;
    }
    let sum: f64 = values.iter().sum();
    Val::Num(match item.agg.as_str() {
        "min" => values.iter().copied().fold(f64::INFINITY, f64::min),
        "max" => values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        "avg" => sum / values.len() as f64,
        _ => sum,
    })
}

/// Read every item: plain GETs share a few PDUs, then each table is walked.
pub async fn poll(target: &str, c: &Config) -> anyhow::Result<Vec<Val>> {
    let mut s = open(target, c).await?;
    let mut out = vec![Val::Missing; c.items.len()];

    let plain: Vec<usize> = (0..c.items.len()).filter(|i| !c.items[*i].walk).collect();
    let mut by_oid = HashMap::new();
    for chunk in plain.chunks(GET_CHUNK) {
        let oids = chunk.iter().map(|i| parse_oid(&c.items[*i].oid)).collect::<anyhow::Result<Vec<_>>>()?;
        // shortcut: SNMPv1 fails a whole GET on one missing OID, split per item if v1 devices need partial results.
        by_oid.extend(get_chunk(&mut s, &oids).await?.into_iter().map(|(oid, val, _)| (oid, val)));
    }
    for i in plain {
        out[i] = by_oid.get(c.items[i].oid.trim().trim_start_matches('.')).cloned().unwrap_or(Val::Missing);
    }

    let bulk = c.version != "v1";
    for (i, item) in c.items.iter().enumerate().filter(|(_, it)| it.walk) {
        out[i] = aggregate(&walk(&mut s, bulk, &item.oid).await?, item);
    }
    Ok(out)
}

fn level(item: &Item, v: f64) -> &'static str {
    if item.expect.is_some_and(|e| v != e) {
        return "crit";
    }
    let past = |t: Option<f64>| t.is_some_and(|t| if item.low { v <= t } else { v >= t });
    if past(item.crit) { "crit" } else if past(item.warn) { "warn" } else { "ok" }
}

/// Apply rates, scaling and thresholds. `prev` keeps counters between polls.
pub fn readings(items: &[Item], vals: Vec<Val>, prev: &mut HashMap<String, (f64, Instant)>, now: Instant) -> Vec<Reading> {
    items
        .iter()
        .zip(vals)
        .map(|(item, val)| {
            let mut r = Reading { label: item.label.clone(), unit: item.unit.clone(), value: None, text: String::new(), level: "ok" };
            match val {
                Val::Text(t) => r.text = t,
                Val::Missing => {}
                Val::Num(raw) => {
                    let n = if item.rate {
                        let before = prev.insert(item.label.clone(), (raw, now));
                        // A counter going backwards wrapped or the device rebooted: skip one sample.
                        before.filter(|(old, at)| raw >= *old && now > *at).map(|(old, at)| (raw - old) / (now - at).as_secs_f64())
                    } else {
                        Some(raw)
                    };
                    if let Some(n) = n {
                        let v = n * if item.scale == 0.0 { 1.0 } else { item.scale };
                        r.level = level(item, v);
                        r.value = Some(v);
                    }
                }
            }
            r
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(f: impl FnOnce(&mut Item)) -> Item {
        let mut i = Item { label: "x".into(), ..Item::default() };
        f(&mut i);
        i
    }

    fn one(i: Item, v: f64) -> Reading {
        readings(&[i], vec![Val::Num(v)], &mut HashMap::new(), Instant::now()).remove(0)
    }

    #[test]
    fn thresholds_work_both_ways() {
        let high = |v| one(item(|i| { i.warn = Some(75.0); i.crit = Some(90.0) }), v).level;
        assert_eq!((high(10.0), high(80.0), high(95.0)), ("ok", "warn", "crit"));
        let low = |v| one(item(|i| { i.low = true; i.warn = Some(50.0); i.crit = Some(20.0) }), v).level;
        assert_eq!((low(80.0), low(40.0), low(10.0)), ("ok", "warn", "crit"));
    }

    #[test]
    fn expected_status_and_scaling() {
        assert_eq!(one(item(|i| i.expect = Some(2.0)), 2.0).level, "ok");
        assert_eq!(one(item(|i| i.expect = Some(2.0)), 3.0).level, "crit");
        assert_eq!(one(item(|i| i.scale = 0.1), 412.0).value, Some(41.2));
    }

    #[test]
    fn counters_become_rates_and_survive_a_reset() {
        let items = [item(|i| i.rate = true)];
        let mut prev = HashMap::new();
        let t0 = Instant::now();
        let at = |s| t0 + Duration::from_secs(s);
        let mut poll = |v, s| readings(&items, vec![Val::Num(v)], &mut prev, at(s)).remove(0).value;
        assert_eq!(poll(1000.0, 0), None, "first sample has no rate");
        assert_eq!(poll(1600.0, 60), Some(10.0));
        assert_eq!(poll(5.0, 120), None, "device rebooted");
        assert_eq!(poll(65.0, 180), Some(1.0));
    }

    #[test]
    fn table_aggregation() {
        let v = [1.0, 2.0, 1.0, 6.0];
        let by = |agg: &str| aggregate(&v, &item(|i| i.agg = agg.into()));
        assert_eq!((by("sum"), by("min"), by("max"), by("avg")), (Val::Num(10.0), Val::Num(1.0), Val::Num(6.0), Val::Num(2.5)));
        assert_eq!(aggregate(&v, &item(|i| { i.agg = "count".into(); i.matches = Some(1.0) })), Val::Num(2.0));
        assert_eq!(aggregate(&[], &item(|i| i.agg = "max".into())), Val::Missing);
        assert_eq!(aggregate(&[], &item(|i| i.agg = "count".into())), Val::Num(0.0));
    }

    #[test]
    fn oids_parse_with_or_without_a_leading_dot() {
        assert_eq!(parse_oid(".1.3.6.1").unwrap().to_id_string(), "1.3.6.1");
        assert!(parse_oid("1.3.x").is_err());
    }

    #[test]
    fn text_and_missing_values_never_alert() {
        let r = readings(&[item(|i| i.warn = Some(1.0)), item(|i| i.warn = Some(1.0))], vec![Val::Text("up".into()), Val::Missing], &mut HashMap::new(), Instant::now());
        assert_eq!((r[0].text.as_str(), r[0].level, r[1].value), ("up", "ok", None));
    }
}

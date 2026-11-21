//! Signed HTTPS calls to the monitor. The agent only ever connects outwards.

use crate::config::Config;
use anyhow::{bail, Context};
use nyx_proto::{sign, verify, LiveLogs, LiveReply, Report, Reply};
use std::net::IpAddr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ureq::tls::{RootCerts, TlsConfig};
use ureq::unversioned::transport::DefaultConnector;

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Uses the OS trust store so a homelab CA works without extra configuration, and
/// `dns` instead of the system resolver when it is set.
pub fn client(dns: &[IpAddr]) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(60)))
        .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build())
        .build();
    if dns.is_empty() {
        return config.new_agent();
    }
    ureq::Agent::with_parts(config, DefaultConnector::new(), crate::dns::Servers(dns.to_vec()))
}

pub fn post_report(http: &ureq::Agent, cfg: &Config, report: &Report) -> anyhow::Result<Reply> {
    post(http, cfg, "report", report)
}

/// Whether someone is still watching.
pub fn post_logs(http: &ureq::Agent, cfg: &Config, lines: Vec<String>) -> anyhow::Result<bool> {
    Ok(post::<_, LiveReply>(http, cfg, "logs", &LiveLogs { lines })?.live)
}

fn post<B: serde::Serialize, R: serde::de::DeserializeOwned>(http: &ureq::Agent, cfg: &Config, path: &str, body: &B) -> anyhow::Result<R> {
    let body = serde_json::to_vec(body)?;
    let ts = now();
    if !cfg.relay_key.is_empty() {
        let headers = [("content-type", "application/json".into()), ("x-nyx-token", cfg.token.clone()), ("x-nyx-ts", ts.to_string()), ("x-nyx-sig", sign(&cfg.key, ts, &body))];
        let (_, body) = relayed(http, cfg, "POST", &format!("/agent/v1/{path}"), &headers, &body)?;
        return Ok(serde_json::from_slice(&body)?);
    }
    let mut res = http
        .post(format!("{}/agent/v1/{path}", cfg.url))
        .header("content-type", "application/json")
        .header("x-nyx-token", &cfg.token)
        .header("x-nyx-ts", ts.to_string())
        .header("x-nyx-sig", sign(&cfg.key, ts, &body))
        .send(&body[..])?;
    Ok(serde_json::from_slice(&res.body_mut().read_to_vec()?)?)
}

/// Download the agent binary and check the monitor's HMAC over its SHA-256, so a
/// plain-HTTP LAN deployment cannot be fed a tampered binary.
pub fn fetch_agent_binary(http: &ureq::Agent, cfg: &Config, name: &str) -> anyhow::Result<Vec<u8>> {
    let path = format!("/agent/v1/binary/{name}");
    let ts = now();
    let signed = [("x-nyx-token", cfg.token.clone()), ("x-nyx-ts", ts.to_string()), ("x-nyx-sig", sign(&cfg.key, ts, path.as_bytes()))];
    let (headers, bytes) = if cfg.relay_key.is_empty() {
        let mut req = http.get(format!("{}{path}", cfg.url));
        for (k, v) in &signed {
            req = req.header(*k, v);
        }
        let mut res = req.call()?;
        let headers = res.headers().iter().filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string()))).collect();
        (headers, res.body_mut().with_config().limit(BINARY_LIMIT).read_to_vec()?)
    } else {
        relayed(http, cfg, "GET", &path, &signed, &[])?
    };
    let header = |n: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.clone()).with_context(|| format!("missing {n}"));
    let (sha, sig, resp_ts) = (header("x-nyx-sha256")?, header("x-nyx-sig")?, header("x-nyx-ts")?);
    if nyx_proto::sha256_hex(&bytes) != sha || !verify(&cfg.key, resp_ts.parse()?, sha.as_bytes(), &sig) {
        bail!("binary signature mismatch");
    }
    Ok(bytes)
}

const BINARY_LIMIT: u64 = 100 * 1024 * 1024;

type Headers = Vec<(String, String)>;

/// One call through the Cloudflare relay: sealed with the relay key, so the Worker
/// forwards it without reading it. Answers like ureq: an HTTP error is an `Err`.
fn relayed(http: &ureq::Agent, cfg: &Config, method: &str, path: &str, headers: &[(&str, String)], body: &[u8]) -> anyhow::Result<(Headers, Vec<u8>)> {
    use nyx_proto::relay::{nonce, pack, unpack, Key, ReqHead, ResHead, PATH};
    let key = Key::parse(&cfg.relay_key).context("bad relay key")?;
    let head = ReqHead { m: method.into(), p: path.into(), h: headers.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(), t: now() };
    let sealed = key.seal(b"", &pack(&head, body));
    let mut res = http.post(format!("{}{PATH}", cfg.url)).header("content-type", "application/octet-stream").send(&sealed[..])?;
    let answer = res.body_mut().with_config().limit(BINARY_LIMIT).read_to_vec()?;
    let plain = key.open(nonce(&sealed), &answer).context("relay answer does not open with the relay key")?;
    let (head, body) = unpack::<ResHead>(&plain).context("malformed relay answer")?;
    if head.s >= 400 {
        bail!("{method} {path}: http status {}: {}", head.s, String::from_utf8_lossy(body));
    }
    Ok((head.h, body.to_vec()))
}

//! Signed HTTPS calls to the monitor. The agent only ever connects outwards.

use crate::config::Config;
use anyhow::{bail, Context};
use nyx_proto::{sign, verify, LiveLogs, LiveReply, Report, Reply};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ureq::tls::{RootCerts, TlsConfig};

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Uses the OS trust store so a homelab CA works without extra configuration.
pub fn client() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(60)))
        .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build())
        .build()
        .new_agent()
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
    let mut res = http
        .get(format!("{}{path}", cfg.url))
        .header("x-nyx-token", &cfg.token)
        .header("x-nyx-ts", ts.to_string())
        .header("x-nyx-sig", sign(&cfg.key, ts, path.as_bytes()))
        .call()?;
    let header = |n: &str| res.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string).with_context(|| format!("missing {n}"));
    let (sha, sig, resp_ts) = (header("x-nyx-sha256")?, header("x-nyx-sig")?, header("x-nyx-ts")?);
    let bytes = res.body_mut().with_config().limit(100 * 1024 * 1024).read_to_vec()?;
    if nyx_proto::sha256_hex(&bytes) != sha || !verify(&cfg.key, resp_ts.parse()?, sha.as_bytes(), &sig) {
        bail!("binary signature mismatch");
    }
    Ok(bytes)
}

//! nyx-mcp: a local MCP server (stdio) in front of a Nyx server's MCP endpoint.
//!
//! An AI client (Claude Desktop, Claude Code, Codex…) starts it and writes one JSON-RPC
//! message per line. Each one goes to the server's `/mcp` and its answer comes back on
//! stdout. Behind the Cloudflare relay, every message is sealed with the relay key, so
//! Cloudflare forwards the questions and the answers about your infrastructure without
//! reading them. Without a relay key it calls `NYX_URL/mcp` over HTTPS, for clients that
//! only start local servers.
//!
//! Settings come from the environment: `NYX_URL`, `NYX_MCP_TOKEN` and, behind the relay,
//! `NYX_RELAY_KEY`. stdout carries the protocol only: messages for people go to stderr.

use anyhow::{bail, Context};
use nyx_proto::relay::{nonce, pack, unpack, Key, ReqHead, ResHead, PATH};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ureq::tls::{RootCerts, TlsConfig};

const DOCS: &str = "https://github.com/midnights-ra1n/nyx-stack/blob/stable/docs/integrations.md#through-the-cloudflare-relay";

struct Config {
    url: String,
    token: String,
    /// The relay key: messages go sealed to `NYX_URL/_relay`. Direct to `/mcp` without it.
    key: Option<Key>,
}

impl Config {
    fn from_env(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let need = |k: &str| get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).with_context(|| format!("{k} is not set, see {DOCS}"));
        let url = need("NYX_URL")?.trim_end_matches('/').to_string();
        let key = match get("NYX_RELAY_KEY").unwrap_or_default().trim() {
            "" => None,
            k => Some(Key::parse(k).context("NYX_RELAY_KEY must be 64 hexadecimal characters")?),
        };
        // Sealed, plain HTTP is fine (a local `wrangler dev`). Unsealed, the token and the
        // answers would travel in clear.
        if key.is_none() && !url.starts_with("https://") {
            bail!("NYX_URL must start with https:// when NYX_RELAY_KEY is not set");
        }
        Ok(Self { url, token: need("NYX_MCP_TOKEN")?, key })
    }

    /// Passes one message on. `None` for a notification, which gets no answer.
    fn call(&self, http: &ureq::Agent, msg: &[u8]) -> anyhow::Result<Option<Value>> {
        let headers = [("content-type", "application/json"), ("accept", "application/json, text/event-stream"), ("authorization", &format!("Bearer {}", self.token))];
        let (status, body) = match &self.key {
            Some(key) => {
                let h = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
                let sealed = key.seal(b"", &pack(&ReqHead { m: "POST".into(), p: "/mcp".into(), h, t: now() }, msg));
                let mut res = http.post(format!("{}{PATH}", self.url)).header("content-type", "application/octet-stream").send(&sealed[..])?;
                let bytes = res.body_mut().read_to_vec()?;
                // The relay's own answers come in clear: server offline, key refused.
                if res.headers().get("x-nyx-relay").is_none_or(|v| v != "sealed") {
                    bail!("relay: {}: {}", res.status(), String::from_utf8_lossy(&bytes));
                }
                let plain = key.open(nonce(&sealed), &bytes).context("the answer does not open with NYX_RELAY_KEY: is it this server's relay key?")?;
                let (head, body) = unpack::<ResHead>(&plain).context("malformed relay answer")?;
                (head.s, body.to_vec())
            }
            None => {
                let mut req = http.post(format!("{}/mcp", self.url));
                for (k, v) in headers {
                    req = req.header(k, v);
                }
                let mut res = req.send(msg)?;
                (res.status().as_u16(), res.body_mut().read_to_vec()?)
            }
        };
        match status {
            202 => Ok(None),
            200 => Ok(Some(serde_json::from_slice(&body).context("the server's answer is not JSON")?)),
            401 => bail!("NYX_MCP_TOKEN was refused: create a token in Settings, Security"),
            s => bail!("http status {s}: {}", String::from_utf8_lossy(&body)),
        }
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn failure(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// The answer to write for one line read: the server's, or an error for a request.
fn relay_line(cfg: &Config, http: &ureq::Agent, line: &str) -> Option<Value> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(m) => m,
        Err(e) => return Some(failure(&Value::Null, -32700, &format!("parse error: {e}"))),
    };
    match cfg.call(http, line.as_bytes()) {
        Ok(answer) => answer,
        Err(e) => {
            eprintln!("nyx-mcp: {e:#}");
            msg.get("id").map(|id| failure(id, -32603, &format!("Nyx: {e:#}")))
        }
    }
}

fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).is_some_and(|a| a == "version" || a == "--version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let cfg = Config::from_env(|k| std::env::var(k).ok())?;
    let http = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(120)))
        .http_status_as_error(false)
        .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build())
        .build()
        .new_agent();
    eprintln!("nyx-mcp: {} {}", cfg.url, if cfg.key.is_some() { "through the relay, sealed" } else { "over HTTPS" });
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(answer) = relay_line(&cfg, &http, &line) {
            writeln!(out, "{answer}")?;
            out.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    const K: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn settings_from_the_environment() {
        let c = Config::from_env(env(&[("NYX_URL", "https://r.example/ "), ("NYX_MCP_TOKEN", "t")])).unwrap();
        assert_eq!((c.url.as_str(), c.key.is_none()), ("https://r.example", true));
        assert!(Config::from_env(env(&[("NYX_URL", "http://m.lan"), ("NYX_MCP_TOKEN", "t")])).is_err(), "clear without a relay key");
        assert!(Config::from_env(env(&[("NYX_URL", "http://localhost:8787"), ("NYX_MCP_TOKEN", "t"), ("NYX_RELAY_KEY", K)])).is_ok());
        assert!(Config::from_env(env(&[("NYX_URL", "https://r.example"), ("NYX_MCP_TOKEN", "t"), ("NYX_RELAY_KEY", "abc")])).is_err());
        assert!(Config::from_env(env(&[("NYX_URL", "https://r.example")])).err().unwrap().to_string().contains("NYX_MCP_TOKEN"));
    }

    /// A relay that answers each sealed `/mcp` call as the server would, after checking
    /// the token inside the envelope. Serves `n` requests, one per connection.
    fn fake_relay(n: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let key = Key::parse(K).unwrap();
            for stream in listener.incoming().take(n) {
                let mut s = stream.unwrap();
                let mut buf = vec![];
                let mut chunk = [0u8; 4096];
                let body = loop {
                    let got = s.read(&mut chunk).unwrap();
                    buf.extend_from_slice(&chunk[..got]);
                    let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                    let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
                    let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length: ")).unwrap().trim().parse().unwrap();
                    if buf.len() >= end + 4 + len {
                        break buf[end + 4..end + 4 + len].to_vec();
                    }
                };
                let plain = key.open(b"", &body).unwrap();
                let (req, msg) = unpack::<ReqHead>(&plain).unwrap();
                assert_eq!((req.m.as_str(), req.p.as_str()), ("POST", "/mcp"));
                let authorized = req.h.contains(&("authorization".into(), "Bearer t".into()));
                let msg: Value = serde_json::from_slice(msg).unwrap();
                let (status, answer) = match (authorized, msg.get("id")) {
                    (false, _) => (401, json!({"error": "invalid token"}).to_string()),
                    (true, None) => (202, String::new()),
                    (true, Some(id)) => (200, json!({"jsonrpc": "2.0", "id": id, "result": {"tools": []}}).to_string()),
                };
                let sealed = key.seal(nonce(&body), &pack(&ResHead { s: status, h: vec![] }, answer.as_bytes()));
                write!(s, "HTTP/1.1 200 OK\r\nx-nyx-relay: sealed\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", sealed.len()).unwrap();
                s.write_all(&sealed).unwrap();
            }
        });
        url
    }

    #[test]
    fn messages_go_sealed_and_answers_come_back_one_per_line() {
        let url = fake_relay(3);
        let http = ureq::Agent::config_builder().http_status_as_error(false).build().new_agent();
        let cfg = Config::from_env(env(&[("NYX_URL", &url), ("NYX_MCP_TOKEN", "t"), ("NYX_RELAY_KEY", K)])).unwrap();
        let answer = relay_line(&cfg, &http, r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#).unwrap();
        assert_eq!(answer["id"], 7);
        assert!(!answer.to_string().contains('\n'));
        assert_eq!(relay_line(&cfg, &http, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#), None);
        assert_eq!(relay_line(&cfg, &http, "{oops").unwrap()["error"]["code"], -32700, "no call for a broken line");
        let bad = Config { token: "wrong".into(), ..Config::from_env(env(&[("NYX_URL", &url), ("NYX_MCP_TOKEN", "t"), ("NYX_RELAY_KEY", K)])).unwrap() };
        let refused = relay_line(&bad, &http, r#"{"jsonrpc":"2.0","id":"a","method":"ping"}"#).unwrap();
        assert_eq!((refused["id"].as_str(), refused["error"]["code"].as_i64()), (Some("a"), Some(-32603)));
        assert!(refused["error"]["message"].as_str().unwrap().contains("Settings, Security"));
    }
}

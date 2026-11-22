//! Signed calls to the monitor. The agent only ever connects outwards.
//!
//! Reports and live logs go over one WebSocket the agent keeps open, to the monitor or to
//! the Cloudflare relay: no new connection, DNS lookup or Cloudflare request per report.
//! When the socket cannot be opened (an older monitor or Worker, a proxy that drops
//! WebSockets) the same calls go over HTTPS, and the socket is tried again 10 minutes later.

use crate::config::Config;
use anyhow::{anyhow, bail, Context};
use nyx_proto::relay::{nonce, pack, unpack, Key, ReqHead, ResHead, PATH, PLAIN, SEALED};
use nyx_proto::{sign, verify, LiveLogs, LiveReply, Report, Reply};
use std::io::{Read, Write};
use std::net::{IpAddr, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tungstenite::{Message, WebSocket};
use ureq::tls::{RootCerts, TlsConfig};
use ureq::unversioned::transport::DefaultConnector;

const TIMEOUT: Duration = Duration::from_secs(60);
const SOCKET_RETRY: Duration = Duration::from_secs(600);

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Uses the OS trust store so a homelab CA works without extra configuration, and
/// `dns` instead of the system resolver when it is set.
pub fn client(dns: &[IpAddr]) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
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
    let headers = [("content-type", "application/json".into()), ("x-nyx-token", cfg.token.clone()), ("x-nyx-ts", ts.to_string()), ("x-nyx-sig", sign(&cfg.key, ts, &body))];
    let path = format!("/agent/v1/{path}");
    if let Some(res) = over_socket(cfg, &path, &headers, &body) {
        return Ok(serde_json::from_slice(&res?)?);
    }
    if !cfg.relay_key.is_empty() {
        let (_, body) = relayed(http, cfg, "POST", &path, &headers, &body)?;
        return Ok(serde_json::from_slice(&body)?);
    }
    let mut req = http.post(format!("{}{path}", cfg.url));
    for (k, v) in &headers {
        req = req.header(*k, v);
    }
    Ok(serde_json::from_slice(&req.send(&body[..])?.body_mut().read_to_vec()?)?)
}

/// Download the agent binary and check the monitor's HMAC over its SHA-256, so a
/// plain-HTTP LAN deployment cannot be fed a tampered binary. Over HTTPS, not the
/// socket: it is large and rare.
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

/// The request, packed, then sealed when the monitor is behind the relay.
fn frame(cfg: &Config, method: &str, path: &str, headers: &[(&str, String)], body: &[u8]) -> (Option<Key>, Vec<u8>) {
    let head = ReqHead { m: method.into(), p: path.into(), h: headers.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(), t: now() };
    let plain = pack(&head, body);
    match Key::parse(&cfg.relay_key) {
        Some(key) => {
            let sealed = key.seal(b"", &plain);
            (Some(key), sealed)
        }
        None => (None, plain),
    }
}

/// An answer of the relay or of the monitor's socket: sealed against `request`'s nonce,
/// or plain. Answers like ureq: an HTTP error is an `Err`.
fn answer(key: Option<&Key>, request: &[u8], kind: u8, payload: &[u8]) -> anyhow::Result<(Headers, Vec<u8>)> {
    let opened = match (kind, key) {
        (SEALED, Some(k)) => Some(k.open(nonce(request), payload).context("relay answer does not open with the relay key")?),
        (SEALED, None) => bail!("sealed answer, but this agent has no relay key"),
        _ => None,
    };
    let (head, body) = unpack::<ResHead>(opened.as_deref().unwrap_or(payload)).context("malformed answer")?;
    if head.s >= 400 {
        bail!("http status {}: {}", head.s, String::from_utf8_lossy(body));
    }
    Ok((head.h, body.to_vec()))
}

/// One call through the Cloudflare relay over HTTPS: sealed with the relay key, so the
/// Worker forwards it without reading it.
fn relayed(http: &ureq::Agent, cfg: &Config, method: &str, path: &str, headers: &[(&str, String)], body: &[u8]) -> anyhow::Result<(Headers, Vec<u8>)> {
    let (key, sealed) = frame(cfg, method, path, headers, body);
    let key = key.context("bad relay key")?;
    let mut res = http.post(format!("{}{PATH}", cfg.url)).header("content-type", "application/octet-stream").send(&sealed[..])?;
    let bytes = res.body_mut().with_config().limit(BINARY_LIMIT).read_to_vec()?;
    answer(Some(&key), &sealed, SEALED, &bytes).with_context(|| format!("{method} {path}"))
}

trait Io: Read + Write + Send {}
impl<T: Read + Write + Send> Io for T {}

struct Socket {
    ws: Option<WebSocket<Box<dyn Io>>>,
    retry_at: Option<Instant>,
    next: u32,
}

static SOCKET: Mutex<Socket> = Mutex::new(Socket { ws: None, retry_at: None, next: 0 });

/// One POST over the kept-open WebSocket, in the relay's frames. `None` sends it over
/// HTTPS instead: the socket cannot be opened, or it just broke and opens again next call.
fn over_socket(cfg: &Config, path: &str, headers: &[(&str, String)], body: &[u8]) -> Option<anyhow::Result<Vec<u8>>> {
    let mut s = SOCKET.lock().unwrap_or_else(|e| e.into_inner());
    if s.ws.is_none() {
        if s.retry_at.is_some_and(|t| Instant::now() < t) {
            return None;
        }
        match open(cfg) {
            Ok(ws) => s.ws = Some(ws),
            Err(e) => {
                eprintln!("websocket to {} unavailable, using HTTPS for 10 minutes: {e:#}", cfg.url);
                s.retry_at = Some(Instant::now() + SOCKET_RETRY);
                return None;
            }
        }
    }
    s.next = s.next.wrapping_add(1);
    let id = s.next;
    // Sealed anew for each try: the monitor refuses a sealed request it has seen.
    let (key, req) = frame(cfg, "POST", path, headers, body);
    let res = exchange(s.ws.as_mut()?, id, if key.is_some() { SEALED } else { PLAIN }, &req);
    match res {
        Ok((kind, payload)) => Some(answer(key.as_ref(), &req, kind, &payload).map(|(_, b)| b).with_context(|| format!("POST {path}"))),
        Err(e) => {
            eprintln!("websocket: {e:#}, sending over HTTPS");
            s.ws = None;
            None
        }
    }
}

fn exchange(ws: &mut WebSocket<Box<dyn Io>>, id: u32, kind: u8, payload: &[u8]) -> anyhow::Result<(u8, Vec<u8>)> {
    let id = id.to_be_bytes();
    ws.send(Message::binary([&id[..], &[kind], payload].concat()))?;
    loop {
        match ws.read()? {
            Message::Binary(f) if f.len() >= 5 && f[..4] == id => return Ok((f[4], f[5..].to_vec())),
            Message::Close(_) => bail!("closed by the other end"),
            _ => {} // pings are answered by tungstenite; an answer to a timed-out call is dropped
        }
    }
}

/// `wss://…/agent/v1/ws` on the monitor, or `/_relay/ws` on the relay. Same DNS servers
/// and trust store as the HTTPS client.
fn open(cfg: &Config) -> anyhow::Result<WebSocket<Box<dyn Io>>> {
    let uri: ureq::http::Uri = cfg.url.parse()?;
    let tls = uri.scheme_str() == Some("https");
    let host = uri.host().context("no host in NYX_URL")?.trim_start_matches('[').trim_end_matches(']');
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let addrs = crate::dns::resolve(&cfg.dns, host, port)?;
    let tcp = addrs.iter().find_map(|a| TcpStream::connect_timeout(a, Duration::from_secs(10)).ok()).with_context(|| format!("cannot connect to {host}:{port}"))?;
    tcp.set_read_timeout(Some(TIMEOUT))?;
    tcp.set_write_timeout(Some(TIMEOUT))?;
    let stream: Box<dyn Io> = if tls {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier = rustls_platform_verifier::Verifier::new(provider.clone())?;
        let config = rustls::ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions()?.dangerous().with_custom_certificate_verifier(Arc::new(verifier)).with_no_client_auth();
        let name = rustls::pki_types::ServerName::try_from(host.to_string())?;
        Box::new(rustls::StreamOwned::new(rustls::ClientConnection::new(Arc::new(config), name)?, tcp))
    } else {
        Box::new(tcp)
    };
    let path = if cfg.relay_key.is_empty() { "/agent/v1/ws" } else { "/_relay/ws" };
    let url = format!("{}{path}", cfg.url.replacen("http", "ws", 1));
    Ok(tungstenite::client(url.as_str(), stream).map_err(|e| anyhow!("{e}"))?.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A monitor's socket that answers each call with its path, after a ping and a stale
    /// answer the agent must skip. The second connection is refused: HTTPS takes over.
    #[test]
    fn calls_go_over_one_socket_and_fall_back() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(tcp).unwrap();
            for _ in 0..2 {
                let f = loop {
                    if let Message::Binary(f) = ws.read().unwrap() {
                        break f; // after the pong of the previous ping
                    }
                };
                assert_eq!(f[4], PLAIN);
                let (head, _) = unpack::<ReqHead>(&f[5..]).unwrap();
                assert!(head.h.iter().any(|(k, _)| k == "x-nyx-sig"), "still signed by the agent");
                ws.send(Message::Ping(vec![].into())).unwrap();
                ws.send(Message::binary([&[9, 9, 9, 9, PLAIN][..], &pack(&ResHead { s: 200, h: vec![] }, b"\"stale\"")].concat())).unwrap();
                let body = format!("\"{}\"", head.p);
                ws.send(Message::binary([&f[..4], &[PLAIN], &pack(&ResHead { s: 200, h: vec![] }, body.as_bytes())].concat())).unwrap();
            }
            let _ = ws.close(None);
            let _ = ws.flush();
        });
        let flag = |f: &str| match f {
            "--url" => Some(format!("http://{addr}")),
            "--token" | "--key" => Some("x".into()),
            "--kind" => Some("vm".into()),
            _ => None,
        };
        let cfg = Config::from_flags("p".into(), &flag, false).unwrap();
        let headers = [("x-nyx-sig", "s".to_string())];
        let call = |p: &str| over_socket(&cfg, p, &headers, b"{}").map(|r| String::from_utf8(r.unwrap()).unwrap());
        assert_eq!(call("/agent/v1/report").as_deref(), Some("\"/agent/v1/report\""));
        assert_eq!(call("/agent/v1/logs").as_deref(), Some("\"/agent/v1/logs\""));
        server.join().unwrap();
        assert_eq!(call("/agent/v1/report"), None, "the socket closed: this call goes over HTTPS");
        assert_eq!(call("/agent/v1/report"), None, "nothing listens: HTTPS for a while");
        assert!(SOCKET.lock().unwrap().retry_at.is_some());
    }

    #[test]
    fn plain_and_sealed_answers() {
        let key = Key::parse(&"ab".repeat(32)).unwrap();
        let ok = pack(&ResHead { s: 200, h: vec![("a".into(), "b".into())] }, b"hi");
        assert_eq!(answer(None, b"", PLAIN, &ok).unwrap(), (vec![("a".into(), "b".into())], b"hi".to_vec()));
        let req = key.seal(b"", b"request");
        assert_eq!(answer(Some(&key), &req, SEALED, &key.seal(nonce(&req), &ok)).unwrap().1, b"hi");
        assert!(answer(Some(&key), &req, SEALED, &key.seal(b"another", &ok)).is_err(), "bound to its request");
        assert!(answer(None, &req, SEALED, &ok).is_err());
        let refused = pack(&ResHead { s: 503, h: vec![] }, b"offline");
        assert!(answer(Some(&key), &req, PLAIN, &refused).unwrap_err().to_string().contains("503: offline"));
    }
}

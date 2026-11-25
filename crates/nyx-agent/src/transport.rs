//! Signed calls to the monitor. The agent only ever connects outwards.
//!
//! Reports and live logs go over one WebSocket the agent keeps open, to the monitor or to
//! the Cloudflare relay: no new connection, DNS lookup or Cloudflare request per report.
//! The socket stays up between reports: pings every 25 s, and a new socket as soon as the
//! old one dies, with a growing pause while the monitor is out of reach. Only when
//! something refuses the WebSocket (an older monitor or Worker, a proxy that drops them)
//! do the same calls go over HTTPS, and the socket is tried again 10 minutes later.

use crate::config::Config;
use anyhow::{anyhow, bail, Context};
use nyx_proto::relay::{nonce, pack, unpack, Key, ReqHead, ResHead, PATH, PLAIN, SEALED};
use nyx_proto::{sign, verify, LiveLogs, LiveReply, Report, Reply};
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tungstenite::{Message, WebSocket};
use ureq::tls::{RootCerts, TlsConfig};
use ureq::unversioned::transport::DefaultConnector;

const TIMEOUT: Duration = Duration::from_secs(60);
const SOCKET_RETRY: Duration = Duration::from_secs(600);
/// Below the idle timeouts of common reverse proxies: 60 s for nginx, 100 s for Cloudflare.
const KEEPALIVE: Duration = Duration::from_secs(25);

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

/// A stream under the socket, plain or TLS, with its TCP socket at hand to change the read timeout.
trait Io: Read + Write + Send {
    fn tcp(&self) -> &TcpStream;
}
impl Io for TcpStream {
    fn tcp(&self) -> &TcpStream {
        self
    }
}
impl Io for rustls::StreamOwned<rustls::ClientConnection, TcpStream> {
    fn tcp(&self) -> &TcpStream {
        &self.sock
    }
}

struct Socket {
    ws: Option<WebSocket<Box<dyn Io>>>,
    /// A proxy refused the upgrade: calls go over HTTPS until then.
    https_until: Option<Instant>,
    /// The monitor was out of reach: [`wait`] tries again from then on.
    next_try: Option<Instant>,
    backoff: Duration,
    /// The last frame from the other end, a pong included.
    heard: Option<Instant>,
    next: u32,
    /// The monitor's addresses, looked up once per connection at most.
    addrs: Vec<SocketAddr>,
    resolved: Option<Instant>,
}

static SOCKET: Mutex<Socket> = Mutex::new(Socket { ws: None, https_until: None, next_try: None, backoff: FIRST_BACKOFF, heard: None, next: 0, addrs: Vec::new(), resolved: None });

const FIRST_BACKOFF: Duration = Duration::from_secs(5);
const MAX_BACKOFF: Duration = Duration::from_secs(300);
/// Nothing heard for this long, though both ends ping: the connection is dead.
const DEAD_AFTER: Duration = Duration::from_secs(80);
/// Addresses are looked up again before a new connection only once they are this old.
const DNS_REUSE: Duration = Duration::from_secs(60);

/// Why no socket could be opened.
enum Failure {
    /// No connection at all (no network, no address, nothing listening): HTTPS would fail
    /// the same way, so the call fails and the socket is tried again soon.
    Unreachable(anyhow::Error),
    /// Something answered but did not take the WebSocket: a proxy that drops them, or a
    /// monitor older than the agent. HTTPS for a while.
    Refused(anyhow::Error),
}

impl Socket {
    fn connect(&mut self, cfg: &Config) -> Result<(), Failure> {
        self.ws = None;
        let opened = open(cfg, &mut self.addrs, &mut self.resolved);
        let now = Instant::now();
        match opened {
            Ok(ws) => {
                (self.ws, self.heard, self.next_try, self.backoff) = (Some(ws), Some(now), None, FIRST_BACKOFF);
                Ok(())
            }
            Err(Failure::Refused(e)) => {
                eprintln!("websocket to {} refused, using HTTPS for 10 minutes: {e:#}", cfg.url);
                self.https_until = Some(now + SOCKET_RETRY);
                Err(Failure::Refused(e))
            }
            Err(Failure::Unreachable(e)) => {
                eprintln!("{} out of reach, trying again in {} s: {e:#}", cfg.url, self.backoff.as_secs());
                self.next_try = Some(now + self.backoff);
                self.backoff = (self.backoff * 2).min(MAX_BACKOFF);
                Err(Failure::Unreachable(e))
            }
        }
    }

    fn https_only(&self) -> bool {
        self.https_until.is_some_and(|t| Instant::now() < t)
    }

    /// Reads what came in while idle, pongs and pings, without waiting. False when the
    /// connection is gone or has been silent for too long.
    fn alive(&mut self) -> bool {
        let Some(ws) = self.ws.as_mut() else { return false };
        if ws.get_ref().tcp().set_read_timeout(Some(Duration::from_millis(1))).is_err() {
            return false;
        }
        let ok = loop {
            match ws.read() {
                Ok(_) => self.heard = Some(Instant::now()),
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break true,
                Err(_) => break false,
            }
        };
        ok && ws.get_ref().tcp().set_read_timeout(Some(TIMEOUT)).is_ok() && self.heard.is_some_and(|t| t.elapsed() < DEAD_AFTER)
    }
}

/// One POST over the kept-open WebSocket, in the relay's frames. `None` sends it over
/// HTTPS instead, which only happens when something refused the WebSocket.
fn over_socket(cfg: &Config, path: &str, headers: &[(&str, String)], body: &[u8]) -> Option<anyhow::Result<Vec<u8>>> {
    let mut s = SOCKET.lock().unwrap_or_else(|e| e.into_inner());
    if s.https_only() {
        return None;
    }
    // A socket a proxy closed while the agent slept only shows when used: one more try on
    // a fresh one, else every report after a quiet spell would go over HTTPS.
    for fresh in [s.ws.is_none(), true] {
        if fresh {
            match s.connect(cfg) {
                Ok(()) => {}
                Err(Failure::Refused(_)) => return None,
                Err(Failure::Unreachable(e)) => return Some(Err(e)),
            }
        }
        s.next = s.next.wrapping_add(1);
        let id = s.next;
        // Sealed anew for each try: the monitor refuses a sealed request it has seen.
        let (key, req) = frame(cfg, "POST", path, headers, body);
        match exchange(s.ws.as_mut()?, id, if key.is_some() { SEALED } else { PLAIN }, &req) {
            Ok((kind, payload)) => {
                s.heard = Some(Instant::now());
                return Some(answer(key.as_ref(), &req, kind, &payload).map(|(_, b)| b).with_context(|| format!("POST {path}")));
            }
            Err(e) => {
                s.ws = None;
                if fresh {
                    eprintln!("websocket: {e:#}, sending over HTTPS");
                    return None;
                }
            }
        }
    }
    None
}

/// Sleeps until `until`, keeping the connection up meanwhile: every 25 s it reads what
/// came in, pings so that no proxy closes the socket as idle, and opens a new socket
/// when the old one died, with a growing pause while the monitor stays out of reach.
pub fn wait(cfg: &Config, until: Instant) {
    loop {
        let now = Instant::now();
        if now >= until {
            return;
        }
        let retry = SOCKET.lock().unwrap_or_else(|e| e.into_inner()).next_try;
        let wake = [Some(until), Some(now + KEEPALIVE), retry.filter(|t| *t > now)].into_iter().flatten().min().unwrap_or(until);
        std::thread::sleep(wake - now);
        if Instant::now() >= until {
            return;
        }
        keep_up(cfg);
    }
}

fn keep_up(cfg: &Config) {
    let mut s = SOCKET.lock().unwrap_or_else(|e| e.into_inner());
    if s.ws.is_some() && !s.alive() {
        eprintln!("websocket to {}: connection lost, opening a new one", cfg.url);
        s.ws = None;
    }
    if s.ws.is_none() {
        if s.https_only() || s.next_try.is_some_and(|t| Instant::now() < t) {
            return;
        }
        let _ = s.connect(cfg);
    }
    // The pongs wait in the buffer, read with the next answer or the next check.
    if s.ws.as_mut().is_some_and(|ws| ws.send(Message::Ping(Vec::new().into())).is_err()) {
        s.ws = None;
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
/// and trust store as the HTTPS client. The addresses found are kept in `addrs` and used
/// again for a minute, so a flapping link does not flood the DNS server.
fn open(cfg: &Config, addrs: &mut Vec<SocketAddr>, resolved: &mut Option<Instant>) -> Result<WebSocket<Box<dyn Io>>, Failure> {
    let unreachable = |e: anyhow::Error| Failure::Unreachable(e);
    let uri: ureq::http::Uri = cfg.url.parse().map_err(|e| unreachable(anyhow!("{e}")))?;
    let tls = uri.scheme_str() == Some("https");
    let host = uri.host().ok_or_else(|| unreachable(anyhow!("no host in NYX_URL")))?.trim_start_matches('[').trim_end_matches(']');
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
    if addrs.is_empty() || resolved.is_none_or(|t| t.elapsed() > DNS_REUSE) {
        *addrs = crate::dns::resolve(&cfg.dns, host, port).map_err(|e| unreachable(e.into()))?;
        *resolved = Some(Instant::now());
    }
    let tcp = addrs.iter().find_map(|a| TcpStream::connect_timeout(a, Duration::from_secs(10)).ok()).ok_or_else(|| unreachable(anyhow!("cannot connect to {host}:{port}")))?;
    // From here something answers: a failure is a refusal, which HTTPS may get through.
    let refused = |e: anyhow::Error| Failure::Refused(e);
    tcp.set_read_timeout(Some(TIMEOUT)).map_err(|e| refused(e.into()))?;
    tcp.set_write_timeout(Some(TIMEOUT)).map_err(|e| refused(e.into()))?;
    let _ = tcp.set_nodelay(true);
    let stream: Box<dyn Io> = if tls {
        let tls = || -> anyhow::Result<Box<dyn Io>> {
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let verifier = rustls_platform_verifier::Verifier::new(provider.clone())?;
            let config = rustls::ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions()?.dangerous().with_custom_certificate_verifier(Arc::new(verifier)).with_no_client_auth();
            let name = rustls::pki_types::ServerName::try_from(host.to_string())?;
            Ok(Box::new(rustls::StreamOwned::new(rustls::ClientConnection::new(Arc::new(config), name)?, tcp)))
        };
        tls().map_err(refused)?
    } else {
        Box::new(tcp)
    };
    let path = if cfg.relay_key.is_empty() { "/agent/v1/ws" } else { "/_relay/ws" };
    let url = format!("{}{path}", cfg.url.replacen("http", "ws", 1));
    tungstenite::client(url.as_str(), stream).map(|(ws, _)| ws).map_err(|e| match e {
        // A proxy whose monitor is down or restarting: back soon, and HTTPS would get the same.
        tungstenite::HandshakeError::Failure(tungstenite::Error::Http(r)) if r.status().is_server_error() => Failure::Unreachable(anyhow!("the proxy answered {}", r.status())),
        e => refused(anyhow!("{e}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A monitor's socket that answers each call with its path, after a ping and a stale
    /// answer the agent must skip. The second connection is refused: HTTPS takes over.
    /// The tests below share the one socket of the agent: one at a time, from a clean slate.
    static SERIAL: Mutex<()> = Mutex::new(());
    fn clean() -> std::sync::MutexGuard<'static, ()> {
        let g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        *SOCKET.lock().unwrap_or_else(|e| e.into_inner()) = Socket { ws: None, https_until: None, next_try: None, backoff: FIRST_BACKOFF, heard: None, next: 0, addrs: Vec::new(), resolved: None };
        g
    }

    fn cfg_for(addr: std::net::SocketAddr) -> Config {
        let flag = |f: &str| match f {
            "--url" => Some(format!("http://{addr}")),
            "--token" | "--key" => Some("x".into()),
            "--kind" => Some("vm".into()),
            _ => None,
        };
        Config::from_flags("p".into(), &flag, false).unwrap()
    }

    const HEADERS: [(&str, String); 0] = [];
    fn call(cfg: &Config, p: &str) -> Option<anyhow::Result<String>> {
        over_socket(cfg, p, &HEADERS, b"{}").map(|r| r.map(|b| String::from_utf8(b).unwrap()))
    }

    /// Answers `calls` calls on an accepted socket, as the monitor does.
    fn serve(ws: &mut WebSocket<TcpStream>, calls: usize) {
        for _ in 0..calls {
            let f = loop {
                if let Message::Binary(f) = ws.read().unwrap() {
                    break f; // after the pong of the previous ping
                }
            };
            assert_eq!(f[4], PLAIN);
            let (head, _) = unpack::<ReqHead>(&f[5..]).unwrap();
            ws.send(Message::Ping(vec![].into())).unwrap();
            ws.send(Message::binary([&[9, 9, 9, 9, PLAIN][..], &pack(&ResHead { s: 200, h: vec![] }, b"\"stale\"")].concat())).unwrap();
            let body = format!("\"{}\"", head.p);
            ws.send(Message::binary([&f[..4], &[PLAIN], &pack(&ResHead { s: 200, h: vec![] }, body.as_bytes())].concat())).unwrap();
        }
    }

    #[test]
    fn calls_go_over_one_socket_and_a_closed_one_is_replaced_without_https() {
        let _g = clean();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            // Two connections: the first one closed after two calls, as a proxy closes an idle socket.
            for calls in [2, 1] {
                let mut ws = tungstenite::accept(listener.accept().unwrap().0).unwrap();
                serve(&mut ws, calls);
                let _ = ws.close(None);
                // Read until the agent hangs up: closing with its pong unread makes Linux send
                // an RST, which can wipe the last answer before the agent reads it.
                while ws.read().is_ok() {}
            }
        });
        let cfg = cfg_for(addr);
        let ok = |p: &str| call(&cfg, p).map(|r| r.unwrap());
        assert_eq!(ok("/agent/v1/report").as_deref(), Some("\"/agent/v1/report\""));
        assert_eq!(ok("/agent/v1/logs").as_deref(), Some("\"/agent/v1/logs\""));
        assert_eq!(ok("/agent/v1/report").as_deref(), Some("\"/agent/v1/report\""), "the socket was closed: a fresh one, not HTTPS");
        SOCKET.lock().unwrap().ws = None; // hang up, so that the server goes away
        server.join().unwrap();
        let down = call(&cfg, "/agent/v1/report").expect("nothing listens: HTTPS would fail too, so none is tried");
        assert!(down.is_err());
        let s = SOCKET.lock().unwrap();
        assert!(s.next_try.is_some() && !s.https_only(), "tried again soon, over the socket");
        assert_eq!(s.backoff, FIRST_BACKOFF * 2);
    }

    /// A server that answers the upgrade with a plain HTTP status, as a proxy would.
    fn answers(status: &'static str) -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut tcp, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = tcp.read(&mut buf);
            let _ = tcp.write_all(format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes());
        });
        addr
    }

    #[test]
    fn a_refused_upgrade_means_https_for_a_while() {
        let _g = clean();
        let cfg = cfg_for(answers("404 Not Found"));
        assert!(call(&cfg, "/agent/v1/report").is_none(), "over HTTPS");
        assert!(SOCKET.lock().unwrap().https_only());
        assert!(call(&cfg, "/agent/v1/report").is_none(), "still HTTPS, without trying the socket again");
    }

    #[test]
    fn a_proxy_whose_monitor_is_down_is_tried_again_soon_not_over_https() {
        let _g = clean();
        let cfg = cfg_for(answers("502 Bad Gateway"));
        assert!(call(&cfg, "/agent/v1/report").is_some_and(|r| r.is_err()));
        let s = SOCKET.lock().unwrap();
        assert!(!s.https_only() && s.next_try.is_some());
    }

    #[test]
    fn a_dead_socket_is_noticed_and_replaced_while_idle() {
        let _g = clean();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut ws = tungstenite::accept(listener.accept().unwrap().0).unwrap();
            serve(&mut ws, 1);
            drop(ws); // the connection dies without a word
            let mut ws = tungstenite::accept(listener.accept().unwrap().0).unwrap();
            loop {
                if let Message::Ping(_) = ws.read().unwrap() {
                    return; // the new socket is kept alive
                }
            }
        });
        let cfg = cfg_for(addr);
        assert!(call(&cfg, "/agent/v1/report").is_some_and(|r| r.is_ok()));
        std::thread::sleep(Duration::from_millis(100));
        keep_up(&cfg);
        server.join().unwrap();
        assert!(SOCKET.lock().unwrap().ws.is_some());
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

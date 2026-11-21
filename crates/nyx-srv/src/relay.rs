//! Client of the zero-knowledge Cloudflare relay (`relay/` in the repository).
//!
//! The server keeps one outbound WebSocket to the Worker, so it needs no open port.
//! Each frame holds a request sealed by an agent or a browser with the relay key. The
//! server opens it, answers it from its own router as if it had come in directly, and
//! seals the answer. The Worker never has the key and only forwards ciphertext. The one
//! exception is the short list in [`relay::is_public`], served in clear because
//! `curl … | sh` cannot decrypt.
//!
//! Frame, both ways: `id (u32 BE) || kind (0 sealed, 1 plain) || payload`.

use crate::Env;
use axum::{body::Body, http::Request, Router};
use futures_util::{SinkExt, StreamExt};
use nyx_proto::relay::{self, nonce, pack, unpack, Key, ReqHead, ResHead};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use tower::ServiceExt;

const SEALED: u8 = 0;
const PLAIN: u8 = 1;
/// The Worker answers each `hb` with `ok` without waking up; three missed is a dead link.
const HEARTBEAT: Duration = Duration::from_secs(30);
/// How far a sealed request's clock may be from ours. Its nonce is kept twice as long.
const WINDOW_S: u64 = 300;
const MAX_BODY: usize = 64 << 20;

static CONNECTED: AtomicBool = AtomicBool::new(false);

pub fn connected() -> bool {
    CONNECTED.load(Ordering::Relaxed)
}

struct Link {
    url: String,
    secret: String,
    key: Key,
    seen: Mutex<HashMap<Vec<u8>, u64>>,
}

/// Starts the link when `NYX_RELAY_URL` is set. `router` is the server's whole API.
pub fn spawn(router: Router, env: &Env) {
    let (Some(url), Some(secret), Some(key)) = (&env.relay_url, &env.relay_secret, &env.relay_key) else { return };
    let ws = url.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
    let link = Arc::new(Link { url: format!("{ws}/_relay/up"), secret: secret.clone(), key: Key::parse(key).expect("checked by Env::load"), seen: Mutex::default() });
    let _ = rustls::crypto::ring::default_provider().install_default();
    tokio::spawn(async move {
        let mut wait = 1;
        loop {
            let started = Instant::now();
            let ended = session(&link, &router).await;
            CONNECTED.store(false, Ordering::Relaxed);
            match ended {
                Ok(()) => eprintln!("relay: the Worker closed the link"),
                Err(e) => eprintln!("relay: {e:#}"),
            }
            wait = if started.elapsed() > Duration::from_secs(60) { 1 } else { (wait * 2).min(60) };
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
    });
}

async fn session(link: &Arc<Link>, router: &Router) -> anyhow::Result<()> {
    let mut req = link.url.as_str().into_client_request()?;
    req.headers_mut().insert("authorization", format!("Bearer {}", link.secret).parse()?);
    let (ws, _) = tokio_tungstenite::connect_async(req).await?;
    CONNECTED.store(true, Ordering::Relaxed);
    println!("relay: linked to {}", link.url);
    let (mut tx, mut rx) = ws.split();
    let (out, mut replies) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let mut beat = tokio::time::interval(HEARTBEAT);
    let mut alive = Instant::now();
    loop {
        tokio::select! {
            _ = beat.tick() => {
                anyhow::ensure!(alive.elapsed() < HEARTBEAT * 3, "the Worker stopped answering");
                tx.send(Message::text("hb")).await?;
            }
            Some(frame) = replies.recv() => tx.send(Message::binary(frame)).await?,
            m = rx.next() => match m {
                None | Some(Ok(Message::Close(_))) => return Ok(()),
                Some(Err(e)) => return Err(e.into()),
                Some(Ok(Message::Text(t))) if t.as_str() == "ok" => alive = Instant::now(),
                Some(Ok(Message::Binary(frame))) if frame.len() > 5 => {
                    let (link, router, out) = (link.clone(), router.clone(), out.clone());
                    tokio::spawn(async move {
                        let (kind, payload) = answer(&link, &router, frame[4], &frame[5..]).await;
                        let _ = out.send([&frame[..4], &[kind], &payload].concat());
                    });
                }
                _ => {}
            },
        }
    }
}

async fn answer(link: &Link, router: &Router, kind: u8, payload: &[u8]) -> (u8, Vec<u8>) {
    if kind == PLAIN {
        let path = unpack::<ReqHead>(payload).filter(|(h, _)| h.m == "GET").map(|(h, _)| h.p.split('?').next().unwrap_or_default().to_string());
        return match path.filter(|p| relay::is_public(p)) {
            Some(p) => {
                let (head, body) = call(router, ReqHead { m: "GET".into(), p, h: vec![], t: 0 }, &[]).await;
                (PLAIN, pack(&head, &body))
            }
            None => refuse(403, "only public files are served without the relay key"),
        };
    }
    let Some(plain) = link.key.open(b"", payload) else { return refuse(403, "relay key rejected: open the link from Settings → This server again") };
    let Some((head, body)) = unpack::<ReqHead>(&plain) else { return refuse(400, "malformed request") };
    if !fresh(&link.seen, nonce(payload), head.t, unix_now()) {
        return refuse(403, "request replayed, or this device's clock is off by more than 5 minutes");
    }
    let (res, body) = call(router, head, body).await;
    (SEALED, link.key.seal(nonce(payload), &pack(&res, &body)))
}

/// Refuses a replay: the Worker could send a sealed request twice.
fn fresh(seen: &Mutex<HashMap<Vec<u8>, u64>>, nonce: &[u8], t: u64, now: u64) -> bool {
    if t.abs_diff(now) > WINDOW_S {
        return false;
    }
    let mut seen = seen.lock().unwrap();
    seen.retain(|_, at| now.saturating_sub(*at) <= 2 * WINDOW_S);
    seen.insert(nonce.to_vec(), now).is_none()
}

fn refuse(status: u16, msg: &str) -> (u8, Vec<u8>) {
    let head = ResHead { s: status, h: vec![("content-type".into(), "application/json".into())] };
    (PLAIN, pack(&head, json!({ "error": msg }).to_string().as_bytes()))
}

/// Runs the request through the router, like one that came in on the listener.
async fn call(router: &Router, head: ReqHead, body: &[u8]) -> (ResHead, Vec<u8>) {
    if !head.p.starts_with('/') {
        return (ResHead { s: 400, h: vec![] }, vec![]);
    }
    let mut req = Request::builder().method(head.m.as_str()).uri(&head.p);
    for (k, v) in &head.h {
        req = req.header(k, v);
    }
    let Ok(req) = req.body(Body::from(body.to_vec())) else { return (ResHead { s: 400, h: vec![] }, vec![]) };
    let Ok(res) = router.clone().oneshot(req).await;
    let s = res.status().as_u16();
    let h = res.headers().iter().filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string()))).collect();
    match axum::body::to_bytes(res.into_body(), MAX_BODY).await {
        Ok(b) => (ResHead { s, h }, b.to_vec()),
        Err(_) => (ResHead { s: 502, h: vec![] }, b"answer too large for the relay".to_vec()),
    }
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};

    const K: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn link() -> Link {
        Link { url: String::new(), secret: String::new(), key: Key::parse(K).unwrap(), seen: Mutex::default() }
    }

    #[test]
    fn replays_and_stale_requests_are_refused() {
        let seen = Mutex::default();
        assert!(fresh(&seen, b"n1", 1000, 1000));
        assert!(!fresh(&seen, b"n1", 1000, 1001), "same nonce twice");
        assert!(fresh(&seen, b"n2", 1000, 1000 + WINDOW_S));
        assert!(!fresh(&seen, b"n3", 1000, 1001 + WINDOW_S), "too old");
        assert!(!fresh(&seen, b"n4", 2000 + WINDOW_S, 1999), "from the future");
    }

    #[tokio::test]
    async fn sealed_and_public_requests_reach_the_router() {
        let router = Router::new()
            .route("/api/echo", post(|h: axum::http::HeaderMap, b: String| async move { format!("{}:{b}", h["x-a"].to_str().unwrap()) }))
            .route("/install.sh", get(|| async { "#!/bin/sh" }))
            .route("/api/hosts", get(|| async { "secret" }));
        let l = link();
        let head = ReqHead { m: "POST".into(), p: "/api/echo".into(), h: vec![("x-a".into(), "1".into())], t: unix_now() };
        let sealed = l.key.seal(b"", &pack(&head, b"hi"));
        let (kind, out) = answer(&l, &router, SEALED, &sealed).await;
        let plain = l.key.open(nonce(&sealed), &out).expect("sealed for this request");
        let (res, body) = unpack::<ResHead>(&plain).unwrap();
        assert_eq!((kind, res.s, body), (SEALED, 200, &b"1:hi"[..]));
        assert_eq!(answer(&l, &router, SEALED, &sealed).await.0, PLAIN, "a replay gets a plain refusal");

        let get_plain = |p: &str| pack(&ReqHead { m: "GET".into(), p: p.into(), h: vec![], t: 0 }, b"");
        let (_, out) = answer(&l, &router, PLAIN, &get_plain("/install.sh?x=1")).await;
        assert_eq!(unpack::<ResHead>(&out).unwrap().1, b"#!/bin/sh");
        let (_, out) = answer(&l, &router, PLAIN, &get_plain("/api/hosts")).await;
        assert_eq!(unpack::<ResHead>(&out).unwrap().0.s, 403, "the API never goes out in clear");
        let wrong = Key::parse(&K.replace('0', "1")).unwrap().seal(b"", &pack(&head, b""));
        assert_eq!(unpack::<ResHead>(&answer(&l, &router, SEALED, &wrong).await.1).unwrap().0.s, 403);
    }
}

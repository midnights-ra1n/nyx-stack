//! Envelope of the zero-knowledge relay (`relay/`, a Cloudflare Worker).
//!
//! Agents and browsers seal each HTTP request with the relay key, the Worker forwards
//! the bytes to the server over its outbound WebSocket, and the answer comes back sealed
//! the same way. The Worker never holds the key, so it sees sizes and timing, not data.
//!
//! Sealed: `nonce (12) || AES-256-GCM(plain) || tag (16)`. A response is sealed with the
//! nonce of its request as associated data, so it cannot be swapped with another one.
//! Plain: `u32 BE header length || header JSON || body bytes`.

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub const PATH: &str = "/_relay";
/// Frames on the relay's WebSockets, and on the socket agents keep to a monitor:
/// `id (u32 BE) || kind || payload`, the payload sealed or packed in clear.
pub const SEALED: u8 = 0;
pub const PLAIN: u8 = 1;
/// Fetched without the key, so in clear: files for `curl … | sh`, and the public API of
/// status pages, which anyone may read anyway. GET only, and without headers, so a wall
/// display's key never travels this way.
pub fn is_public(path: &str) -> bool {
    path == "/install.sh" || path == "/api/health" || path.starts_with("/api/public/") || path.strip_prefix("/agent/v1/binary/").is_some_and(|n| !n.is_empty() && !n.contains('/'))
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ReqHead {
    /// Method, path with query, headers, and the Unix time it was sealed at.
    pub m: String,
    pub p: String,
    #[serde(default)]
    pub h: Vec<(String, String)>,
    #[serde(default)]
    pub t: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ResHead {
    pub s: u16,
    #[serde(default)]
    pub h: Vec<(String, String)>,
}

pub struct Key(LessSafeKey);

impl Key {
    /// 64 hex characters, as `openssl rand -hex 32` prints.
    pub fn parse(hex: &str) -> Option<Self> {
        let bytes = crate::unhex(hex.trim()).filter(|b| b.len() == 32)?;
        Some(Self(LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &bytes).ok()?)))
    }

    pub fn seal(&self, aad: &[u8], plain: &[u8]) -> Vec<u8> {
        let mut nonce = [0u8; NONCE_LEN];
        SystemRandom::new().fill(&mut nonce).expect("OS random source");
        let mut out = nonce.to_vec();
        let mut buf = plain.to_vec();
        self.0.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(aad), &mut buf).expect("plaintext fits AES-GCM");
        out.extend(buf);
        out
    }

    pub fn open(&self, aad: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
        let (nonce, ct) = sealed.split_at_checked(NONCE_LEN)?;
        let mut buf = ct.to_vec();
        let n = self.0.open_in_place(Nonce::try_assume_unique_for_key(nonce).ok()?, Aad::from(aad), &mut buf).ok()?.len();
        buf.truncate(n);
        Some(buf)
    }
}

/// The nonce of a sealed request: what its response is bound to.
pub fn nonce(sealed: &[u8]) -> &[u8] {
    &sealed[..NONCE_LEN.min(sealed.len())]
}

pub fn pack(head: &impl Serialize, body: &[u8]) -> Vec<u8> {
    let head = serde_json::to_vec(head).expect("headers serialize");
    let mut out = (head.len() as u32).to_be_bytes().to_vec();
    out.extend(head);
    out.extend_from_slice(body);
    out
}

pub fn unpack<T: DeserializeOwned>(buf: &[u8]) -> Option<(T, &[u8])> {
    let (len, rest) = buf.split_at_checked(4)?;
    let (head, body) = rest.split_at_checked(u32::from_be_bytes(len.try_into().ok()?) as usize)?;
    Some((serde_json::from_slice(head).ok()?, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    const K: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    #[test]
    fn seal_open_round_trip_and_tamper() {
        let k = Key::parse(K).unwrap();
        let s = k.seal(b"", b"hello");
        assert_eq!(k.open(b"", &s).as_deref(), Some(&b"hello"[..]));
        assert!(k.open(b"other", &s).is_none(), "bound to its associated data");
        let mut bad = s.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(k.open(b"", &bad).is_none());
        assert_ne!(nonce(&k.seal(b"", b"x")), nonce(&k.seal(b"", b"x")));
        assert!(Key::parse("abcd").is_none() && Key::parse(&K.replace('0', "g")).is_none());
        assert!(k.open(b"", b"short").is_none());
    }

    #[test]
    fn pack_round_trip() {
        let h = ReqHead { m: "POST".into(), p: "/a?b=1".into(), h: vec![("x".into(), "y".into())], t: 7 };
        let buf = pack(&h, b"\0body");
        let (back, body) = unpack::<ReqHead>(&buf).unwrap();
        assert_eq!((back, body), (h, &b"\0body"[..]));
        assert!(unpack::<ReqHead>(&[0, 0, 1, 0, b'{']).is_none());
    }

    /// Sealed by `web/src/ui/envelope.ts`: the browser and the Worker speak the same format.
    #[test]
    fn opens_what_the_browser_seals() {
        let ts = "f05b182956d8a29a929d3a7704feabe66d8b212c700c8388d80b931fd91a95edb546d7fbb5bdb44908f49a06132979ff556b35850333fcd4f3bd616fc4d1a04bec948852ca8ef1da032e22da9314687a";
        let plain = Key::parse(K).unwrap().open(b"req", &crate::unhex(ts).unwrap()).unwrap();
        let (head, body) = unpack::<ReqHead>(&plain).unwrap();
        assert_eq!((head, body), (ReqHead { m: "GET".into(), p: "/api/x".into(), h: vec![("a".into(), "b".into())], t: 5 }, &b"hi"[..]));
    }

    #[test]
    fn public_paths() {
        assert!(is_public("/install.sh") && is_public("/agent/v1/binary/nyx-agent-linux-x86_64") && is_public("/api/public/pages/home"));
        assert!(!is_public("/agent/v1/binary/") && !is_public("/agent/v1/binary/a/b") && !is_public("/agent/v1/report") && !is_public("/api/hosts"));
    }
}

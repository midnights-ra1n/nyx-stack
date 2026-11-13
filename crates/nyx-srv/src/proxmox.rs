//! Proxmox console access. The settings hold the server address and either a user with
//! its password or an API token.
//!
//! A token (or a password) lets Nyx check the connection. Only a password can open the
//! console without a sign-in page: Nyx asks Proxmox for a ticket and hands it to the browser
//! as the `PVEAuthCookie` Proxmox itself would set. A browser only sends a cookie to hosts
//! that share its domain, so this works when Nyx and Proxmox do (`nyx.home.lan` and
//! `pve.home.lan`), and otherwise the sign-in page of Proxmox appears as before.

use crate::{auth::Session, ApiError, ApiResult, Core};
use axum::{
    extract::{Query, State},
    http::{header, HeaderMap},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use reqwest::Url;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::Duration};

struct Server {
    url: Url,
    user: String,
    password: String,
    token: String,
    insecure: bool,
}

fn server(cfg: &Value) -> Result<Server, String> {
    let field = |k: &str| cfg[k].as_str().map(str::trim).unwrap_or_default().to_string();
    let url = Url::parse(field("url").trim_end_matches('/')).ok().filter(|u| ["http", "https"].contains(&u.scheme()) && u.host().is_some()).ok_or("Enter the Proxmox address, such as https://pve.lan:8006.")?;
    Ok(Server { url, user: field("user"), password: cfg["password"].as_str().unwrap_or_default().to_string(), token: field("token"), insecure: cfg["insecure"] == true })
}

impl Server {
    fn client(&self) -> anyhow::Result<reqwest::Client> {
        Ok(reqwest::Client::builder().tls_danger_accept_invalid_certs(self.insecure).timeout(Duration::from_secs(10)).redirect(reqwest::redirect::Policy::none()).build()?)
    }

    fn api(&self, path: &str) -> String {
        format!("{}/api2/json/{path}", self.url.as_str().trim_end_matches('/'))
    }
}

/// What Proxmox says when it refuses, which the status alone would hide.
fn explain(status: u16) -> String {
    match status {
        401 | 403 => "Proxmox refused these credentials. Use user@realm such as root@pam, or a token as user@realm!name=secret.".into(),
        s => format!("Proxmox answered with status {s}."),
    }
}

/// A browser session ticket for a user and password.
async fn ticket(s: &Server) -> Result<String, String> {
    if s.user.is_empty() || s.password.is_empty() {
        return Err("Fill in the user (such as root@pam) and the password.".into());
    }
    let res = s.client().map_err(|e| e.to_string())?.post(s.api("access/ticket")).json(&json!({"username": s.user, "password": s.password})).send().await.map_err(|e| format!("Cannot reach Proxmox: {}", e.without_url()))?;
    if !res.status().is_success() {
        return Err(explain(res.status().as_u16()));
    }
    let body: Value = res.json().await.map_err(|_| "Unexpected answer from Proxmox.")?;
    body["data"]["ticket"].as_str().map(String::from).ok_or_else(|| "Proxmox sent no ticket.".into())
}

/// Version of the server, proving the credentials work.
async fn version(s: &Server) -> Result<String, String> {
    let client = s.client().map_err(|e| e.to_string())?;
    let req = if !s.token.is_empty() {
        client.get(s.api("version")).header("authorization", format!("PVEAPIToken={}", s.token))
    } else {
        client.get(s.api("version")).header("cookie", format!("PVEAuthCookie={}", encode(&ticket(s).await?)))
    };
    let res = req.send().await.map_err(|e| format!("Cannot reach Proxmox: {}", e.without_url()))?;
    if !res.status().is_success() {
        return Err(explain(res.status().as_u16()));
    }
    let body: Value = res.json().await.map_err(|_| "Unexpected answer from Proxmox.")?;
    Ok(body["data"]["version"].as_str().unwrap_or("unknown").into())
}

/// Tickets hold `:`, `=`, `+` and `/`, which a cookie value must carry escaped.
fn encode(ticket: &str) -> String {
    ticket.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// Domain a cookie set from `nyx_host` also reaches `pve_host` with: none when they are one
/// host, the longest common parent otherwise, and `None` for addresses and unrelated hosts.
fn shared_domain(nyx_host: &str, pve_host: &str) -> Option<String> {
    if nyx_host.eq_ignore_ascii_case(pve_host) {
        return Some(String::new());
    }
    if nyx_host.parse::<std::net::IpAddr>().is_ok() || pve_host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    let (a, b): (Vec<_>, Vec<_>) = (nyx_host.rsplit('.').collect(), pve_host.rsplit('.').collect());
    let common: Vec<&str> = a.iter().zip(&b).take_while(|(x, y)| x.eq_ignore_ascii_case(y)).map(|(x, _)| *x).collect();
    // Two labels at least: `lan` alone is a suffix, which browsers refuse.
    (common.len() >= 2).then(|| common.iter().rev().copied().collect::<Vec<_>>().join("."))
}

/// The console of a guest or of the node's shell, from the few values the interface knows.
fn console_url(s: &Server, q: &HashMap<String, String>) -> Option<String> {
    let kind = q.get("console").map(String::as_str).filter(|k| ["lxc", "kvm", "shell"].contains(k))?;
    let safe = |v: &str| !v.is_empty() && v.len() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    let mut url = s.url.clone();
    url.set_path("/");
    let mut pairs = url.query_pairs_mut();
    pairs.append_pair("novnc", "1").append_pair("console", kind);
    for key in ["vmid", "node"] {
        match q.get(key) {
            Some(v) if safe(v) => { pairs.append_pair(key, v); }
            Some(_) => return None,
            None if key == "node" || kind != "shell" => return None,
            None => {}
        }
    }
    if let Some(name) = q.get("vmname").filter(|n| !n.is_empty()) {
        pairs.append_pair("vmname", &name.chars().take(64).collect::<String>());
    }
    drop(pairs);
    Some(url.into())
}

async fn open_console(_: Session, State(core): State<Arc<Core>>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> ApiResult<Response> {
    let cfg = core.pb.setting("proxmox").await?.unwrap_or_default();
    let s = server(&cfg).map_err(ApiError::bad_request)?;
    let target = console_url(&s, &q).ok_or_else(|| ApiError::bad_request("unknown console"))?;
    let mut res = Redirect::to(&target).into_response();
    if !s.user.is_empty() && !s.password.is_empty() && s.token.is_empty() {
        let nyx_host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).map(|h| h.rsplit_once(':').filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit())).map_or(h, |(h, _)| h).trim_matches(['[', ']']).to_string()).unwrap_or_default();
        // A failed sign-in leaves the sign-in page of Proxmox to do it.
        if let (Some(domain), Ok(t)) = (shared_domain(&nyx_host, s.url.host_str().unwrap_or_default()), ticket(&s).await) {
            let domain = if domain.is_empty() { String::new() } else { format!("; Domain={domain}") };
            let secure = if s.url.scheme() == "https" { "; Secure" } else { "" };
            // Not HttpOnly: the Proxmox interface reads this cookie to know it is signed in.
            let cookie = format!("PVEAuthCookie={}; Path=/; Max-Age=7200; SameSite=Lax{domain}{secure}", encode(&t));
            res.headers_mut().append(header::SET_COOKIE, cookie.parse().map_err(|_| ApiError::bad_request("bad cookie"))?);
        }
    }
    Ok(res)
}

async fn test(_: Session, State(core): State<Arc<Core>>) -> ApiResult<Json<Value>> {
    let cfg = core.pb.setting("proxmox").await?.unwrap_or_default();
    let s = server(&cfg).map_err(ApiError::bad_request)?;
    let v = version(&s).await.map_err(ApiError::bad_request)?;
    Ok(Json(json!({"version": v})))
}

pub fn router() -> Router<Arc<Core>> {
    Router::new().route("/api/proxmox/test", post(test)).route("/api/proxmox/console", get(open_console))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s() -> Server {
        server(&json!({"url": "https://pve.home.lan:8006/", "user": "root@pam", "password": "x"})).unwrap()
    }

    fn q(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn the_address_must_be_a_web_address() {
        assert!(server(&json!({"url": "pve.lan"})).is_err());
        assert!(server(&json!({"url": "ftp://pve.lan"})).is_err());
        assert!(server(&json!({})).is_err());
        assert_eq!(s().api("version"), "https://pve.home.lan:8006/api2/json/version");
    }

    #[test]
    fn a_cookie_is_only_shared_with_hosts_of_the_same_domain() {
        assert_eq!(shared_domain("nyx.home.lan", "pve.home.lan").as_deref(), Some("home.lan"));
        assert_eq!(shared_domain("pve.home.lan", "PVE.home.lan").as_deref(), Some(""));
        assert_eq!(shared_domain("nyx.lan", "pve.lan"), None, "`lan` is a suffix");
        assert_eq!(shared_domain("192.168.1.2", "192.168.1.3"), None);
        assert_eq!(shared_domain("nyx.example.org", "pve.home.lan"), None);
    }

    #[test]
    fn tickets_are_escaped_for_a_cookie() {
        assert_eq!(encode("PVE:root@pam:5F=="), "PVE%3Aroot%40pam%3A5F%3D%3D");
    }

    #[test]
    fn consoles_are_built_from_checked_values_only() {
        let guest = console_url(&s(), &q(&[("console", "lxc"), ("vmid", "101"), ("node", "pve"), ("vmname", "web & co")])).unwrap();
        assert_eq!(guest, "https://pve.home.lan:8006/?novnc=1&console=lxc&vmid=101&node=pve&vmname=web+%26+co");
        assert!(console_url(&s(), &q(&[("console", "shell"), ("node", "pve")])).unwrap().ends_with("console=shell&node=pve"));
        assert!(console_url(&s(), &q(&[("console", "lxc"), ("node", "pve")])).is_none(), "a guest needs its id");
        assert!(console_url(&s(), &q(&[("console", "lxc"), ("vmid", "1&x=2"), ("node", "pve")])).is_none());
        assert!(console_url(&s(), &q(&[("console", "other"), ("node", "pve")])).is_none());
    }
}

//! Optional link to nyx-monitor, read-only: the fleet's health, EDF Tempo and the pipelines
//! for the overview's panels. Monitored hosts stay out of the inventory and IPAM.

use crate::App;
use anyhow::{bail, Context};
use nyx_proto::relay::Key;

pub struct Link {
    url: String,
    token: String,
    /// The monitor's relay key, when `url` is its Cloudflare relay: calls go sealed.
    key: Option<Key>,
}

pub async fn config(app: &App) -> anyhow::Result<Option<Link>> {
    let Some(cfg) = app.core.pb.setting("link").await? else { return Ok(None) };
    let (url, token) = (cfg["url"].as_str().unwrap_or_default(), cfg["token"].as_str().unwrap_or_default());
    if url.is_empty() || token.is_empty() {
        return Ok(None);
    }
    let key = match cfg["relay_key"].as_str().map(str::trim).unwrap_or_default() {
        "" => None,
        k => Some(Key::parse(k).context("the monitor's relay key must be 64 hexadecimal characters")?),
    };
    Ok(Some(Link { url: url.trim_end_matches('/').to_string(), token: token.to_string(), key }))
}

/// One call to the linked monitor, direct or sealed through its relay. Returns the
/// status and body.
async fn call(app: &App, link: &Link, method: &str, path: &str, body: Option<&impl serde::Serialize>) -> anyhow::Result<(u16, Vec<u8>)> {
    let body = body.map(serde_json::to_vec).transpose()?.unwrap_or_default();
    let mut headers = vec![("authorization".to_string(), format!("Bearer {}", link.token))];
    if !body.is_empty() {
        headers.push(("content-type".into(), "application/json".into()));
    }
    if let Some(key) = &link.key {
        return nyx_srv::relay::sealed_call(&app.http, &link.url, key, method, path, headers, body).await;
    }
    let mut req = app.http.request(method.parse()?, format!("{}{path}", link.url)).body(body);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let res = req.send().await?;
    Ok((res.status().as_u16(), res.bytes().await?.to_vec()))
}

/// The body of a successful call, as JSON.
fn ok<T: serde::de::DeserializeOwned>(path: &str, (status, body): (u16, Vec<u8>)) -> anyhow::Result<T> {
    if status >= 400 {
        bail!("monitor: {path}: http status {status}: {}", String::from_utf8_lossy(&body));
    }
    Ok(serde_json::from_slice(&body)?)
}

/// `GET /api/link/{path}` on the linked monitor, `None` without a link.
pub async fn get<T: serde::de::DeserializeOwned>(app: &App, path: &str) -> anyhow::Result<Option<T>> {
    let Some(link) = config(app).await? else { return Ok(None) };
    let path = format!("/api/link/{path}");
    Ok(Some(ok(&path, call(app, &link, "GET", &path, None::<&()>).await?)?))
}

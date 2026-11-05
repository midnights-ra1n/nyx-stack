//! Updates of servers installed from `.deb` or `.rpm` packages.
//!
//! The server runs unprivileged, so it only drops a request file. A root systemd
//! path unit picks it up, see `packaging/update.sh`. GitHub is contacted only when
//! the user asks for a check. Docker installs update by pulling a new image.
//!
//! Release tags are `vX.Y.Z`, or `vX.Y.Z-beta.N` on the beta channel, which leads
//! up to the stable version of the same number.

use crate::{auth::Session, ApiError, ApiResult, Core};
use axum::{extract::State, routing::{get, post}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const RELEASES: &str = "https://api.github.com/repos/midnights-ra1n/nyx-stack/releases";
/// Beta releases follow each push, so the newest is always on the first page.
const BETA_LOOKBACK: u32 = 30;

fn update_dir() -> Option<String> {
    std::env::var("NYX_UPDATE_DIR").ok().filter(|d| !d.is_empty())
}

/// `(major, minor, patch, beta)`, in comparing order. A stable release has the
/// highest beta number, so it outranks every beta of its version.
fn parse_version(v: &str) -> Option<(u32, u32, u32, u32)> {
    let v = v.strip_prefix('v')?;
    let (core, beta) = match v.split_once("-beta.") {
        Some((core, beta)) => (core, beta.parse().ok().filter(|b| *b != u32::MAX)?),
        None => (v, u32::MAX),
    };
    let mut p = core.split('.').map(|n| n.parse().ok());
    let t = (p.next()??, p.next()??, p.next()??, beta);
    p.next().is_none().then_some(t)
}

fn is_newer(tag: &str, current: &str) -> bool {
    parse_version(tag) > parse_version(&format!("v{current}"))
}

async fn version(_: Session) -> Json<Value> {
    Json(json!({"version": env!("CARGO_PKG_VERSION"), "managed": update_dir().is_some()}))
}

/// The highest version in a list of GitHub releases, beta or not.
fn newest(releases: &Value) -> &str {
    let tags = releases.as_array().into_iter().flatten().filter(|r| r["draft"] != true).filter_map(|r| r["tag_name"].as_str());
    tags.max_by_key(|t| parse_version(t)).unwrap_or_default()
}

async fn check(_: Session, State(core): State<Arc<Core>>) -> ApiResult<Json<Value>> {
    let beta = core.pb.setting("updates").await?.is_some_and(|s| s["beta"] == true);
    let url = if beta { format!("{RELEASES}?per_page={BETA_LOOKBACK}") } else { format!("{RELEASES}/latest") };
    let fail = |e: reqwest::Error| ApiError::bad_request(format!("could not reach GitHub: {e}"));
    let answer: Value = reqwest::Client::new().get(url).header("user-agent", "nyx-stack").send().await.map_err(fail)?.error_for_status().map_err(fail)?.json().await.map_err(fail)?;
    let tag = if beta { newest(&answer) } else { answer["tag_name"].as_str().unwrap_or_default() };
    Ok(Json(json!({"latest": tag, "available": is_newer(tag, env!("CARGO_PKG_VERSION"))})))
}

#[derive(Deserialize)]
struct Update {
    tag: String,
}

async fn update(_: Session, Json(b): Json<Update>) -> ApiResult<Json<Value>> {
    let dir = update_dir().ok_or_else(|| ApiError::bad_request("this install is not managed by packages"))?;
    if parse_version(&b.tag).is_none() {
        return Err(ApiError::bad_request("not a release tag"));
    }
    tokio::fs::write(format!("{dir}/request"), b.tag).await.map_err(anyhow::Error::from)?;
    Ok(Json(Value::Null))
}

pub fn router() -> Router<Arc<Core>> {
    Router::new().route("/api/system/version", get(version)).route("/api/system/check", post(check)).route("/api/system/update", post(update))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically_and_junk_is_refused() {
        assert!(is_newer("v0.10.0", "0.9.9") && is_newer("v1.0.0", "0.9.9"));
        assert!(!is_newer("v0.1.0", "0.1.0") && !is_newer("garbage", "0.1.0"));
        for bad in ["0.1.0", "v1.2", "v1.2.3.4", "v1.2.3;rm", "v1.2.x", "v1.2.3-beta", "v1.2.3-beta.x", "v1.2.3-rc.1", "v1.2.3-beta.1;rm"] {
            assert_eq!(parse_version(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_stable_release_outranks_its_betas_which_outrank_the_previous_stable() {
        assert!(is_newer("v0.2.0-beta.2", "0.2.0-beta.1") && is_newer("v0.2.0-beta.10", "0.2.0-beta.9"));
        assert!(is_newer("v0.2.0", "0.2.0-beta.9") && is_newer("v0.2.0-beta.1", "0.1.9"));
        assert!(!is_newer("v0.2.0-beta.1", "0.2.0") && !is_newer("v0.1.9", "0.2.0-beta.1"));
    }

    #[test]
    fn the_newest_release_skips_drafts_and_may_be_stable_or_beta() {
        let list = |tags: &[(&str, bool)]| Value::Array(tags.iter().map(|(t, draft)| json!({"tag_name": t, "draft": draft})).collect());
        assert_eq!(newest(&list(&[("v0.2.0-beta.2", false), ("v0.1.9", false), ("v0.2.0-beta.3", true)])), "v0.2.0-beta.2");
        assert_eq!(newest(&list(&[("v0.2.0-beta.2", false), ("v0.2.0", false)])), "v0.2.0");
        assert_eq!(newest(&json!({"message": "rate limited"})), "");
    }
}

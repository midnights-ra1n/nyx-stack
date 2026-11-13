//! Node.js sites: deploy keys, deploys through agents, Git webhooks.

use crate::{link, App};
use anyhow::Context;
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use chrono::{Duration, Utc};
use nyx_proto::Deploy;
use nyx_srv::{auth::Session, notify, pb_date, random_hex, ApiError, ApiResult};
use rand_core::OsRng;
use serde::Deserialize;
use serde_json::{json, Value};
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use std::sync::Arc;

const DEPLOY_TIMEOUT_MIN: i64 = 30;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}

fn slug_ok(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Generate a key, or validate a pasted one. Returns `(private, public)`.
fn resolve_key(pasted: &str) -> Result<(String, String), ApiError> {
    let key = if pasted.trim().is_empty() {
        PrivateKey::random(&mut OsRng, Algorithm::Ed25519).map_err(anyhow::Error::from)?
    } else {
        PrivateKey::from_openssh(pasted.trim()).map_err(|_| ApiError::bad_request("not a valid OpenSSH private key"))?
    };
    if key.is_encrypted() {
        return Err(ApiError::bad_request("the key must not have a passphrase"));
    }
    let private = key.to_openssh(LineEnding::LF).map_err(anyhow::Error::from)?.to_string();
    let public = key.public_key().to_openssh().map_err(anyhow::Error::from)?;
    Ok((private, public))
}

#[derive(Deserialize)]
struct NewSite {
    name: String,
    host: String,
    repo: String,
    #[serde(default)]
    branch: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    run_user: String,
    #[serde(default)]
    install_cmd: String,
    #[serde(default)]
    build_cmd: String,
    #[serde(default)]
    start_cmd: String,
    #[serde(default)]
    ssh_private_key: String,
    #[serde(default)]
    service: String,
    /// Seconds as text, empty: the app's own cache headers.
    #[serde(default)]
    cache_max_age: String,
    #[serde(default)]
    env: String,
    #[serde(default)]
    health_url: String,
}

fn or<'a>(v: &'a str, default: &'a str) -> &'a str {
    if v.trim().is_empty() { default } else { v }
}

async fn create(_: Session, State(app): State<Arc<App>>, Json(b): Json<NewSite>) -> ApiResult<Json<Value>> {
    if !slug_ok(&b.name) {
        return Err(ApiError::bad_request("name may only use letters, digits, - and _"));
    }
    let (private, public) = resolve_key(&b.ssh_private_key)?;
    let secret = random_hex(24);
    let path = format!("/srv/{}", b.name);
    let rec = app.core.pb.create("sites", &json!({
        "name": b.name, "host": b.host, "repo": b.repo, "branch": or(&b.branch, "main"), "path": or(&b.path, &path),
        "run_user": or(&b.run_user, "www-data"), "install_cmd": or(&b.install_cmd, "npm ci"),
        "build_cmd": or(&b.build_cmd, "npm run build --if-present"), "start_cmd": or(&b.start_cmd, "npm start"), "service": b.service, "cache_max_age": b.cache_max_age, "env": b.env, "health_url": b.health_url,
        "ssh_private_key": private, "ssh_public_key": public, "webhook_secret": secret,
    })).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(json!({"id": rec["id"], "ssh_public_key": public, "webhook_url": format!("{}/hooks/git/{}", app.core.env.public_url, s(&rec, "id")), "webhook_secret": secret})))
}

/// Queue a deploy and open its tracking record.
async fn start_deploy(app: &App, site: &Value, commit: &str) -> anyhow::Result<String> {
    let d = Deploy {
        site: s(site, "name").into(),
        repo: s(site, "repo").into(),
        branch: s(site, "branch").into(),
        path: s(site, "path").into(),
        user: s(site, "run_user").into(),
        install_cmd: s(site, "install_cmd").into(),
        build_cmd: s(site, "build_cmd").into(),
        start_cmd: s(site, "start_cmd").into(),
        ssh_private_key: s(site, "ssh_private_key").into(),
        service: s(site, "service").into(),
        cache_max_age: s(site, "cache_max_age").parse().ok(),
        env: s(site, "env").into(),
        commit: commit.into(),
    };
    let cmd = link::deploy(app, s(site, "host"), &d).await?;
    let pb = &app.core.pb;
    pb.update("sites", s(site, "id"), &json!({"last_status": "running", "last_command": cmd, "last_deploy": pb_date(Utc::now())})).await?;
    pb.create("deployments", &json!({"name": s(site, "name"), "target": s(site, "host"), "status": "running", "command": cmd})).await?;
    Ok(cmd)
}

async fn deploy(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let site = app.core.pb.get("sites", &id).await.map_err(|_| ApiError::not_found())?;
    let cmd = start_deploy(&app, &site, "").await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(json!({"id": cmd})))
}

/// Deploy again the commit of an earlier deployment of this site.
async fn rollback(_: Session, State(app): State<Arc<App>>, Path((id, deployment)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let pb = &app.core.pb;
    let site = pb.get("sites", &id).await.map_err(|_| ApiError::not_found())?;
    let past = pb.get("deployments", &deployment).await.map_err(|_| ApiError::not_found())?;
    let commit = full_commit(s(&past, "notes")).filter(|_| s(&past, "name") == s(&site, "name") && s(&past, "status") == "ok");
    let commit = commit.ok_or_else(|| ApiError::bad_request("this deployment has no known commit"))?;
    let cmd = start_deploy(&app, &site, commit).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(json!({"id": cmd})))
}

#[derive(Deserialize)]
struct Control {
    op: String,
}

/// The service of a site: the one it was adopted with, or the one Nyx created.
fn service_of(site: &Value) -> String {
    if s(site, "service").is_empty() { format!("nyx-site-{}.service", s(site, "name")) } else { s(site, "service").into() }
}

async fn control(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>, Json(b): Json<Control>) -> ApiResult<Json<Value>> {
    if !["restart", "stop", "start", "logs"].contains(&b.op.as_str()) {
        return Err(ApiError::bad_request("unknown operation"));
    }
    let site = app.core.pb.get("sites", &id).await.map_err(|_| ApiError::not_found())?;
    let c = nyx_proto::SiteControl { op: b.op, service: service_of(&site), user: s(&site, "run_user").into() };
    let cmd = link::site_control(&app, s(&site, "host"), &c).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(json!({"id": cmd})))
}

/// `null` until the agent has answered.
async fn command_result(_: Session, State(app): State<Arc<App>>, Path(cmd): Path<String>) -> ApiResult<Json<Value>> {
    let r = link::result(&app, &cmd).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(r.map_or(Value::Null, |r| json!({"ok": r["ok"], "output": r["output"]}))))
}

async fn details(_: Session, State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let site = app.core.pb.get("sites", &id).await.map_err(|_| ApiError::not_found())?;
    Ok(Json(json!({"webhook_url": format!("{}/hooks/git/{id}", app.core.env.public_url), "webhook_secret": site["webhook_secret"], "ssh_public_key": site["ssh_public_key"]})))
}

fn signature_ok(secret: &str, headers: &HeaderMap, body: &[u8]) -> bool {
    if secret.is_empty() {
        return false;
    }
    let header = |n: &str| headers.get(n).and_then(|v| v.to_str().ok());
    if let Some(sig) = header("x-hub-signature-256").and_then(|v| v.strip_prefix("sha256=")) {
        return nyx_proto::verify_webhook(secret, body, sig); // GitHub, Gitea, Forgejo
    }
    // GitLab sends the secret itself; compare digests to stay constant-time-ish.
    header("x-gitlab-token").is_some_and(|t| nyx_proto::sha256_hex(t.as_bytes()) == nyx_proto::sha256_hex(secret.as_bytes()))
}

/// Public endpoint for Git forges; the signature is the only authentication.
async fn webhook(State(app): State<Arc<App>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> ApiResult<&'static str> {
    let denied = || ApiError::new(StatusCode::UNAUTHORIZED, "bad signature");
    let site = app.core.pb.get("sites", &id).await.map_err(|_| denied())?;
    if !signature_ok(s(&site, "webhook_secret"), &headers, &body) {
        return Err(denied());
    }
    let payload: Value = serde_json::from_slice(&body).unwrap_or_default();
    if payload["ref"].as_str() != Some(&format!("refs/heads/{}", s(&site, "branch"))) {
        return Ok("ignored");
    }
    start_deploy(&app, &site, "").await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok("deploying")
}

/// Commit hash the deploy script prints last.
fn commit_of(output: &str) -> &str {
    let line = output.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default().trim();
    if line.len() == 40 && line.chars().all(|c| c.is_ascii_hexdigit()) { &line[..7] } else { "" }
}

/// The full hash a deploy printed last, which a rollback needs.
fn full_commit(output: &str) -> Option<&str> {
    let line = output.lines().rev().find(|l| !l.trim().is_empty())?.trim();
    (line.len() == 40 && line.chars().all(|c| c.is_ascii_hexdigit())).then_some(line)
}

/// `ok`, then `failing` after one miss and `down` after two, so a single lost request stays quiet.
fn next_health(before: &str, up: bool) -> &'static str {
    match (up, before) {
        (true, _) => "ok",
        (false, "failing" | "down") => "down",
        (false, _) => "failing",
    }
}

/// Asks each site's address. Only a change to or from `down` is told.
pub async fn check_health(app: &App) -> anyhow::Result<()> {
    let pb = &app.core.pb;
    for site in pb.list("sites", "health_url != ''", "").await? {
        let up = app.http.get(s(&site, "health_url")).timeout(std::time::Duration::from_secs(10)).send().await.is_ok_and(|r| r.status().is_success());
        let (before, now) = (s(&site, "health"), next_health(s(&site, "health"), up));
        pb.update("sites", s(&site, "id"), &json!({"health": now, "health_at": pb_date(Utc::now())})).await?;
        let name = s(&site, "name");
        match (before, now) {
            (b, "down") if b != "down" => notify::emit(&app.core, "state", "crit", &format!("Site {name} is down"), s(&site, "health_url"), name).await,
            ("down", "ok") => notify::emit(&app.core, "state", "ok", &format!("Site {name} is back"), "", name).await,
            _ => {}
        }
    }
    Ok(())
}

/// Close running deploys once their agent answered, or after a timeout.
pub async fn poll_results(app: &App) -> anyhow::Result<()> {
    let pb = &app.core.pb;
    for site in pb.list("sites", "last_status = 'running'", "").await? {
        let result = link::result(app, s(&site, "last_command")).await?;
        let started = chrono::DateTime::parse_from_rfc3339(&s(&site, "last_deploy").replacen(' ', "T", 1)).context("deploy date")?;
        let (ok, output) = match &result {
            Some(r) => (r["ok"].as_bool().unwrap_or(false), s(r, "output").to_string()),
            None if Utc::now() - started.to_utc() > Duration::minutes(DEPLOY_TIMEOUT_MIN) => (false, "no answer from the agent".to_string()),
            None => continue,
        };
        let status = if ok { "ok" } else { "failed" };
        pb.update("sites", s(&site, "id"), &json!({"last_status": status, "last_output": output})).await?;
        let filter = format!("command = {}", nyx_srv::pb_quote(s(&site, "last_command")));
        if let Some(d) = pb.first("deployments", &filter).await? {
            pb.update("deployments", s(&d, "id"), &json!({"status": status, "version": commit_of(&output), "done_at": pb_date(Utc::now()), "notes": output})).await?;
        }
        let title = format!("Deploy of {} {}", s(&site, "name"), if ok { "succeeded" } else { "failed" });
        notify::emit(&app.core, "task", if ok { "info" } else { "crit" }, &title, commit_of(&output), s(&site, "name")).await;
    }
    Ok(())
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/api/sites", post(create))
        .route("/api/sites/{id}/deploy", post(deploy))
        .route("/api/sites/{id}/details", axum::routing::get(details))
        .route("/api/sites/{id}/control", post(control))
        .route("/api/sites/{id}/rollback/{deployment}", post(rollback))
        .route("/api/sites/result/{cmd}", axum::routing::get(command_result))
        .route("/hooks/git/{id}", post(webhook))
        .with_state(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_keys_round_trip_and_pasted_ones_are_validated() {
        let (private, public) = resolve_key("").unwrap();
        assert!(private.contains("OPENSSH PRIVATE KEY") && public.starts_with("ssh-ed25519 "));
        assert_eq!(resolve_key(&private).unwrap().1, public);
        assert!(resolve_key("garbage").is_err());
    }

    #[test]
    fn webhook_signatures() {
        let mut h = HeaderMap::new();
        assert!(!signature_ok("s", &h, b"x"), "unsigned");
        h.insert("x-gitlab-token", "".parse().unwrap());
        assert!(!signature_ok("", &h, b"x"), "site without a secret");
        h.insert("x-gitlab-token", "s".parse().unwrap());
        assert!(signature_ok("s", &h, b"x"));
        h.insert("x-gitlab-token", "wrong".parse().unwrap());
        assert!(!signature_ok("s", &h, b"x"));
        let mut h = HeaderMap::new();
        h.insert("x-hub-signature-256", "sha256=88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b".parse().unwrap());
        assert!(signature_ok("secret", &h, b"hello"));
        assert!(!signature_ok("secret", &h, b"tampered"));
    }

    #[test]
    fn commit_comes_from_the_last_line() {
        let hash = "a".repeat(40);
        assert_eq!(commit_of(&format!("built\n{hash}\n")), "aaaaaaa");
        assert_eq!(commit_of("npm failed"), "");
    }

    #[test]
    fn health_needs_two_misses_to_go_down_and_one_answer_to_recover() {
        assert_eq!(next_health("", false), "failing");
        assert_eq!(next_health("failing", false), "down");
        assert_eq!(next_health("down", false), "down");
        assert_eq!(next_health("down", true), "ok");
    }

    #[test]
    fn a_rollback_needs_the_full_hash() {
        let hash = "b".repeat(40);
        assert_eq!(full_commit(&format!("built\n{hash}\n")), Some(hash.as_str()));
        assert_eq!(full_commit("npm failed"), None);
    }

    #[test]
    fn a_site_without_a_service_gets_the_one_nyx_made() {
        assert_eq!(service_of(&json!({"name": "blog"})), "nyx-site-blog.service");
        assert_eq!(service_of(&json!({"name": "blog", "service": "pm2:api"})), "pm2:api");
    }

    #[test]
    fn site_names_are_shell_safe() {
        assert!(slug_ok("my-site_2") && !slug_ok("a b") && !slug_ok("a;b") && !slug_ok(""));
    }
}

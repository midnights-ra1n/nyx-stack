//! Dashboard sessions (stateless signed cookie) and passkeys.

use crate::{random_hex, ApiError, ApiResult, Core};
use axum::{
    extract::{FromRequestParts, Path, Request, State},
    http::{header, request::Parts, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use nyx_proto::{sign, verify};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use webauthn_rs::prelude::*;

const COOKIE: &str = "nyx_session";
const SESSION_S: u64 = 7 * 86400;
const MAX_FAILS: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(60);
const FLOW_TTL: Duration = Duration::from_secs(300);

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Authenticated user id. Extracting it is what protects a route.
#[derive(Clone)]
pub struct Session(pub String);

fn encode(secret: &str, uid: &str, exp: u64) -> String {
    format!("{uid}.{exp}.{}", sign(secret, exp, uid.as_bytes()))
}

fn decode(secret: &str, value: &str, now: u64) -> Option<String> {
    let mut p = value.splitn(3, '.');
    let (uid, exp, sig) = (p.next()?, p.next()?.parse::<u64>().ok()?, p.next()?);
    (exp > now && verify(secret, exp, uid.as_bytes(), sig)).then(|| uid.to_string())
}

fn cookie_value(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::COOKIE)?.to_str().ok()?.split(';').find_map(|c| c.trim().strip_prefix(COOKIE)?.strip_prefix('='))
}

impl<S: Send + Sync> FromRequestParts<S> for Session {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, ApiError> {
        let core = parts.extensions.get::<Arc<Core>>().ok_or_else(|| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "core missing"))?;
        cookie_value(&parts.headers)
            .and_then(|v| decode(&core.secret, v, now()))
            .map(Session)
            .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "login required"))
    }
}

/// Middleware making [`Core`] reachable from the [`Session`] extractor.
pub async fn inject(State(core): State<Arc<Core>>, mut req: Request, next: Next) -> Response {
    req.extensions_mut().insert(core);
    next.run(req).await
}

fn session_cookie(core: &Core, uid: &str) -> String {
    let secure = if core.https_enabled() { "; Secure" } else { "" };
    format!("{COOKIE}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_S}{secure}", encode(&core.secret, uid, now() + SESSION_S))
}

fn logged_in(core: &Core, user: &Value) -> Response {
    let uid = user["id"].as_str().unwrap_or_default();
    ([(header::SET_COOKIE, session_cookie(core, uid))], Json(json!({"email": user["email"]}))).into_response()
}

/// Per-identity failure counter, in memory on purpose: a restart forgives.
#[derive(Default)]
pub struct Limiter(HashMap<String, (u32, Instant)>);

impl Limiter {
    fn blocked(&mut self, id: &str) -> bool {
        self.0.retain(|_, (_, t)| t.elapsed() < LOCKOUT);
        self.0.get(id).is_some_and(|(n, _)| *n >= MAX_FAILS)
    }
    fn fail(&mut self, id: &str) {
        let e = self.0.entry(id.to_string()).or_insert((0, Instant::now()));
        e.0 += 1;
        e.1 = Instant::now();
    }
}

#[derive(Deserialize)]
struct Credentials {
    email: String,
    password: String,
}

async fn has_users(core: &Core) -> anyhow::Result<bool> {
    Ok(core.pb.first("users", "").await?.is_some())
}

async fn status(State(core): State<Arc<Core>>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let uid = cookie_value(&headers).and_then(|v| decode(&core.secret, v, now()));
    let email = match &uid {
        Some(uid) => core.pb.get("users", uid).await.ok().map(|u| u["email"].clone()),
        None => None,
    };
    Ok(Json(json!({
        "needs_setup": !has_users(&core).await?,
        "authenticated": uid.is_some(),
        "passkeys": core.webauthn.is_some(),
        "https": core.https_enabled(),
        "public_url": core.env.public_url,
        "shared_database": core.shared,
        "email": email,
    })))
}

async fn setup(State(core): State<Arc<Core>>, Json(c): Json<Credentials>) -> ApiResult<Response> {
    if has_users(&core).await? {
        return Err(ApiError::new(StatusCode::CONFLICT, "already set up"));
    }
    if c.password.len() < 10 {
        return Err(ApiError::bad_request("password must be at least 10 characters"));
    }
    let body = json!({"email": c.email, "password": c.password, "passwordConfirm": c.password, "verified": true});
    let user = core.pb.create("users", &body).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(logged_in(&core, &user))
}

async fn login(State(core): State<Arc<Core>>, Json(c): Json<Credentials>) -> ApiResult<Response> {
    if core.limiter.lock().unwrap().blocked(&c.email) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many attempts, wait a minute"));
    }
    match core.pb.user_login(&c.email, &c.password).await {
        Ok(user) => Ok(logged_in(&core, &user)),
        Err(_) => {
            core.limiter.lock().unwrap().fail(&c.email);
            Err(ApiError::new(StatusCode::UNAUTHORIZED, "invalid email or password"))
        }
    }
}

async fn logout() -> impl IntoResponse {
    ([(header::SET_COOKIE, format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"))], Json(Value::Null))
}

#[derive(Deserialize)]
struct PasswordChange {
    current: String,
    password: String,
}

/// shortcut: sessions are stateless, so other browsers stay signed in until their
/// cookie expires. Upgrade to a per-user session epoch if that ever matters.
async fn change_password(session: Session, State(core): State<Arc<Core>>, Json(b): Json<PasswordChange>) -> ApiResult<Json<Value>> {
    if b.password.len() < 10 {
        return Err(ApiError::bad_request("password must be at least 10 characters"));
    }
    if core.limiter.lock().unwrap().blocked(&session.0) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many attempts, wait a minute"));
    }
    let user = core.pb.get("users", &session.0).await?;
    // 400, not 401: the session is fine, and the UI treats 401 as being signed out.
    if core.pb.user_login(user["email"].as_str().unwrap_or_default(), &b.current).await.is_err() {
        core.limiter.lock().unwrap().fail(&session.0);
        return Err(ApiError::bad_request("the current password is wrong"));
    }
    core.pb.update("users", &session.0, &json!({"password": b.password, "passwordConfirm": b.password})).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))?;
    Ok(Json(Value::Null))
}

// Passkeys ---------------------------------------------------------------------

pub fn build_webauthn(public_url: &str) -> Option<Webauthn> {
    let origin = url::Url::parse(public_url).ok().filter(|u| u.scheme() == "https")?;
    WebauthnBuilder::new(origin.host_str()?, &origin).ok()?.rp_name("Nyx").build().ok()
}

/// Ceremonies in progress, kept in RAM for a few minutes.
#[derive(Default)]
pub struct PasskeyFlows {
    register: HashMap<String, (PasskeyRegistration, Instant)>,
    login: HashMap<String, (PasskeyAuthentication, String, Instant)>,
}

impl PasskeyFlows {
    fn expire(&mut self) {
        self.register.retain(|_, v| v.1.elapsed() < FLOW_TTL);
        self.login.retain(|_, v| v.2.elapsed() < FLOW_TTL);
    }
}

fn webauthn(core: &Core) -> ApiResult<&Webauthn> {
    core.webauthn.as_ref().ok_or_else(|| ApiError::bad_request("passkeys require an https:// NYX_PUBLIC_URL"))
}

fn user_uuid(uid: &str) -> Uuid {
    let hash = nyx_proto::sha256_hex(uid.as_bytes());
    Uuid::parse_str(&hash[..32]).unwrap_or_default()
}

async fn user_passkeys(core: &Core, uid: &str) -> anyhow::Result<Vec<(String, Passkey)>> {
    let rows = core.pb.list("passkeys", &format!("user = {}", crate::pb_quote(uid)), "").await?;
    Ok(rows.into_iter().filter_map(|r| Some((r["id"].as_str()?.to_string(), serde_json::from_value(r["data"].clone()).ok()?))).collect())
}

async fn register_start(session: Session, State(core): State<Arc<Core>>) -> ApiResult<Json<Value>> {
    let w = webauthn(&core)?;
    let user = core.pb.get("users", &session.0).await?;
    let email = user["email"].as_str().unwrap_or_default();
    let exclude: Vec<_> = user_passkeys(&core, &session.0).await?.iter().map(|(_, p)| p.cred_id().clone()).collect();
    let (options, state) = w
        .start_passkey_registration(user_uuid(&session.0), email, email, Some(exclude))
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
    let mut flows = core.passkey_flows.lock().unwrap();
    flows.expire();
    flows.register.insert(session.0, (state, Instant::now()));
    Ok(Json(serde_json::to_value(options)?))
}

#[derive(Deserialize)]
struct RegisterFinish {
    name: String,
    credential: RegisterPublicKeyCredential,
}

async fn register_finish(session: Session, State(core): State<Arc<Core>>, Json(b): Json<RegisterFinish>) -> ApiResult<Json<Value>> {
    let (state, _) = core.passkey_flows.lock().unwrap().register.remove(&session.0).ok_or_else(|| ApiError::bad_request("no registration in progress"))?;
    let key = webauthn(&core)?.finish_passkey_registration(&b.credential, &state).map_err(|e| ApiError::bad_request(e.to_string()))?;
    core.pb.create("passkeys", &json!({"user": session.0, "name": b.name, "data": key})).await?;
    Ok(Json(Value::Null))
}

async fn list_passkeys(session: Session, State(core): State<Arc<Core>>) -> ApiResult<Json<Value>> {
    let rows = core.pb.list("passkeys", &format!("user = {}", crate::pb_quote(&session.0)), "created").await?;
    Ok(Json(json!(rows.iter().map(|r| json!({"id": r["id"], "name": r["name"], "created": r["created"]})).collect::<Vec<_>>())))
}

async fn delete_passkey(session: Session, State(core): State<Arc<Core>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let row = core.pb.get("passkeys", &id).await.map_err(|_| ApiError::not_found())?;
    if row["user"] != session.0 {
        return Err(ApiError::not_found());
    }
    core.pb.delete("passkeys", &id).await?;
    Ok(Json(Value::Null))
}

#[derive(Deserialize)]
struct LoginStart {
    email: String,
}

async fn login_start(State(core): State<Arc<Core>>, Json(b): Json<LoginStart>) -> ApiResult<Json<Value>> {
    let w = webauthn(&core)?;
    let none = || ApiError::bad_request("no passkey for this account");
    let user = core.pb.first("users", &format!("email = {}", crate::pb_quote(&b.email))).await?.ok_or_else(none)?;
    let uid = user["id"].as_str().unwrap_or_default().to_string();
    let keys: Vec<Passkey> = user_passkeys(&core, &uid).await?.into_iter().map(|(_, k)| k).collect();
    if keys.is_empty() {
        return Err(none());
    }
    let (options, state) = w.start_passkey_authentication(&keys).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let flow = random_hex(16);
    let mut flows = core.passkey_flows.lock().unwrap();
    flows.expire();
    flows.login.insert(flow.clone(), (state, uid, Instant::now()));
    Ok(Json(json!({"flow": flow, "options": options})))
}

#[derive(Deserialize)]
struct LoginFinish {
    flow: String,
    credential: PublicKeyCredential,
}

async fn login_finish(State(core): State<Arc<Core>>, Json(b): Json<LoginFinish>) -> ApiResult<Response> {
    let (state, uid, _) = core.passkey_flows.lock().unwrap().login.remove(&b.flow).ok_or_else(|| ApiError::bad_request("login expired, try again"))?;
    let result = webauthn(&core)?
        .finish_passkey_authentication(&b.credential, &state)
        .map_err(|_| ApiError::new(StatusCode::UNAUTHORIZED, "passkey rejected"))?;
    // Persist the signature counter so a cloned authenticator can be detected.
    for (id, mut key) in user_passkeys(&core, &uid).await? {
        if key.update_credential(&result) == Some(true) {
            core.pb.update("passkeys", &id, &json!({"data": key})).await?;
        }
    }
    let user = core.pb.get("users", &uid).await?;
    Ok(logged_in(&core, &user))
}

pub fn router() -> Router<Arc<Core>> {
    Router::new()
        .route("/api/auth/status", get(status))
        .route("/api/auth/setup", post(setup))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/password", post(change_password))
        .route("/api/auth/passkey/login/start", post(login_start))
        .route("/api/auth/passkey/login/finish", post(login_finish))
        .route("/api/auth/passkey/register/start", post(register_start))
        .route("/api/auth/passkey/register/finish", post(register_finish))
        .route("/api/auth/passkeys", get(list_passkeys))
        .route("/api/auth/passkeys/{id}", delete(delete_passkey))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_round_trip_and_tamper_detection() {
        let v = encode("s", "user1", 1000);
        assert_eq!(decode("s", &v, 999).as_deref(), Some("user1"));
        assert_eq!(decode("s", &v, 1000), None, "expired");
        assert_eq!(decode("other", &v, 999), None, "wrong secret");
        assert_eq!(decode("s", &v.replace("user1", "admin"), 999), None, "forged user");
        assert_eq!(decode("s", &v.replace(".1000.", ".9999."), 999), None, "extended expiry");
        assert_eq!(decode("s", "garbage", 0), None);
    }

    #[test]
    fn limiter_blocks_after_repeated_failures() {
        let mut l = Limiter::default();
        (0..MAX_FAILS).for_each(|_| l.fail("a"));
        assert!(l.blocked("a") && !l.blocked("b"));
    }

    #[test]
    fn passkeys_need_https() {
        assert!(build_webauthn("http://nyx.lan").is_none());
        assert!(build_webauthn("https://nyx.lan").is_some());
    }
}

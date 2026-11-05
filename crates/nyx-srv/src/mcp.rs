//! Read-only MCP server (Streamable HTTP, JSON responses, no SSE stream), HTTPS
//! only. Each role supplies its tools; tokens are stored hashed.

use crate::{auth::Session, pb_date, pb_quote, random_hex, ApiError, ApiResult, Core};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{future::Future, pin::Pin, sync::Arc};

const PROTOCOL_VERSIONS: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];

pub type BoxFut = Pin<Box<dyn Future<Output = anyhow::Result<Value>> + Send>>;

pub struct Tools {
    /// `(name, description, JSON schema of the arguments)`.
    pub list: Vec<(&'static str, &'static str, Value)>,
    pub call: Box<dyn Fn(String, Value) -> BoxFut + Send + Sync>,
}

#[derive(Clone)]
struct Mcp {
    core: Arc<Core>,
    tools: Arc<Tools>,
}

fn reply(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn fail(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// Handle one JSON-RPC message; `None` for notifications, which get no answer.
pub async fn dispatch(tools: &Tools, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?;
    let method = msg["method"].as_str().unwrap_or_default();
    Some(match method {
        "initialize" => {
            let asked = msg["params"]["protocolVersion"].as_str().unwrap_or_default();
            let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).unwrap_or(&PROTOCOL_VERSIONS[0]);
            reply(id, json!({"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": "nyx", "version": env!("CARGO_PKG_VERSION")}}))
        }
        "ping" => reply(id, json!({})),
        "tools/list" => {
            let list: Vec<Value> = tools.list.iter().map(|(n, d, s)| json!({"name": n, "description": d, "inputSchema": s})).collect();
            reply(id, json!({"tools": list}))
        }
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or_default();
            if !tools.list.iter().any(|(n, ..)| *n == name) {
                return Some(fail(id, -32602, "unknown tool"));
            }
            match (tools.call)(name.to_string(), msg["params"]["arguments"].clone()).await {
                Ok(v) => reply(id, json!({"content": [{"type": "text", "text": v.to_string()}]})),
                Err(e) => reply(id, json!({"content": [{"type": "text", "text": format!("{e:#}")}], "isError": true})),
            }
        }
        _ => fail(id, -32601, "method not found"),
    })
}

/// True only if the request truly arrived over TLS: natively, or through a proxy
/// that says so while the public URL is https as well.
fn request_is_https(core: &Core, headers: &HeaderMap) -> bool {
    let proxied = headers.get("x-forwarded-proto").is_some_and(|v| v == "https");
    core.https_enabled() && (core.env.tls_cert.is_some() || proxied)
}

async fn token_valid(core: &Core, token: &str) -> anyhow::Result<bool> {
    let hash = nyx_proto::sha256_hex(token.as_bytes());
    let Some(row) = core.pb.first("mcp_tokens", &format!("token_hash = {}", pb_quote(&hash))).await? else { return Ok(false) };
    let id = row["id"].as_str().unwrap_or_default();
    core.pb.update("mcp_tokens", id, &json!({"last_used": pb_date(chrono::Utc::now())})).await?;
    Ok(true)
}

async fn handle(m: &Mcp, headers: &HeaderMap, token: Option<&str>, msg: Value) -> Response {
    if !request_is_https(&m.core, headers) {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "MCP is only served over HTTPS"}))).into_response();
    }
    let bearer = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    match token.or(bearer) {
        Some(t) if token_valid(&m.core, t).await.unwrap_or(false) => {}
        _ => return (StatusCode::UNAUTHORIZED, Json(json!({"error": "invalid token"}))).into_response(),
    }
    match dispatch(&m.tools, &msg).await {
        Some(v) => Json(v).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn with_header(State(m): State<Mcp>, headers: HeaderMap, Json(msg): Json<Value>) -> Response {
    handle(&m, &headers, None, msg).await
}

/// For clients that can only be given a URL.
async fn with_path(State(m): State<Mcp>, Path(token): Path<String>, headers: HeaderMap, Json(msg): Json<Value>) -> Response {
    handle(&m, &headers, Some(&token), msg).await
}

#[derive(Deserialize)]
struct NewToken {
    name: String,
}

async fn create_token(_: Session, State(core): State<Arc<Core>>, Json(b): Json<NewToken>) -> ApiResult<Json<Value>> {
    if !core.https_enabled() {
        return Err(ApiError::bad_request("MCP needs an https:// NYX_PUBLIC_URL"));
    }
    let token = random_hex(32);
    core.pb.create("mcp_tokens", &json!({"name": b.name, "token_hash": nyx_proto::sha256_hex(token.as_bytes())})).await?;
    Ok(Json(json!({"token": token, "url": format!("{}/mcp", core.env.public_url)})))
}

pub fn router(core: Arc<Core>, tools: Tools) -> Router {
    let m = Mcp { core: core.clone(), tools: Arc::new(tools) };
    let public = Router::new().route("/mcp", post(with_header)).route("/mcp/{token}", post(with_path)).with_state(m);
    let admin = Router::new().route("/api/mcp/tokens", post(create_token)).with_state(core);
    public.merge(admin)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tools() -> Tools {
        Tools {
            list: vec![("status", "Infra status", json!({"type": "object"}))],
            call: Box::new(|name, _| Box::pin(async move { if name == "status" { Ok(json!({"ok": true})) } else { anyhow::bail!("no") } })),
        }
    }

    fn rpc(id: i64, method: &str, params: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
    }

    #[tokio::test]
    async fn negotiates_and_lists() {
        let t = tools();
        let r = dispatch(&t, &rpc(1, "initialize", json!({"protocolVersion": "2025-06-18"}))).await.unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        let r = dispatch(&t, &rpc(1, "initialize", json!({"protocolVersion": "1999-01-01"}))).await.unwrap();
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
        let r = dispatch(&t, &rpc(2, "tools/list", json!({}))).await.unwrap();
        assert_eq!(r["result"]["tools"][0]["name"], "status");
    }

    #[tokio::test]
    async fn calls_tools_and_rejects_unknown_ones() {
        let t = tools();
        let r = dispatch(&t, &rpc(3, "tools/call", json!({"name": "status"}))).await.unwrap();
        assert_eq!(r["result"]["content"][0]["text"], r#"{"ok":true}"#);
        let r = dispatch(&t, &rpc(4, "tools/call", json!({"name": "rm"}))).await.unwrap();
        assert_eq!(r["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn notifications_get_no_reply() {
        assert!(dispatch(&tools(), &json!({"method": "notifications/initialized"})).await.is_none());
    }
}

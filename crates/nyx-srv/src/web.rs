//! HTTP helpers: error type, embedded UI serving, security headers, listener.

use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderValue, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
    Json, Router,
};
use serde_json::json;
use std::{future::Future, net::SocketAddr};

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);
pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(code: StatusCode, msg: impl Into<String>) -> Self {
        Self(code, msg.into())
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not found")
    }
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, msg)
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        let e = e.into();
        eprintln!("internal error: {e:#}");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "internal error, see server logs".into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}

/// Serve an embedded SPA: real file if it exists, `index.html` otherwise.
pub async fn spa<A: rust_embed::Embed>(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let (file, name) = match A::get(path) {
        Some(f) if !path.is_empty() => (f, path),
        _ => match A::get("index.html") {
            Some(f) => (f, "index.html"),
            None => return (StatusCode::NOT_FOUND, "UI not built").into_response(),
        },
    };
    let cache = if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    (
        [(header::CONTENT_TYPE, mime.as_ref().to_string()), (header::CACHE_CONTROL, cache.to_string())],
        Body::from(file.data.into_owned()),
    )
        .into_response()
}

/// `default-src 'self'` is the privacy promise made enforceable: the browser
/// refuses any third-party request even if a dependency tried one.
pub const CSP: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

pub async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    // A route that needs to differ, such as an embeddable page, sets its own.
    h.entry(header::CONTENT_SECURITY_POLICY).or_insert(HeaderValue::from_static(CSP));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    res
}

/// Serve until SIGINT/SIGTERM, or until [`crate::Core::restart`] asks for a new start.
pub async fn serve(router: Router, core: &std::sync::Arc<crate::Core>) -> anyhow::Result<()> {
    let c = core.clone();
    let stop = async move {
        tokio::select! {
            _ = nyx_db::shutdown_signal() => {}
            _ = c.restart.notified() => println!("stopping so that the service manager restarts this server"),
        }
    };
    serve_until(router, &core.env, std::time::Duration::from_secs(5), stop).await
}

/// Serve until `stop` resolves, with TLS when a certificate is configured.
pub async fn serve_until(router: Router, env: &crate::Env, grace: std::time::Duration, stop: impl Future<Output = ()> + Send + 'static) -> anyhow::Result<()> {
    let addr: SocketAddr = env.bind.parse()?;
    let router = router.layer(axum::middleware::from_fn(security_headers));
    println!("listening on {addr} (public URL {})", env.public_url);
    let handle = axum_server::Handle::new();
    let stopper = handle.clone();
    tokio::spawn(async move {
        stop.await;
        stopper.graceful_shutdown(Some(grace));
    });
    let app = router.into_make_service();
    match (&env.tls_cert, &env.tls_key) {
        (Some(cert), Some(key)) => {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key).await?;
            axum_server::bind_rustls(addr, tls).handle(handle).serve(app).await?;
        }
        _ => axum_server::bind(addr).handle(handle).serve(app).await?,
    }
    Ok(())
}

/// Run `f` every `period`, logging failures rather than dying.
pub fn every<F, Fut>(period: std::time::Duration, name: &'static str, mut f: F)
where
    F: FnMut() -> Fut + Send + 'static,
    Fut: Future<Output = anyhow::Result<()>> + Send,
{
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(period);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            if let Err(e) = f().await {
                eprintln!("{name}: {e:#}");
            }
        }
    });
}

//! Which database a server uses, decided once. `NYX_PB_*` variables decide for
//! unattended installs. Otherwise the choice made at the first start is kept in
//! `database.json`, and until then this module serves only the UI and that choice, so
//! the rest of the server never has to run without a database.

use crate::{pb::Pb, random_hex, web, ApiError, ApiResult, Env};
use anyhow::{bail, Context};
use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    net::IpAddr,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Notify;
use url::Url;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct Connection {
    /// Address of a shared `nyx-db`. `None` is the embedded database.
    pub url: Option<String>,
    pub email: String,
    pub password: String,
}

fn from_env(env: &Env) -> anyhow::Result<Option<Connection>> {
    match (&env.pb_url, &env.pb_email, &env.pb_password) {
        (url, Some(email), Some(password)) => Ok(Some(Connection { url: url.clone(), email: email.clone(), password: password.clone() })),
        (Some(_), _, _) => bail!("NYX_PB_URL needs NYX_PB_EMAIL and NYX_PB_PASSWORD"),
        _ => Ok(None),
    }
}

/// Finds the connection, asking through the UI on the very first start.
pub async fn resolve<U: rust_embed::Embed + Send + Sync + 'static>(env: &Env) -> anyhow::Result<Connection> {
    if let Some(conn) = from_env(env)? {
        return Ok(conn);
    }
    let file = env.data_dir.join("database.json");
    if !file.exists() {
        fs::create_dir_all(&env.data_dir).with_context(|| format!("cannot create {}", env.data_dir.display()))?;
        choose::<U>(env, file.clone()).await?;
    }
    serde_json::from_slice(&fs::read(&file)?).with_context(|| format!("invalid {}", file.display()))
}

struct Choosing {
    file: PathBuf,
    chosen: Notify,
}

/// Serves the choice on the normal port, until a connection has been saved.
async fn choose<U: rust_embed::Embed + Send + Sync + 'static>(env: &Env, file: PathBuf) -> anyhow::Result<()> {
    println!("waiting for the database choice in the web interface");
    let state = Arc::new(Choosing { file, chosen: Notify::new() });
    let waiting = state.clone();
    let router = Router::new()
        .route("/api/auth/status", get(status))
        .route("/api/database", post(submit))
        .fallback(web::spa::<U>)
        .with_state(state);
    let stop = async move {
        tokio::select! {
            _ = waiting.chosen.notified() => {}
            _ = nyx_db::shutdown_signal() => std::process::exit(0), // nothing to save yet
        }
    };
    web::serve_until(router, env, Duration::from_secs(1), stop).await
}

async fn status() -> Json<Value> {
    Json(json!({"database_setup": true, "embedded": !nyx_db::POCKETBASE.is_empty()}))
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
enum Choice {
    Local,
    Remote { url: String, email: String, password: String },
}

async fn submit(State(state): State<Arc<Choosing>>, Json(choice): Json<Choice>) -> ApiResult<Json<Value>> {
    if state.file.exists() {
        return Err(ApiError::new(StatusCode::CONFLICT, "already chosen"));
    }
    let conn = match choice {
        Choice::Local if nyx_db::POCKETBASE.is_empty() => return Err(ApiError::bad_request("This build has no local database.")),
        Choice::Local => Connection { url: None, email: "nyx@localhost.invalid".into(), password: random_hex(24) },
        Choice::Remote { url, email, password } => {
            let url = check_url(&url).await?;
            probe(&url, &email, &password).await?;
            Connection { url: Some(url), email, password }
        }
    };
    save(&state.file, &conn)?;
    state.chosen.notify_one();
    Ok(Json(Value::Null))
}

/// The file holds the database password: only 0600, and never half written.
fn save(file: &Path, conn: &Connection) -> anyhow::Result<()> {
    let tmp = file.with_extension("tmp");
    fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?.write_all(&serde_json::to_vec(conn)?)?;
    Ok(fs::rename(tmp, file)?)
}

fn is_private(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            // The last one is shared address space, used by Tailscale.
            ip.is_loopback() || ip.is_private() || ip.is_link_local() || (a == 100 && b & 0xc0 == 64)
        }
        IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local(),
    }
}

/// The superuser password and token travel with every request, so plain HTTP is
/// refused unless the address stays on a private network.
async fn check_url(raw: &str) -> ApiResult<String> {
    let invalid = || ApiError::bad_request("Enter a full address, such as https://db.example.com.");
    let raw = raw.trim().trim_end_matches('/');
    let url = Url::parse(raw).map_err(|_| invalid())?;
    let host = url.host_str().ok_or_else(invalid)?.trim_matches(['[', ']']);
    match url.scheme() {
        "https" => {}
        "http" => {
            let unknown = |_| ApiError::bad_request("Cannot resolve this address.");
            let port = url.port_or_known_default().ok_or_else(invalid)?;
            if !tokio::net::lookup_host((host, port)).await.map_err(unknown)?.all(|a| is_private(a.ip())) {
                return Err(ApiError::bad_request("Use HTTPS: this address is outside your private network."));
            }
        }
        _ => return Err(invalid()),
    }
    Ok(raw.to_string())
}

/// Tries the connection, so that a typo shows up here and not as a failed start.
async fn probe(url: &str, email: &str, password: &str) -> ApiResult<()> {
    let pb = Pb::new(url, email, password)?;
    pb.login().await.map_err(|e| {
        let refused = e.downcast_ref::<reqwest::Error>().and_then(|e| e.status()).is_some_and(|s| s.is_client_error());
        ApiError::bad_request(if refused { "Wrong email or password." } else { "Cannot reach this address." })
    })?;
    pb.first("settings", "").await.map_err(|_| ApiError::bad_request("This is not a nyx-db database."))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(url: Option<&str>, email: Option<&str>, password: Option<&str>) -> Env {
        Env {
            bind: String::new(),
            pb_url: url.map(Into::into),
            data_dir: PathBuf::new(),
            pb_email: email.map(Into::into),
            pb_password: password.map(Into::into),
            public_url: String::new(),
            tls_cert: None,
            tls_key: None,
            notifier_bin: String::new(),
        }
    }

    #[test]
    fn variables_decide_only_when_complete() {
        assert_eq!(from_env(&env(None, None, None)).unwrap(), None, "first start asks");
        assert_eq!(from_env(&env(None, Some("e"), None)).unwrap(), None);
        let local = from_env(&env(None, Some("e"), Some("p"))).unwrap().unwrap();
        assert_eq!(local.url, None, "existing installs stay local");
        let remote = from_env(&env(Some("https://db"), Some("e"), Some("p"))).unwrap().unwrap();
        assert_eq!(remote.url.as_deref(), Some("https://db"));
        assert!(from_env(&env(Some("https://db"), None, None)).is_err(), "a URL alone cannot log in");
    }

    #[test]
    fn private_addresses() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.1.1", "100.64.0.1", "100.127.255.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"] {
            assert!(is_private(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "100.63.0.1", "100.128.0.1", "172.32.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"] {
            assert!(!is_private(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn urls_are_normalized_and_plain_http_stays_private() {
        assert_eq!(check_url(" https://db.example.com/ ").await.unwrap(), "https://db.example.com");
        assert_eq!(check_url("http://127.0.0.1:8090").await.unwrap(), "http://127.0.0.1:8090");
        assert_eq!(check_url("http://[::1]:8090").await.unwrap(), "http://[::1]:8090");
        assert!(check_url("http://8.8.8.8:8090").await.is_err());
        assert!(check_url("ftp://db.example.com").await.is_err());
        assert!(check_url("db.example.com").await.is_err());
    }

    #[test]
    fn saved_connection_is_private_and_reads_back() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("nyx-database-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("database.json");
        let conn = Connection { url: None, email: "e".into(), password: "p".into() };
        save(&file, &conn).unwrap();
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(serde_json::from_slice::<Connection>(&fs::read(&file).unwrap()).unwrap(), conn);
        fs::remove_dir_all(dir).unwrap();
    }
}

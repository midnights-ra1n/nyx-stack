//! Plumbing shared by `nyx-monitor` and `nyx-manager`, so that each role can run
//! alone: the embedded database and access to it, sessions, passkeys, generic CRUD,
//! notifications, the MCP endpoint and static UI serving.

pub mod auth;
pub mod backup;
pub mod crud;
pub mod database;
pub mod mcp;
pub mod notify;
pub mod pb;
pub mod system;
pub mod web;

pub use pb::{pb_date, pb_quote, Pb};
pub use web::{ApiError, ApiResult};

use std::sync::{Arc, Mutex};

/// Runtime configuration, all from the environment.
pub struct Env {
    pub bind: String,
    /// With the two below, skips the first-start choice: see [`database`].
    pub pb_url: Option<String>,
    pub data_dir: std::path::PathBuf,
    pub pb_email: Option<String>,
    pub pb_password: Option<String>,
    pub public_url: String,
    pub tls_cert: Option<String>,
    pub tls_key: Option<String>,
    pub notifier_bin: String,
}

impl Env {
    pub fn load(default_bind: &str) -> anyhow::Result<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Ok(Self {
            bind: var("NYX_BIND").unwrap_or_else(|| default_bind.into()),
            pb_url: var("NYX_PB_URL").map(|u| u.trim_end_matches('/').into()),
            data_dir: var("NYX_DATA_DIR").unwrap_or_else(|| "nyx-data".into()).into(),
            pb_email: var("NYX_PB_EMAIL"),
            pb_password: var("NYX_PB_PASSWORD"),
            public_url: var("NYX_PUBLIC_URL").unwrap_or_else(|| format!("http://{}", default_bind.replace("0.0.0.0", "localhost"))).trim_end_matches('/').into(),
            tls_cert: var("NYX_TLS_CERT"),
            tls_key: var("NYX_TLS_KEY"),
            notifier_bin: var("NYX_NOTIFIER_BIN").unwrap_or_else(|| "nyx-notify".into()),
        })
    }
}

/// State shared by every shared route; roles keep their own state next to it.
pub struct Core {
    pub pb: Pb,
    db: Option<nyx_db::Database>,
    /// On a shared `nyx-db`, next to the other server.
    pub shared: bool,
    pub env: Env,
    pub secret: String,
    pub crud: &'static [crud::Spec],
    pub webauthn: Option<webauthn_rs::Webauthn>,
    pub passkey_flows: Mutex<auth::PasskeyFlows>,
    pub limiter: Mutex<auth::Limiter>,
    /// Stops the server so that its supervisor starts it again, as after a restore.
    pub restart: tokio::sync::Notify,
}

impl Core {
    /// `U` is the server's UI, shown by the first-start choice.
    pub async fn start<U: rust_embed::Embed + Send + Sync + 'static>(env: Env, crud: &'static [crud::Spec]) -> anyhow::Result<Arc<Self>> {
        let conn = database::resolve::<U>(&env).await?;
        let shared = conn.url.is_some();
        let (db, pb_url) = match conn.url {
            Some(url) => (None, url),
            None => {
                anyhow::ensure!(!nyx_db::POCKETBASE.is_empty(), "built without NYX_PB_BIN: set NYX_PB_URL");
                let addr = nyx_db::loopback()?;
                (Some(nyx_db::start(&env.data_dir, addr, &conn.email, &conn.password)?), format!("http://{addr}"))
            }
        };
        let pb = Pb::connect(&pb_url, &conn.email, &conn.password).await?;
        let secret = match pb.setting("session_secret").await? {
            Some(v) => v.as_str().unwrap_or_default().to_string(),
            None => {
                let s = random_hex(32);
                pb.set_setting("session_secret", &s.clone().into()).await?;
                s
            }
        };
        let webauthn = auth::build_webauthn(&env.public_url);
        Ok(Arc::new(Self {
            pb,
            db,
            shared,
            env,
            secret,
            crud,
            webauthn,
            passkey_flows: Mutex::default(),
            limiter: Mutex::default(),
            restart: tokio::sync::Notify::new(),
        }))
    }

    /// Stops the embedded database, if any. The last thing a server does.
    pub async fn stop_db(&self) {
        if let Some(db) = &self.db {
            db.stop().await;
        }
    }

    /// Passkeys and MCP are refused unless the instance is really served over HTTPS.
    pub fn https_enabled(&self) -> bool {
        self.env.public_url.starts_with("https://")
    }
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS random source");
    nyx_proto::hex(&buf)
}

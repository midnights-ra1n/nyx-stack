//! Plumbing shared by `nyx-monitor` and `nyx-manager`, so that each role can run
//! alone: PocketBase access, sessions, passkeys, generic CRUD, notifications,
//! the MCP endpoint and static UI serving.

pub mod auth;
pub mod crud;
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
    pub pb_url: String,
    pub pb_email: String,
    pub pb_password: String,
    pub public_url: String,
    pub tls_cert: Option<String>,
    pub tls_key: Option<String>,
    pub notifier_bin: String,
}

impl Env {
    pub fn load(default_bind: &str) -> anyhow::Result<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let need = |k: &str| var(k).ok_or_else(|| anyhow::anyhow!("{k} must be set"));
        Ok(Self {
            bind: var("NYX_BIND").unwrap_or_else(|| default_bind.into()),
            pb_url: var("NYX_PB_URL").unwrap_or_else(|| "http://127.0.0.1:8090".into()).trim_end_matches('/').into(),
            pb_email: need("NYX_PB_EMAIL")?,
            pb_password: need("NYX_PB_PASSWORD")?,
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
    pub env: Env,
    pub secret: String,
    pub crud: &'static [crud::Spec],
    pub webauthn: Option<webauthn_rs::Webauthn>,
    pub passkey_flows: Mutex<auth::PasskeyFlows>,
    pub limiter: Mutex<auth::Limiter>,
}

impl Core {
    pub async fn start(env: Env, crud: &'static [crud::Spec]) -> anyhow::Result<Arc<Self>> {
        let pb = Pb::connect(&env.pb_url, &env.pb_email, &env.pb_password).await?;
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
            env,
            secret,
            crud,
            webauthn,
            passkey_flows: Mutex::default(),
            limiter: Mutex::default(),
        }))
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

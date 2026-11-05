//! nyx-db: the optional shared database. The monitor and the manager connect to it
//! when you pick a remote database at their first start, and then share their
//! accounts and settings.

use anyhow::Context;
use std::{env::var, net::SocketAddr, path::PathBuf};

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let need = |k: &str| var(k).ok().filter(|v| !v.is_empty()).with_context(|| format!("{k} must be set"));
    let (email, password) = (need("NYX_PB_EMAIL")?, need("NYX_PB_PASSWORD")?);
    let bind: SocketAddr = var("NYX_BIND").unwrap_or_else(|_| "0.0.0.0:8090".into()).parse().context("NYX_BIND")?;
    let dir = PathBuf::from(var("NYX_DATA_DIR").unwrap_or_else(|_| "nyx-data".into()));

    anyhow::ensure!(!nyx_db::POCKETBASE.is_empty(), "built without NYX_PB_BIN, so PocketBase is missing");
    let db = nyx_db::start(&dir, bind, &email, &password)?;
    println!("nyx-db listening on {bind}");
    nyx_db::shutdown_signal().await;
    db.stop().await;
    Ok(())
}

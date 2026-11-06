//! nyx-monitor: receives agent reports, runs probes, raises alerts.
//!
//! Disk-write budget: metrics stay in RAM and reach PocketBase as one batched
//! rollup every five minutes. Only state *transitions* are written immediately.

mod api;
mod compact;
mod ingest;
mod integrations;
mod link;
mod pages;
mod probes;
mod snmp;
mod state;

use axum::{middleware::from_fn_with_state, routing::get, Router};
use nyx_srv::{auth, crud, mcp, notify, system, web, Core, Env};
use rust_embed::Embed;
use state::App;
use std::{sync::Arc, time::Duration};

#[derive(Embed)]
#[folder = "../../web/dist/monitor"]
struct Ui;

const COLLECTIONS: &[crud::Spec] = &[
    crud::Spec { name: "hosts", hidden: &["key", "token"] },
    crud::Spec { name: "alerts", hidden: &[] },
    crud::Spec { name: "probes", hidden: &[] },
    crud::Spec { name: "mcp_tokens", hidden: &["token_hash"] },
    crud::Spec { name: "notif_channels", hidden: &[] },
    crud::Spec { name: "notif_rules", hidden: &[] },
    crud::Spec { name: "notif_events", hidden: &[] },
];

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let env = Env::load("0.0.0.0:8081")?;
    let core = Core::start::<Ui>(env, COLLECTIONS).await?;
    let app = Arc::new(App::load(core.clone()).await?);
    notify::spawn(core.clone());
    spawn_loops(app.clone());
    let history = app.clone();
    tokio::spawn(async move {
        if let Err(e) = pages::load_history(history.clone()).await {
            eprintln!("uptime history: {e:#}");
        }
        // Only now: retention deletes rows, which would make the paged read above skip others.
        web::every(Duration::from_secs(86400), "retention", move || {
            let a = history.clone();
            async move { a.retention().await }
        });
    });

    let shared = auth::router().merge(crud::router()).merge(notify::router()).merge(system::router()).with_state(core.clone());
    let router = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .merge(shared)
        .merge(api::router(app.clone()))
        .merge(ingest::router(app.clone()))
        .merge(link::router(app.clone()))
        .merge(integrations::router(app.clone()))
        .merge(pages::router(app.clone()))
        .merge(mcp::router(core.clone(), api::mcp_tools(app.clone())))
        .fallback(web::spa::<Ui>)
        .layer(from_fn_with_state(core.clone(), auth::inject));

    web::serve(router, &core.env).await?;
    let flushed = app.flush().await; // keep the last partial rollup across restarts
    core.stop_db().await;
    flushed
}

fn spawn_loops(app: Arc<App>) {
    macro_rules! task {
        ($secs:expr, $name:literal, $body:expr) => {{
            let a = app.clone();
            web::every(Duration::from_secs($secs), $name, move || {
                let a = a.clone();
                async move { $body(a).await }
            });
        }};
    }
    task!(15, "offline sweep", |a: Arc<App>| async move { a.sweep_offline().await });
    task!(300, "rollup flush", |a: Arc<App>| async move { a.flush().await });
    task!(60, "maintenance", |a: Arc<App>| async move { a.maintenance().await });
    task!(5, "probes", |a: Arc<App>| async move { probes::tick(&a).await });
    task!(60, "probe reload", |a: Arc<App>| async move { probes::reload(&a).await });
    task!(60, "meross", |a: Arc<App>| async move { integrations::poll_power(&a).await });
    task!(3600, "beta agents", |a: Arc<App>| async move { ingest::refresh_beta_agents(&a).await });
    task!(3600, "tempo", |a: Arc<App>| async move { integrations::tempo_tick(&a).await });
    task!(3600, "tempo calendar", |a: Arc<App>| async move { integrations::sync_tempo_calendar(&a, false).await.map(drop) });
}

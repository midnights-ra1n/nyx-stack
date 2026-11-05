//! nyx-manager: inventory, IPAM, network map, deployments and Node.js sites.
//! Works alone; linking a nyx-monitor adds discovery and agent-driven deploys.

mod api;
mod ipam;
mod link;
mod map;
mod nextcloud;
mod sites;

use axum::{middleware::from_fn_with_state, routing::get, Router};
use nyx_srv::{auth, crud, mcp, notify, system, web, Core, Env};
use rust_embed::Embed;
use std::{sync::Arc, time::Duration};

#[derive(Embed)]
#[folder = "../../web/dist/manager"]
struct Ui;

const COLLECTIONS: &[crud::Spec] = &[
    crud::Spec { name: "hardware", hidden: &[] },
    crud::Spec { name: "virtual_assets", hidden: &[] },
    crud::Spec { name: "subnets", hidden: &[] },
    crud::Spec { name: "ip_addresses", hidden: &[] },
    crud::Spec { name: "routes", hidden: &[] },
    crud::Spec { name: "deployments", hidden: &[] },
    crud::Spec { name: "map_nodes", hidden: &[] },
    crud::Spec { name: "map_links", hidden: &[] },
    crud::Spec { name: "sites", hidden: &["ssh_private_key", "webhook_secret"] },
    crud::Spec { name: "mcp_tokens", hidden: &["token_hash"] },
    crud::Spec { name: "notif_channels", hidden: &[] },
    crud::Spec { name: "notif_rules", hidden: &[] },
    crud::Spec { name: "notif_events", hidden: &[] },
];

pub struct App {
    pub core: Arc<Core>,
    pub http: reqwest::Client,
    pub ctag: tokio::sync::Mutex<String>,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let env = Env::load("0.0.0.0:8082")?;
    let core = Core::start::<Ui>(env, COLLECTIONS).await?;
    let http = reqwest::Client::builder().timeout(Duration::from_secs(20)).build()?;
    let app = Arc::new(App { core: core.clone(), http, ctag: Default::default() });
    notify::spawn(core.clone());
    spawn_loops(app.clone());

    let shared = auth::router().merge(crud::router()).merge(notify::router()).merge(system::router()).with_state(core.clone());
    let router = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .merge(shared)
        .merge(api::router(app.clone()))
        .merge(sites::router(app.clone()))
        .merge(mcp::router(core.clone(), api::mcp_tools(app.clone())))
        .fallback(web::spa::<Ui>)
        .layer(from_fn_with_state(core.clone(), auth::inject));
    let served = web::serve(router, &core.env).await;
    core.stop_db().await;
    served
}

fn spawn_loops(app: Arc<App>) {
    macro_rules! task {
        ($secs:expr, $name:literal, $f:path) => {{
            let a = app.clone();
            web::every(Duration::from_secs($secs), $name, move || {
                let a = a.clone();
                async move { $f(&a).await }
            });
        }};
    }
    task!(15, "deploy results", sites::poll_results);
    task!(300, "inventory sync", link::sync);
    task!(300, "reminders", api::reminders);
    task!(30, "nextcloud sync", nextcloud::sync);
}

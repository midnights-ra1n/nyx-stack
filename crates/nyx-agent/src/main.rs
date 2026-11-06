//! nyx-agent: one thread collects and reports, one thread runs slow commands.
//! No listening socket, no async runtime, nothing written to disk in normal
//! operation (the journald cursors live in the `/run` tmpfs).

mod collect;
mod config;
mod exec;
mod node;
mod packages;
mod proxmox;
mod smart;
mod transport;
mod uninstall;

use config::Config;
use nyx_proto::{Action, Reply};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Messages from the command worker back to the reporting loop.
pub enum Msg {
    Result(nyx_proto::CommandResult),
    Updates(Vec<nyx_proto::PackageUpdate>),
    Progress(nyx_proto::Progress),
    Restart,
}

const TAIL_STEP: Duration = Duration::from_secs(2);

const USAGE: &str = "usage: nyx-agent [run] [--config PATH] | version | uninstall | configure --url URL --token T --key K --kind vm|physical|proxmox|vps [--ct-autoinstall] [--config PATH]";

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let path = flag("--config").unwrap_or_else(|| config::DEFAULT_PATH.into());
    match args.first().map(String::as_str) {
        Some("version" | "--version") => println!("{}", env!("CARGO_PKG_VERSION")),
        Some("configure") => {
            let cfg = Config::from_flags(path, &flag, args.iter().any(|a| a == "--ct-autoinstall"))?;
            cfg.save()?;
            println!("wrote {}", cfg.path);
        }
        Some("uninstall") => uninstall::run(&path)?,
        None | Some("run" | "--config") => run(Config::load(path)?)?,
        _ => anyhow::bail!(USAGE),
    }
    Ok(())
}

fn run(mut cfg: Config) -> anyhow::Result<()> {
    let http = transport::client();
    let mut collector = collect::Collector::new()?;
    let (job_tx, job_rx) = mpsc::channel::<nyx_proto::Command>();
    let (msg_tx, msg_rx) = mpsc::channel::<Msg>();
    let worker_cfg = cfg.clone();
    let worker_http = http.clone();
    std::thread::spawn(move || {
        for cmd in job_rx {
            exec::run(&worker_cfg, &worker_http, cmd, &msg_tx);
        }
    });

    let mut interval = 15;
    let mut restart = false;
    loop {
        for msg in msg_rx.try_iter() {
            match msg {
                Msg::Result(r) => {
                    collector.progress = None;
                    collector.pending_results.push(r);
                }
                Msg::Progress(p) => collector.progress = Some(p),
                Msg::Updates(u) => collector.set_updates(u),
                Msg::Restart => restart = true,
            }
        }
        let report = collector.report(&cfg);
        let mut tail = false;
        match transport::post_report(&http, &cfg, &report) {
            Ok(reply) => {
                if restart {
                    std::process::exit(0); // systemd brings the new binary up
                }
                tail = reply.live_logs;
                interval = handle_reply(reply, &mut cfg, &mut collector, &job_tx);
            }
            Err(e) => {
                eprintln!("report failed: {e:#}");
                collector.restore(report);
            }
        }
        let next_report = Instant::now() + Duration::from_secs(interval);
        if tail {
            tail_logs(&http, &cfg, next_report);
        } else {
            collect::forget_live_logs();
        }
        std::thread::sleep(next_report.saturating_duration_since(Instant::now()));
    }
}

/// Sends new journal lines every step until the next report is due, or nobody is watching.
fn tail_logs(http: &ureq::Agent, cfg: &Config, until: Instant) {
    while Instant::now() < until {
        match transport::post_logs(http, cfg, collect::live_lines()) {
            Ok(true) => std::thread::sleep(TAIL_STEP.min(until.saturating_duration_since(Instant::now()))),
            Ok(false) => return,
            Err(e) => return eprintln!("live logs failed: {e:#}"),
        }
    }
}

fn handle_reply(reply: Reply, cfg: &mut Config, collector: &mut collect::Collector, jobs: &mpsc::Sender<nyx_proto::Command>) -> u64 {
    if reply.resync {
        collector.resync();
    }
    for cmd in reply.commands {
        match cmd.action {
            // Handled inline: the running loop owns the configuration.
            Action::SetKind { kind, ct_autoinstall } => {
                cfg.kind = kind;
                cfg.ct_autoinstall = ct_autoinstall;
                let saved = cfg.save();
                collector.resync();
                collector.pending_results.push(nyx_proto::CommandResult {
                    id: cmd.id,
                    ok: saved.is_ok(),
                    output: saved.err().map_or(format!("kind set to {}", kind.as_str()), |e| format!("applied, not persisted: {e}")),
                });
            }
            _ => {
                let _ = jobs.send(cmd);
            }
        }
    }
    reply.interval_s.clamp(5, 300)
}

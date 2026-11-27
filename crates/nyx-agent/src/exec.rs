//! Slow commands from the monitor, run one at a time on the worker thread.

use crate::{config::Config, packages, transport, Msg};
use anyhow::{bail, Context};
use nyx_proto::{Action, Command, CommandResult, Progress};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    os::unix::fs::PermissionsExt,
    process::{self, Stdio},
    sync::mpsc::Sender,
};

const OUTPUT_TAIL: usize = 4000;

pub fn run(cfg: &Config, http: &ureq::Agent, cmd: Command, tx: &Sender<Msg>) {
    let mut restart = false;
    let outcome = match cmd.action {
        Action::CheckUpdates => match packages::check() {
            Some(list) => {
                let n = list.len();
                let _ = tx.send(Msg::Updates(list));
                Ok(format!("{n} updates available"))
            }
            None => Err(anyhow::anyhow!("no supported package manager")),
        },
        Action::UpdateSystem => upgrade(tx),
        Action::CleanSystem => clean(tx),
        Action::UpdateAgent => update_agent(cfg, http).inspect(|_| restart = true),
        Action::Container { op, name } => container_op(&op, &name),
        Action::Service { op, name } => service_op(&op, &name),
        Action::Firewall(c) => {
            let done = crate::firewall::change(cfg, &c);
            let _ = tx.send(Msg::FirewallChanged); // also after a failure: it may have been undone
            done
        }
        Action::Repos(files) => {
            let done = crate::repos::write(&files);
            let _ = tx.send(Msg::ReposChanged);
            done
        }
        Action::InstallInCt { vmid, token, key } => install_in_ct(cfg, http, vmid, &token, &key),
        Action::SetKind { .. } | Action::SetDns { .. } => Ok(String::new()), // handled by the main loop
    };
    let (ok, output) = match outcome {
        Ok(o) => (true, o),
        Err(e) => (false, format!("{e:#}")),
    };
    let _ = tx.send(Msg::Result(CommandResult { id: cmd.id, ok, output: tail(&output) }));
    if restart {
        let _ = tx.send(Msg::Restart); // Last, so the report before the exit carries the result.
    }
}

fn tail(s: &str) -> String {
    let skip = s.chars().count().saturating_sub(OUTPUT_TAIL);
    s.chars().skip(skip).collect()
}

/// Takes a command or a `&mut` to one, as the builder methods return.
pub(crate) fn sh(mut c: impl std::borrow::BorrowMut<process::Command>) -> anyhow::Result<String> {
    let c = c.borrow_mut();
    let out = c.output().with_context(|| format!("cannot start {:?}", c.get_program()))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(text)
    } else {
        bail!("{} failed:\n{}", c.get_program().to_string_lossy(), tail(&text))
    }
}

/// [`sh`] for long commands: tells the monitor how far they have come.
fn stream(mut c: process::Command, parse: fn(&str) -> Option<Progress>, tx: &Sender<Msg>) -> anyhow::Result<String> {
    let mut child = c.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().with_context(|| format!("cannot start {:?}", c.get_program()))?;
    let (out, mut err) = (child.stdout.take().context("no stdout")?, child.stderr.take().context("no stderr")?);
    // On its own thread: a full stderr pipe would stall the command.
    let errors = std::thread::spawn(move || {
        let mut bytes = vec![];
        let _ = err.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let (mut text, mut shown) = (String::new(), None);
    for line in BufReader::new(out).split(b'\n').map_while(Result::ok) {
        let line = String::from_utf8_lossy(&line);
        if let Some(p) = parse(&line).filter(|p| shown != Some(p.pct)) {
            shown = Some(p.pct);
            let _ = tx.send(Msg::Progress(p));
        }
        if !packages::is_apt_status(&line) {
            text.push_str(&line);
            text.push('\n');
        }
    }
    text.push_str(&errors.join().unwrap_or_default());
    if child.wait()?.success() {
        Ok(text)
    } else {
        bail!("{} failed:\n{}", c.get_program().to_string_lossy(), tail(&text))
    }
}

pub(crate) fn cmd<const N: usize>(program: &str, args: [&str; N]) -> process::Command {
    let mut c = process::Command::new(program);
    c.args(args);
    c
}

fn upgrade(tx: &Sender<Msg>) -> anyhow::Result<String> {
    let (program, args) = packages::upgrade_command().context("no supported package manager")?;
    let _ = tx.send(Msg::Progress(Progress { pct: 0, step: "Refreshing the package list".into() }));
    packages::check(); // The daily check can be a day old.
    let mut c = process::Command::new(program);
    c.args(args).env("DEBIAN_FRONTEND", "noninteractive");
    let output = stream(c, if program == "dnf" { packages::dnf_progress } else { packages::apt_progress }, tx);
    if let Some(list) = packages::check() {
        let _ = tx.send(Msg::Updates(list)); // Also after a failure: part of it may have gone through.
    }
    output
}

fn clean(tx: &Sender<Msg>) -> anyhow::Result<String> {
    let [(program, args), cache] = packages::clean_commands().context("no supported package manager")?;
    let _ = tx.send(Msg::Progress(Progress { pct: 0, step: "Removing unneeded packages".into() }));
    let mut c = process::Command::new(program);
    c.args(args).env("DEBIAN_FRONTEND", "noninteractive");
    let mut output = stream(c, if program == "dnf" { packages::dnf_progress } else { packages::apt_progress }, tx)?;
    output.push_str(&sh(cmd(cache.0, []).args(cache.1))?);
    Ok(output)
}

fn update_agent(cfg: &Config, http: &ureq::Agent) -> anyhow::Result<String> {
    let name = format!("nyx-agent-linux-{}", std::env::consts::ARCH);
    let bytes = transport::fetch_agent_binary(http, cfg, &name)?;
    let exe = std::env::current_exe()?;
    let tmp = exe.with_extension("new");
    fs::write(&tmp, bytes)?;
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))?;
    fs::rename(&tmp, &exe)?; // atomic, a running binary can be replaced on Linux
    Ok("agent binary replaced, restarting".into())
}

/// The installer is the one served by the monitor, built into the agent so that both match.
const INSTALL_SH: &str = include_str!("../../../packaging/install.sh");

/// Puts the agent in a container from the host: the binary and the installer are pushed
/// first, as the container may have no curl. Arguments go straight to `pct`, never through a shell.
fn install_in_ct(cfg: &Config, http: &ureq::Agent, vmid: u32, token: &str, key: &str) -> anyhow::Result<String> {
    if !(safe_word(token) && safe_word(key)) {
        bail!("invalid token or key");
    }
    let dir = std::path::Path::new("/run/nyx-agent");
    let (script, bin) = (dir.join(format!("ct{vmid}-install.sh")), dir.join(format!("ct{vmid}-agent")));
    fs::write(&script, INSTALL_SH)?;
    fs::write(&bin, transport::fetch_agent_binary(http, cfg, &format!("nyx-agent-linux-{}", std::env::consts::ARCH))?)?;
    let id = vmid.to_string();
    let run = || -> anyhow::Result<String> {
        sh(cmd("pct", ["push", &id, &script.to_string_lossy(), "/tmp/nyx-install.sh", "--perms", "0755"]))?;
        sh(cmd("pct", ["push", &id, &bin.to_string_lossy(), "/tmp/nyx-agent.bin", "--perms", "0755"]))?;
        let mut install = cmd("pct", ["exec", &id, "--", "sh", "/tmp/nyx-install.sh", "--url", &cfg.url, "--token", token, "--key", key, "--kind", "lxc", "--binary", "/tmp/nyx-agent.bin"]);
        if !cfg.relay_key.is_empty() {
            install.args(["--relay-key", &cfg.relay_key]);
        }
        sh(install)
    };
    let done = run();
    let _ = sh(cmd("pct", ["exec", &id, "--", "rm", "-f", "/tmp/nyx-install.sh", "/tmp/nyx-agent.bin"]));
    let _ = (fs::remove_file(&script), fs::remove_file(&bin));
    done
}

/// Rejects anything that would not stay one word inside a shell string.
fn safe_word(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Start, stop or restart a Docker container, or read its last lines.
/// Start, stop or restart a systemd service, or read its logs, status or unit file.
fn service_op(op: &str, name: &str) -> anyhow::Result<String> {
    if !nyx_proto::unit_name_ok(name) {
        bail!("invalid service name");
    }
    let unit = format!("{name}.service");
    // Stopping the agent from the monitor would leave nothing to start it again.
    if name == "nyx-agent" && op == "stop" {
        bail!("the agent cannot stop itself from here");
    }
    match op {
        "start" | "stop" | "restart" => sh(cmd("systemctl", [op, "--", &unit])).map(|_| format!("{op} done")),
        "logs" => sh(cmd("journalctl", ["-u", &unit, "-n", "300", "--no-pager", "-o", "short-iso"])),
        // `status` exits 3 for a stopped unit: still an answer worth showing.
        "status" => Ok(String::from_utf8_lossy(&cmd("systemctl", ["status", "--no-pager", "--full", "-n", "0", "--", &unit]).output()?.stdout).into_owned()),
        "cat" => sh(cmd("systemctl", ["cat", "--no-pager", "--", &unit])),
        _ => bail!("unknown operation"),
    }
}

fn container_op(op: &str, name: &str) -> anyhow::Result<String> {
    if !nyx_proto::container_name_ok(name) {
        bail!("invalid container name");
    }
    let path = match op {
        "start" | "restart" | "stop" => format!("/containers/{name}/{op}"),
        "logs" => format!("/containers/{name}/logs?stdout=1&stderr=1&tail=200&timestamps=1"),
        _ => bail!("unknown operation"),
    };
    let (status, body) = crate::collect::docker_call(if op == "logs" { "GET" } else { "POST" }, &path).context("Docker is not reachable")?;
    match status {
        200 if op == "logs" => Ok(crate::collect::unframe(&body)),
        204 => Ok(format!("{op} done")),
        304 => Ok(format!("nothing to do: already {}", if op == "start" { "started" } else { "stopped" })),
        404 => bail!("no such container"),
        _ => bail!("Docker answered {status}: {}", String::from_utf8_lossy(&body).trim()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_keeps_the_output_and_reports_each_step_once() {
        let (tx, rx) = std::sync::mpsc::channel();
        let run = |script: &str| stream(cmd("sh", ["-c", script]), packages::apt_progress, &tx);
        let out = run("echo hello; echo pmstatus:a:0:One; echo pmstatus:a:0:Again; echo pmstatus:b:100:Two; echo oops >&2").unwrap();
        assert_eq!(out, "hello\noops\n");
        let pcts: Vec<u8> = rx.try_iter().map(|m| match m { Msg::Progress(p) => p.pct, _ => panic!("unexpected message") }).collect();
        assert_eq!(pcts, [25, 100]);
        assert!(format!("{:#}", run("echo broken >&2; exit 3").unwrap_err()).contains("broken"));
    }

    #[test]
    fn rejects_shell_metacharacters() {
        assert!(safe_word("abc-123_DEF") && !safe_word("a;rm") && !safe_word("") && !safe_word("a b"));
    }

    #[test]
    fn tail_keeps_the_end_on_char_boundaries() {
        let s = "é".repeat(OUTPUT_TAIL + 5);
        assert_eq!(tail(&s).chars().count(), OUTPUT_TAIL);
    }
}

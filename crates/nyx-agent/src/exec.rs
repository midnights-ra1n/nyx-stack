//! Slow commands from the monitor, run one at a time on the worker thread.

use crate::{config::Config, packages, transport, Msg};
use anyhow::{bail, Context};
use nyx_proto::{Action, Command, CommandResult, Deploy, Progress};
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
        Action::UpdateAgent => update_agent(cfg, http).inspect(|_| restart = true),
        Action::Deploy(d) => deploy(&d),
        Action::Site(c) => site_control(&c),
        Action::Container { op, name } => container_op(&op, &name),
        Action::Firewall(c) => {
            let done = crate::firewall::change(cfg, &c);
            let _ = tx.send(Msg::FirewallChanged); // also after a failure: it may have been undone
            done
        }
        Action::InstallInCt { vmid, token, key } => install_in_ct(cfg, http, vmid, &token, &key),
        Action::SetKind { .. } => Ok(String::new()), // handled by the main loop
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
        sh(cmd("pct", ["exec", &id, "--", "sh", "/tmp/nyx-install.sh", "--url", &cfg.url, "--token", token, "--key", key, "--kind", "lxc", "--binary", "/tmp/nyx-agent.bin"]))
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

const DEPLOY_SCRIPT: &str = r#"set -e
export GIT_SSH_COMMAND="ssh -i $NYX_DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if [ -d "$NYX_PATH/.git" ]; then
  git -C "$NYX_PATH" fetch --depth 1 origin "${NYX_COMMIT:-$NYX_BRANCH}"
  git -C "$NYX_PATH" reset --hard FETCH_HEAD
else
  git clone --depth 1 --branch "$NYX_BRANCH" "$NYX_REPO" "$NYX_PATH"
fi
cd "$NYX_PATH"
sh -c "$NYX_INSTALL"
sh -c "$NYX_BUILD"
git rev-parse HEAD
"#;

fn deploy(d: &Deploy) -> anyhow::Result<String> {
    if !safe_word(&d.site) || !safe_word(&d.user) || !d.path.starts_with('/') {
        bail!("invalid site name, user or path");
    }
    if !d.commit.is_empty() && !(d.commit.len() >= 7 && d.commit.chars().all(|c| c.is_ascii_hexdigit())) {
        bail!("invalid commit");
    }
    env_lines(&d.env)?; // before anything is changed on the host
    sh(cmd("install", ["-d", "-o", &d.user, "-m", "755", &d.path]))?;
    let key_dir = "/run/nyx-agent/keys";
    sh(cmd("install", ["-d", "-o", &d.user, "-m", "700", key_dir]))?;
    let key_path = format!("{key_dir}/{}", d.site);
    fs::write(&key_path, format!("{}\n", d.ssh_private_key.trim()))?;
    let locked = sh(cmd("chown", [&d.user, &key_path])).and_then(|_| Ok(fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600))?));

    let mut c = process::Command::new("runuser");
    c.args(["-u", &d.user, "--", "env"])
        .arg(format!("NYX_DEPLOY_KEY={key_path}"))
        .arg(format!("NYX_PATH={}", d.path))
        .arg(format!("NYX_REPO={}", d.repo))
        .arg(format!("NYX_BRANCH={}", d.branch))
        .arg(format!("NYX_COMMIT={}", d.commit))
        .arg(format!("NYX_INSTALL={}", d.install_cmd))
        .arg(format!("NYX_BUILD={}", d.build_cmd))
        .args(["sh", "-c", DEPLOY_SCRIPT]);
    let result = locked.and_then(|_| sh(c));
    let _ = fs::remove_file(&key_path); // the key only exists for the deploy
    let output = result?;

    write_env(d)?;
    if d.cache_max_age.is_some() {
        fs::create_dir_all(CACHE_DIR)?;
        fs::write(format!("{CACHE_DIR}/cache.js"), CACHE_JS)?; // umask 022: readable by the run user
    }
    if !d.service.is_empty() {
        restart_existing(d)?;
        return Ok(output);
    }
    let unit = format!("nyx-site-{}", d.site);
    fs::write(format!("/etc/systemd/system/{unit}.service"), unit_file(d))?;
    sh(cmd("systemctl", ["daemon-reload"]))?;
    sh(cmd("systemctl", ["enable", &unit]))?;
    sh(cmd("systemctl", ["restart", &unit]))?;
    Ok(output)
}

const ENV_DIR: &str = "/etc/nyx/env";

/// `KEY=value` lines only: the file is read by systemd, as root.
fn env_lines(env: &str) -> anyhow::Result<String> {
    let mut out = String::new();
    for line in env.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let name = line.split_once('=').map(|(k, _)| k);
        if !name.is_some_and(|k| !k.is_empty() && !k.starts_with(|c: char| c.is_ascii_digit()) && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')) {
            bail!("invalid environment line (expected NAME=value)");
        }
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
}

/// Readable by root only: it holds secrets.
fn write_env(d: &Deploy) -> anyhow::Result<()> {
    let path = format!("{ENV_DIR}/{}.env", d.site);
    let lines = env_lines(&d.env)?;
    if lines.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    fs::create_dir_all(ENV_DIR)?;
    fs::write(&path, lines)?;
    Ok(fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?)
}

/// Start, stop or restart a Docker container, or read its last lines.
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

/// Start, stop or restart a site's service, or read what it logged lately.
fn site_control(c: &nyx_proto::SiteControl) -> anyhow::Result<String> {
    if !service_ok(&c.service) || !safe_word(&c.user) {
        bail!("refusing unsafe service name");
    }
    let op = c.op.as_str();
    if !["restart", "stop", "start", "logs"].contains(&op) {
        bail!("unknown operation");
    }
    match c.service.strip_prefix("pm2:") {
        Some(name) if op == "logs" => sh(cmd("runuser", ["-u", &c.user, "--", "sh", "-lc", "pm2 logs \"$1\" --nostream --lines 200", "sh", name])),
        Some(name) => sh(cmd("runuser", ["-u", &c.user, "--", "sh", "-lc", "pm2 \"$1\" \"$2\"", "sh", op, name])),
        None if op == "logs" => sh(cmd("journalctl", ["-u", &c.service, "-n", "200", "--no-pager", "-o", "short-iso"])),
        None => sh(cmd("systemctl", [op, &c.service])).map(|_| format!("{op} done")),
    }
}

/// A site Nyx adopted keeps the service that already runs it.
// shortcut: pm2 is looked up in the user's login PATH, keep the path in the app if nvm hides it.
// shortcut: the cache setting only reaches systemd services, not PM2 ones; pass the env through pm2 if asked.
fn restart_existing(d: &Deploy) -> anyhow::Result<String> {
    if !service_ok(&d.service) {
        bail!("refusing unsafe service name");
    }
    match d.service.strip_prefix("pm2:") {
        Some(name) => sh(cmd("runuser", ["-u", &d.user, "--", "sh", "-lc", "pm2 restart \"$1\"", "sh", name])),
        None => {
            let dir = format!("/etc/systemd/system/{}.d", unit_name(&d.service));
            let env_conf = format!("{dir}/nyx-env.conf");
            if env_lines(&d.env)?.is_empty() {
                let _ = fs::remove_file(&env_conf);
            } else {
                fs::create_dir_all(&dir)?;
                fs::write(&env_conf, format!("[Service]\nEnvironmentFile={ENV_DIR}/{}.env\n", d.site))?;
            }
            match cache_env(d) {
                env if env.is_empty() => { let _ = fs::remove_file(format!("{dir}/nyx-cache.conf")); }
                env => {
                    fs::create_dir_all(&dir)?;
                    fs::write(format!("{dir}/nyx-cache.conf"), format!("[Service]\n{env}"))?;
                }
            }
            sh(cmd("systemctl", ["daemon-reload"]))?;
            sh(cmd("systemctl", ["restart", &d.service]))
        }
    }
}

const CACHE_DIR: &str = "/usr/local/lib/nyx-agent";
const CACHE_JS: &str = include_str!("../assets/cache.js");

/// Drop-in folders need the full unit name, `systemctl` does not.
fn unit_name(service: &str) -> String {
    if service.contains('.') { service.into() } else { format!("{service}.service") }
}

/// Environment lines that preload the cache module, empty when the app keeps its own headers.
// shortcut: replaces a NODE_OPTIONS the unit already sets; merge them if a site needs both.
fn cache_env(d: &Deploy) -> String {
    d.cache_max_age.map_or_else(String::new, |age| {
        format!("Environment=CACHE_MAX_AGE={age}\nEnvironment=\"NODE_OPTIONS=--require {CACHE_DIR}/cache.js\"\n")
    })
}

fn service_ok(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.@:".contains(c))
}

fn unit_file(d: &Deploy) -> String {
    let start = d.start_cmd.replace('\\', "\\\\").replace('"', "\\\"").replace('%', "%%").replace('$', "$$");
    format!(
        "[Unit]\nDescription=Nyx site {site}\nAfter=network-online.target\n\n[Service]\nUser={user}\nWorkingDirectory={path}\nEnvironment=NODE_ENV=production\nEnvironmentFile=-{ENV_DIR}/{site}.env\n{cache}ExecStart=/bin/sh -c \"{start}\"\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n",
        site = d.site, user = d.user, path = d.path, cache = cache_env(d)
    )
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
    fn environment_lines_are_names_and_values_only() {
        assert_eq!(env_lines("# c\n PORT=3000 \n\nDB_URL=postgres://u:p@h/db?x=1\n").unwrap(), "PORT=3000\nDB_URL=postgres://u:p@h/db?x=1\n");
        for bad in ["PORT", "=x", "1A=x", "A B=x", "A-B=x"] {
            assert!(env_lines(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn site_operations_are_checked() {
        let c = |op: &str, service: &str| nyx_proto::SiteControl { op: op.into(), service: service.into(), user: "www".into() };
        assert!(site_control(&c("reboot", "a.service")).is_err());
        assert!(site_control(&c("stop", "-rf")).is_err());
        assert!(site_control(&c("stop", "a b")).is_err());
    }

    #[test]
    fn unit_escapes_start_command() {
        let d = Deploy { site: "blog".into(), user: "www".into(), path: "/srv/blog".into(), start_cmd: r#"node "a$b" 100%"#.into(), repo: "".into(), branch: "".into(), install_cmd: "".into(), build_cmd: "".into(), ssh_private_key: "".into(), service: "".into(), cache_max_age: None, env: "".into(), commit: "".into() };
        assert!(unit_file(&d).contains(r#"ExecStart=/bin/sh -c "node \"a$$b\" 100%%""#));
        assert!(!unit_file(&d).contains("CACHE_MAX_AGE"));
        let d = Deploy { cache_max_age: Some(0), ..d };
        assert!(unit_file(&d).contains("Environment=CACHE_MAX_AGE=0\nEnvironment=\"NODE_OPTIONS=--require /usr/local/lib/nyx-agent/cache.js\"\nExecStart"));
    }

    #[test]
    fn drop_ins_use_the_full_unit_name() {
        assert_eq!((unit_name("my-app").as_str(), unit_name("app@1.service").as_str()), ("my-app.service", "app@1.service"));
    }

    #[test]
    fn service_names_cannot_become_options_or_commands() {
        assert!(service_ok("my-app.service") && service_ok("pm2:api_1") && service_ok("app@1.service"));
        assert!(!service_ok("") && !service_ok("--now") && !service_ok("a b") && !service_ok("a;reboot"));
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

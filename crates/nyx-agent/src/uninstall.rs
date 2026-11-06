//! `nyx-agent uninstall`: removes everything the installer or package put on the host.
//!
//! The service is stopped last. If this ever runs from the service itself, stopping
//! it first would end the process with the removal half done.

use anyhow::{bail, Context};
use std::{fs, io::ErrorKind, path::Path, process::Command};

const UNIT: &str = "/etc/systemd/system/nyx-agent.service";
const PACKAGE_BIN_DIR: &str = "/usr/bin";
/// Run in each container, where the binary is in one of two places.
const REMOVE_IN_CT: &str = r#"for b in /usr/local/bin/nyx-agent /usr/bin/nyx-agent; do [ -x "$b" ] && exec "$b" uninstall; done; true"#;

fn remove_file(path: &Path) -> anyhow::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(e).with_context(|| format!("cannot remove {}", path.display())),
        _ => Ok(()),
    }
}

/// `/etc/nyx` is shared with the servers on a host that runs both, so it only goes if empty.
fn remove_config(path: &Path) -> anyhow::Result<()> {
    remove_file(path)?;
    if let Some(dir) = path.parent() {
        let _ = fs::remove_dir(dir);
    }
    Ok(())
}

fn systemctl(args: &[&str]) {
    // Containers have no systemd, and there is then nothing to stop.
    let _ = Command::new("systemctl").args(args).status();
}

fn remove_package() -> anyhow::Result<()> {
    for (tool, args) in [("dpkg", ["--purge", "nyx-agent"]), ("rpm", ["-e", "nyx-agent"])] {
        match Command::new(tool).args(args).status() {
            Ok(status) if status.success() => return Ok(()),
            Ok(status) => bail!("{tool} failed: {status}"),
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(e) => return Err(e).context(tool),
        }
    }
    bail!("neither dpkg nor rpm was found")
}

/// IDs of the running containers in the output of `pct list`.
fn running(pct_list: &str) -> Vec<&str> {
    pct_list.lines().skip(1).filter_map(|l| {
        let mut columns = l.split_whitespace();
        Some(columns.next()?).filter(|_| columns.next() == Some("running"))
    }).collect()
}

/// Earlier versions installed the agent in containers. A stopped one keeps its agent,
/// as `pct exec` cannot reach it. Elsewhere there is no `pct`, and nothing to do.
fn remove_from_containers() {
    let Ok(list) = Command::new("pct").arg("list").output() else { return };
    for vmid in running(&String::from_utf8_lossy(&list.stdout)) {
        let _ = Command::new("pct").args(["exec", vmid, "--", "sh", "-c", REMOVE_IN_CT]).status();
    }
}

pub fn run(config: &str) -> anyhow::Result<()> {
    let id = Command::new("id").arg("-u").output().context("cannot read the user id")?;
    if id.stdout.trim_ascii() != b"0" {
        bail!("run this as root");
    }
    let exe = std::env::current_exe().context("cannot find the agent binary")?;
    remove_from_containers();
    systemctl(&["disable", "nyx-agent"]);
    remove_config(Path::new(config))?;
    if exe.starts_with(PACKAGE_BIN_DIR) {
        remove_package()?;
    } else {
        remove_file(Path::new(UNIT))?;
        remove_file(&exe)?;
    }
    systemctl(&["daemon-reload"]);
    systemctl(&["stop", "nyx-agent"]);
    println!("nyx-agent removed. To also forget the host, delete it in the monitor.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nyx-uninstall-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_config_dir_goes_only_when_nothing_else_lives_there() {
        let dir = temp_dir("shared");
        let (config, server) = (dir.join("agent.conf"), dir.join("server.env"));
        fs::write(&config, "x").unwrap();
        fs::write(&server, "x").unwrap();
        remove_config(&config).unwrap();
        assert!(!config.exists() && server.exists(), "a server's settings must survive");
        fs::remove_file(&server).unwrap();
        fs::write(&config, "x").unwrap();
        remove_config(&config).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn only_running_containers_can_be_reached() {
        let list = "VMID       Status     Lock         Name\n101        running                 web\n102        stopped                 db\n103        running    backup       mail\n";
        assert_eq!(running(list), ["101", "103"]);
    }

    #[test]
    fn running_twice_is_not_an_error() {
        let dir = temp_dir("twice");
        remove_config(&dir.join("agent.conf")).unwrap();
        remove_file(&dir.join("missing")).unwrap();
    }
}

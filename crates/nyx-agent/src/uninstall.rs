//! `nyx-agent uninstall`: removes everything the installer or package put on the host.
//!
//! The service is stopped last. If this ever runs from the service itself, stopping
//! it first would end the process with the removal half done.

use anyhow::{bail, Context};
use std::{fs, io::ErrorKind, path::Path, process::Command};

const UNIT: &str = "/etc/systemd/system/nyx-agent.service";
const PACKAGE_BIN_DIR: &str = "/usr/bin";

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

pub fn run(config: &str) -> anyhow::Result<()> {
    let id = Command::new("id").arg("-u").output().context("cannot read the user id")?;
    if id.stdout.trim_ascii() != b"0" {
        bail!("run this as root");
    }
    let exe = std::env::current_exe().context("cannot find the agent binary")?;
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
    fn running_twice_is_not_an_error() {
        let dir = temp_dir("twice");
        remove_config(&dir.join("agent.conf")).unwrap();
        remove_file(&dir.join("missing")).unwrap();
    }
}

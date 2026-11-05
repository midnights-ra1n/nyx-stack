//! PocketBase embedded in the server binary. It is a Go program, so it still runs as
//! a child process: the executable and the migrations are unpacked into the data
//! directory, and this process starts, restarts and stops it.

use rust_embed::Embed;
use std::{fs, io, os::unix::fs::PermissionsExt, path::Path, time::Duration};
use tokio::{process::Command, sync::watch, time::sleep};

pub const POCKETBASE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/pocketbase"));

#[derive(Embed)]
#[folder = "../../pb/pb_migrations"]
struct Migrations;

/// Handle on the running database.
pub struct Database(watch::Sender<bool>);

impl Database {
    /// Stops PocketBase cleanly. Call it last: the final flush still needs the database.
    pub async fn stop(&self) {
        self.0.send_replace(true);
        self.0.closed().await;
    }
}

/// Rewrites `path` only when it differs, so a normal start writes nothing.
fn unpack(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    if fs::read(path).is_ok_and(|current| current == bytes) {
        return Ok(());
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
    fs::rename(tmp, path)
}

/// Starts PocketBase on a loopback port and returns its URL.
pub fn start(dir: &Path) -> anyhow::Result<(Database, String)> {
    let migrations = dir.join("pb_migrations");
    fs::create_dir_all(&migrations)?;
    let exe = dir.join("pocketbase");
    unpack(&exe, POCKETBASE, 0o700)?;
    for name in Migrations::iter() {
        let file = Migrations::get(&name).expect("listed by iter");
        unpack(&migrations.join(&*name), &file.data, 0o600)?;
    }
    // Chosen by the OS, so that both servers can run on one host without any setting.
    let addr = std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?;
    let mut cmd = Command::new(exe);
    cmd.arg("serve").arg("--http").arg(addr.to_string());
    cmd.arg("--dir").arg(dir.join("pb_data")).arg("--migrationsDir").arg(migrations);
    cmd.kill_on_drop(true);

    let (stop, mut stopping) = watch::channel(false);
    tokio::spawn(async move {
        loop {
            match cmd.spawn() {
                Ok(mut child) => tokio::select! {
                    status = child.wait() => eprintln!("PocketBase stopped ({status:?}), restarting it"),
                    _ = stopping.changed() => {
                        if let Some(pid) = child.id() {
                            // SAFETY: plain syscall, and `pid` is our unreaped child.
                            unsafe { libc::kill(pid as i32, libc::SIGTERM) };
                        }
                        let _ = child.wait().await;
                        return;
                    }
                },
                Err(e) => eprintln!("cannot start PocketBase: {e}"),
            }
            tokio::select! {
                _ = sleep(Duration::from_secs(5)) => {}
                _ = stopping.changed() => return,
            }
        }
    });
    Ok((Database(stop), format!("http://{addr}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpack_writes_only_what_changed() {
        let dir = std::env::temp_dir().join(format!("nyx-unpack-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("bin");

        unpack(&file, b"one", 0o700).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"one");
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o700);

        // A read-only file proves the unchanged case does not touch it.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        unpack(&file, b"one", 0o700).unwrap();
        assert!(unpack(&file, b"two", 0o700).is_err());
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();

        // Replaced, not overwritten: a running copy cannot be written in place.
        unpack(&file, b"two", 0o700).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"two");
        fs::remove_dir_all(dir).unwrap();
    }
}

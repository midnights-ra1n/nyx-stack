//! Package sources: apt's `sources.list` and `sources.list.d`, dnf's `yum.repos.d`.
//! Read for the monitor, written on command and undone when the index stops refreshing.

use crate::exec::sh;
use anyhow::bail;
use nyx_proto::RepoFile;
use std::{fs, path::Path, process::Command};

const APT_LIST: &str = "/etc/apt/sources.list";
const DIRS: [&str; 2] = ["/etc/apt/sources.list.d", "/etc/yum.repos.d"];

/// Every source file this host has, in a stable order. Unreadable ones are skipped.
pub fn scan() -> Option<Vec<RepoFile>> {
    let mut paths = vec![APT_LIST.to_string()];
    for dir in DIRS {
        let mut names: Vec<String> = fs::read_dir(dir).into_iter().flatten().flatten().map(|e| format!("{dir}/{}", e.file_name().to_string_lossy())).collect();
        names.sort();
        paths.extend(names);
    }
    let files = paths.into_iter().filter_map(|path| {
        let content = fs::read_to_string(&path).ok()?;
        let f = RepoFile { path, content };
        f.check().is_ok().then_some(f)
    });
    Some(files.collect())
}

/// Writes the files (an empty one is deleted) and refreshes the index. When the refresh
/// fails, every file is put back, so a typo never leaves the host unable to update.
pub fn write(files: &[RepoFile]) -> anyhow::Result<String> {
    for f in files {
        if let Err(e) = f.check() {
            bail!("{}: {e}", f.path);
        }
    }
    let before: Vec<(&str, Option<String>)> = files.iter().map(|f| (f.path.as_str(), fs::read_to_string(&f.path).ok())).collect();
    let applied = files.iter().try_for_each(|f| put(&f.path, (!f.content.is_empty()).then_some(f.content.as_str())));
    let refreshed = applied.and_then(|_| refresh());
    match refreshed {
        Ok(out) => Ok(format!("{} source file(s) saved\n{out}", files.len())),
        Err(e) => {
            let undone = before.iter().try_for_each(|(path, old)| put(path, old.as_deref()));
            match undone {
                Ok(()) => Err(e.context("the sources are back as they were")),
                Err(u) => Err(e.context(format!("and the old sources could not be put back, check the host: {u:#}"))),
            }
        }
    }
}

fn put(path: &str, content: Option<&str>) -> anyhow::Result<()> {
    match content {
        Some(c) => {
            if let Some(dir) = Path::new(path).parent() {
                fs::create_dir_all(dir)?;
            }
            fs::write(path, c)?;
        }
        None => match fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        },
    }
    Ok(())
}

/// apt-get exits 0 when a source cannot be fetched, so its `Err:` and `E:` lines count too.
fn refresh() -> anyhow::Result<String> {
    if Path::new("/usr/bin/apt-get").exists() {
        let out = sh(Command::new("apt-get").args(["update", "-q"]).env("LC_ALL", "C"))?;
        if out.lines().any(|l| l.starts_with("Err:") || l.starts_with("E:")) {
            bail!("apt-get update could not use these sources:\n{}", apt_errors(&out));
        }
        Ok(out)
    } else if Path::new("/usr/bin/dnf").exists() {
        sh(Command::new("dnf").args(["-q", "makecache"]))
    } else {
        bail!("no apt-get or dnf on this host")
    }
}

fn apt_errors(out: &str) -> String {
    out.lines().filter(|l| l.starts_with("Err:") || l.starts_with("E:") || l.starts_with("W:") || l.starts_with("  ")).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_errors_of_apt() {
        let out = "Hit:1 http://deb.debian.org/debian bookworm InRelease\nErr:2 https://mirror.invalid/debian bookworm InRelease\n  Could not resolve 'mirror.invalid'\nReading package lists...\nW: Failed to fetch https://mirror.invalid/debian/dists/bookworm/InRelease\n";
        assert_eq!(apt_errors(out), "Err:2 https://mirror.invalid/debian bookworm InRelease\n  Could not resolve 'mirror.invalid'\nW: Failed to fetch https://mirror.invalid/debian/dists/bookworm/InRelease");
    }

    #[test]
    fn writes_and_deletes() {
        let dir = std::env::temp_dir().join(format!("nyx-repos-{}", std::process::id()));
        let path = dir.join("a.list").to_string_lossy().to_string();
        put(&path, Some("deb http://x y main\n")).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "deb http://x y main\n");
        put(&path, None).unwrap();
        put(&path, None).unwrap();
        assert!(!Path::new(&path).exists());
        fs::remove_dir_all(dir).unwrap();
    }
}

//! apt / dnf update detection and application.

use nyx_proto::{PackageUpdate, Progress};
use std::{path::Path, process::Command};

/// Share of the bar for downloads, the rest is for installing.
const DOWNLOAD_PCT: f32 = 25.0;

fn has(tool: &str) -> bool {
    Command::new(tool).arg("--version").output().is_ok_and(|o| o.status.success())
}

/// Refresh the index, then list pending updates. `None` if neither tool exists.
pub fn check() -> Option<Vec<PackageUpdate>> {
    if has("apt-get") {
        Command::new("apt-get").args(["update", "-qq"]).output().ok()?;
        let out = Command::new("apt").args(["list", "--upgradable"]).env("LC_ALL", "C").output().ok()?;
        Some(parse_apt(&String::from_utf8_lossy(&out.stdout)))
    } else if has("dnf") {
        // Exit code 100 just means "updates available".
        let out = Command::new("dnf").args(["-q", "check-update"]).output().ok()?;
        Some(parse_dnf(&String::from_utf8_lossy(&out.stdout)))
    } else {
        None
    }
}

/// Returns (command, args) for a non-interactive system upgrade. Plain `upgrade`
/// would hold back new kernels, and Proxmox only supports `dist-upgrade`.
pub fn upgrade_command() -> Option<(&'static str, &'static [&'static str])> {
    if has("apt-get") {
        Some(if Path::new("/usr/bin/pveversion").exists() {
            ("apt-get", &["-y", "-o", "Dpkg::Options::=--force-confold", "-o", "APT::Status-Fd=1", "dist-upgrade"])
        } else {
            ("apt-get", &["-y", "-o", "Dpkg::Options::=--force-confold", "-o", "APT::Status-Fd=1", "--with-new-pkgs", "upgrade"])
        })
    } else if has("dnf") {
        Some(("dnf", &["-y", "upgrade"]))
    } else {
        None
    }
}

/// A line of `APT::Status-Fd`, which the output of the command must not show.
pub fn is_apt_status(line: &str) -> bool {
    line.starts_with("dlstatus:") || line.starts_with("pmstatus:")
}

fn overall(download: bool, pct: f32) -> u8 {
    (if download { pct * DOWNLOAD_PCT / 100.0 } else { DOWNLOAD_PCT + pct * (100.0 - DOWNLOAD_PCT) / 100.0 }) as u8
}

/// `pmstatus:libc6:amd64:12.5:Unpacking libc6:amd64`: names and steps can hold colons.
pub fn apt_progress(line: &str) -> Option<Progress> {
    if !is_apt_status(line) {
        return None;
    }
    let parts: Vec<&str> = line.split(':').collect();
    let i = (2..parts.len()).find(|&i| parts[i].parse::<f32>().is_ok())?;
    Some(Progress { pct: overall(line.starts_with("dl"), parts[i].parse().ok()?), step: parts[i + 1..].join(":") })
}

/// `(3/12): name.rpm` while downloading, then `Upgrading : name 3/12` or, with dnf5, `[3/12] Upgrading name`.
pub fn dnf_progress(line: &str) -> Option<Progress> {
    let (n, of) = line.split_whitespace().find_map(|t| {
        let (n, of) = t.trim_matches(|c: char| !c.is_ascii_digit()).split_once('/')?;
        Some((n.parse::<f32>().ok()?, of.parse::<f32>().ok()?))
    })?;
    (n <= of && of > 0.0).then(|| Progress { pct: overall(line.starts_with('('), n / of * 100.0), step: line.trim().into() })
}

/// `/run/reboot-required` only exists with Ubuntu or unattended-upgrades, so also
/// compare the kernels.
pub fn reboot_required(running: &str) -> bool {
    let installed = std::fs::read_dir("/lib/modules").into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned());
    Path::new("/run/reboot-required").exists() || newer_kernel(running, &installed.collect::<Vec<_>>())
}

/// In a container the running kernel is the host's, which is not installed there.
// shortcut: a kernel kept on purpose below the newest one reads as a pending restart, upgrade by asking the boot loader.
fn newer_kernel(running: &str, installed: &[String]) -> bool {
    let version = |k: &str| k.split(|c: char| !c.is_ascii_digit()).filter_map(|n| n.parse::<u64>().ok()).collect::<Vec<_>>();
    installed.iter().any(|k| k == running) && installed.iter().any(|k| version(k) > version(running))
}

fn parse_apt(out: &str) -> Vec<PackageUpdate> {
    out.lines()
        .filter(|l| l.contains("[upgradable from"))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let (name, suite) = parts.next()?.split_once('/')?;
            Some(PackageUpdate { name: name.into(), version: parts.next()?.into(), security: suite.contains("security") })
        })
        .collect()
}

fn parse_dnf(out: &str) -> Vec<PackageUpdate> {
    out.lines()
        .take_while(|l| !l.starts_with("Obsoleting"))
        .filter_map(|l| {
            let p: Vec<&str> = l.split_whitespace().collect();
            let [pkg, version, repo] = p[..] else { return None };
            let (name, _arch) = pkg.rsplit_once('.')?;
            Some(PackageUpdate { name: name.into(), version: version.into(), security: repo.contains("security") })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apt_output() {
        let out = "Listing...\nopenssl/stable-security 3.0.15-1 amd64 [upgradable from: 3.0.14-1]\ncurl/stable 8.5.0-2 arm64 [upgradable from: 8.5.0-1]\n";
        let u = parse_apt(out);
        assert_eq!(u.len(), 2);
        assert_eq!(u[0], PackageUpdate { name: "openssl".into(), version: "3.0.15-1".into(), security: true });
        assert!(!u[1].security);
    }

    #[test]
    fn apt_status_lines_fill_the_bar_in_order() {
        let p = |l: &str| apt_progress(l).unwrap();
        assert_eq!(p("dlstatus:1:50.0000:Retrieving file 1 of 2"), Progress { pct: 12, step: "Retrieving file 1 of 2".into() });
        assert_eq!(p("pmstatus:libc6:amd64:0.0000:Preparing libc6:amd64"), Progress { pct: 25, step: "Preparing libc6:amd64".into() });
        assert_eq!(p("pmstatus:dpkg-exec:100.0000:Running dpkg").pct, 100);
        assert_eq!(apt_progress("Get:1 http://deb.debian.org 1/2"), None);
    }

    #[test]
    fn dnf_counters_fill_the_bar_in_order() {
        let p = |l: &str| dnf_progress(l).map(|p| p.pct);
        assert_eq!(p("(1/2): curl-8.5.0.x86_64.rpm   1.2 MB/s | 300 kB  00:00"), Some(12));
        assert_eq!(p("  Upgrading        : curl-8.5.0.x86_64    2/4"), Some(62));
        assert_eq!(p("[4/4] Upgrading curl-8.5.0.x86_64"), Some(100));
        assert_eq!(p("Total download size: 12 MB/s"), None);
        assert_eq!(p("9/4"), None);
    }

    #[test]
    fn only_a_newer_installed_kernel_asks_for_a_restart() {
        let kernels = |l: &[&str]| l.iter().map(|k| k.to_string()).collect::<Vec<_>>();
        assert!(newer_kernel("6.8.12-4-pve", &kernels(&["6.8.12-4-pve", "6.8.12-10-pve"])));
        assert!(newer_kernel("5.14.0-427.13.1.el9_4.x86_64", &kernels(&["5.14.0-427.13.1.el9_4.x86_64", "5.14.0-503.11.1.el9_5.x86_64"])));
        assert!(!newer_kernel("6.1.0-25-amd64", &kernels(&["6.1.0-21-amd64", "6.1.0-25-amd64"])));
        assert!(!newer_kernel("6.8.12-4-pve", &kernels(&[])), "a container has no kernel of its own");
        assert!(!newer_kernel("6.8.12-4-pve", &kernels(&["5.15.0-91-generic", "6.9.0-1-generic"])), "a container with a stray kernel package");
    }

    #[test]
    fn dnf_output_stops_at_obsoletes() {
        let out = "\nkernel.x86_64  6.8.9-300.fc40  updates\nopenssl-libs.x86_64 1:3.2.2-3 baseos-security\nObsoleting Packages\nold.x86_64 1 updates\n";
        let u = parse_dnf(out);
        assert_eq!(u.len(), 2);
        assert_eq!(u[1].name, "openssl-libs");
        assert!(u[1].security);
    }
}

//! apt / dnf update detection and application.

use nyx_proto::PackageUpdate;
use std::process::Command;

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

/// Returns (command, args) for a non-interactive system upgrade.
pub fn upgrade_command() -> Option<(&'static str, &'static [&'static str])> {
    if has("apt-get") {
        Some(("apt-get", &["-y", "-o", "Dpkg::Options::=--force-confold", "upgrade"]))
    } else if has("dnf") {
        Some(("dnf", &["-y", "upgrade"]))
    } else {
        None
    }
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
    fn dnf_output_stops_at_obsoletes() {
        let out = "\nkernel.x86_64  6.8.9-300.fc40  updates\nopenssl-libs.x86_64 1:3.2.2-3 baseos-security\nObsoleting Packages\nold.x86_64 1 updates\n";
        let u = parse_dnf(out);
        assert_eq!(u.len(), 2);
        assert_eq!(u[1].name, "openssl-libs");
        assert!(u[1].security);
    }
}

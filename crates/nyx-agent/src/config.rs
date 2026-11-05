//! `KEY=VALUE` config file, overridable by `NYX_*` environment variables so the
//! same binary works from systemd, Ansible and Docker.

use anyhow::{bail, Context};
use nyx_proto::HostKind;
use std::{fs, os::unix::fs::OpenOptionsExt};

pub const DEFAULT_PATH: &str = "/etc/nyx/agent.conf";

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub path: String,
    pub url: String,
    pub token: String,
    pub key: String,
    pub kind: HostKind,
    pub ct_autoinstall: bool,
}

impl Config {
    pub fn load(path: String) -> anyhow::Result<Self> {
        let file = fs::read_to_string(&path).unwrap_or_default();
        Self::parse(path, &file, |k| std::env::var(k).ok())
    }

    fn parse(path: String, file: &str, env: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let get = |k: &str| {
            env(k).or_else(|| file.lines().filter_map(|l| l.trim().split_once('=')).find(|(n, _)| *n == k).map(|(_, v)| v.to_string()))
        };
        let need = |k: &str| get(k).filter(|v| !v.is_empty()).with_context(|| format!("{k} missing in {path} and environment"));
        let cfg = Self {
            url: need("NYX_URL")?.trim_end_matches('/').to_string(),
            token: need("NYX_TOKEN")?,
            key: need("NYX_KEY")?,
            kind: parse_kind(&get("NYX_KIND").unwrap_or_else(|| "vm".into()))?,
            ct_autoinstall: get("NYX_CT_AUTOINSTALL").is_some_and(|v| v == "1" || v == "true"),
            path: path.clone(),
        };
        Ok(cfg)
    }

    pub fn from_flags(path: String, flag: &impl Fn(&str) -> Option<String>, ct_autoinstall: bool) -> anyhow::Result<Self> {
        let need = |n: &str| flag(n).with_context(|| format!("{n} is required"));
        Ok(Self {
            url: need("--url")?.trim_end_matches('/').to_string(),
            token: need("--token")?,
            key: need("--key")?,
            kind: parse_kind(&need("--kind")?)?,
            ct_autoinstall,
            path,
        })
    }

    /// Written 0600 and replaced atomically: the file holds the agent key.
    pub fn save(&self) -> anyhow::Result<()> {
        let tmp = format!("{}.tmp", self.path);
        if let Some(dir) = std::path::Path::new(&self.path).parent() {
            fs::create_dir_all(dir)?;
        }
        let body = format!(
            "NYX_URL={}\nNYX_TOKEN={}\nNYX_KEY={}\nNYX_KIND={}\nNYX_CT_AUTOINSTALL={}\n",
            self.url, self.token, self.key, self.kind.as_str(), self.ct_autoinstall as u8
        );
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        std::io::Write::write_all(&mut f, body.as_bytes())?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

fn parse_kind(s: &str) -> anyhow::Result<HostKind> {
    match HostKind::parse(s) {
        Some(k) => Ok(k),
        None => bail!("unknown deployment type {s:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_values_and_env_override() {
        let file = "NYX_URL=https://m.lan/\nNYX_TOKEN=t\nNYX_KEY=a=b\nNYX_KIND=physical\n";
        let c = Config::parse("p".into(), file, |_| None).unwrap();
        assert_eq!((c.url.as_str(), c.key.as_str(), c.kind), ("https://m.lan", "a=b", HostKind::Physical));
        let c = Config::parse("p".into(), file, |k| (k == "NYX_KIND").then(|| "vps".to_string())).unwrap();
        assert_eq!(c.kind, HostKind::Vps);
    }

    #[test]
    fn rejects_missing_values_and_bad_kind() {
        assert!(Config::parse("p".into(), "NYX_URL=x\n", |_| None).is_err());
        assert!(Config::parse("p".into(), "NYX_URL=x\nNYX_TOKEN=t\nNYX_KEY=k\nNYX_KIND=nas", |_| None).is_err());
    }

    #[test]
    fn save_round_trips_with_private_mode() {
        let dir = std::env::temp_dir().join(format!("nyx-agent-test-{}", std::process::id()));
        let path = dir.join("agent.conf").to_string_lossy().to_string();
        let c = Config { path: path.clone(), url: "u".into(), token: "t".into(), key: "k".into(), kind: HostKind::Proxmox, ct_autoinstall: true };
        c.save().unwrap();
        assert_eq!(Config::parse(path.clone(), &fs::read_to_string(&path).unwrap(), |_| None).unwrap(), c);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        fs::remove_dir_all(dir).unwrap();
    }
}

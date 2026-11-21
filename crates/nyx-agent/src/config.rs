//! `KEY=VALUE` config file, overridable by `NYX_*` environment variables so the
//! same binary works from systemd, Ansible and Docker.

use anyhow::{bail, Context};
use nyx_proto::HostKind;
use std::{
    fs,
    net::{IpAddr, SocketAddr},
    os::unix::fs::OpenOptionsExt,
};

pub const DEFAULT_PATH: &str = "/etc/nyx/agent.conf";

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub path: String,
    pub url: String,
    pub token: String,
    pub key: String,
    pub kind: HostKind,
    pub ct_autoinstall: bool,
    /// Servers that resolve the monitor's name; empty means the system's.
    pub dns: Vec<IpAddr>,
    /// Where to serve Prometheus metrics, off when unset.
    pub metrics_listen: Option<SocketAddr>,
    /// Bearer token asked of scrapers. Required off loopback.
    pub metrics_token: String,
    /// Seals every call for a monitor behind the Cloudflare relay; empty when direct.
    pub relay_key: String,
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
            dns: parse_dns(&get("NYX_DNS").unwrap_or_default())?,
            metrics_listen: get("NYX_METRICS_LISTEN").filter(|v| !v.is_empty()).map(|v| v.parse().with_context(|| format!("NYX_METRICS_LISTEN {v:?} is not an address:port"))).transpose()?,
            metrics_token: get("NYX_METRICS_TOKEN").unwrap_or_default(),
            relay_key: get("NYX_RELAY_KEY").unwrap_or_default(),
            path: path.clone(),
        };
        check_relay_key(&cfg.relay_key)?;
        if cfg.metrics_listen.is_some_and(|a| !a.ip().is_loopback()) && cfg.metrics_token.len() < 16 {
            bail!("NYX_METRICS_TOKEN of 16 characters or more is required when NYX_METRICS_LISTEN is not a loopback address");
        }
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
            dns: parse_dns(&flag("--dns").unwrap_or_default())?,
            metrics_listen: None,
            metrics_token: String::new(),
            relay_key: check_relay_key(&flag("--relay-key").unwrap_or_default())?,
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
            "NYX_URL={}\nNYX_TOKEN={}\nNYX_KEY={}\nNYX_KIND={}\nNYX_CT_AUTOINSTALL={}\nNYX_DNS={}\n",
            self.url, self.token, self.key, self.kind.as_str(), self.ct_autoinstall as u8,
            self.dns.iter().map(IpAddr::to_string).collect::<Vec<_>>().join(",")
        );
        // Only when set, so a file without them stays as the user wrote it.
        let body = if self.relay_key.is_empty() { body } else { format!("{body}NYX_RELAY_KEY={}\n", self.relay_key) };
        let body = match self.metrics_listen {
            Some(a) => format!("{body}NYX_METRICS_LISTEN={a}\nNYX_METRICS_TOKEN={}\n", self.metrics_token),
            None => body,
        };
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        std::io::Write::write_all(&mut f, body.as_bytes())?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

fn check_relay_key(k: &str) -> anyhow::Result<String> {
    if !k.is_empty() && nyx_proto::relay::Key::parse(k).is_none() {
        bail!("the relay key must be 64 hexadecimal characters");
    }
    Ok(k.to_string())
}

fn parse_kind(s: &str) -> anyhow::Result<HostKind> {
    match HostKind::parse(s) {
        Some(k) => Ok(k),
        None => bail!("unknown deployment type {s:?}"),
    }
}

/// `1.1.1.1,1.0.0.1`, commas or spaces.
pub fn parse_dns(s: &str) -> anyhow::Result<Vec<IpAddr>> {
    s.split([',', ' ']).filter(|v| !v.is_empty()).map(|v| v.parse().with_context(|| format!("{v:?} is not an IP address"))).collect()
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
        assert!(c.dns.is_empty());
        let c = Config::parse("p".into(), &format!("{file}NYX_DNS=1.1.1.1, 2606:4700:4700::1111\n"), |_| None).unwrap();
        assert_eq!(c.dns, vec!["1.1.1.1".parse::<IpAddr>().unwrap(), "2606:4700:4700::1111".parse().unwrap()]);
        assert!(Config::parse("p".into(), &format!("{file}NYX_DNS=cloudflare\n"), |_| None).is_err());
        assert_eq!(c.metrics_listen, None);
        let local = Config::parse("p".into(), &format!("{file}NYX_METRICS_LISTEN=127.0.0.1:9101\n"), |_| None).unwrap();
        assert_eq!(local.metrics_listen, Some("127.0.0.1:9101".parse().unwrap()));
        assert!(Config::parse("p".into(), &format!("{file}NYX_METRICS_LISTEN=0.0.0.0:9101\n"), |_| None).is_err(), "open without a token");
        assert!(Config::parse("p".into(), &format!("{file}NYX_METRICS_LISTEN=0.0.0.0:9101\nNYX_METRICS_TOKEN=0123456789abcdef\n"), |_| None).is_ok());
        assert!(Config::parse("p".into(), &format!("{file}NYX_METRICS_LISTEN=9101\n"), |_| None).is_err());
        assert!(Config::parse("p".into(), &format!("{file}NYX_RELAY_KEY=abc\n"), |_| None).is_err(), "malformed relay key");
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
        let c = Config { path: path.clone(), url: "u".into(), token: "t".into(), key: "k".into(), kind: HostKind::Proxmox, ct_autoinstall: true, dns: parse_dns("9.9.9.9,1.1.1.1").unwrap(), metrics_listen: Some("[::]:9101".parse().unwrap()), metrics_token: "0123456789abcdef".into(), relay_key: "ab".repeat(32) };
        c.save().unwrap();
        assert_eq!(Config::parse(path.clone(), &fs::read_to_string(&path).unwrap(), |_| None).unwrap(), c);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        fs::remove_dir_all(dir).unwrap();
    }
}

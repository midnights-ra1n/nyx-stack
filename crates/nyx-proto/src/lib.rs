//! Wire protocol between `nyx-agent` and `nyx-monitor`.
//!
//! The agent pushes a [`Report`] over HTTP(S) and receives a [`Reply`] carrying
//! any queued [`Command`]s. The agent never opens a listening port. Optional
//! fields are `None` when the agent has nothing new, which keeps reports small.

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// How the agent is deployed. Can be changed live with [`Action::SetKind`].
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum HostKind {
    #[default]
    Vm,
    Physical,
    Proxmox,
    Vps,
}

impl HostKind {
    /// SMART is mandatory on bare metal and meaningless inside a VM.
    pub fn has_physical_disks(self) -> bool {
        matches!(self, Self::Physical | Self::Proxmox)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vm => "vm",
            Self::Physical => "physical",
            Self::Proxmox => "proxmox",
            Self::Vps => "vps",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "vm" => Self::Vm,
            "physical" => Self::Physical,
            "proxmox" => Self::Proxmox,
            "vps" => Self::Vps,
            _ => return None,
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Report {
    pub agent_version: String,
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub ip: String,
    pub kind: HostKind,
    pub ct_autoinstall: bool,
    pub uptime_s: u64,
    pub cpu_pct: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    pub net_rx_bps: u64,
    pub net_tx_bps: u64,
    pub disks: Vec<Disk>,
    pub temp_c: Option<f32>,
    pub containers: Option<Vec<Container>>,
    pub smart: Option<Vec<SmartDisk>>,
    pub updates: Option<Vec<PackageUpdate>>,
    pub node: Option<NodeInfo>,
    pub guests: Option<Vec<Guest>>,
    pub logs: Vec<String>,
    pub results: Vec<CommandResult>,
    /// The system update running now. Absent from older agents.
    pub progress: Option<Progress>,
    /// A restart is needed to run what is installed. False from older agents.
    #[serde(default)]
    pub reboot_required: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Progress {
    pub pct: u8,
    pub step: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Disk {
    pub mount: String,
    pub used: u64,
    pub total: u64,
    /// File system type, such as ext4. Empty from older agents.
    #[serde(default)]
    pub fs: String,
    /// Backing device, such as /dev/sda1. Empty from older agents.
    #[serde(default)]
    pub device: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Container {
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    #[default]
    Ok,
    Warn,
    Crit,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct SmartDisk {
    pub device: String,
    pub model: String,
    pub health: Health,
    /// Remaining endurance in percent, when the drive exposes it.
    pub life_left_pct: Option<u8>,
    pub temp_c: Option<i32>,
    pub power_on_hours: Option<u64>,
    pub reason: String,
    /// `NVMe`, `SSD` or `HDD`. This field and the ones below are absent from older agents.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub serial: String,
    #[serde(default)]
    pub capacity: Option<u64>,
    #[serde(default)]
    pub bad_sectors: u64,
    #[serde(default)]
    pub power_cycles: Option<u64>,
    /// Lifetime writes, when the drive counts them.
    #[serde(default)]
    pub written_bytes: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PackageUpdate {
    pub name: String,
    pub version: String,
    pub security: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct NodeInfo {
    pub version: String,
    pub apps: Vec<NodeApp>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct NodeApp {
    pub name: String,
    pub path: String,
    pub pid: u32,
}

/// A Proxmox guest seen by an agent of kind `proxmox`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Guest {
    pub vmid: u32,
    pub name: String,
    /// `lxc` or `qemu`.
    pub kind: String,
    pub status: String,
    pub node: String,
    /// Container started from an OCI image without an init: no agent can run in it.
    #[serde(default)]
    pub oci: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Reply {
    /// Seconds until the next report.
    pub interval_s: u64,
    /// The monitor lost its state (restart): resend all change-only data.
    pub resync: bool,
    pub commands: Vec<Command>,
    /// Someone is watching this host: send logs to `/agent/v1/logs` until told to stop.
    #[serde(default)]
    pub live_logs: bool,
}

/// Body of `/agent/v1/logs`. Same line format as [`Report::logs`].
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct LiveLogs {
    pub lines: Vec<String>,
}

/// Answer of `/agent/v1/logs`: `false` once nobody is watching any more.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct LiveReply {
    pub live: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Command {
    pub id: String,
    pub action: Action,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    /// Change the deployment type without reinstalling.
    SetKind { kind: HostKind, ct_autoinstall: bool },
    /// Refresh the package index and report available updates.
    CheckUpdates,
    UpdateSystem,
    /// Replace the agent binary with the one served by the monitor.
    UpdateAgent,
    /// Install the agent inside a running Proxmox container.
    InstallInCt { vmid: u32, token: String, key: String },
    /// Clone or pull a Node.js site, build it and restart its service.
    Deploy(Deploy),
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Deploy {
    pub site: String,
    pub repo: String,
    pub branch: String,
    pub path: String,
    pub user: String,
    pub install_cmd: String,
    pub build_cmd: String,
    pub start_cmd: String,
    pub ssh_private_key: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CommandResult {
    pub id: String,
    pub ok: bool,
    /// Tail of the command output.
    pub output: String,
}

type HmacSha256 = Hmac<Sha256>;

fn mac(key: &str, ts: u64, payload: &[u8]) -> HmacSha256 {
    let mut m = HmacSha256::new_from_slice(key.as_bytes()).expect("HMAC accepts any key length");
    m.update(ts.to_string().as_bytes());
    m.update(b"\n");
    m.update(payload);
    m
}

/// Lowercase hex HMAC-SHA256 of `"{ts}\n{payload}"`. The key itself never travels.
pub fn sign(key: &str, ts: u64, payload: &[u8]) -> String {
    hex(&mac(key, ts, payload).finalize().into_bytes())
}

/// Constant-time verification of a [`sign`] signature.
pub fn verify(key: &str, ts: u64, payload: &[u8], sig: &str) -> bool {
    match unhex(sig) {
        Some(bytes) => mac(key, ts, payload).verify_slice(&bytes).is_ok(),
        None => false,
    }
}

/// Plain HMAC check over `body`, the scheme Git forges use for webhooks.
pub fn verify_webhook(secret: &str, body: &[u8], sig_hex: &str) -> bool {
    let mut m = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    m.update(body);
    unhex(sig_hex).is_some_and(|b| m.verify_slice(&b).is_ok())
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.is_ascii() {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_round_trip_rejects_tampering() {
        let sig = sign("k", 42, b"body");
        assert!(verify("k", 42, b"body", &sig));
        assert!(!verify("k", 43, b"body", &sig));
        assert!(!verify("k", 42, b"bodz", &sig));
        assert!(!verify("other", 42, b"body", &sig));
        assert!(!verify("k", 42, b"body", "zz"));
        assert!(!verify("k", 42, b"body", "é"));
    }

    #[test]
    fn webhook_signature_matches_the_github_scheme() {
        // Known answer computed with `openssl dgst -sha256 -hmac secret`.
        let sig = "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b";
        assert!(verify_webhook("secret", b"hello", sig));
        assert!(!verify_webhook("secret", b"hello!", sig));
    }

    #[test]
    fn kind_round_trips() {
        for k in [HostKind::Vm, HostKind::Physical, HostKind::Proxmox, HostKind::Vps] {
            assert_eq!(HostKind::parse(k.as_str()), Some(k));
        }
        assert!(HostKind::Proxmox.has_physical_disks() && !HostKind::Vps.has_physical_disks());
    }
}

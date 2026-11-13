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
    Lxc,
}

impl HostKind {
    /// SMART is mandatory on bare metal and meaningless inside a VM or a container.
    pub fn has_physical_disks(self) -> bool {
        matches!(self, Self::Physical | Self::Proxmox)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vm => "vm",
            Self::Physical => "physical",
            Self::Proxmox => "proxmox",
            Self::Vps => "vps",
            Self::Lxc => "lxc",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "vm" => Self::Vm,
            "physical" => Self::Physical,
            "proxmox" => Self::Proxmox,
            "vps" => Self::Vps,
            "lxc" => Self::Lxc,
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
    /// Tunnels of this host. Empty from older agents.
    #[serde(default)]
    pub vpn: Vec<VpnLink>,
    /// Sent when it changed. Absent from older agents.
    #[serde(default)]
    pub firewall: Option<Firewall>,
}

/// The firewall of a host, as its own tool sees it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Firewall {
    /// `ufw`, `firewalld`, `nftables` or `iptables`. Empty: none found.
    pub backend: String,
    /// Filtering incoming traffic. ufw and firewalld can be installed and off.
    pub active: bool,
    /// Fate of incoming traffic no rule matches: `accept`, `drop` or `reject`.
    pub default_in: String,
    /// Incoming rules, in the order they apply.
    pub rules: Vec<FwRule>,
    /// Ports open to the network, to compare with the rules. Loopback is left out.
    pub listening: Vec<Listener>,
    /// The ruleset as `nft` prints it, as Nyx does not edit nftables.
    #[serde(default)]
    pub raw: String,
    /// Docker's `DOCKER-USER` chain exists: published ports bypass the host rules.
    #[serde(default)]
    pub docker: bool,
    /// What reloads the rules at boot: `ufw`, `firewalld`, `netfilter-persistent` or
    /// `iptables-services`. Empty: only the chains Nyx keeps come back.
    #[serde(default)]
    pub saved_by: String,
    /// The live iptables rules differ from the file loaded at boot.
    #[serde(default)]
    pub unsaved: bool,
    /// Package that would save iptables rules, when none does yet.
    #[serde(default)]
    pub installable: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct FwRule {
    /// `allow`, `deny`, `reject`, `limit`, or the target of anything else.
    pub action: String,
    /// `tcp`, `udp`, or empty for any.
    #[serde(default)]
    pub proto: String,
    /// `22`, `80,443`, `8000:8100`, a firewalld service name, or empty for any.
    #[serde(default)]
    pub port: String,
    /// Address or network, empty for anywhere.
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub iface: String,
    /// `4` or `6` when the rule only covers one of them.
    #[serde(default)]
    pub family: String,
    #[serde(default)]
    pub comment: String,
    /// iptables chain holding it. `DOCKER-USER` filters ports published by Docker.
    #[serde(default)]
    pub chain: String,
    /// The rule as its tool prints it, which is how it is found again to remove it.
    #[serde(default)]
    pub raw: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Listener {
    pub proto: String,
    pub port: u16,
    /// Addresses it listens on, `*` for all.
    pub addr: String,
    /// Program, or the container publishing the port.
    pub process: String,
    /// Published by Docker: only `DOCKER-USER` rules apply to it.
    #[serde(default)]
    pub docker: bool,
}

/// Add or remove one incoming rule.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FirewallChange {
    /// `add` or `delete` a rule, `save` the iptables rules for the next boot, or `persist`:
    /// install what saves them, then save.
    pub op: String,
    pub rule: FwRule,
}

impl FirewallChange {
    /// What an added rule may hold. Everything ends up as arguments of a root command.
    pub fn check(&self) -> Result<(), &'static str> {
        let r = &self.rule;
        match self.op.as_str() {
            "delete" => return if r.raw.is_empty() || r.raw.contains(['\n', '\0']) { Err("rule not found") } else { Ok(()) },
            "save" | "persist" => return Ok(()),
            "add" => {}
            _ => return Err("unknown operation"),
        }
        if !r.iface.is_empty() || !r.raw.is_empty() || !matches!(r.chain.as_str(), "" | "DOCKER-USER") {
            return Err("a new rule takes an action, a protocol, a port and a source, for the host or for Docker");
        }
        if !matches!(r.action.as_str(), "allow" | "deny" | "reject") {
            return Err("action must be allow, deny or reject");
        }
        if !matches!(r.proto.as_str(), "" | "tcp" | "udp") {
            return Err("protocol must be tcp or udp");
        }
        if !r.port.is_empty() && !port_ok(&r.port) {
            return Err("port must be a number from 1 to 65535, or a range such as 8000:8100");
        }
        if r.port.contains(':') && r.proto.is_empty() {
            return Err("a port range needs a protocol");
        }
        if r.port.is_empty() && r.source.is_empty() {
            return Err("give a port, a source or both");
        }
        if !r.source.is_empty() && !net_ok(&r.source) {
            return Err("source must be an IP address or a network such as 192.168.1.0/24");
        }
        if !r.comment.chars().all(|c| c.is_ascii_alphanumeric() || " -_.".contains(c)) || r.comment.len() > 64 {
            return Err("comment: letters, digits, spaces, - _ and . only");
        }
        Ok(())
    }
}

fn port_ok(p: &str) -> bool {
    let n = |s: &str| s.parse::<u16>().is_ok_and(|n| n > 0) && !s.starts_with('0');
    match p.split_once(':') {
        Some((a, b)) => n(a) && n(b) && a.parse::<u16>().ok() < b.parse::<u16>().ok(),
        None => n(p),
    }
}

fn net_ok(s: &str) -> bool {
    let (ip, prefix) = s.split_once('/').unwrap_or((s, ""));
    match ip.parse::<std::net::IpAddr>() {
        Ok(a) => prefix.is_empty() || prefix.parse::<u8>().is_ok_and(|p| p <= if a.is_ipv4() { 32 } else { 128 }),
        Err(_) => false,
    }
}

/// A VPN interface. Its address stays out of `ip`: it only means something inside the VPN.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct VpnLink {
    pub iface: String,
    /// `Tailscale`, `NetBird`, `WireGuard`, `OpenVPN`, `ZeroTier`, `IPsec` or `Mesh VPN`.
    pub kind: String,
    pub ip: String,
    /// The interface exists and holds an address.
    pub up: bool,
    pub rx_bps: u64,
    pub tx_bps: u64,
    /// Set by the monitor: when the tunnel was last up.
    #[serde(default)]
    pub seen: i64,
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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Container {
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    /// Short ID. The figures below are absent from older agents, and for stopped containers.
    #[serde(default)]
    pub id: String,
    /// Share of one core, so that 200 means two cores. Average since the previous report.
    #[serde(default)]
    pub cpu_pct: f32,
    #[serde(default)]
    pub mem_used: u64,
    /// Memory limit of the container, or the host's memory when it has none.
    #[serde(default)]
    pub mem_limit: u64,
}

/// Names Docker accepts for a container.
pub fn container_name_ok(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && name.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
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
    /// Version of the runtime of this app. The fields below are absent from older agents.
    #[serde(default)]
    pub version: String,
    /// Origin of its Git clone, without credentials.
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub user: String,
    /// `systemd`, `pm2` or `docker`. Empty when it was started by hand.
    #[serde(default)]
    pub manager: String,
    /// What restarts it: a systemd unit, or `pm2:<name>`.
    #[serde(default)]
    pub service: String,
    #[serde(default)]
    pub install_cmd: String,
    #[serde(default)]
    pub build_cmd: String,
    #[serde(default)]
    pub start_cmd: String,
    /// What the app's processes use, summed. CPU is the average since the previous scan.
    #[serde(default)]
    pub cpu_pct: f32,
    #[serde(default)]
    pub mem_bytes: u64,
    #[serde(default)]
    pub uptime_s: u64,
}

/// A Proxmox guest seen by an agent of kind `proxmox`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
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
    /// Figures Proxmox keeps for the guest, so that none of this needs an agent inside.
    /// Absent from older agents.
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub ip: String,
    #[serde(default)]
    pub uptime_s: u64,
    #[serde(default)]
    pub cpu_pct: f32,
    #[serde(default)]
    pub mem_used: u64,
    #[serde(default)]
    pub mem_total: u64,
    #[serde(default)]
    pub disk_used: u64,
    #[serde(default)]
    pub disk_total: u64,
    #[serde(default)]
    pub rx_bps: u64,
    #[serde(default)]
    pub tx_bps: u64,
    /// Bytes since the guest started, which the two rates above come from.
    #[serde(skip)]
    pub net_in: u64,
    #[serde(skip)]
    pub net_out: u64,
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
    /// Clone or pull a Node.js site, build it and restart its service.
    Deploy(Deploy),
    /// Undone by the agent when it cannot reach the monitor afterwards.
    Firewall(FirewallChange),
    /// Proxmox host only: install the agent inside one of its containers with `pct`, so that
    /// the container reports for itself. The container reaches the monitor at the host's address.
    InstallInCt { vmid: u32, token: String, key: String },
    /// Restart, stop, start a Node.js site's service, or read its recent logs.
    Site(SiteControl),
    /// `start`, `stop`, `restart` or `logs` of a Docker container.
    Container { op: String, name: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SiteControl {
    /// `restart`, `stop`, `start` or `logs`.
    pub op: String,
    /// A systemd unit or `pm2:<name>`.
    pub service: String,
    pub user: String,
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
    /// The service already running this site, see [`NodeApp::service`]. Empty: Nyx creates its own.
    #[serde(default)]
    pub service: String,
    /// Seconds of HTTP cache forced on the site's answers, `0` to always revalidate. `None`: the app's own.
    #[serde(default)]
    pub cache_max_age: Option<u32>,
    /// `KEY=value` lines for the site's service. Empty: none.
    #[serde(default)]
    pub env: String,
    /// Deploy this commit instead of the head of the branch (a rollback). Empty: the head.
    #[serde(default)]
    pub commit: String,
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

/// True for 100.64.0.0/10 (RFC 6598), where Tailscale and NetBird take their addresses.
/// Nothing outside the mesh can reach them, so they never describe where a host is.
pub fn is_vpn_ip(ip: &str) -> bool {
    ip.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.octets()[0] == 100 && ip.octets()[1] & 0xc0 == 64)
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
    fn firewall_changes_only_take_plain_values() {
        let add = |action: &str, proto: &str, port: &str, source: &str| FirewallChange {
            op: "add".into(),
            rule: FwRule { action: action.into(), proto: proto.into(), port: port.into(), source: source.into(), ..FwRule::default() },
        }.check();
        assert!(add("allow", "tcp", "22", "").is_ok() && add("deny", "", "", "10.0.0.0/8").is_ok() && add("reject", "udp", "8000:8100", "fd00::1").is_ok());
        assert!(add("accept", "tcp", "22", "").is_err() && add("allow", "icmp", "22", "").is_err());
        assert!(add("allow", "tcp", "0", "").is_err() && add("allow", "tcp", "65536", "").is_err() && add("allow", "tcp", "9:8", "").is_err());
        assert!(add("allow", "", "8000:8100", "").is_err(), "ranges need a protocol");
        assert!(add("allow", "", "", "").is_err() && add("allow", "tcp", "22", "1.2.3.4/33").is_err() && add("allow", "tcp", "22", "-j ACCEPT").is_err());
        let del = |raw: &str| FirewallChange { op: "delete".into(), rule: FwRule { raw: raw.into(), ..FwRule::default() } }.check();
        assert!(del("-A INPUT -j ACCEPT").is_ok() && del("").is_err() && del("a\nb").is_err());
        let docker = |chain: &str| FirewallChange { op: "add".into(), rule: FwRule { action: "deny".into(), port: "8080".into(), chain: chain.into(), ..FwRule::default() } }.check();
        assert!(docker("DOCKER-USER").is_ok() && docker("FORWARD").is_err());
    }

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
    fn mesh_addresses_are_the_whole_shared_range() {
        assert!(is_vpn_ip("100.64.0.1") && is_vpn_ip("100.101.102.103") && is_vpn_ip("100.127.255.254"));
        assert!(!is_vpn_ip("100.63.0.1") && !is_vpn_ip("100.128.0.1") && !is_vpn_ip("192.168.1.1") && !is_vpn_ip("") && !is_vpn_ip("fd7a::1"));
    }

    #[test]
    fn kind_round_trips() {
        for k in [HostKind::Vm, HostKind::Physical, HostKind::Proxmox, HostKind::Vps, HostKind::Lxc] {
            assert_eq!(HostKind::parse(k.as_str()), Some(k));
        }
        assert!(HostKind::Proxmox.has_physical_disks() && !HostKind::Vps.has_physical_disks() && !HostKind::Lxc.has_physical_disks());
    }
}

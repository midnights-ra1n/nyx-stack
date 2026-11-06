//! Gathers host metrics. Slow-changing data is read on its own schedule and sent
//! only when it changed, which keeps both CPU use and reports small.

use crate::{config::Config, packages, proxmox, smart};
use nyx_proto::*;
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};
use sysinfo::{Components, Disks, Networks, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

const SLOW: Duration = Duration::from_secs(60);
const RARE: Duration = Duration::from_secs(300);
const SMART: Duration = Duration::from_secs(1800);
const MAX_LOG_BACKLOG: usize = 200;
const MAX_LOG_LINE: usize = 500;
const JOURNAL_CURSOR: &str = "/run/nyx-agent/journal.cursor";
const LIVE_CURSOR: &str = "/run/nyx-agent/live.cursor";

/// Runs at most once per period; `reset` makes it due on the next check.
struct Every(Duration, Option<Instant>);

impl Every {
    fn due(&mut self) -> bool {
        let due = self.1.is_none_or(|t| t.elapsed() >= self.0);
        if due {
            self.1 = Some(Instant::now());
        }
        due
    }
    fn reset(&mut self) {
        self.1 = None;
    }
}

pub struct Collector {
    sys: System,
    nets: Networks,
    disks: Disks,
    temps: Components,
    last_net: Instant,
    pub pending_results: Vec<CommandResult>,
    pub progress: Option<Progress>,
    pending_logs: Vec<String>,
    slow: Every,
    rare: Every,
    smart_every: Every,
    containers: Option<Vec<Container>>,
    /// Slow data sent only when it changed; `None` means "must be re-sent".
    updates: Option<Vec<PackageUpdate>>,
    updates_dirty: bool,
    node: Option<NodeInfo>,
    guests: Option<Vec<Guest>>,
    smart: Option<Vec<SmartDisk>>,
}

impl Collector {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            sys: System::new()?,
            nets: Networks::new_with_refreshed_list()?,
            disks: Disks::new_with_refreshed_list()?,
            temps: Components::new_with_refreshed_list()?,
            last_net: Instant::now(),
            pending_results: vec![],
            progress: None,
            pending_logs: vec![],
            slow: Every(SLOW, None),
            rare: Every(RARE, None),
            smart_every: Every(SMART, None),
            containers: None,
            updates: None,
            updates_dirty: false,
            node: None,
            guests: None,
            smart: None,
        })
    }

    pub fn set_updates(&mut self, updates: Vec<PackageUpdate>) {
        self.updates = Some(updates);
        self.updates_dirty = true;
    }

    /// Forget what the monitor has seen: everything goes out on the next report.
    pub fn resync(&mut self) {
        self.containers = None;
        self.node = None;
        self.guests = None;
        self.smart = None;
        self.updates_dirty = self.updates.is_some();
        self.slow.reset();
        self.rare.reset();
        self.smart_every.reset();
    }

    /// The report never reached the monitor: keep logs and results, resend the rest.
    pub fn restore(&mut self, failed: Report) {
        let mut logs = failed.logs;
        logs.append(&mut self.pending_logs);
        let excess = logs.len().saturating_sub(MAX_LOG_BACKLOG);
        logs.drain(..excess);
        self.pending_logs = logs;
        self.pending_results.splice(0..0, failed.results);
        if failed.containers.is_some() || failed.node.is_some() || failed.guests.is_some() || failed.smart.is_some() || failed.updates.is_some() {
            self.resync();
        }
    }

    pub fn report(&mut self, cfg: &Config) -> Report {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.nets.refresh(true);
        self.disks.refresh(true);
        self.temps.refresh(true);

        let secs = self.last_net.elapsed().as_secs_f64().max(1.0);
        self.last_net = Instant::now();
        let real = || self.nets.iter().filter(|(n, _)| is_physical_nic(&n.to_string_lossy()));
        let rx: u64 = real().map(|(_, d)| d.received()).sum();
        let tx: u64 = real().map(|(_, d)| d.transmitted()).sum();

        let mut r = Report {
            agent_version: env!("CARGO_PKG_VERSION").into(),
            hostname: System::host_name().unwrap_or_default(),
            os: System::long_os_version().unwrap_or_default(),
            kernel: System::kernel_version().unwrap_or_default(),
            arch: std::env::consts::ARCH.into(),
            ip: primary_ip(&self.nets),
            kind: cfg.kind,
            ct_autoinstall: cfg.ct_autoinstall,
            uptime_s: System::uptime().unwrap_or(0),
            cpu_pct: self.sys.global_cpu_usage(),
            mem_used: self.sys.used_memory(),
            mem_total: self.sys.total_memory(),
            swap_used: self.sys.used_swap(),
            swap_total: self.sys.total_swap(),
            net_rx_bps: (rx as f64 / secs) as u64,
            net_tx_bps: (tx as f64 / secs) as u64,
            disks: real_disks(&self.disks),
            temp_c: self.temps.iter().filter_map(|c| c.temperature()).filter(|t| t.is_finite() && *t > 0.0).reduce(f32::max),
            logs: std::mem::take(&mut self.pending_logs),
            results: std::mem::take(&mut self.pending_results),
            progress: self.progress.clone(),
            ..Report::default()
        };
        r.reboot_required = packages::reboot_required(&r.kernel);

        if self.slow.due() {
            r.containers = changed(&mut self.containers, docker_containers());
            r.logs.extend(journal("warning", "100", JOURNAL_CURSOR));
        }
        if self.rare.due() {
            let node = self.node_info();
            r.node = changed(&mut self.node, node);
            if cfg.kind == HostKind::Proxmox {
                r.guests = changed(&mut self.guests, proxmox::guests(&r.hostname));
            }
        }
        if cfg.kind.has_physical_disks() && self.smart_every.due() {
            r.smart = changed(&mut self.smart, smart::scan());
        }
        if self.updates_dirty {
            self.updates_dirty = false;
            r.updates = self.updates.clone();
        }
        r
    }

    fn node_info(&mut self) -> Option<NodeInfo> {
        let out = Command::new("node").arg("--version").output().ok().filter(|o| o.status.success())?;
        let kind = ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always);
        self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
        let mut apps: Vec<NodeApp> = self
            .sys
            .processes()
            .iter()
            .filter(|(_, p)| p.thread_kind().is_none() && p.name() == "node")
            .filter_map(|(pid, p)| {
                let path = p.cwd()?.to_string_lossy().to_string();
                Some(NodeApp { name: package_name(Path::new(&path))?, path, pid: pid.as_u32() })
            })
            .collect();
        apps.sort_by(|a, b| (&a.name, a.pid).cmp(&(&b.name, b.pid)));
        apps.dedup_by(|a, b| a.path == b.path);
        // Keep PIDs out of change detection: a restart is not a new app.
        apps.iter_mut().for_each(|a| a.pid = 0);
        Some(NodeInfo { version: String::from_utf8_lossy(&out.stdout).trim().to_string(), apps })
    }
}

/// `Some(new)` when it differs from the last value sent.
fn changed<T: Clone + PartialEq>(last: &mut Option<T>, new: Option<T>) -> Option<T> {
    match new {
        Some(v) if last.as_ref() != Some(&v) => {
            *last = Some(v.clone());
            Some(v)
        }
        _ => None,
    }
}

fn is_physical_nic(name: &str) -> bool {
    !["lo", "docker", "veth", "br-", "virbr", "tap", "fwbr", "fwpr", "fwln", "utun", "awdl", "llw", "bridge", "anpi", "gif", "stf"]
        .iter()
        .any(|p| name.starts_with(p))
}

fn primary_ip(nets: &Networks) -> String {
    nets.iter()
        .filter(|(n, _)| is_physical_nic(&n.to_string_lossy()))
        .flat_map(|(_, d)| d.ip_networks())
        .map(|ip| ip.addr)
        .find(|ip| ip.is_ipv4() && !ip.is_loopback() && !ip.is_unspecified())
        .map_or(String::new(), |ip| ip.to_string())
}

fn real_disks(disks: &Disks) -> Vec<Disk> {
    let mut seen = std::collections::HashSet::new();
    disks
        .iter()
        .filter(|d| {
            let fs = d.file_system().to_string_lossy();
            d.total_space() > 0
                && !["tmpfs", "overlay", "squashfs", "devtmpfs", "ramfs", "nsfs"].contains(&fs.as_ref())
                && seen.insert(d.name().to_owned()) // bind mounts repeat a device
        })
        .map(|d| Disk {
            mount: d.mount_point().to_string_lossy().into(),
            used: d.total_space() - d.available_space(),
            total: d.total_space(),
            fs: d.file_system().to_string_lossy().into(),
            device: d.name().to_string_lossy().into(),
        })
        .collect()
}

fn package_name(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(json["name"].as_str().map_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().to_string(), str::to_string))
}

fn docker_containers() -> Option<Vec<Container>> {
    let mut s = UnixStream::connect("/var/run/docker.sock").ok()?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    // HTTP/1.0 so the daemon closes the connection and never answers chunked.
    s.write_all(b"GET /containers/json?all=1 HTTP/1.0\r\n\r\n").ok()?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).ok()?;
    parse_containers(buf.split_once("\r\n\r\n")?.1)
}

fn parse_containers(body: &str) -> Option<Vec<Container>> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let text = |v: &serde_json::Value| v.as_str().unwrap_or_default().to_string();
    let mut out: Vec<Container> = json
        .as_array()?
        .iter()
        .map(|c| Container {
            name: c["Names"][0].as_str().unwrap_or_default().trim_start_matches('/').to_string(),
            image: text(&c["Image"]),
            state: text(&c["State"]),
            status: text(&c["Status"]),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Some(out)
}

/// Everything from info up since the last call, for someone watching this host.
pub fn live_lines() -> Vec<String> {
    journal("info", "200", LIVE_CURSOR)
}

/// The next live view starts from the latest lines, not from where this one stopped.
pub fn forget_live_logs() {
    let _ = std::fs::remove_file(LIVE_CURSOR);
}

/// New journal entries since the last call. The cursor sits in tmpfs, so the agent
/// adds no disk writes of its own.
// shortcut: journald only, add a syslog file tailer if non-systemd hosts matter.
fn journal(priority: &str, limit: &str, cursor: &str) -> Vec<String> {
    let cursor = format!("--cursor-file={cursor}");
    let fields = "--output-fields=PRIORITY,MESSAGE,SYSLOG_IDENTIFIER,_SYSTEMD_UNIT";
    let args = ["-p", priority, "-o", "json", fields, "-q", "--no-pager", "-n", limit, cursor.as_str()];
    let Ok(out) = Command::new("journalctl").args(args).output() else { return vec![] };
    out.stdout.split(|&b| b == b'\n').filter_map(log_line).collect()
}

/// One journal entry as `<epoch seconds> <<priority>> <service>: <message>`, on one line.
fn log_line(entry: &[u8]) -> Option<String> {
    let e: serde_json::Value = serde_json::from_slice(entry).ok()?;
    let secs = e["__REALTIME_TIMESTAMP"].as_str()?.parse::<u64>().ok()? / 1_000_000;
    let message = match &e["MESSAGE"] {
        serde_json::Value::String(s) => s.clone(),
        // journald stores a message that is not valid UTF-8 as an array of bytes.
        serde_json::Value::Array(bytes) => String::from_utf8_lossy(&bytes.iter().filter_map(|b| b.as_u64()).map(|b| b as u8).collect::<Vec<_>>()).into_owned(),
        _ => return None,
    };
    let service = e["SYSLOG_IDENTIFIER"].as_str().or(e["_SYSTEMD_UNIT"].as_str().map(|u| u.trim_end_matches(".service"))).unwrap_or("system");
    let priority = e["PRIORITY"].as_str().unwrap_or("4");
    let line = format!("{secs} <{priority}> {service}: {}", message.split_whitespace().collect::<Vec<_>>().join(" "));
    Some(line.chars().take(MAX_LOG_LINE).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_entries_become_one_short_line() {
        let entry = br#"{"__REALTIME_TIMESTAMP":"1793000000123456","PRIORITY":"3","SYSLOG_IDENTIFIER":"sshd","MESSAGE":"bad  key\n  from 10.0.0.2"}"#;
        assert_eq!(log_line(entry).unwrap(), "1793000000 <3> sshd: bad key from 10.0.0.2");
        let bytes = br#"{"__REALTIME_TIMESTAMP":"1793000000000000","_SYSTEMD_UNIT":"nginx.service","MESSAGE":[104,105,255]}"#;
        assert_eq!(log_line(bytes).unwrap(), "1793000000 <4> nginx: hi\u{fffd}");
        let long = format!(r#"{{"__REALTIME_TIMESTAMP":"1000000","MESSAGE":"{}"}}"#, "x".repeat(900));
        assert_eq!(log_line(long.as_bytes()).unwrap().chars().count(), MAX_LOG_LINE);
        assert!(log_line(b"").is_none());
        assert!(log_line(br#"{"__REALTIME_TIMESTAMP":"1000000","MESSAGE":null}"#).is_none());
    }

    #[test]
    fn containers_parse_sorted_and_trimmed() {
        let body = r#"[{"Names":["/web"],"Image":"nginx","State":"running","Status":"Up 2 hours"},
                       {"Names":["/db"],"Image":"pg","State":"exited","Status":"Exited (0)"}]"#;
        let c = parse_containers(body).unwrap();
        assert_eq!((c[0].name.as_str(), c[0].state.as_str()), ("db", "exited"));
        assert_eq!(c[1].image, "nginx");
        assert!(parse_containers("nope").is_none());
    }

    #[test]
    fn change_detection_only_reports_differences() {
        let mut last = None;
        assert_eq!(changed(&mut last, Some(1)), Some(1));
        assert_eq!(changed(&mut last, Some(1)), None);
        assert_eq!(changed(&mut last, None), None);
        assert_eq!(changed(&mut last, Some(2)), Some(2));
    }

    #[test]
    fn nic_filter_skips_virtual_interfaces() {
        assert!(is_physical_nic("eth0") && is_physical_nic("enp3s0") && is_physical_nic("vmbr0"));
        assert!(!is_physical_nic("veth12ab") && !is_physical_nic("docker0") && !is_physical_nic("lo"));
    }

    #[test]
    fn failed_report_keeps_logs_within_the_cap() {
        let mut c = Collector::new().unwrap();
        c.pending_logs = vec!["new".into()];
        c.restore(Report { logs: vec!["old".into(); MAX_LOG_BACKLOG], ..Report::default() });
        assert_eq!(c.pending_logs.len(), MAX_LOG_BACKLOG);
        assert_eq!(c.pending_logs.last().unwrap(), "new");
    }
}

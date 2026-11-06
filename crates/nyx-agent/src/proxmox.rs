//! Proxmox guests, read from `pvesh`. The host already measures its guests, so this
//! gives their figures without an agent inside them.

use nyx_proto::Guest;
use std::process::Command;

/// Guests on this node only: in a cluster, each node's agent reports its own and
/// `pct exec` can only reach local containers.
pub fn guests(hostname: &str) -> Option<Vec<Guest>> {
    let out = Command::new("pvesh").args(["get", "/cluster/resources", "--type", "vm", "--output-format", "json"]).output().ok()?;
    let conf = |vmid| std::fs::read_to_string(format!("/etc/pve/lxc/{vmid}.conf")).unwrap_or_default();
    // A node is named after the short host name, whatever `/etc/hostname` holds.
    let node = hostname.split('.').next().unwrap_or(hostname);
    let mut guests = parse(&String::from_utf8_lossy(&out.stdout), node, conf)?;
    for g in guests.iter_mut().filter(|g| g.kind == "lxc" && g.status == "running" && g.ip.is_empty()) {
        g.ip = dhcp_ip(g.vmid);
    }
    Some(guests)
}

/// The configuration only knows a static address.
fn dhcp_ip(vmid: u32) -> String {
    let out = Command::new("lxc-info").args(["-n", &vmid.to_string(), "-iH"]).output();
    out.map_or(String::new(), |o| String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or_default().trim().to_string())
}

/// Turns the byte counters of two readings `secs` apart into rates. A guest that
/// restarted counts from zero again, and shows no traffic for one reading.
pub fn rates(guests: &mut [Guest], before: &[Guest], secs: f64) {
    for g in guests {
        if let Some(b) = before.iter().find(|b| b.vmid == g.vmid) {
            g.rx_bps = (g.net_in.saturating_sub(b.net_in) as f64 / secs) as u64;
            g.tx_bps = (g.net_out.saturating_sub(b.net_out) as f64 / secs) as u64;
        }
    }
}

/// The settings of a container, without those of its snapshots, which follow in `[sections]`.
fn settings(conf: &str) -> impl Iterator<Item = &str> {
    conf.lines().take_while(|l| !l.starts_with('['))
}

fn static_ip(conf: &str) -> String {
    let net = settings(conf).filter(|l| l.starts_with("net")).flat_map(|l| l.split(','));
    net.filter_map(|p| p.strip_prefix("ip=")?.split('/').next()).find(|ip| ip.parse::<std::net::IpAddr>().is_ok()).unwrap_or_default().to_string()
}

/// Proxmox writes `entrypoint` when an OCI image starts anything but `/sbin/init`,
/// so the container has no systemd for the agent.
fn no_init(conf: &str) -> bool {
    settings(conf).filter_map(|l| l.strip_prefix("entrypoint:")).any(|e| e.trim() != "/sbin/init" && !e.contains("systemd"))
}

fn parse(json: &str, hostname: &str, conf: impl Fn(u64) -> String) -> Option<Vec<Guest>> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let mut out: Vec<Guest> = v
        .as_array()?
        .iter()
        .filter(|g| g["node"] == hostname)
        .filter_map(|g| {
            let vmid = g["vmid"].as_u64()?;
            let kind = g["type"].as_str()?;
            let conf = if kind == "lxc" { conf(vmid) } else { String::new() };
            let count = |k: &str| g[k].as_u64().unwrap_or(0);
            let os = settings(&conf).find_map(|l| l.strip_prefix("ostype:")).unwrap_or_default().trim().to_string();
            Some(Guest {
                vmid: vmid as u32,
                name: g["name"].as_str().unwrap_or_default().into(),
                kind: kind.into(),
                oci: no_init(&conf),
                status: g["status"].as_str().unwrap_or_default().into(),
                node: hostname.into(),
                os,
                ip: static_ip(&conf),
                uptime_s: count("uptime"),
                // Proxmox gives a share of the cores the guest may use.
                cpu_pct: g["cpu"].as_f64().unwrap_or(0.0) as f32 * 100.0,
                mem_used: count("mem"),
                mem_total: count("maxmem"),
                disk_used: count("disk"),
                disk_total: count("maxdisk"),
                net_in: count("netin"),
                net_out: count("netout"),
                ..Guest::default()
            })
        })
        .collect();
    out.sort_by_key(|g| g.vmid);
    Some(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn keeps_local_guests_only() {
        let json = r#"[{"vmid":101,"name":"web","type":"lxc","status":"running","node":"pve1"},
                       {"vmid":100,"name":"db","type":"qemu","status":"stopped","node":"pve1"},
                       {"vmid":200,"name":"other","type":"lxc","status":"running","node":"pve2"}]"#;
        let g = super::parse(json, "pve1", |_| String::new()).unwrap();
        assert_eq!(g.iter().map(|g| g.vmid).collect::<Vec<_>>(), [100, 101]);
        assert_eq!(g[1].kind, "lxc");
    }

    #[test]
    fn reads_what_the_host_measures_for_a_container() {
        let json = r#"[{"vmid":101,"name":"web","type":"lxc","status":"running","node":"pve1","uptime":90,"cpu":0.25,
            "mem":512,"maxmem":1024,"disk":10,"maxdisk":100,"netin":1000,"netout":2000}]"#;
        let conf = "ostype: debian\nnet0: name=eth0,bridge=vmbr0,ip=192.168.1.20/24,gw=192.168.1.1,type=veth\n[snap]\nostype: alpine\n";
        let g = &super::parse(json, "pve1", |_| conf.into()).unwrap()[0];
        assert_eq!((g.os.as_str(), g.ip.as_str(), g.uptime_s, g.cpu_pct), ("debian", "192.168.1.20", 90, 25.0));
        assert_eq!((g.mem_used, g.mem_total, g.disk_used, g.disk_total), (512, 1024, 10, 100));
    }

    #[test]
    fn a_dhcp_address_is_not_in_the_configuration() {
        assert_eq!(super::static_ip("net0: name=eth0,ip=dhcp,ip6=auto\n"), "");
        assert_eq!(super::static_ip("hostname: ct\n"), "");
    }

    #[test]
    fn traffic_is_the_difference_between_two_readings() {
        let reading = |net_in, net_out| vec![nyx_proto::Guest { vmid: 101, net_in, net_out, ..Default::default() }];
        let mut now = reading(4000, 2000);
        super::rates(&mut now, &reading(1000, 3000), 30.0);
        assert_eq!((now[0].rx_bps, now[0].tx_bps), (100, 0), "a restart must not show as a burst");
        let mut first = reading(4000, 2000);
        super::rates(&mut first, &[], 30.0);
        assert_eq!(first[0].rx_bps, 0);
    }

    #[test]
    fn spots_oci_containers_without_an_init() {
        let json = r#"[{"vmid":101,"type":"lxc","node":"pve1"},{"vmid":102,"type":"lxc","node":"pve1"},{"vmid":100,"type":"qemu","node":"pve1"}]"#;
        let g = super::parse(json, "pve1", |id| if id == 101 { String::new() } else { "entrypoint: nginx -g daemon\\ off;\ncmode: console\n".into() }).unwrap();
        assert_eq!(g.iter().map(|g| g.oci).collect::<Vec<_>>(), [false, false, true]);
    }

    #[test]
    fn an_init_or_a_snapshot_is_not_an_oci_app() {
        assert!(!super::no_init("hostname: ct\n"));
        assert!(!super::no_init("entrypoint: /sbin/init\n"));
        assert!(!super::no_init("entrypoint: /lib/systemd/systemd\n"));
        assert!(!super::no_init("hostname: ct\n[before]\nentrypoint: nginx\n"));
    }
}

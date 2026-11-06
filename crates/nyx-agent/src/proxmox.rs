//! Proxmox guests, read from `pvesh`, used to list guests and reach containers.

use nyx_proto::Guest;
use std::process::Command;

/// Guests on this node only: in a cluster, each node's agent reports its own and
/// `pct exec` can only reach local containers.
pub fn guests(hostname: &str) -> Option<Vec<Guest>> {
    let out = Command::new("pvesh").args(["get", "/cluster/resources", "--type", "vm", "--output-format", "json"]).output().ok()?;
    let conf = |vmid| std::fs::read_to_string(format!("/etc/pve/lxc/{vmid}.conf")).unwrap_or_default();
    parse(&String::from_utf8_lossy(&out.stdout), hostname, conf)
}

/// Proxmox writes `entrypoint` when an OCI image starts anything but `/sbin/init`,
/// so the container has no systemd for the agent. Snapshots follow in `[sections]`.
fn no_init(conf: &str) -> bool {
    conf.lines()
        .take_while(|l| !l.starts_with('['))
        .filter_map(|l| l.strip_prefix("entrypoint:"))
        .any(|e| e.trim() != "/sbin/init" && !e.contains("systemd"))
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
            Some(Guest {
                vmid: vmid as u32,
                name: g["name"].as_str().unwrap_or_default().into(),
                kind: kind.into(),
                oci: kind == "lxc" && no_init(&conf(vmid)),
                status: g["status"].as_str().unwrap_or_default().into(),
                node: hostname.into(),
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

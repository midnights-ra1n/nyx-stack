//! Proxmox guests, read from `pvesh`, used to list guests and reach containers.

use nyx_proto::Guest;
use std::process::Command;

/// Guests on this node only: in a cluster, each node's agent reports its own and
/// `pct exec` can only reach local containers.
pub fn guests(hostname: &str) -> Option<Vec<Guest>> {
    let out = Command::new("pvesh").args(["get", "/cluster/resources", "--type", "vm", "--output-format", "json"]).output().ok()?;
    parse(&String::from_utf8_lossy(&out.stdout), hostname)
}

fn parse(json: &str, hostname: &str) -> Option<Vec<Guest>> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let mut out: Vec<Guest> = v
        .as_array()?
        .iter()
        .filter(|g| g["node"] == hostname)
        .filter_map(|g| {
            Some(Guest {
                vmid: g["vmid"].as_u64()? as u32,
                name: g["name"].as_str().unwrap_or_default().into(),
                kind: g["type"].as_str()?.into(),
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
        let g = super::parse(json, "pve1").unwrap();
        assert_eq!(g.iter().map(|g| g.vmid).collect::<Vec<_>>(), [100, 101]);
        assert_eq!(g[1].kind, "lxc");
    }
}

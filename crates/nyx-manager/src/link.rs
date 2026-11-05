//! Optional link to nyx-monitor: discovered hosts feed the inventory and IPAM.

use crate::App;
use anyhow::Context;
use nyx_proto::Deploy;
use nyx_srv::pb_quote;
use serde_json::{json, Value};

pub async fn config(app: &App) -> anyhow::Result<Option<(String, String)>> {
    let Some(cfg) = app.core.pb.setting("link").await? else { return Ok(None) };
    let (url, token) = (cfg["url"].as_str().unwrap_or_default(), cfg["token"].as_str().unwrap_or_default());
    Ok((!url.is_empty() && !token.is_empty()).then(|| (url.trim_end_matches('/').to_string(), token.to_string())))
}

pub async fn hosts(app: &App) -> anyhow::Result<Option<Vec<Value>>> {
    let Some((url, token)) = config(app).await? else { return Ok(None) };
    let res = app.http.get(format!("{url}/api/link/hosts")).bearer_auth(token).send().await?.error_for_status()?;
    Ok(Some(res.json().await?))
}

pub async fn deploy(app: &App, host: &str, d: &Deploy) -> anyhow::Result<String> {
    let (url, token) = config(app).await?.context("no monitor linked: set it in Settings")?;
    let res: Value = app.http.post(format!("{url}/api/link/hosts/{host}/deploy")).bearer_auth(token).json(d).send().await?.error_for_status()?.json().await?;
    Ok(res["id"].as_str().context("no command id")?.to_string())
}

/// `None` while the agent has not answered yet.
pub async fn result(app: &App, id: &str) -> anyhow::Result<Option<Value>> {
    let (url, token) = config(app).await?.context("no monitor linked")?;
    let res = app.http.get(format!("{url}/api/link/results/{id}")).bearer_auth(token).send().await?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    Ok(Some(res.error_for_status()?.json().await?))
}

/// Desired inventory rows `(external_id, fields)` for one monitor host.
fn assets_of(h: &Value) -> Vec<(String, Value)> {
    let id = h["id"].as_str().unwrap_or_default();
    let name = h["name"].as_str().unwrap_or_default();
    let mut out = vec![];
    if h["kind"] == "vm" || h["kind"] == "vps" {
        let kind = if h["vmid"].as_u64().unwrap_or(0) > 0 { "container" } else { h["kind"].as_str().unwrap_or("vm") };
        out.push((id.to_string(), json!({"name": name, "type": kind, "hostname": h["hostname"], "ip": h["ip"], "status": h["status"], "vmid": h["vmid"], "pve_node": h["pve_node"]})));
    }
    for g in h["guests"].as_array().into_iter().flatten() {
        let t = if g["kind"] == "lxc" { "container" } else { "vm" };
        out.push((format!("{id}/{}", g["vmid"]), json!({"name": g["name"], "type": t, "status": g["status"], "vmid": g["vmid"], "pve_node": g["node"], "parent": name})));
    }
    for c in h["containers"].as_array().into_iter().flatten() {
        out.push((format!("{id}/docker/{}", c["name"].as_str().unwrap_or_default()), json!({"name": c["name"], "type": "docker", "status": c["state"], "parent": name})));
    }
    out
}

/// Inventory rows of the whole fleet. A Proxmox guest that runs an agent is listed by
/// its node and as a host of its own: keep the host row, it knows more.
fn inventory(hosts: &[Value]) -> Vec<(String, Value)> {
    let mut rows: Vec<(String, Value)> = hosts.iter().flat_map(assets_of).collect();
    let monitored = |g: &Value| hosts.iter().any(|h| h["name"] == g["name"] || (h["vmid"].as_u64().unwrap_or(0) > 0 && h["vmid"] == g["vmid"] && h["pve_node"] == g["pve_node"]));
    rows.retain(|(_, f)| f.get("parent").is_none() || f["type"] == "docker" || !monitored(f));
    rows
}

fn differs(row: &Value, wanted: &Value) -> bool {
    wanted.as_object().is_some_and(|o| o.iter().any(|(k, v)| row[k] != *v && !(v.is_null() && row[k].as_str().is_some_and(str::is_empty))))
}

/// Mirror monitor hosts into `virtual_assets` and `ip_addresses`, writing only what
/// changed. Rows that left the monitor are removed; manual rows are left alone.
pub async fn sync(app: &App) -> anyhow::Result<()> {
    let Some(hosts) = hosts(app).await? else { return Ok(()) };
    let pb = &app.core.pb;
    let existing = pb.list("virtual_assets", "source = 'monitor'", "").await?;
    let wanted = inventory(&hosts);
    for (ext, fields) in &wanted {
        let mut body = fields.clone();
        body["source"] = "monitor".into();
        body["external_id"] = ext.as_str().into();
        match existing.iter().find(|r| r["external_id"] == ext.as_str()) {
            Some(row) if differs(row, &body) => { pb.update("virtual_assets", row["id"].as_str().unwrap_or_default(), &body).await?; }
            Some(_) => {}
            None => { pb.create("virtual_assets", &body).await?; }
        }
    }
    for row in existing.iter().filter(|r| !wanted.iter().any(|(e, _)| r["external_id"] == e.as_str())) {
        pb.delete("virtual_assets", row["id"].as_str().unwrap_or_default()).await?;
    }
    for h in &hosts {
        let (ip, name) = (h["ip"].as_str().unwrap_or_default(), h["name"].as_str().unwrap_or_default());
        if ip.is_empty() {
            continue;
        }
        let filter = format!("address = {} && device = {}", pb_quote(ip), pb_quote(name));
        if pb.first("ip_addresses", &filter).await?.is_none() {
            pb.create("ip_addresses", &json!({"address": ip, "device": name, "hostname": h["hostname"], "note": "From monitoring"})).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_expand_into_guests_and_containers() {
        let h = json!({"id": "h", "name": "pve", "kind": "proxmox", "guests": [{"vmid": 101, "name": "web", "kind": "lxc", "status": "running", "node": "pve"}],
            "containers": [{"name": "db", "state": "running"}]});
        let a = assets_of(&h);
        assert_eq!(a.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["h/101", "h/docker/db"]);
        assert_eq!(a[0].1["type"], "container");
        let vm = json!({"id": "v", "name": "vm1", "kind": "vm", "vmid": 0});
        assert_eq!(assets_of(&vm)[0].1["type"], "vm");
    }

    #[test]
    fn guests_with_an_agent_are_listed_once() {
        let hosts = [
            json!({"id": "n", "name": "pve", "kind": "proxmox", "guests": [
                {"vmid": 101, "name": "web", "kind": "qemu", "node": "pve"},
                {"vmid": 102, "name": "other-name", "kind": "lxc", "node": "pve"},
                {"vmid": 103, "name": "plain", "kind": "qemu", "node": "pve"}]}),
            json!({"id": "w", "name": "web", "kind": "vm", "vmid": 0}),
            json!({"id": "c", "name": "ct", "kind": "vm", "vmid": 102, "pve_node": "pve"}),
        ];
        let rows = inventory(&hosts);
        assert_eq!(rows.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["n/103", "w", "c"]);
    }

    #[test]
    fn unchanged_rows_are_not_rewritten() {
        let row = json!({"name": "a", "ip": "", "extra": 1});
        assert!(!differs(&row, &json!({"name": "a", "ip": null})));
        assert!(differs(&row, &json!({"name": "b"})));
    }
}

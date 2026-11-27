//! Network map: built from the inventory, and its exporters.

use serde_json::{json, Value};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}

fn xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn quoted(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

fn name_of<'a>(nodes: &'a [Value], id: &str) -> Option<&'a Value> {
    nodes.iter().find(|n| s(n, "id") == id)
}

/// Map devices for the inventory, as `(name, type, address, runs on)`. Docker services, passive
/// gear and devices on a shelf (spare or retired) stay off the map: they are on no network.
pub fn from_inventory(hardware: &[Value], virtual_assets: &[Value]) -> Vec<(String, &'static str, String, String)> {
    let kind = |c: &str| match c {
        "Server" => "server",
        "Switch" => "switch",
        "Router" => "router",
        "Firewall" => "firewall",
        "NAS" => "nas",
        "Access point" => "ap",
        _ => "other",
    };
    let wired = |h: &&Value| !["Patch panel", "PDU"].contains(&s(h, "category")) && !["Spare", "Retired"].contains(&s(h, "status"));
    let hw = hardware.iter().filter(wired).map(|h| (s(h, "name").to_string(), kind(s(h, "category")), s(h, "mgmt_ip").to_string(), String::new()));
    let guests = virtual_assets.iter().filter(|a| s(a, "type") != "docker").map(|a| {
        (s(a, "name").to_string(), if s(a, "type") == "container" { "lxc" } else { "vm" }, s(a, "ip").to_string(), s(a, "parent").to_string())
    });
    hw.chain(guests).filter(|d| !d.0.is_empty()).collect()
}

/// VPN links are kept on their own page, and join the map through the device names.
pub fn with_vpn(nodes: &[Value], links: &[Value], vpn: &[Value]) -> Vec<Value> {
    let id_of = |name: &str| nodes.iter().find(|n| !name.is_empty() && s(n, "name") == name).map(|n| n["id"].clone());
    let drawn = vpn.iter().filter_map(|v| {
        let (a, b) = (id_of(s(v, "side_a"))?, id_of(s(v, "side_b"))?);
        Some(json!({"id": v["id"], "source": a, "target": b, "label": s(v, "name"), "kind": "vpn"}))
    });
    links.iter().cloned().chain(drawn).collect()
}

/// Cables between network ports of the hardware inventory, drawn when both devices are on the map under the same name.
/// One line per pair of devices, even with several cables, unless a hand-drawn link already joins them.
pub fn with_cables(nodes: &[Value], links: Vec<Value>, ports: &[Value], hardware: &[Value]) -> Vec<Value> {
    let node_of = |device: &str| {
        let name = s(hardware.iter().find(|h| s(h, "id") == device)?, "name");
        nodes.iter().find(|n| !name.is_empty() && s(n, "name") == name).map(|n| s(n, "id").to_string())
    };
    let mut out = links;
    for p in ports {
        let Some(q) = ports.iter().find(|q| !s(p, "peer").is_empty() && s(q, "id") == s(p, "peer")) else { continue };
        let (Some(a), Some(b)) = (node_of(s(p, "device")), node_of(s(q, "device"))) else { continue };
        let joined = |l: &Value| (s(l, "source"), s(l, "target")) == (&a, &b) || (s(l, "source"), s(l, "target")) == (&b, &a);
        if a != b && !out.iter().any(joined) {
            out.push(json!({"id": p["id"], "source": a, "target": b, "label": format!("{} – {}", s(p, "name"), s(q, "name")), "kind": "cable"}));
        }
    }
    out
}

fn is_vpn(l: &Value) -> bool {
    l["kind"] == "vpn"
}

const W: f64 = 140.0;
const H: f64 = 56.0;

/// The colours zones can take on the map, as the exports draw them.
fn zone_color(z: &Value) -> &'static str {
    match s(z, "color") {
        "green" => "#4cc38a",
        "yellow" => "#e5b94e",
        "red" => "#e5534b",
        "orange" => "#f08a4b",
        "grey" => "#8b98a8",
        _ => "#5b9bf0",
    }
}

fn zone_box(z: &Value) -> (f64, f64, f64, f64) {
    let n = |k: &str| z[k].as_f64().unwrap_or(0.0);
    (n("x"), n("y"), n("w").max(40.0), n("h").max(40.0))
}

pub fn svg(nodes: &[Value], links: &[Value], zones: &[Value]) -> String {
    let xy = |n: &Value| (n["x"].as_f64().unwrap_or(0.0), n["y"].as_f64().unwrap_or(0.0));
    let ends = zones.iter().map(|z| { let (x, y, w, h) = zone_box(z); (x + w - W, y + h - H) });
    let right = nodes.iter().map(xy).chain(ends.clone()).map(|p| p.0).fold(0.0, f64::max) + W + 40.0;
    let bottom = nodes.iter().map(xy).chain(ends).map(|p| p.1).fold(0.0, f64::max) + H + 40.0;
    let mut out = format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="{right}" height="{bottom}" viewBox="0 0 {right} {bottom}" font-family="Ubuntu, sans-serif"><rect width="100%" height="100%" fill="#141a22"/>"##);
    for z in zones {
        let ((x, y, w, h), c) = (zone_box(z), zone_color(z));
        out += &format!(r##"<rect x="{}" y="{}" width="{w}" height="{h}" rx="14" fill="{c}" fill-opacity="0.08" stroke="{c}" stroke-opacity="0.6" stroke-dasharray="6 4"/><text x="{}" y="{}" font-size="13" fill="{c}">{}</text>"##,
            x + 20.0, y + 20.0, x + 32.0, y + 40.0, xml(s(z, "name")));
    }
    for l in links {
        if let (Some(a), Some(b)) = (name_of(nodes, s(l, "source")), name_of(nodes, s(l, "target"))) {
            let ((ax, ay), (bx, by)) = (xy(a), xy(b));
            let (x1, y1, x2, y2) = (ax + W / 2.0 + 20.0, ay + H / 2.0 + 20.0, bx + W / 2.0 + 20.0, by + H / 2.0 + 20.0);
            let dash = if is_vpn(l) { r#" stroke-dasharray="6 4""# } else { "" };
            out += &format!(r##"<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#6e7d8f"{dash}/>"##);
            if !s(l, "label").is_empty() {
                out += &format!(r##"<text x="{}" y="{}" font-size="12" fill="#9aa6b5" text-anchor="middle">{}</text>"##, (x1 + x2) / 2.0, (y1 + y2) / 2.0 - 4.0, xml(s(l, "label")));
            }
        }
    }
    for n in nodes {
        let (x, y) = xy(n);
        let (x, y) = (x + 20.0, y + 20.0);
        out += &format!(r##"<rect x="{x}" y="{y}" width="{W}" height="{H}" rx="16" fill="#1b232d" stroke="#6e7d8f"/><text x="{}" y="{}" font-size="14" fill="#edf1f6" text-anchor="middle">{}</text><text x="{}" y="{}" font-size="12" fill="#bcc6d2" text-anchor="middle">{}</text>"##,
            x + W / 2.0, y + 24.0, xml(s(n, "name")), x + W / 2.0, y + 42.0, xml(s(n, "ip")));
    }
    out + "</svg>"
}

pub fn dot(nodes: &[Value], links: &[Value]) -> String {
    let mut out = String::from("graph network {\n  node [shape=box];\n");
    for n in nodes {
        out += &format!("  \"{}\" [label=\"{}\\n{}\"];\n", quoted(s(n, "id")), quoted(s(n, "name")), quoted(s(n, "ip")));
    }
    for l in links {
        let style = if is_vpn(l) { ", style=dashed" } else { "" };
        out += &format!("  \"{}\" -- \"{}\" [label=\"{}\"{style}];\n", quoted(s(l, "source")), quoted(s(l, "target")), quoted(s(l, "label")));
    }
    out + "}\n"
}

pub fn mermaid(nodes: &[Value], links: &[Value]) -> String {
    let safe = |t: &str| t.replace('"', "#quot;");
    let mut out = String::from("graph TD\n");
    for n in nodes {
        out += &format!("  n{}[\"{}<br/>{}\"]\n", s(n, "id"), safe(s(n, "name")), safe(s(n, "ip")));
    }
    for l in links {
        let label = s(l, "label");
        let line = if is_vpn(l) { "-.-" } else { "---" };
        let edge = if label.is_empty() { line.to_string() } else { format!("{line}|\"{}\"|", safe(label)) };
        out += &format!("  n{} {edge} n{}\n", s(l, "source"), s(l, "target"));
    }
    out
}

/// draw.io / diagrams.net uncompressed format.
pub fn drawio(nodes: &[Value], links: &[Value], zones: &[Value]) -> String {
    let mut out = String::from(r#"<mxfile><diagram name="Nyx network"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>"#);
    // Zones first, so that they sit behind the devices.
    for z in zones {
        let ((x, y, w, h), c) = (zone_box(z), zone_color(z));
        out += &format!(r#"<mxCell id="zone-{}" value="{}" style="rounded=1;dashed=1;fillColor={c};opacity=15;strokeColor={c};verticalAlign=top;align=left;spacingLeft=10;" vertex="1" parent="1"><mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>"#,
            xml(s(z, "id")), xml(s(z, "name")));
    }
    for n in nodes {
        let label = xml(&format!("{}\n{}", s(n, "name"), s(n, "ip"))).replace('\n', "&#10;");
        out += &format!(r#"<mxCell id="{}" value="{label}" style="rounded=1;whiteSpace=wrap;html=0;" vertex="1" parent="1"><mxGeometry x="{}" y="{}" width="{W}" height="{H}" as="geometry"/></mxCell>"#,
            xml(s(n, "id")), n["x"].as_f64().unwrap_or(0.0), n["y"].as_f64().unwrap_or(0.0));
    }
    for l in links {
        let style = if is_vpn(l) { "dashed=1;" } else { "" };
        out += &format!(r#"<mxCell id="{}" value="{}" style="{style}" edge="1" parent="1" source="{}" target="{}"><mxGeometry relative="1" as="geometry"/></mxCell>"#,
            xml(s(l, "id")), xml(s(l, "label")), xml(s(l, "source")), xml(s(l, "target")));
    }
    out + "</root></mxGraphModel></diagram></mxfile>"
}

/// `(body, content type, file extension)`.
pub fn export(format: &str, nodes: &[Value], links: &[Value], zones: &[Value]) -> Option<(String, &'static str, &'static str)> {
    Some(match format {
        "svg" => (svg(nodes, links, zones), "image/svg+xml", "svg"),
        "dot" => (dot(nodes, links), "text/vnd.graphviz", "dot"),
        "mermaid" => (mermaid(nodes, links), "text/plain; charset=utf-8", "mmd"),
        "drawio" => (drawio(nodes, links, zones), "application/xml", "drawio"),
        "json" => (json!({"nodes": nodes, "links": links, "zones": zones}).to_string(), "application/json", "json"),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> (Vec<Value>, Vec<Value>) {
        (
            vec![json!({"id": "a", "name": "r<1>", "ip": "10.0.0.1", "x": 0, "y": 0}), json!({"id": "b", "name": "sw \"core\"", "ip": "", "x": 200, "y": 100})],
            vec![json!({"id": "l", "source": "a", "target": "b", "label": "1 & 2"}), json!({"id": "m", "source": "a", "target": "gone", "label": ""})],
        )
    }

    #[test]
    fn the_inventory_becomes_devices_and_guests() {
        let hw = [
            json!({"name": "pve", "category": "Server", "mgmt_ip": "10.0.0.2", "status": "In service"}),
            json!({"name": "ups", "category": "UPS"}),
            json!({"name": ""}),
            json!({"name": "panel", "category": "Patch panel"}),
            json!({"name": "old", "category": "Server", "status": "Retired"}),
        ];
        let va = [json!({"name": "web", "type": "vm", "ip": "10.0.0.20", "parent": "pve"}), json!({"name": "dns", "type": "container", "parent": "pve"}), json!({"name": "redis", "type": "docker", "parent": "web"})];
        let d = from_inventory(&hw, &va);
        let got: Vec<_> = d.iter().map(|(n, k, ip, p)| (n.as_str(), *k, ip.as_str(), p.as_str())).collect();
        assert_eq!(got, [("pve", "server", "10.0.0.2", ""), ("ups", "other", "", ""), ("web", "vm", "10.0.0.20", "pve"), ("dns", "lxc", "", "pve")]);
    }

    #[test]
    fn zones_are_drawn_behind_the_devices() {
        let (n, l) = data();
        let z = [json!({"id": "z1", "name": "DMZ <edge>", "color": "red", "x": 0, "y": 0, "w": 400, "h": 300})];
        let s = svg(&n, &l, &z);
        assert!(s.contains("DMZ &lt;edge&gt;") && s.contains("#e5534b"));
        assert!(s.find("DMZ").unwrap() < s.find("<line").unwrap_or(usize::MAX));
        let d = drawio(&n, &l, &z);
        assert!(d.find("zone-z1").unwrap() < d.find(r#"<mxCell id="a""#).unwrap());
        assert!(export("json", &n, &l, &z).unwrap().0.contains("\"zones\""));
    }

    #[test]
    fn every_format_exports_and_unknown_is_refused() {
        let (n, l) = data();
        for f in ["svg", "dot", "mermaid", "drawio", "json"] {
            assert!(!export(f, &n, &l, &[]).unwrap().0.is_empty());
        }
        assert!(export("pdf", &n, &l, &[]).is_none());
    }

    #[test]
    fn labels_cannot_break_out_of_their_format() {
        let (n, l) = data();
        let s = svg(&n, &l, &[]);
        assert!(s.contains("r&lt;1&gt;") && s.contains("1 &amp; 2") && !s.contains("r<1>"));
        assert!(drawio(&n, &l, &[]).contains("sw &quot;core&quot;"));
        assert!(dot(&n, &l).contains(r#"sw \"core\""#));
        assert!(mermaid(&n, &l).contains("sw #quot;core#quot;"));
    }

    #[test]
    fn vpn_links_join_by_device_name_and_are_dashed() {
        let n = [json!({"id": "a", "name": "paris", "x": 0, "y": 0}), json!({"id": "b", "name": "lyon", "x": 200, "y": 0})];
        let vpn = [json!({"id": "v", "name": "tunnel", "side_a": "paris", "side_b": "lyon"}), json!({"id": "w", "name": "mesh", "side_a": "paris", "side_b": ""})];
        let l = with_vpn(&n, &[], &vpn);
        assert_eq!(l.len(), 1, "a tunnel with one known end cannot be drawn");
        assert_eq!((l[0]["source"].as_str(), l[0]["target"].as_str()), (Some("a"), Some("b")));
        assert!(svg(&n, &l, &[]).contains("stroke-dasharray") && dot(&n, &l).contains("style=dashed"));
        assert!(mermaid(&n, &l).contains("-.-|") && drawio(&n, &l, &[]).contains("dashed=1"));
    }

    #[test]
    fn cables_join_devices_once_and_skip_unmapped_ones() {
        let n = [json!({"id": "a", "name": "sw1"}), json!({"id": "b", "name": "pve"})];
        let hw = [json!({"id": "h1", "name": "sw1"}), json!({"id": "h2", "name": "pve"}), json!({"id": "h3", "name": "nas"})];
        let ports = [
            json!({"id": "p1", "device": "h1", "name": "1", "peer": "p2"}),
            json!({"id": "p2", "device": "h2", "name": "eno1", "peer": ""}),
            json!({"id": "p3", "device": "h1", "name": "2", "peer": "p4"}),
            json!({"id": "p4", "device": "h2", "name": "eno2", "peer": ""}),
            json!({"id": "p5", "device": "h1", "name": "3", "peer": "p6"}),
            json!({"id": "p6", "device": "h3", "name": "eth0", "peer": ""}),
        ];
        let l = with_cables(&n, vec![], &ports, &hw);
        assert_eq!(l.len(), 1, "two cables between the same devices make one line, nas is not on the map: {l:?}");
        assert_eq!((l[0]["source"].as_str(), l[0]["label"].as_str()), (Some("a"), Some("1 – eno1")));
        let drawn = [json!({"id": "x", "source": "b", "target": "a", "label": ""})];
        assert_eq!(with_cables(&n, drawn.to_vec(), &ports, &hw).len(), 1, "a hand-drawn link wins");
    }

    #[test]
    fn svg_skips_links_to_deleted_nodes() {
        let (n, l) = data();
        assert_eq!(svg(&n, &l, &[]).matches("<line").count(), 1);
    }
}

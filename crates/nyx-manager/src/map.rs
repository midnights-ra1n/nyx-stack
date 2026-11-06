//! Network map exporters.

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

const W: f64 = 140.0;
const H: f64 = 56.0;

pub fn svg(nodes: &[Value], links: &[Value]) -> String {
    let xy = |n: &Value| (n["x"].as_f64().unwrap_or(0.0), n["y"].as_f64().unwrap_or(0.0));
    let right = nodes.iter().map(|n| xy(n).0).fold(0.0, f64::max) + W + 40.0;
    let bottom = nodes.iter().map(|n| xy(n).1).fold(0.0, f64::max) + H + 40.0;
    let mut out = format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="{right}" height="{bottom}" viewBox="0 0 {right} {bottom}" font-family="Ubuntu, sans-serif"><rect width="100%" height="100%" fill="#141a22"/>"##);
    for l in links {
        if let (Some(a), Some(b)) = (name_of(nodes, s(l, "source")), name_of(nodes, s(l, "target"))) {
            let ((ax, ay), (bx, by)) = (xy(a), xy(b));
            let (x1, y1, x2, y2) = (ax + W / 2.0 + 20.0, ay + H / 2.0 + 20.0, bx + W / 2.0 + 20.0, by + H / 2.0 + 20.0);
            out += &format!(r##"<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#6e7d8f"/>"##);
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
        out += &format!("  \"{}\" -- \"{}\" [label=\"{}\"];\n", quoted(s(l, "source")), quoted(s(l, "target")), quoted(s(l, "label")));
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
        let edge = if label.is_empty() { "---".to_string() } else { format!("---|\"{}\"|", safe(label)) };
        out += &format!("  n{} {edge} n{}\n", s(l, "source"), s(l, "target"));
    }
    out
}

/// draw.io / diagrams.net uncompressed format.
pub fn drawio(nodes: &[Value], links: &[Value]) -> String {
    let mut out = String::from(r#"<mxfile><diagram name="Nyx network"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>"#);
    for n in nodes {
        let label = xml(&format!("{}\n{}", s(n, "name"), s(n, "ip"))).replace('\n', "&#10;");
        out += &format!(r#"<mxCell id="{}" value="{label}" style="rounded=1;whiteSpace=wrap;html=0;" vertex="1" parent="1"><mxGeometry x="{}" y="{}" width="{W}" height="{H}" as="geometry"/></mxCell>"#,
            xml(s(n, "id")), n["x"].as_f64().unwrap_or(0.0), n["y"].as_f64().unwrap_or(0.0));
    }
    for l in links {
        out += &format!(r#"<mxCell id="{}" value="{}" edge="1" parent="1" source="{}" target="{}"><mxGeometry relative="1" as="geometry"/></mxCell>"#,
            xml(s(l, "id")), xml(s(l, "label")), xml(s(l, "source")), xml(s(l, "target")));
    }
    out + "</root></mxGraphModel></diagram></mxfile>"
}

/// `(body, content type, file extension)`.
pub fn export(format: &str, nodes: &[Value], links: &[Value]) -> Option<(String, &'static str, &'static str)> {
    Some(match format {
        "svg" => (svg(nodes, links), "image/svg+xml", "svg"),
        "dot" => (dot(nodes, links), "text/vnd.graphviz", "dot"),
        "mermaid" => (mermaid(nodes, links), "text/plain; charset=utf-8", "mmd"),
        "drawio" => (drawio(nodes, links), "application/xml", "drawio"),
        "json" => (json!({"nodes": nodes, "links": links}).to_string(), "application/json", "json"),
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
    fn every_format_exports_and_unknown_is_refused() {
        let (n, l) = data();
        for f in ["svg", "dot", "mermaid", "drawio", "json"] {
            assert!(!export(f, &n, &l).unwrap().0.is_empty());
        }
        assert!(export("pdf", &n, &l).is_none());
    }

    #[test]
    fn labels_cannot_break_out_of_their_format() {
        let (n, l) = data();
        let s = svg(&n, &l);
        assert!(s.contains("r&lt;1&gt;") && s.contains("1 &amp; 2") && !s.contains("r<1>"));
        assert!(drawio(&n, &l).contains("sw &quot;core&quot;"));
        assert!(dot(&n, &l).contains(r#"sw \"core\""#));
        assert!(mermaid(&n, &l).contains("sw #quot;core#quot;"));
    }

    #[test]
    fn svg_skips_links_to_deleted_nodes() {
        let (n, l) = data();
        assert_eq!(svg(&n, &l).matches("<line").count(), 1);
    }
}

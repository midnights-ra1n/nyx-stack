//! Prometheus exposition of everything the monitor knows, for Grafana.
//!
//! Read from RAM only: a scrape costs one settings read and never writes to disk.
//! Prometheus (or Grafana Alloy, VictoriaMetrics...) scrapes `/metrics` with a
//! bearer token, and Grafana reads that.

use crate::state::{host_status, App, State as Fleet};
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{Local, Utc};
use nyx_proto::Health;
use nyx_srv::{auth::Session, random_hex, ApiResult};
use serde_json::{json, Value};
use std::{fmt::Write, sync::Arc};

const SETTING: &str = "metrics";

/// Metric families in the order they were first seen; Prometheus wants each one's samples together.
#[derive(Default)]
struct Out(Vec<(&'static str, &'static str, &'static str, String)>);

impl Out {
    fn put(&mut self, name: &'static str, kind: &'static str, help: &'static str, labels: &[(&str, &str)], value: f64) {
        if !value.is_finite() {
            return;
        }
        let i = self.0.iter().position(|f| f.0 == name).unwrap_or_else(|| {
            self.0.push((name, kind, help, String::new()));
            self.0.len() - 1
        });
        let body = &mut self.0[i].3;
        body.push_str(name);
        if !labels.is_empty() {
            body.push('{');
            for (j, (k, v)) in labels.iter().enumerate() {
                let v = v.replace('\\', r"\\").replace('"', "\\\"").replace('\n', r"\n");
                let _ = write!(body, "{}{k}=\"{v}\"", if j > 0 { "," } else { "" });
            }
            body.push('}');
        }
        let _ = writeln!(body, " {value}");
    }

    fn gauge(&mut self, name: &'static str, help: &'static str, labels: &[(&str, &str)], value: f64) {
        self.put(name, "gauge", help, labels, value);
    }

    fn render(self) -> String {
        let mut s = String::new();
        for (name, kind, help, body) in self.0 {
            let _ = write!(s, "# HELP {name} {help}\n# TYPE {name} {kind}\n{body}");
        }
        s
    }
}

/// Shared by every health-like gauge: -1 off or unknown, 0 ok, 1 warning or running, 2 critical.
fn code(level: &str) -> f64 {
    match level {
        "ok" => 0.0,
        "warn" | "info" => 1.0,
        "crit" => 2.0,
        _ => -1.0,
    }
}

fn with<'a>(base: &[(&'a str, &'a str)], extra: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
    base.iter().chain(extra).copied().collect()
}

fn b(v: bool) -> f64 {
    if v { 1.0 } else { 0.0 }
}

pub fn render(st: &Fleet, now: i64, monitor_uptime_s: u64) -> String {
    let mut o = Out::default();
    let th = &st.thresholds;
    o.gauge("nyx_monitor_uptime_seconds", "Seconds since this monitor started.", &[], monitor_uptime_s as f64);
    o.gauge("nyx_hosts", "Hosts known to the monitor.", &[], st.hosts.len() as f64);
    o.gauge("nyx_hosts_online", "Hosts that reported recently.", &[], st.hosts.values().filter(|h| h.online(now)).count() as f64);
    for (key, warn, crit) in [("percent", th.warn, th.crit), ("temperature", th.temp_warn, th.temp_crit)] {
        o.gauge("nyx_threshold_warning", "Warning threshold set in the monitor.", &[("metric", key)], warn as f64);
        o.gauge("nyx_threshold_critical", "Critical threshold set in the monitor.", &[("metric", key)], crit as f64);
    }

    for h in st.hosts.values() {
        let base = [("host", h.name.as_str()), ("host_id", h.id.as_str())];
        o.gauge("nyx_host_info", "Host details, always 1.", &with(&base, &[("kind", &h.kind), ("parent", &h.parent), ("hostname", &h.hostname), ("ip", &h.ip),
            ("os", &h.os), ("kernel", &h.kernel), ("arch", &h.arch), ("agent_version", &h.agent_version), ("pve_node", &h.pve_node)]), 1.0);
        o.gauge("nyx_host_up", "1 while the agent reports, 0 once it is silent.", &base, b(h.online(now)));
        o.gauge("nyx_host_status", "Worst state of the host: -1 offline, 0 ok, 1 warning, 2 critical.", &base, code(host_status(h, now, th)));
        o.gauge("nyx_host_muted", "1 when the host is kept out of alerts.", &base, b(h.muted));
        o.gauge("nyx_host_last_seen_timestamp_seconds", "Unix time of the last report.", &base, h.last_seen as f64);
        o.gauge("nyx_host_updating", "1 while a system or agent update runs.", &base, b(h.updating(now)));
        // Figures of an offline host are its last known ones, as in the web UI; filter with nyx_host_up.
        let Some(live) = &h.live else { continue };
        let r = &live.report;
        o.gauge("nyx_host_uptime_seconds", "Host uptime.", &base, r.uptime_s as f64);
        o.gauge("nyx_host_cpu_usage_percent", "CPU usage.", &base, r.cpu_pct as f64);
        o.gauge("nyx_host_memory_used_bytes", "Memory in use.", &base, r.mem_used as f64);
        o.gauge("nyx_host_memory_total_bytes", "Memory installed.", &base, r.mem_total as f64);
        o.gauge("nyx_host_swap_used_bytes", "Swap in use.", &base, r.swap_used as f64);
        o.gauge("nyx_host_swap_total_bytes", "Swap size.", &base, r.swap_total as f64);
        o.gauge("nyx_host_network_receive_bytes_per_second", "Inbound traffic.", &base, r.net_rx_bps as f64);
        o.gauge("nyx_host_network_transmit_bytes_per_second", "Outbound traffic.", &base, r.net_tx_bps as f64);
        if let Some(t) = r.temp_c {
            o.gauge("nyx_host_temperature_celsius", "Hottest host sensor.", &base, t as f64);
        }
        o.gauge("nyx_host_updates_pending", "System packages with an update.", &base, live.updates.len() as f64);
        o.gauge("nyx_host_security_updates_pending", "Pending updates that fix a security issue.", &base, live.updates.iter().filter(|u| u.security).count() as f64);
        o.gauge("nyx_host_reboot_required", "1 when the system asks for a restart.", &base, b(r.reboot_required));
        o.gauge("nyx_host_logs_buffered", "Log lines held in memory for the host.", &base, live.logs.len() as f64);
        for d in &r.disks {
            let dl = with(&base, &[("mount", &d.mount), ("fs", &d.fs), ("device", &d.device)]);
            o.gauge("nyx_disk_used_bytes", "Filesystem space in use.", &dl, d.used as f64);
            o.gauge("nyx_disk_total_bytes", "Filesystem size.", &dl, d.total as f64);
        }
        for d in &live.smart {
            let dl = with(&base, &[("device", &d.device), ("model", &d.model), ("serial", &d.serial), ("type", &d.kind)]);
            let health = match d.health { Health::Ok => "ok", Health::Warn => "warn", Health::Crit => "crit" };
            o.gauge("nyx_smart_health", "SMART verdict: 0 ok, 1 warning, 2 critical.", &dl, code(health));
            o.gauge("nyx_smart_bad_sectors", "Reallocated, pending and uncorrectable sectors.", &dl, d.bad_sectors as f64);
            let opt = [
                ("nyx_smart_life_left_percent", "Estimated life left.", d.life_left_pct.map(f64::from)),
                ("nyx_smart_temperature_celsius", "Drive temperature.", d.temp_c.map(f64::from)),
                ("nyx_smart_power_on_hours", "Hours powered on.", d.power_on_hours.map(|v| v as f64)),
                ("nyx_smart_power_cycles", "Power cycles.", d.power_cycles.map(|v| v as f64)),
                ("nyx_smart_written_bytes", "Bytes written over the drive's life.", d.written_bytes.map(|v| v as f64)),
                ("nyx_smart_capacity_bytes", "Drive capacity.", d.capacity.map(|v| v as f64)),
            ];
            for (name, help, v) in opt {
                if let Some(v) = v { o.gauge(name, help, &dl, v); }
            }
        }
        for c in &live.containers {
            let cl = with(&base, &[("container", &c.name), ("image", &c.image), ("state", &c.state)]);
            o.gauge("nyx_container_running", "1 while the Docker container runs.", &cl, b(c.state == "running"));
            o.gauge("nyx_container_cpu_usage_percent", "Container CPU usage.", &cl, c.cpu_pct as f64);
            o.gauge("nyx_container_memory_used_bytes", "Container memory in use.", &cl, c.mem_used as f64);
            o.gauge("nyx_container_memory_limit_bytes", "Container memory limit.", &cl, c.mem_limit as f64);
        }
        for g in &live.guests {
            let vmid = g.vmid.to_string();
            let gl = with(&base, &[("vmid", &vmid), ("guest", &g.name), ("type", &g.kind), ("node", &g.node), ("status", &g.status)]);
            o.gauge("nyx_guest_running", "1 while the Proxmox VM or container runs.", &gl, b(g.status == "running"));
            o.gauge("nyx_guest_uptime_seconds", "Guest uptime.", &gl, g.uptime_s as f64);
            o.gauge("nyx_guest_cpu_usage_percent", "Guest CPU usage.", &gl, g.cpu_pct as f64);
            o.gauge("nyx_guest_memory_used_bytes", "Guest memory in use.", &gl, g.mem_used as f64);
            o.gauge("nyx_guest_memory_total_bytes", "Guest memory size.", &gl, g.mem_total as f64);
            o.gauge("nyx_guest_disk_used_bytes", "Guest disk in use.", &gl, g.disk_used as f64);
            o.gauge("nyx_guest_disk_total_bytes", "Guest disk size.", &gl, g.disk_total as f64);
            o.gauge("nyx_guest_network_receive_bytes_per_second", "Guest inbound traffic.", &gl, g.rx_bps as f64);
            o.gauge("nyx_guest_network_transmit_bytes_per_second", "Guest outbound traffic.", &gl, g.tx_bps as f64);
            o.put("nyx_guest_network_receive_bytes_total", "counter", "Guest inbound bytes since it started.", &gl, g.net_in as f64);
            o.put("nyx_guest_network_transmit_bytes_total", "counter", "Guest outbound bytes since it started.", &gl, g.net_out as f64);
        }
        for v in &live.vpn {
            let vl = with(&base, &[("iface", &v.iface), ("type", &v.kind), ("ip", &v.ip)]);
            o.gauge("nyx_vpn_up", "1 while the VPN link is up.", &vl, b(v.up));
            o.gauge("nyx_vpn_receive_bytes_per_second", "VPN inbound traffic.", &vl, v.rx_bps as f64);
            o.gauge("nyx_vpn_transmit_bytes_per_second", "VPN outbound traffic.", &vl, v.tx_bps as f64);
        }
        if let Some(n) = &live.node {
            for a in &n.apps {
                let al = with(&base, &[("app", &a.name), ("path", &a.path), ("version", &a.version), ("manager", &a.manager)]);
                o.gauge("nyx_node_app_cpu_usage_percent", "Node.js app CPU usage.", &al, a.cpu_pct as f64);
                o.gauge("nyx_node_app_memory_bytes", "Node.js app memory.", &al, a.mem_bytes as f64);
                o.gauge("nyx_node_app_uptime_seconds", "Node.js app uptime.", &al, a.uptime_s as f64);
            }
        }
        if let Some(f) = &live.firewall {
            let fl = with(&base, &[("backend", &f.backend)]);
            o.gauge("nyx_firewall_active", "1 when the host firewall is on.", &fl, b(f.active));
            o.gauge("nyx_firewall_rules", "Firewall rules.", &fl, f.rules.len() as f64);
            o.gauge("nyx_listening_ports", "Ports the host listens on.", &base, f.listening.len() as f64);
        }
    }

    for p in st.probes.values() {
        let d = &p.def;
        let pl = [("probe", d.name.as_str()), ("probe_id", d.id.as_str()), ("type", d.kind.as_str()), ("target", d.target.as_str())];
        let Some(up) = p.up else { continue };
        o.gauge("nyx_probe_up", "1 when the last check passed.", &pl, b(up));
        if up {
            o.gauge("nyx_probe_latency_seconds", "Duration of the last check.", &pl, p.latency_ms / 1000.0);
        }
        if !p.history.is_empty() {
            o.gauge("nyx_probe_success_ratio", "Share of the recent checks that passed.", &pl, p.history.iter().filter(|u| **u).count() as f64 / p.history.len() as f64);
        }
        if let Some(days) = p.cert_days {
            o.gauge("nyx_probe_certificate_expiry_days", "Days until the TLS certificate expires.", &pl, days as f64);
        }
        for r in &p.readings {
            let Some(v) = r.value else { continue };
            let rl = [pl[0], pl[1], ("label", r.label.as_str()), ("unit", r.unit.as_str())];
            o.gauge("nyx_probe_value", "SNMP reading.", &rl, v);
            o.gauge("nyx_probe_value_status", "SNMP reading against its thresholds: 0 ok, 1 warning, 2 critical.", &rl, code(r.level));
        }
    }
    if let Some(a) = st.uptime.availability(st.probes.keys(), Local::now().date_naive(), 7) {
        o.gauge("nyx_probes_availability_7d_percent", "Availability of every probe over the last 7 days.", &[], a);
    }

    for p in st.pipelines.values() {
        let d = &p.def;
        let state = p.latest().map_or("off", |r| r.state);
        let pl = [("pipeline", d.name.as_str()), ("provider", d.provider.as_str()), ("repo", d.repo.as_str()), ("branch", d.branch.as_str())];
        o.gauge("nyx_pipeline_status", "Latest run: -1 unknown or cancelled, 0 success, 1 running, 2 failed.", &pl, code(state));
        o.gauge("nyx_pipeline_error", "1 when the forge could not be read.", &pl, b(!p.error.is_empty()));
    }

    for sev in ["info", "warn", "crit"] {
        o.gauge("nyx_alerts_open", "Open alerts by severity.", &[("severity", sev)], st.alerts.values().filter(|a| a.severity == sev).count() as f64);
    }

    for (plug, w) in &st.power {
        o.gauge("nyx_power_watts", "Meross plug power draw.", &[("plug", plug)], *w);
    }
    for plug in st.power_problems.keys() {
        o.gauge("nyx_power_plug_error", "1 when the Meross plug could not be read.", &[("plug", plug)], 1.0);
    }

    if let Some((_, t)) = &st.tempo {
        for colour in ["blue", "white", "red"] {
            if let Some(n) = t["remaining"][colour].as_f64() {
                o.gauge("nyx_tempo_days_remaining", "EDF Tempo days left this season.", &[("colour", colour)], n);
            }
        }
        for (name, day) in [("nyx_tempo_today", "today"), ("nyx_tempo_tomorrow", "tomorrow")] {
            if let Some(c) = t[day].as_str() {
                let c = c.to_lowercase();
                o.gauge(name, "EDF Tempo colour of the day, as a label, always 1.", &[("colour", &c)], 1.0);
            }
        }
    }
    o.render()
}

async fn scrape(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    let bearer = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    let stored = app.core.pb.setting(SETTING).await.ok().flatten();
    let want = stored.as_ref().and_then(|v| v["token_hash"].as_str()).filter(|h| !h.is_empty());
    let Some(want) = want else { return (StatusCode::NOT_FOUND, "metrics are off: create a token in Settings > Integrations").into_response() };
    if !bearer.is_some_and(|t| nyx_proto::sha256_hex(t.as_bytes()) == want) {
        return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
    }
    let body = render(&app.lock(), Utc::now().timestamp(), app.uptime_s());
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")], body).into_response()
}

async fn status(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    let on = app.core.pb.setting(SETTING).await?.is_some_and(|v| v["token_hash"].as_str().is_some_and(|h| !h.is_empty()));
    Ok(Json(json!({"enabled": on, "url": format!("{}/metrics", app.core.env.public_url)})))
}

/// A new token replaces the old one, which stops working at once.
async fn new_token(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    let token = random_hex(32);
    app.core.pb.set_setting(SETTING, &json!({"token_hash": nyx_proto::sha256_hex(token.as_bytes())})).await?;
    Ok(Json(json!({"token": token})))
}

async fn disable(_: Session, State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    app.core.pb.set_setting(SETTING, &json!({})).await?;
    Ok(Json(Value::Null))
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/metrics", get(scrape))
        .route("/api/metrics", get(status).delete(disable))
        .route("/api/metrics/token", post(new_token))
        .with_state(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_are_grouped_and_labels_escaped() {
        let mut o = Out::default();
        o.gauge("a", "A.", &[("x", "1")], 1.0);
        o.gauge("b", "B.", &[], 2.0);
        o.gauge("a", "A.", &[("x", "q\"\\\n")], 3.0);
        o.gauge("a", "A.", &[], f64::NAN);
        assert_eq!(o.render(), "# HELP a A.\n# TYPE a gauge\na{x=\"1\"} 1\na{x=\"q\\\"\\\\\\n\"} 3\n# HELP b B.\n# TYPE b gauge\nb 2\n");
    }

    #[test]
    fn empty_fleet_still_renders() {
        let s = render(&Fleet::default(), 0, 5);
        assert!(s.contains("nyx_monitor_uptime_seconds 5\n"));
        assert!(s.contains("nyx_alerts_open{severity=\"crit\"} 0\n"));
    }
}

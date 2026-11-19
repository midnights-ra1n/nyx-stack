//! Optional Prometheus endpoint, for scraping an agent straight from Prometheus,
//! VictoriaMetrics or Grafana Alloy without going through the monitor.
//!
//! Off unless `NYX_METRICS_LISTEN` is set. Serves the figures of the last report
//! from memory: a scrape reads nothing from disk and starts no measurement.
//! Metric names match the monitor's `/metrics`, so the Nyx dashboard works on both.

use nyx_proto::{Container, Health, Report, SmartDisk};
use std::{
    fmt::Write as _,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{Arc, Mutex},
    time::Duration,
};

/// The text served on the next scrape, replaced after every report.
pub type Latest = Arc<Mutex<String>>;

pub fn serve(addr: SocketAddr, token: String) -> anyhow::Result<Latest> {
    let listener = TcpListener::bind(addr)?;
    let latest = Latest::default();
    let text = latest.clone();
    std::thread::spawn(move || {
        // One at a time: scrapes are rare, and a slow client cannot pile up threads.
        for conn in listener.incoming().flatten() {
            let _ = answer(conn, &token, &text);
        }
    });
    Ok(latest)
}

fn answer(mut conn: TcpStream, token: &str, latest: &Latest) -> std::io::Result<()> {
    conn.set_read_timeout(Some(Duration::from_secs(2)))?;
    conn.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut buf = [0u8; 4096];
    let mut n = 0;
    while n < buf.len() && !buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
        match conn.read(&mut buf[n..])? {
            0 => break,
            m => n += m,
        }
    }
    let req = String::from_utf8_lossy(&buf[..n]);
    let (status, body) = route(&req, token, latest);
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; version=0.0.4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    conn.write_all(head.as_bytes())?;
    conn.write_all(body.as_bytes())
}

fn route(req: &str, token: &str, latest: &Latest) -> (&'static str, String) {
    let mut lines = req.lines();
    let path = lines.next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split(' ').next()).unwrap_or_default();
    if path.split('?').next() != Some("/metrics") {
        return ("404 Not Found", "not found\n".into());
    }
    let given = lines.find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("authorization")).map(|(_, v)| v.trim().to_string()));
    let given = given.as_deref().and_then(|v| v.strip_prefix("Bearer ")).unwrap_or_default();
    if !token.is_empty() && !same(given.as_bytes(), token.as_bytes()) {
        return ("401 Unauthorized", "missing or wrong bearer token\n".into());
    }
    ("200 OK", latest.lock().map(|s| s.clone()).unwrap_or_default())
}

/// Constant time, so the token cannot be guessed one byte at a time.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Default)]
struct Out(Vec<(&'static str, &'static str, String)>);

impl Out {
    fn gauge(&mut self, name: &'static str, help: &'static str, labels: &[(&str, &str)], value: f64) {
        if !value.is_finite() {
            return;
        }
        let i = self.0.iter().position(|f| f.0 == name).unwrap_or_else(|| {
            self.0.push((name, help, String::new()));
            self.0.len() - 1
        });
        let body = &mut self.0[i].2;
        body.push_str(name);
        body.push('{');
        for (j, (k, v)) in labels.iter().enumerate() {
            let v = v.replace('\\', r"\\").replace('"', "\\\"").replace('\n', r"\n");
            let _ = write!(body, "{}{k}=\"{v}\"", if j > 0 { "," } else { "" });
        }
        let _ = writeln!(body, "}} {value}");
    }
}

fn with<'a>(h: &[(&'a str, &'a str)], extra: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
    h.iter().chain(extra).copied().collect()
}

/// Every sample carries `host`, as on the monitor, so dashboards filter the same way.
pub fn render(r: &Report, containers: &[Container], smart: &[SmartDisk]) -> String {
    let mut o = Out::default();
    let h = [("host", r.hostname.as_str())];
    o.gauge("nyx_host_info", "Always 1", &with(&h, &[("kind", r.kind.as_str()), ("ip", &r.ip), ("os", &r.os), ("kernel", &r.kernel), ("arch", &r.arch), ("agent_version", &r.agent_version)]), 1.0);
    o.gauge("nyx_host_up", "1 while the agent runs", &h, 1.0);
    o.gauge("nyx_host_uptime_seconds", "Uptime", &h, r.uptime_s as f64);
    o.gauge("nyx_host_cpu_usage_percent", "CPU usage", &h, f64::from(r.cpu_pct));
    o.gauge("nyx_host_memory_used_bytes", "Memory used", &h, r.mem_used as f64);
    o.gauge("nyx_host_memory_total_bytes", "Memory size", &h, r.mem_total as f64);
    o.gauge("nyx_host_swap_used_bytes", "Swap used", &h, r.swap_used as f64);
    o.gauge("nyx_host_swap_total_bytes", "Swap size", &h, r.swap_total as f64);
    o.gauge("nyx_host_network_receive_bytes_per_second", "Traffic in", &h, r.net_rx_bps as f64);
    o.gauge("nyx_host_network_transmit_bytes_per_second", "Traffic out", &h, r.net_tx_bps as f64);
    o.gauge("nyx_host_reboot_required", "1 when a restart is needed", &h, f64::from(u8::from(r.reboot_required)));
    if let Some(t) = r.temp_c {
        o.gauge("nyx_host_temperature_celsius", "Hottest sensor", &h, f64::from(t));
    }
    for d in &r.disks {
        let l = with(&h, &[("mount", &d.mount), ("fs", &d.fs), ("device", &d.device)]);
        o.gauge("nyx_disk_used_bytes", "Filesystem space used", &l, d.used as f64);
        o.gauge("nyx_disk_total_bytes", "Filesystem size", &l, d.total as f64);
    }
    for d in smart {
        let l = with(&h, &[("device", &d.device), ("model", &d.model), ("serial", &d.serial), ("type", &d.kind)]);
        let health = match d.health { Health::Ok => 0.0, Health::Warn => 1.0, Health::Crit => 2.0 };
        o.gauge("nyx_smart_health", "SMART verdict: 0 ok, 1 warning, 2 critical", &l, health);
        if let Some(v) = d.life_left_pct { o.gauge("nyx_smart_life_left_percent", "Remaining endurance", &l, f64::from(v)); }
        if let Some(v) = d.temp_c { o.gauge("nyx_smart_temperature_celsius", "Drive temperature", &l, f64::from(v)); }
        if let Some(v) = d.power_on_hours { o.gauge("nyx_smart_power_on_hours", "Hours powered on", &l, v as f64); }
        o.gauge("nyx_smart_bad_sectors", "Reallocated and pending sectors", &l, d.bad_sectors as f64);
    }
    for c in containers {
        let l = with(&h, &[("container", &c.name), ("image", &c.image), ("state", &c.state)]);
        let running = c.state == "running";
        o.gauge("nyx_container_running", "1 while the container runs", &l, f64::from(u8::from(running)));
        if running {
            o.gauge("nyx_container_cpu_usage_percent", "Share of one core", &l, f64::from(c.cpu_pct));
            o.gauge("nyx_container_memory_used_bytes", "Memory used", &l, c.mem_used as f64);
        }
    }
    let mut s = String::new();
    for (name, help, body) in o.0 {
        let _ = write!(s, "# HELP {name} {help}\n# TYPE {name} gauge\n{body}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_metrics_only_to_the_token_holder() {
        let latest = Latest::new(Mutex::new("nyx_host_up{host=\"a\"} 1\n".into()));
        let get = |path: &str, auth: &str| route(&format!("GET {path} HTTP/1.1\r\nHost: x\r\n{auth}\r\n"), "s3cret-token-0001", &latest);
        assert_eq!(get("/metrics", "Authorization: Bearer s3cret-token-0001").0, "200 OK");
        assert_eq!(get("/metrics", "authorization: Bearer s3cret-token-0001").1, "nyx_host_up{host=\"a\"} 1\n");
        assert_eq!(get("/metrics", "Authorization: Bearer wrong").0, "401 Unauthorized");
        assert_eq!(get("/metrics", "").0, "401 Unauthorized");
        assert_eq!(get("/", "Authorization: Bearer s3cret-token-0001").0, "404 Not Found");
        assert_eq!(route("GET /metrics HTTP/1.1\r\n\r\n", "", &latest).0, "200 OK", "loopback without a token");
    }

    #[test]
    fn renders_host_disk_smart_and_container_samples() {
        let r = Report { hostname: "pve \"1\"".into(), cpu_pct: 12.5, temp_c: Some(48.0), disks: vec![nyx_proto::Disk { mount: "/".into(), used: 5, total: 10, ..Default::default() }], ..Default::default() };
        let smart = [SmartDisk { device: "/dev/sda".into(), health: Health::Warn, life_left_pct: Some(91), ..Default::default() }];
        let c = [Container { name: "web".into(), state: "running".into(), cpu_pct: 3.0, ..Default::default() }];
        let text = render(&r, &c, &smart);
        assert!(text.contains("nyx_host_cpu_usage_percent{host=\"pve \\\"1\\\"\"} 12.5\n"), "{text}");
        assert!(text.contains("nyx_disk_total_bytes{host=\"pve \\\"1\\\"\",mount=\"/\",fs=\"\",device=\"\"} 10\n"));
        assert!(text.contains("nyx_smart_health{") && text.contains("} 1\n"));
        assert!(text.contains("nyx_smart_life_left_percent{") && text.contains("nyx_container_running{"));
        assert_eq!(text.matches("# TYPE nyx_disk_used_bytes gauge").count(), 1);
    }
}

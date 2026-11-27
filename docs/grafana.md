# Grafana

Show Nyx in Grafana in about five minutes. Nyx gives the metrics; the `grafana`
profile of the [Docker setup](deployment.md#docker) stores them and runs Grafana,
with the data source and the dashboard already set up. Nothing to click through in
Grafana.

```
Nyx monitor  ──/metrics──▶  VictoriaMetrics  ──▶  Grafana
 (RAM only)    every 60 s    (stores history)     (dashboard, port 3000)
```

## How the metrics travel

The agents measure, the monitor gathers, Grafana draws. There are two ways to connect
them, and they can run side by side:

| | Through the monitor (recommended) | Straight from the agents |
| --- | --- | --- |
| Scraped | One address: the monitor's `/metrics` | Every host, on the port you choose |
| Holds | Hosts, disks, SMART, containers, Proxmox guests, VPN, probes, pipelines, alerts, Meross, Tempo | That host's CPU, memory, swap, network, temperature, disks, SMART and containers |
| Needs on the hosts | Nothing more | One open port per host, and its firewall rule |
| Works without the monitor | No | Yes |
| Set up in | Monitor settings | `/etc/nyx/agent.conf` or Ansible |

```
                         ┌───────────── report every 15-60 s ─────────────┐
agent (each host) ───────┤                                                ▼
   │                     │                                   Nyx monitor ──/metrics──┐
   └── :9101/metrics ────┼── optional, direct ──┐                                    │
                         │                      ▼                                    ▼
                         │              VictoriaMetrics or Prometheus  ◀─────────────┘
                         │                      │
                         │                      ▼
                         └──────────────────  Grafana
```

Through the monitor is the usual way: nothing changes on the hosts and the dashboard gets
everything. Scrape the agents directly when you already run Prometheus and want host
figures even with no Nyx monitor, or at the pace of your own scrape.

Grafana does not store metrics itself, so something has to sit in between. The
profile uses [VictoriaMetrics](https://victoriametrics.com): a single small binary
that speaks the Prometheus language and needs a fraction of Prometheus' memory and
disk. Your Nyx monitor writes nothing more to disk: each scrape is read from memory.

## 1. Create a token

In the monitor, open **Settings → Integrations → Grafana** and click
**Create token**. The panel shows the lines to put in `.env`, token filled in. Copy
them now: the token is shown only once.

## 2. Add the dashboard and the token

In the folder of your `compose.yaml` (see [Docker](deployment.md#docker)):

```sh
curl -fsSLO https://raw.githubusercontent.com/midnights-ra1n/nyx-stack/stable/packaging/docker/nyx-dashboard.json
```

Then, in `.env`:

```sh
NYX_METRICS_TOKEN=the-token
NYX_GRAFANA_PASSWORD=a-long-password
```

## 3. Start it

Add the `grafana` profile to the ones you use:

```sh
docker compose --profile monitor --profile grafana up -d
```

Open `http://your-server:3000` and sign in as `admin`. The **Nyx** dashboard is the
home page. Data appears after the first minute. Use the **Host** filter at the top
to focus on some hosts.

### Grafana on another machine

The `grafana` profile runs on its own too. Get `compose.yaml`, `.env` and the
dashboard there, then tell it where the monitor is:

```sh
NYX_METRICS_HOST=monitor.example.com
NYX_METRICS_SCHEME=https
```

```sh
docker compose --profile grafana up -d
```

## Settings

| In `.env` | Default | Meaning |
| --- | --- | --- |
| `NYX_METRICS_TOKEN` | | Token from the monitor |
| `NYX_GRAFANA_PASSWORD` | `admin`, to change at first sign-in | Password of the Grafana `admin` user, used at its first start only |
| `NYX_METRICS_RETENTION` | `90d` | How long metrics are kept: `30d`, `1y`... |
| `NYX_METRICS_HOST` | `monitor:8081`, the monitor of the same compose | Address of the monitor with its port if any, without `https://` |
| `NYX_METRICS_SCHEME` | `http` | `https` for a monitor behind TLS |
| `NYX_AGENT_METRICS_TARGETS` | empty | Agents to scrape directly, as `'"host:port", "host:port"'`. See [Scraping the agents directly](#scraping-the-agents-directly) |
| `NYX_AGENT_METRICS_TOKEN` | | Their `NYX_METRICS_TOKEN` |

After editing `.env`, run the `up -d` command again.

Grafana is set not to contact grafana.com: no usage reports, no update or news
checks. To keep port 3000 off the network, put Grafana behind your reverse proxy as
described in [Put HTTPS in front](deployment.md#5-put-https-in-front).

## Already have Prometheus or Grafana?

Skip the kit and add this job to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: nyx
    scrape_interval: 60s
    scheme: https
    metrics_path: /metrics
    authorization:
      credentials: TOKEN
    static_configs:
      - targets: ["monitor.example.com"]
```

Then, in Grafana, **Dashboards → New → Import** and upload
[`nyx-dashboard.json`](../packaging/docker/nyx-dashboard.json), choosing your
Prometheus data source.

## Scraping the agents directly

Each agent can serve its own `/metrics`. It is off until you give it an address. The
figures are those of its last report, kept in memory: a scrape measures nothing, reads
no file and writes nothing. Metric names and the `host` label match the monitor's, so
the host panels of the Nyx dashboard read both; fleet totals, probes and alerts stay
empty without the monitor. Here `host` is the machine's host name, which can differ from
the name given in Nyx, and there is no `host_id`.

### 1. Turn it on

In `/etc/nyx/agent.conf` on the host:

```sh
NYX_METRICS_LISTEN=0.0.0.0:9101
NYX_METRICS_TOKEN=a-random-string-of-16-characters-or-more
```

Make a token with `openssl rand -hex 24`. Then `sudo systemctl restart nyx-agent`. The
agent refuses to start with a non-loopback address and no token, or a shorter one, rather
than serve the host's figures to anyone. With `127.0.0.1:9101`, for a collector on the
same host, the token is optional.

With Ansible, set the same two values for every host at once, the token in Ansible Vault:

```yaml
nyx_agent_metrics_listen: "0.0.0.0:9101"
nyx_agent_metrics_token: "{{ vault_nyx_metrics_token }}"
```

Open the port to your Prometheus only. From the host page, **Firewall → Add a rule**:
allow, TCP, port `9101`, from the Prometheus address.

### 2. Check it

```sh
curl -H "Authorization: Bearer TOKEN" http://HOST:9101/metrics
```

Values appear after the agent's first report, 15 seconds at most. SMART and container
figures come with the next reading of each, up to 30 minutes for SMART.

### 3. Scrape it

```yaml
scrape_configs:
  - job_name: nyx-agents
    scrape_interval: 60s
    authorization:
      credentials: TOKEN
    static_configs:
      - targets: ["pve-01.lan:9101", "web-01.lan:9101", "nas.lan:9101"]
```

The same token on every host keeps this to one job.

With the `grafana` Docker profile, the job is already there. List the agents in `.env`,
each in double quotes, the whole list in single quotes, then run
`docker compose --profile grafana up -d`:

```sh
NYX_AGENT_METRICS_TARGETS='"pve-01.lan:9101", "web-01.lan:9101", "nas.lan:9101"'
NYX_AGENT_METRICS_TOKEN=the-agents-token
```

When the monitor is scraped too, every host appears twice, once per job. In Grafana,
pick one with `{job="nyx"}` or `{job="nyx-agents"}`.

### What the agent serves

`nyx_host_info`, `nyx_host_up`, `nyx_host_uptime_seconds`, `nyx_host_cpu_usage_percent`,
`nyx_host_memory_used_bytes`, `nyx_host_memory_total_bytes`, `nyx_host_swap_used_bytes`,
`nyx_host_swap_total_bytes`, `nyx_host_network_receive_bytes_per_second`,
`nyx_host_network_transmit_bytes_per_second`, `nyx_host_temperature_celsius`,
`nyx_host_reboot_required`, `nyx_disk_used_bytes`, `nyx_disk_total_bytes`,
`nyx_smart_health`, `nyx_smart_life_left_percent`, `nyx_smart_temperature_celsius`,
`nyx_smart_power_on_hours`, `nyx_smart_bad_sectors`, `nyx_container_running`,
`nyx_container_cpu_usage_percent` and `nyx_container_memory_used_bytes`, with the labels
of the [table below](#metrics). Probes, pipelines, alerts and integrations live in the
monitor only.

When the agent stops, its endpoint goes with it: alert on `up{job="nyx-agents"} == 0` in
Prometheus.

## Good to know

- **Scrape interval:** while nobody has the monitor's web UI open, agents report
  every 60 s instead of 15 s. Scraping more often than every 60 s adds nothing.
- **Plain HTTP:** it works, but the token then crosses the network in clear. Prefer
  HTTPS when Grafana runs on another network than the monitor.
- **New token:** creating one replaces the old one at once: update `.env` and run
  `docker compose up -d` again. **Turn off** in the monitor makes `/metrics` answer 404.
- **Offline hosts** keep their last known values, as in the web UI. Filter them
  with `nyx_host_up`, for example
  `nyx_host_cpu_usage_percent and on(host_id) nyx_host_up == 1`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Dashboard empty after 2 minutes | Run `docker compose logs victoriametrics` and look for the scrape error |
| Grafana shows "Dashboard not found" | `nyx-dashboard.json` is missing next to `compose.yaml`: download it, then `docker compose up -d --force-recreate grafana` |
| `401` in the logs | Wrong token: create a new one and update `.env` |
| `404` in the logs | Metrics are turned off in the monitor: create a token |
| `connection refused` or timeout | `NYX_METRICS_HOST` is wrong or the machine cannot reach the monitor |
| Certificate error | The monitor's certificate is not trusted: use a trusted one, or `http` on the LAN |
| Agent: `connection refused` on 9101 | `NYX_METRICS_LISTEN` is unset or `127.0.0.1`, or the agent was not restarted. `journalctl -u nyx-agent` shows `cannot serve metrics` if the port is taken |
| Agent: timeout on 9101 | The host's firewall drops it: add the rule above |
| Agent does not start after the change | Its log says the token is missing or too short |

## Metrics

Every host metric carries `host` (name) and `host_id`. States use one scale:
`-1` off or unknown, `0` ok, `1` warning (or running, for pipelines), `2` critical.

| Metric | Labels beyond host | Meaning |
| --- | --- | --- |
| `nyx_monitor_uptime_seconds` | | Seconds since the monitor started |
| `nyx_hosts`, `nyx_hosts_online` | | Hosts known, and reporting |
| `nyx_threshold_warning`, `nyx_threshold_critical` | `metric` (`percent`, `temperature`) | Thresholds set in the monitor |
| `nyx_host_info` | `kind`, `parent`, `hostname`, `ip`, `os`, `kernel`, `arch`, `agent_version`, `pve_node` | Always 1 |
| `nyx_host_up` | | 1 while the agent reports |
| `nyx_host_status` | | Worst state of the host |
| `nyx_host_muted`, `nyx_host_updating`, `nyx_host_reboot_required` | | 0 or 1 |
| `nyx_host_last_seen_timestamp_seconds` | | Unix time of the last report |
| `nyx_host_uptime_seconds` | | Uptime |
| `nyx_host_cpu_usage_percent` | | CPU usage |
| `nyx_host_memory_used_bytes`, `nyx_host_memory_total_bytes` | | Memory |
| `nyx_host_swap_used_bytes`, `nyx_host_swap_total_bytes` | | Swap |
| `nyx_host_network_receive_bytes_per_second`, `nyx_host_network_transmit_bytes_per_second` | | Traffic |
| `nyx_host_temperature_celsius` | | Hottest sensor |
| `nyx_host_updates_pending`, `nyx_host_security_updates_pending` | | Packages with an update |
| `nyx_host_logs_buffered` | | Log lines held in memory |
| `nyx_disk_used_bytes`, `nyx_disk_total_bytes` | `mount`, `fs`, `device` | Filesystems |
| `nyx_smart_health` | `device`, `model`, `serial`, `type` | SMART verdict |
| `nyx_smart_life_left_percent`, `nyx_smart_temperature_celsius`, `nyx_smart_power_on_hours`, `nyx_smart_power_cycles`, `nyx_smart_written_bytes`, `nyx_smart_capacity_bytes`, `nyx_smart_bad_sectors` | same | SMART details, when the drive reports them |
| `nyx_container_running` | `container`, `image`, `state` | Docker containers |
| `nyx_container_cpu_usage_percent`, `nyx_container_memory_used_bytes`, `nyx_container_memory_limit_bytes` | same | Container usage |
| `nyx_guest_running` | `vmid`, `guest`, `type`, `node`, `status` | Proxmox VMs and containers, seen from the node |
| `nyx_guest_uptime_seconds`, `nyx_guest_cpu_usage_percent`, `nyx_guest_memory_used_bytes`, `nyx_guest_memory_total_bytes`, `nyx_guest_disk_used_bytes`, `nyx_guest_disk_total_bytes`, `nyx_guest_network_receive_bytes_per_second`, `nyx_guest_network_transmit_bytes_per_second` | same | Guest usage |
| `nyx_guest_network_receive_bytes_total`, `nyx_guest_network_transmit_bytes_total` | same | Counters since the guest started |
| `nyx_vpn_up`, `nyx_vpn_receive_bytes_per_second`, `nyx_vpn_transmit_bytes_per_second` | `iface`, `type`, `ip` | VPN links |
| `nyx_firewall_active`, `nyx_firewall_rules` | `backend` | Host firewall |
| `nyx_listening_ports` | | Ports the host listens on |
| `nyx_probe_up`, `nyx_probe_latency_seconds`, `nyx_probe_success_ratio` | `probe`, `probe_id`, `type`, `target` (no host) | Ping, HTTP, DNS, certificate and SNMP probes |
| `nyx_probe_certificate_expiry_days` | same | Days until the certificate expires |
| `nyx_probe_value`, `nyx_probe_value_status` | `probe`, `probe_id`, `label`, `unit` | SNMP readings |
| `nyx_probes_availability_7d_percent` | | All probes over 7 days |
| `nyx_pipeline_status`, `nyx_pipeline_error` | `pipeline`, `provider`, `repo`, `branch` (no host) | CI/CD pipelines |
| `nyx_alerts_open` | `severity` | Open alerts |
| `nyx_power_watts`, `nyx_power_plug_error` | `plug` | Meross plugs |
| `nyx_tempo_days_remaining` | `colour` | EDF Tempo days left |
| `nyx_tempo_today`, `nyx_tempo_tomorrow` | `colour` | Colour of the day, always 1 |


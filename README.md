<p align="center"><img src="nyx-mark.svg" width="72" alt=""></p>

# Nyx

Self-hosted homelab management and monitoring. Written in Rust, light on CPU, RAM
and disk, with no third-party requests from the browser.

![The monitor's overview](docs/images/overview.png)

Nyx has three parts. Each one works without the others.

| Part | What it does | Port |
| --- | --- | --- |
| **Monitor** | Dashboards, hosts, containers, SMART, alerts, logs, status pages, wall displays, and ICMP, HTTP, DNS, certificate and SNMP probes | 8081 |
| **Manager** | Hardware and virtual inventory, IPAM (nested subnets, VLANs, VRFs, address map, ping scan, conflict detection), routing simulation, dashboard widgets, network map, and the work to do: tasks, interventions, deployments | 8082 |
| **Agent** | One small Rust binary on each host. It opens no port and only calls the monitor | none |

Run the manager alone, the monitor with its agents alone, or link them. The manager keeps
an inventory of its own, typed by you; when linked, its overview also shows the monitor's
health, EDF Tempo and pipelines.

## Project status

Nyx 1.0.0 is the first stable release, with images and packages on the
[releases page](https://github.com/midnights-ra1n/nyx-stack/releases). It is a young
project: its tests pass, but it has only seen light use on real systems, so keep backups
and report what breaks. You can also [build it from source](docs/development.md).

## Features

- **Agent:** uptime, CPU, RAM, swap, network, disks, temperature, Docker containers,
  systemd services (state, uptime, memory, CPU, restarts, logs and unit file),
  system updates (and applying them), and light log collection. SMART health with
  remaining life on physical hosts. 1.4 MB binary, about 13 MB of RAM.
- **Host types:** VM, physical, Proxmox and VPS. Change the type live, without
  reinstalling. On Proxmox, the agent can install itself in new containers.
- **Install anywhere:** a generated `curl` line, an Ansible role, `.deb` and `.rpm`
  packages, or Docker images, for x86_64 and arm64.
- **Tags and updates:** tag hosts and inventory records, filter and chart by tag, and
  update the packages of a whole tag from one page, security fixes first.
- **Your own charts:** pick a measure, some hosts and a look; `$host` and `$tag`
  variables at the top switch every chart at once.
- **Probes:** ping, website, DNS, HTTPS certificate expiry, and SNMP v1, v2c and v3
  with presets for switches, servers, UPS, printers, Synology and MikroTik.
- **Status pages:** as many public pages as you like, built from Grafana-style panels,
  with your colours and logo. They show only what you pick, never addresses or targets,
  and each can be embedded in another site if you allow it.
- **Wall displays:** full-screen supervision boards for a screen in a room, up to 4K,
  with a private link and no account. Long lists page by themselves.
- **Notifications:** email, Discord, Matrix, Slack, Gotify, Ntfy, Telegram, Teams and
  more through Shoutrrr. Custom templates with emojis, a live preview that looks like
  the app receiving them, and grouping into daily, weekly or monthly digests.
- **VPN links:** agents report Tailscale, NetBird, WireGuard and other tunnels and alert
  when one drops. The manager keeps them on their page and on the network map.
- **Work:** tasks, interventions on devices and deployments in one table, or as a
  board, with states, tags, due dates, checklists synced with Nextcloud, and progress
  overall and per tag.
- **Places and network map:** drag devices into racks, onto shelving units or desks,
  side by side, plug cables between ports, and draw your infrastructure (Internet,
  routers, switches, servers, VMs, VPS, cloud) with typed links (Ethernet, fibre, Wi-Fi,
  VLAN, VPN) and coloured zones.
- **English and French:** the interface follows the browser's language, or the one you pick.
- **Integrations:** Nextcloud tasks and calendar, EDF Tempo (RTE), Proxmox noVNC
  console, Meross power plugs, Prometheus metrics for Grafana, an MCP server for AI
  assistants, and passkeys.
- **Update channels:** stable releases by default, or opt in to beta from the settings.
- **Your pages, your layout:** nearly every page is made of blocks. Slide them, hide
  them, choose up to four columns, on each device. Arrows do the same from the keyboard.
- **Logs you can read:** time, level, service and message, repeats folded, and a live
  view of any host that stores nothing and costs nothing when nobody watches.
- **Works on a phone:** every page is responsive and installable as a PWA. It refreshes
  when you come back to the tab and stops polling while hidden.
- **Long history, small database:** keep 30 to 365 days. Past a week, history is stored
  hour by hour, so a year takes about 3 MB per host.
- **Local or shared database:** each server has its own built in. Or pick a shared
  `nyx-db` at first start, and the monitor and the manager use one set of accounts.
- **Low disk writes:** live metrics stay in RAM. PocketBase gets one batch every five
  minutes, plus state changes when they happen.
- **Low memory:** about 10 MB for an idle server, plus 43 MB for PocketBase. With 200
  hosts, the monitor stays near 30 MB. See the
  [measurements](docs/architecture.md#measured-memory), taken on macOS so far.

## Screenshots

These come from a real monitor and manager, filled with simulated agents and invented
hosts. Select an image to see it at full size.

### Wall display

For a large screen in a room. A panel too long for the screen pages through its content by itself.

![A wall display](docs/images/wall.png)

### Monitor

| **Hosts**, nested under their Proxmox node | **Host detail**, made of blocks |
| --- | --- |
| <a href="docs/images/hosts.png"><img src="docs/images/hosts.png" alt="Host list as a tree"></a> | <a href="docs/images/host-detail.png"><img src="docs/images/host-detail.png" alt="Detail page of a storage server"></a> |
| **Containers** | **Network probes** |
| <a href="docs/images/containers.png"><img src="docs/images/containers.png" alt="Docker containers across hosts"></a> | <a href="docs/images/network.png"><img src="docs/images/network.png" alt="Probe list with latency and history"></a> |
| **Storage and disk health** | **Alerts** |
| <a href="docs/images/storage.png"><img src="docs/images/storage.png" alt="File systems and SMART state"></a> | <a href="docs/images/alerts.png"><img src="docs/images/alerts.png" alt="Open and resolved alerts"></a> |
| **Physical disks**, SMART in plain words | **Customize** any page |
| <a href="docs/images/physical-disks.png"><img src="docs/images/physical-disks.png" alt="One card per disk with health, life left and temperature"></a> | <a href="docs/images/customize.png"><img src="docs/images/customize.png" alt="Host page with its blocks being rearranged"></a> |
| **Logs**, readable and folded | **Live logs** of a host |
| <a href="docs/images/logs.png"><img src="docs/images/logs.png" alt="Logs with levels, services and a summary"></a> | <a href="docs/images/logs-live.png"><img src="docs/images/logs-live.png" alt="Lines of a host arriving live"></a> |
| **Public status page** | **Page editor** |
| <a href="docs/images/status-page.png"><img src="docs/images/status-page.png" alt="Status page with 30 days of uptime"></a> | <a href="docs/images/page-editor.png"><img src="docs/images/page-editor.png" alt="Editor of a wall display"></a> |

### Notification templates

Each channel has its own title and body template, with a live preview. See
[notifications](docs/notifications.md).

![Editing a notification channel next to its preview](docs/images/notifications.png)

### Manager

| **Overview** | **IPAM**, with conflicts and routing simulation |
| --- | --- |
| <a href="docs/images/manager-overview.png"><img src="docs/images/manager-overview.png" alt="Manager overview"></a> | <a href="docs/images/ipam.png"><img src="docs/images/ipam.png" alt="IPAM page"></a> |
| **Network map** | **Hardware inventory** |
| <a href="docs/images/network-map.png"><img src="docs/images/network-map.png" alt="Network map and export formats"></a> | <a href="docs/images/hardware.png"><img src="docs/images/hardware.png" alt="Hardware inventory"></a> |

### On a phone

Both interfaces work as installable web apps.

<p>
  <img src="docs/images/phone-overview.png" width="240" alt="Overview on a phone">
  <img src="docs/images/phone-host.png" width="240" alt="Host detail on a phone">
  <img src="docs/images/phone-alerts.png" width="240" alt="Alerts on a phone">
</p>

## Quick start with Docker

```sh
curl -fsSLO https://raw.githubusercontent.com/midnights-ra1n/nyx-stack/stable/packaging/docker/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/midnights-ra1n/nyx-stack/stable/packaging/docker/.env.example
# Set your two URLs in .env, then:
docker compose --profile monitor --profile manager up -d
```

Open port 8081 or 8082 and create your account. In the monitor, choose **Add host**
and run the generated line on the machine to monitor.

Each step, packages for Debian and RHEL, HTTPS, backups, updates and removal are in the
[deployment guide](docs/deployment.md).

## Documentation

- [Getting started](docs/getting-started.md): from nothing to your first alert
- [Architecture](docs/architecture.md): how the parts fit, and why it stays light
- [Deployment](docs/deployment.md): Docker, packages, HTTPS, linking, upgrades
- [Cloudflare relay](docs/cloudflare.md): reach Nyx from anywhere through a Worker that only sees ciphertext, with uptime checks from the edge
- [Configuration](docs/configuration.md): every environment variable
- [Agent](docs/agent.md): install methods, host types, Ansible, what is collected
- [Monitoring](docs/monitoring.md): probes, SNMP, alerts
- [Status pages](docs/status-pages.md): public pages and wall displays
- [Manager](docs/manager.md): inventory, IPAM, map, work
- [Notifications](docs/notifications.md): channels, rules, templates
- [Integrations](docs/integrations.md): Nextcloud, Tempo, Proxmox, Meross, MCP, passkeys
- [Grafana](docs/grafana.md): dashboards in five minutes, and every metric Nyx exposes
- [Security](docs/security.md): trust model and hardening
- [Troubleshooting](docs/troubleshooting.md)
- [HTTP API](docs/api.md) and [data model](docs/data-model.md): reference
- [Development](docs/development.md): building and testing
- [Third-party software](THIRD-PARTY.md)

## Licence

Copyright (C) 2026 the Nyx contributors.

This program is free software: you can redistribute it and/or modify it under the terms
of the GNU General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version. It is distributed
without any warranty. See [LICENSE](LICENSE), and [THIRD-PARTY.md](THIRD-PARTY.md) for
the licences of the components.

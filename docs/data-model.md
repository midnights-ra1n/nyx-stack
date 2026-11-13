# Data model

All durable data lives in PocketBase. By default each server embeds its own, and with
a [shared database](deployment.md#choosing-a-database) both use the one in `nyx-db`. The schema is in `pb/pb_migrations`, and new changes go
in a new migration file, applied when the server starts. Every collection is reachable by the superuser
only: browsers talk to Nyx, never to PocketBase.

Live metrics, logs, open alert texts, daily uptime and the fleet-wide chart are in RAM,
and are rebuilt from agents and rollups after a restart.

## Shared

| Collection | Purpose | Kept |
| --- | --- | --- |
| `users` | Accounts (PocketBase built-in) | Always |
| `settings` | Key and JSON value: thresholds, integrations, update channel, link token hash, map places, and the monitor's daily `history` snapshot | Always |
| `passkeys` | WebAuthn credentials per user | Until removed |
| `mcp_tokens` | Hashed MCP tokens | Until revoked |
| `notif_channels` | Shoutrrr URL and templates | Always |
| `notif_rules` | Events, channel, schedule, last send and last error | Always |
| `notif_events` | Everything that could be notified | 40 days |
| `notif_claims` | On a shared database, which server sends a digest | 10 minutes |

## Monitor

| Collection | Purpose | Kept |
| --- | --- | --- |
| `hosts` | Enrolled hosts, with their token and key, and whether they are kept out of alerts (`muted`) | Until deleted |
| `rollups` | Host averages, every five minutes then every hour | Chosen retention |
| `alerts` | Open and resolved alerts | Chosen retention once resolved |
| `probes` | Probe definitions, with SNMP items as JSON | Until deleted |
| `pipelines` | CI/CD pipelines followed: forge, address, repository, branch, token | Until deleted |
| `probe_rollups` | Probe results and SNMP values, every five minutes then every hour. Rows with `probe = _monitor` are the monitor's heartbeat | Chosen retention |
| `power_samples` | Meross power readings, every five minutes then every hour | Chosen retention |
| `pages` | Status pages and wall displays | Until deleted |

The retention is set from 30 to 365 days in **Settings, Monitoring**. In those three
time series, `n = 0` marks a five-minute row, and any other `n` is the number of rows
merged into an hourly one. Rows become hourly once they are 7 days old.

A page holds `name`, `slug`, `kind`, `published`, `access_key`, and `config`, which
contains the texts, theme, panels and the `embed` option.

## Manager

| Collection | Purpose |
| --- | --- |
| `hardware` | Physical inventory, warranty dates, and specifications by category (`cpu`, `ram`, `storage`, `ports`, `wifi`, `power`, `battery_at`, `firmware`, `mgmt_ip`) |
| `virtual_assets` | VMs, containers and Docker services. `source = monitor` rows are synced |
| `subnets` | CIDR, gateway, VLAN number, section, VRF name, location, usage threshold |
| `ip_addresses` | Address, state, device, hostname, MAC, owner, last time a scan saw it |
| `vlans` | Number, name, domain |
| `vrfs` | Name, route distinguisher |
| `routes` | Device, destination, next hop, metric, for the simulation |
| `deployments` | Deployment log, due dates and tags |
| `map_nodes`, `map_links` | Network map |
| `vpn_links` | VPN links kept by hand |
| `sites` | Node.js sites, deploy keys, webhook secrets and the existing `service` they run under |
| `tasks` | Tasks and calendar events, with state, tags and CalDAV `uid`, `etag` and `href` |

A task with an empty `etag` is a local change that still has to reach Nextcloud.

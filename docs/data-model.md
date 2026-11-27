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
| `notif_channels` | Shoutrrr URL, templates, language, and the layout of the visual editor (`design`, empty when the templates are written by hand) | Always |
| `notif_rules` | Events, severities, hosts, channel, schedule, wait, quiet hours, last send and last error | Always |
| `notif_events` | Everything that could be notified | 40 days |
| `notif_claims` | On a shared database, which server sends a digest | 10 minutes |

## Monitor

| Collection | Purpose | Kept |
| --- | --- | --- |
| `hosts` | Enrolled hosts, with their token and key, whether they are kept out of alerts (`muted`) or out of the MCP server's answers (`mcp_hidden`), what they alert on (`alerting`, JSON) and their `tags`, comma-separated | Until deleted |
| `rollups` | Host averages, every five minutes then every hour | Chosen retention |
| `alerts` | Open and resolved alerts. Status pages show the last 90 days as incidents | Chosen retention once resolved, and at least 90 days |
| `probes` | Probe definitions, with SNMP items as JSON, the id of their `category` (empty for none), and whether they are paused (`enabled` false), kept out of alerts (`muted`) or out of the MCP server's answers (`mcp_hidden`) | Until deleted |
| `probe_categories` | Categories of the probe list: `name` and `position` | Until deleted |
| `pipelines` | CI/CD pipelines followed: forge, address, repository, branch, token | Until deleted |
| `probe_rollups` | Probe results and SNMP values, every five minutes then every hour. Rows with `probe = _monitor` are the monitor's heartbeat | Chosen retention |
| `power_samples` | Meross power readings, every five minutes then every hour | Chosen retention |
| `pages` | Status pages and wall displays | Until deleted |

The retention is set from 30 to 365 days in **Settings, Monitoring**. In those three
time series, `n = 0` marks a five-minute row, and any other `n` is the number of rows
merged into an hourly one. Rows become hourly once they are 7 days old.

A page holds `name`, `slug`, `kind`, `published`, `access_key`, and `config`, which
contains the texts, theme, panels and the `embed` option. Each item a panel lists has a
`kind`, an `id`, a public `label` and a `group`, the category it is listed under.

## Manager

| Collection | Purpose |
| --- | --- |
| `hardware` | Physical inventory, warranty dates, and specifications by category (`cpu`, `ram`, `storage`, `ports`, `wifi`, `power`, `battery_at`, `firmware`, `mgmt_ip`). Purchase details: `supplier`, `order_number`, `invoice_number`, `price`, `purchased_at`, `in_service_at`. Place: `rack` (the id of a rack, shelving unit or desk), `rack_u` (lowest unit or level, 1 at the bottom), `rack_units` (height in a rack), `rack_x` and `rack_w` (first column and width out of 12; 0 is the whole width). `tags`, comma-separated |
| `racks` | Places: name, location, `kind` (`rack`, `shelf` or `desk`; empty reads as a rack), `units` (height in U, or levels of a shelf), `width_cm` and `color` (`wood`, `white`, `black`, `grey`) of furniture, notes |
| `ports` | Network ports of a hardware record (`device` holds its id): name, speed, MAC, VLAN, note. `peer` holds the id of the port at the other end of the cable, on one of the two ports only |
| `virtual_assets` | VMs, containers and Docker services, typed by hand. `parent` holds the name of what it runs on. `tags`, comma-separated. `source` and `external_id` are left from the monitor sync of 1.0 |
| `subnets` | CIDR, gateway, VLAN number, section, VRF name, location, usage threshold |
| `ip_addresses` | Address, state, device, hostname, MAC, owner, last time a scan saw it, and `shared` for an address held by several machines on purpose (VRRP, CARP, anycast) |
| `components` | Parts inside the hardware: `name`, `type`, `manufacturer`, `model`, `serial`, `capacity`, `device` (the id of the hardware it is fitted in, empty on a shelf), `slot`, `status` (`In service`, `Spare` or `Decommissioned`), `decommissioned_at`, `purchased_at`, `warranty_until`, `tags`, `notes` |
| `vlans` | Number, name, domain |
| `vrfs` | Name, route distinguisher |
| `routes` | Device, destination, next hop, metric, for the simulation |
| `deployments` | Deployment log, due dates and tags. The Node.js sites of 1.0 became deployments tagged `nodejs` |
| `interventions` | Work on a device: `title`, `type` (`Maintenance`, `Repair`, `Upgrade`, `Installation` or `Check`), `asset` (the name of a hardware or virtual record), `status` (`todo`, `doing`, `done` or `cancelled`), `scheduled_at`, `done_at`, `owner`, `tags`, `notes` (the report), `reminded_at` |
| `map_nodes`, `map_links` | Network map. A link's `kind` is `ethernet`, `fiber`, `wifi`, `vlan`, `vpn` or `virtual`; empty reads as Ethernet |
| `map_zones` | Zones of the network map: name, `color` (`blue`, `green`, `yellow`, `red`, `orange`, `grey`), `x`, `y`, `w`, `h` |
| `vpn_links` | VPN links kept by hand |
| `tasks` | Tasks and calendar events, with state, tags and CalDAV `uid`, `etag` and `href`. The checklist lives in `description` as Markdown `- [ ]` lines |
| `history` | Changes saved from the web interface to `hardware` and `virtual_assets`: `coll`, `record` id, `name`, `action` (`create` or `update`) and `changes`, a list of `{field, from, to}` |

A task with an empty `etag` is a local change that still has to reach Nextcloud.

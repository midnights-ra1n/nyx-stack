# HTTP API

The web UI uses this API. It is not versioned yet, so expect changes before 1.0. For
scripts and AI assistants, the read-only [MCP server](integrations.md#mcp-server) is the
stable way in.

Answers are JSON. Errors look like `{"error": "message"}`.

| Access | Meaning |
| --- | --- |
| Public | No authentication |
| Session | Signed-in session cookie |
| Agent | Signed by the host's key: see [security.md](security.md#agent-traffic) |
| Link | `Authorization: Bearer <link token>` |
| Signature | Forge webhook signature |
| Token | MCP token |
| Key | Published, with an `X-Nyx-Page-Key` header for wall displays |

## Both servers

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | Public | Liveness |
| GET | `/api/auth/status` | Public | Session state, signed-in email, whether HTTPS, passkeys and a shared database are on |
| POST | `/api/auth/setup` | Public | Create the first account, once |
| POST | `/api/auth/login` | Public | Sign in, rate limited |
| POST | `/api/auth/logout` | Session | Sign out |
| POST | `/api/auth/password` | Session | Change the password: `{"current", "password"}`, rate limited |
| POST | `/api/auth/passkey/login/start`, `/finish` | Public | Passkey sign-in |
| POST | `/api/auth/passkey/register/start`, `/finish` | Session | Add a passkey |
| GET | `/api/auth/passkeys` | Session | List passkeys |
| DELETE | `/api/auth/passkeys/{id}` | Session | Remove a passkey |
| GET, POST | `/api/c/{coll}` | Session | List or create records |
| PATCH, DELETE | `/api/c/{coll}/{id}` | Session | Change or delete a record |
| GET, PUT | `/api/settings/{key}` | Session | Read or write an allowed setting |
| POST | `/api/notify/preview` | Session | Render templates with sample events |
| POST | `/api/notify/test/{id}` | Session | Send a test through a channel |
| GET | `/api/system/version` | Session | Version and install type |
| POST | `/api/system/check` | Session | Ask GitHub for the latest release, on the chosen channel |
| POST | `/api/system/update` | Session | Request a package upgrade |
| POST | `/api/mcp/tokens` | Session | Create an MCP token |
| POST | `/mcp`, `/mcp/{token}` | Token, HTTPS | MCP endpoint |

`/api/c/{coll}` reaches an allow-list of collections per server, and hides secret fields.
It accepts `sort`, `filter`, `page` and `perPage`.

Settings: `thresholds`, `maintenance` (with `retention_days` and `agent_beta`), `tempo`, `meross`,
`proxmox` and `updates` on the monitor. `link`, `nextcloud`, `proxmox`, `updates` and
`reminders` (`task_days`, `warranty_days`) on the manager. `updates` holds `{"beta": true}` to include beta versions.

## Monitor

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/overview` | Session | Fleet summary |
| GET, POST | `/api/hosts` | Session | List hosts, or add one. `parent` must be a physical or Proxmox host, and a name can only be used once. Each host carries its `vpn` tunnels |
| GET, DELETE | `/api/hosts/{id}` | Session | Host details, or delete it. Its LXC containers go with it, other children stay at the top level |
| GET | `/api/hosts/{id}/install` | Session | Generated install line and Ansible variables. `?url=` sets the address the host reaches the monitor at, by default `NYX_PUBLIC_URL` |
| POST | `/api/hosts/{id}/command` | Session | Queue a command for the agent |
| GET | `/api/hosts/{id}/logs/live` | Session | Live log lines after `?after=<seq>`, with the new `seq` and whether the agent is `connected`. Each request keeps the live view running for 15 seconds |
| GET | `/api/series` | Session | CPU and memory history, of a host with `?host=`, else the fleet average. `?range=1h\|24h\|7d\|30d\|90d\|180d\|365d` |
| GET | `/api/map` | Session | Nodes of the [map](monitoring.md#map): name, state, type, parent, saved place, details and link. Places are the `map_layout` setting |
| GET | `/api/containers` | Session | Docker containers across hosts |
| GET | `/api/storage` | Session | Disks and SMART across hosts |
| GET | `/api/logs` | Session | Recent log lines, `?host=&q=`. A line reads `<epoch> <<priority>> <service>: <message>` |
| GET | `/api/probes` | Session | Probes and latest results |
| POST | `/api/probes/reload` | Session | Apply probe changes now |
| GET | `/api/probes/{id}/series` | Session | Latency or SNMP history, `?metric=&range=` |
| GET | `/api/integrations/tempo` | Session | EDF Tempo days |
| POST | `/api/integrations/tempo/calendar` | Session | Send the season's Tempo days to the Nextcloud calendar. Returns `{"sent": n}` |
| GET | `/api/integrations/power` | Session | Meross power |
| GET, POST | `/api/pages` | Session | List pages, or create one |
| PATCH, DELETE | `/api/pages/{id}` | Session | Change or delete a page |
| POST | `/api/pages/{id}/key` | Session | Replace a wall's private link |
| POST | `/api/pages/preview` | Session | Render an unsaved page |
| GET | `/api/public/pages/{slug}` | Key | Filtered page data. A wall with a rotation also returns `rotation`: `count` and `seconds` |
| GET | `/api/public/pages/{slug}/{step}` | Key | Page at that position of a wall's rotation, with the first wall's key |
| GET | `/status/{slug}` | Public | The status page itself, framable if the page allows it |
| POST | `/api/link/token` | Session | Create the manager link token |
| GET | `/api/link/hosts` | Link | Hosts for the manager |
| POST | `/api/link/hosts/{id}/deploy` | Link | Queue a deploy |
| GET | `/api/link/results/{id}` | Link | Result of a command |
| GET | `/install.sh` | Public | Agent installer |
| GET | `/agent/v1/binary/{name}` | Public | Agent binary. Signed for agents |
| POST | `/api/hosts/update-all` | Session | Upgrade every online host and its agent. Returns `{"started": n}` |
| POST | `/agent/v1/report` | Agent | Metrics up, commands down |
| POST | `/agent/v1/logs` | Agent | Live log lines, while the last report answer asked for them |

Commands take `{"action": ...}`, one of `check_updates`, `update_system`, `update_agent`
or `set_kind` with `kind` and `ct_autoinstall`, which watches LXC containers. `update_system` and `update_agent` are
refused while an update runs on that host.

Each host in `/api/hosts` carries `reboot_required`, and `update` once one was sent:
`{"started", "done", "pct", "step", "error"}`, kept in memory.

## Manager

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/overview` | Session | Inventory summary |
| GET | `/api/ipam/report` | Session | Usage and conflicts |
| GET | `/api/ipam/next/{subnet}` | Session | Next free address |
| POST | `/api/ipam/simulate` | Session | Trace a route, `{"from", "destination"}` |
| GET | `/api/map/export/{format}` | Session | `svg`, `drawio`, `mermaid`, `dot` or `json` |
| POST | `/api/map/import` | Session | Add monitored hosts to the map |
| GET, POST | `/api/tasks` | Session | List tasks, or create one |
| PATCH, DELETE | `/api/tasks/{id}` | Session | Change or delete a task. `status` is `todo`, `doing`, `done` or `cancelled`, `tags` is comma separated. Syncs to Nextcloud |
| POST | `/api/sync` | Session | Sync Nextcloud and the monitor now |
| GET | `/api/monitor/hosts` | Session | Hosts from the linked monitor |
| POST | `/api/sites` | Session | Create a site and its deploy key |
| POST | `/api/sites/{id}/deploy` | Session | Deploy now |
| GET | `/api/sites/{id}/details` | Session | Public key, webhook URL and secret |
| POST | `/hooks/git/{id}` | Signature | Git forge webhook |

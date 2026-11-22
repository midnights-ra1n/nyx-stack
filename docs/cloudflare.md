# Cloudflare relay

The relay is a Cloudflare Worker in front of a Nyx server. It gives the server a public
HTTPS address without opening a port, without exposing your home IP, and without
trusting Cloudflare with your data. Agents and browsers encrypt every request with a
key that Cloudflare never receives, and the Worker only forwards ciphertext.

The Worker also watches the server from the outside. If the server goes silent, it sends
a webhook, and it serves a public uptime page that stays up even when your home
connection is down. It can probe your public sites from Cloudflare's network too.

```
 agents   ─┐                                       ┌──────────────────────────┐
 browsers ─┼── one WebSocket each, /_relay/ws ───►│ Cloudflare Worker        │
 nyx-mcp  ─┘   sealed with the relay key          │  Durable Object "Relay"  │
                                                  │  · forwards sealed bytes │
  visitors ──── GET /_status ────────────────────►│  · uptime checks, alerts │
                                                  └────────────▲─────────────┘
                                                               │ one outbound WebSocket,
                                                               │ opened by the server
                                                  ┌────────────┴─────────────┐
                                                  │ nyx-monitor / nyx-manager│  at home,
                                                  │ opens, answers, seals    │  no open port
                                                  └──────────────────────────┘
```

The server keeps all its features: ICMP and SNMP probes, PocketBase, Shoutrrr
notifications and everything else still run at home. The Worker runs no Nyx logic. It
only relays.

## Why not run Nyx itself on Workers

Code that runs in a Worker runs on Cloudflare's machines. Alerts, charts and inventories
computed there would exist there in clear, under US jurisdiction (the CLOUD Act lets US
authorities compel a US provider to hand over data it holds, wherever it is stored). Nyx
also needs things a Worker cannot do: ICMP, SNMP, a LAN, PocketBase, local processes. So
the logic stays with you, and Cloudflare gets the one job that needs no trust:
moving bytes it cannot read.

## What Cloudflare can and cannot see

| | Cloudflare sees |
| --- | --- |
| Metrics, logs, inventories, IPAM, settings, alerts | No. They are sealed with AES-256-GCM |
| Passwords, session cookies, agent tokens and signatures | No. They travel inside the sealed envelope |
| Which page you open, which API call is made | No. The path is inside the envelope; every call is a frame on `/_relay/ws` or a `POST /_relay` |
| What an AI client asks over MCP, and the answers | No, through [`nyx-mcp`](integrations.md#through-the-cloudflare-relay), which seals them on your computer |
| The relay key | No. It sits in the `#` fragment of the link, which browsers never send, and in the agent's config |
| That a request happened, its size and time, the client's IP | Yes. That is metadata and cannot be hidden from the network that carries it |
| The web interface's code, `install.sh`, agent binaries | Yes. They are public, open-source files, served in clear |
| Public status pages | Yes. Anyone may read them, so they go in clear. Wall displays do not: they are sealed |
| The edge probes' addresses and results, the uptime page, the alert texts | Yes. Probing a site from Cloudflare means Cloudflare knows the site |
| The Worker's secrets (`RELAY_SECRET`, `ALERT_WEBHOOK`) | Yes. The relay secret only lets a server attach to the relay. It cannot decrypt anything |

Each sealed request carries a timestamp and a random nonce. The server refuses replays
and requests more than 5 minutes off its clock. Each answer is sealed against the nonce
of its request, so the Worker cannot swap two answers. A tampered byte fails to open.
The server keeps its own checks inside the envelope: agents still sign reports with
their host key, and browsers still need a session.

### Limits

- **Code delivery.** The web interface, `install.sh` and the agent binary are served
  through Cloudflare. Encryption protects data, not code: a provider forced to *serve
  modified code* could defeat any web-based encryption, as with every webmail. This is
  far harder to compel than handing over stored data, but if it is in your threat
  model, install agents from GitHub packages or Ansible, and open the interface on your
  LAN or VPN.
- **Through the relay, the browser keeps the session itself**, in local storage next to
  the relay key, because the Worker's domain must never receive a cookie. Sign out on
  shared computers.
- **MCP clients cannot seal**, so the Worker refuses `/mcp` from them. Run
  [`nyx-mcp`](integrations.md#through-the-cloudflare-relay) on your computer: Claude
  Desktop, Claude Code, Codex and other clients that start local MCP servers talk to it,
  and it seals for them. Hosted connectors, such as those of claude.ai or ChatGPT on the
  web, call a URL from their own servers and cannot run it. They need the server's own
  HTTPS address.
- **Wall display links carry the relay key** next to the wall's own key, so a screen
  that has one can reach the sign-in page. Replace the wall's link if it leaks, and the
  relay key if that matters to you.
- **Passkeys** are bound to one domain. Give the Worker a domain of your own, set
  `NYX_PUBLIC_URL` to it, and point the same name at the server on your LAN (split DNS):
  one passkey then works both ways.

## Set it up

You need a Cloudflare account (the free plan works, see [costs](#costs)), Node.js 20 or
later, and pnpm. Deploy one Worker per server: one for the monitor and, if you use it,
one for the manager.

### 1. Make the two secrets

```sh
openssl rand -hex 24   # relay secret: lets your server attach to the Worker
openssl rand -hex 32   # relay key: encrypts everything; never give it to Cloudflare
```

Keep both somewhere safe. The relay key is what agents and browsers will need.

### 2. Deploy the Worker

The Worker serves the web interface, so build it first.

```sh
cd web && pnpm install && pnpm build && cd ..
cd relay && pnpm install
pnpm exec wrangler login
pnpm exec wrangler secret put RELAY_SECRET        # paste the relay secret
pnpm exec wrangler secret put ALERT_WEBHOOK       # optional, see "Alerts"
pnpm run deploy
```

Wrangler prints the address, such as `https://nyx-relay.you.workers.dev`. For the
manager, add `--env manager` to the `secret put` commands, with a different relay secret
and key, then run `pnpm run deploy:manager`. To use your own domain, add a route or a
custom domain to the Worker in the Cloudflare dashboard.

Options are in `relay/wrangler.toml`, under `[vars]`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `NAME` | `Nyx monitor` | Name on the uptime page and in alerts |
| `STATUS_PAGE` | `on` | `off` hides `/_status` |
| `DOWN_AFTER` | `2` | Failed one-minute checks in a row before something counts as down |
| `PROBES` | `[]` | [Edge probes](#edge-probes) |

### 3. Link the server

Set three variables on the server, next to the others ([configuration](configuration.md#servers)),
and restart it:

```sh
NYX_RELAY_URL=https://nyx-relay.you.workers.dev
NYX_RELAY_SECRET=<relay secret>
NYX_RELAY_KEY=<relay key>
NYX_PUBLIC_URL=https://nyx-relay.you.workers.dev   # so install lines and passkeys use it
```

With Docker, the same values go in `.env` as `NYX_MONITOR_RELAY_URL`,
`NYX_MONITOR_RELAY_SECRET` and `NYX_MONITOR_RELAY_KEY` (`NYX_MANAGER_…` for the manager).
The server's log shows `relay: linked to wss://…`. It reconnects on its own, and
the link needs no inbound port: you may close the server's port to everything but your
LAN.

### 4. Open it in a browser

In **Settings, This server**, the **Cloudflare relay** row shows the link state, with a
link below it ending in `#relay=…`. Open that link once on each device. The page keeps
the key and removes it from the address bar. Opening the Worker's address without it
asks for the key.

### 5. Agents

**Add host** gives install lines with `--relay-key` when the monitor URL is the Worker's
address. Existing agents need `NYX_RELAY_KEY=<relay key>` added to `/etc/nyx/agent.conf`,
and their `NYX_URL` changed to the Worker's address. See [agent.md](agent.md#through-the-cloudflare-relay).
They keep [one WebSocket](agent.md#one-connection) to the Worker.

### 6. The manager's link to the monitor

When the monitor is only reachable through its Worker, give the manager that address in
**Settings, Integrations, Nyx Monitor**, with the monitor's relay key in **Monitor's
relay key**: the part after `#relay=` of the monitor's link. The manager then seals its
calls like a browser. The manager can sit behind a relay of its own at the same time.

### 7. Status pages, wall displays and MCP

Public status pages work at `https://<worker>/status/<address>` with nothing to set up.
A wall display's private link, copied while you use the interface through the relay,
ends with `&relay=…`: open it once on the screen. For MCP, see
[nyx-mcp](integrations.md#through-the-cloudflare-relay).

## Uptime

The Worker checks, every minute, that the server is linked and answering, and runs the
edge probes. Results are kept for 90 days in the Durable Object's SQLite storage, as
one counter per check and per day.

### Who watches the monitor

The server sends a heartbeat on its link every 30 seconds, and the Worker answers it
without waking up. If no heartbeat arrives for 90 seconds, the check fails. After
`DOWN_AFTER` failed checks the server counts as down and an alert goes out, and another
when it comes back. A power cut, a lost internet connection, a crash or a stopped server
all look the same, which is the point: Nyx cannot report its own outage, the Worker can.

### Uptime page

`https://<worker>/_status` shows the server and each probe: current state, uptime over 24
hours, 7 and 30 days, and one bar per day for 30 days. `/_status.json` gives the same as
JSON. The page is public and holds only names and states. Set `STATUS_PAGE = "off"` to
hide it.

### Edge probes

Probes run from Cloudflare's network, so they show what the internet sees, which a
probe from home cannot. List them in `PROBES`:

```toml
PROBES = '[{"name": "Blog", "url": "https://blog.example.org"}, {"name": "SSH", "url": "tcp://ssh.example.org:22"}]'
```

An `https://` or `http://` probe is up when the answer, after redirects, is below 400
within 10 seconds. A `tcp://host:port` probe is up when the port accepts a connection.
Cloudflare sees these addresses and the results. Probe only what is public anyway, and
keep private targets on the monitor's own probes.

### Alerts

Set `ALERT_WEBHOOK` to a webhook URL. All changes of a minute go out as one POST, with
the same text in several fields so most services read it as is:

```json
{ "title": "Nyx monitor: down", "message": "🔴 Nyx monitor server is down", "text": "…", "content": "…" }
```

| Service | Webhook URL |
| --- | --- |
| Discord | the channel webhook URL (`content`) |
| Slack, Mattermost | an incoming webhook URL (`text`) |
| Gotify | `https://gotify.example.org/message?token=…` (`title`, `message`) |
| ntfy | `https://ntfy.sh/your-topic?tpl=1&t={{.title}}&m={{.message}}` |

The Worker cannot use Shoutrrr, so these alerts are separate from the server's
[notifications](notifications.md). They are only about the server and the edge probes.

## Costs

Agents and browsers keep one WebSocket open to the Worker and send their calls over it.
Opening it is one Worker request. After that, Cloudflare bills a message it receives as
a twentieth of a Durable Object request and does not count it as a Worker request. A
call is two received messages (the client's and the server's answer), so a tenth of a
request:

| | Worker requests a day | Durable Object requests a day |
| --- | --- | --- |
| A host at the idle pace of one report a minute (see [report pace](agent.md#report-pace)) | about 1 | 144 |
| A host while someone has the interface open (every 15 s) | about 1 | 576 |
| A visible browser tab, for each API call its page refreshes every 15 s | about 1 | 576 |
| A visitor of a public status page, refreshing every 30 s | 2,880 | 2,880 |
| The manager's link to a monitor behind its relay | about 300 | about 300 |
| An MCP question through `nyx-mcp` | a few | a few |

The free plan allows 100,000 of each a day. A hundred hosts and a wall display open all
day take about 16,000 Durable Object requests and a handful of Worker requests. Public
status pages are what can grow: each visitor's refresh is one request of each kind. The
paid plan includes 10 million requests a month.

The server's link, its heartbeat and idle sockets use WebSocket hibernation, so an idle
relay costs almost nothing. Check Cloudflare's current prices, as they change.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `the Nyx server is offline: it has no link to the relay` | The server is down, or its `NYX_RELAY_URL` or `NYX_RELAY_SECRET` is wrong. See its log |
| Server log: `bad relay secret`, HTTP 401 | `NYX_RELAY_SECRET` differs from the Worker's `RELAY_SECRET` |
| The browser asks for the relay key again | The key it holds is wrong, or local storage was cleared. Open the link from Settings |
| `request replayed, or this device's clock is off` | The device's clock is more than 5 minutes off the server's |
| Agent log: `relay answer does not open with the relay key` | The agent's `NYX_RELAY_KEY` differs from the server's |
| Agent log: `websocket to … unavailable, using HTTPS for 10 minutes` | The Worker predates agent sockets: run `pnpm run deploy` again. Reports still arrive meanwhile, one request each |
| Manager: `relay: 428` or `relay answer does not open` on the monitor link | The monitor's relay key is missing or wrong in the manager's settings |
| A status page stays empty through the Worker | The Worker predates public pages: run `pnpm run deploy` again |
| `/_status` shows nothing | No check has run yet. Checks start when the server first links |

## Develop

```sh
cd relay
echo "RELAY_SECRET=$(openssl rand -hex 24)" > .dev.vars
pnpm exec wrangler dev        # http://localhost:8787
```

Then start a server with `NYX_RELAY_URL=http://localhost:8787` and the same secret.
`pnpm test` runs the Worker's tests, and `pnpm run check` its type check. The envelope
is defined once per language, in `crates/nyx-proto/src/relay.rs` and
`web/src/ui/envelope.ts`, and each side has a test that opens what the other sealed.

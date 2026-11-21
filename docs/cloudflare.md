# Cloudflare relay

The relay is a Cloudflare Worker in front of a Nyx server. It gives the server a public
HTTPS address without opening a port, without exposing your home IP, and without
trusting Cloudflare with your data. Agents and browsers encrypt every request with a
key that Cloudflare never receives, and the Worker only forwards ciphertext.

The Worker also watches the server from the outside. If the server goes silent, it sends
a webhook, and it serves a public uptime page that stays up even when your home
connection is down. It can probe your public sites from Cloudflare's network too.

```
 agents ─┐   sealed with the relay key            ┌──────────────────────────┐
         ├──── HTTPS POST /_relay ───────────────►│ Cloudflare Worker        │
browsers ┘   (Cloudflare sees ciphertext)         │  Durable Object "Relay"  │
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
| Which page you open, which API call is made | No. The path is inside the envelope; every call is `POST /_relay` |
| The relay key | No. It sits in the `#` fragment of the link, which browsers never send, and in the agent's config |
| That a request happened, its size and time, the client's IP | Yes. That is metadata and cannot be hidden from the network that carries it |
| The web interface's code, `install.sh`, agent binaries | Yes. They are public, open-source files, served in clear |
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
- **MCP is not relayed.** MCP clients cannot seal requests, and their answers describe
  your whole infrastructure, so `/mcp` is refused by the Worker. Use MCP on the server's
  own HTTPS address.
- **Public status pages and wall displays of the monitor** are not served through the
  relay, for the same reason. The Worker has its own [uptime page](#uptime-page).
- **Passkeys** are bound to one address. Set `NYX_PUBLIC_URL` to the Worker's address to
  use them through the relay.

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

Each agent report is one Worker request and one Durable Object request, so hosts set the
volume. At the idle pace of one report a minute, a host makes 1,440 requests a day, and
up to 5,760 while someone has the interface open (see [report pace](agent.md#report-pace)).
The Workers free plan allows 100,000 requests a day, which is about 50 hosts with
headroom for browsing. The paid plan includes 10 million requests a month. The link and
the heartbeat use WebSocket hibernation, so an idle relay costs almost nothing. Check
Cloudflare's current prices, as they change.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `the Nyx server is offline: it has no link to the relay` | The server is down, or its `NYX_RELAY_URL` or `NYX_RELAY_SECRET` is wrong. See its log |
| Server log: `bad relay secret`, HTTP 401 | `NYX_RELAY_SECRET` differs from the Worker's `RELAY_SECRET` |
| The browser asks for the relay key again | The key it holds is wrong, or local storage was cleared. Open the link from Settings |
| `request replayed, or this device's clock is off` | The device's clock is more than 5 minutes off the server's |
| Agent log: `relay answer does not open with the relay key` | The agent's `NYX_RELAY_KEY` differs from the server's |
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

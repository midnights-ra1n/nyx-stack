# Integrations

All integrations are off until configured.

## Nextcloud

Manager, **Settings, Integrations**. Tasks and calendar sync over CalDAV.

| Field | Value |
| --- | --- |
| URL | `https://cloud.example.com` |
| User | Your Nextcloud user |
| App password | From **Personal settings, Security**. Do not use your main password |
| Calendar | The name in the calendar's link, for example `personal` |

- Changes made in Nyx are sent right away. If Nextcloud is unreachable, they are
  retried at the next sync.
- CalDAV cannot push to clients, so Nyx polls every 30 seconds. It only downloads data
  when the calendar's change tag moved, so an idle poll is one small request.
- Calendar events are shown read-only. Edit them in Nextcloud.
- Task states and tags sync too: to do, in progress, done and cancelled are the
  `STATUS` values of a task, and tags are its `CATEGORIES`. A comma cannot be part of a
  tag: Nyx turns it into a space.
- When a task changes on both sides between two syncs, the Nextcloud version wins.
- Times with a time zone (`TZID`) are read as UTC for now, so a due time can be off by
  your UTC offset.

## EDF Tempo

1. Create an application on the [RTE data portal](https://data.rte-france.com).
2. Subscribe that application to the *Tempo Like Supply Contract* API. Keys alone are
   not enough: without the subscription RTE refuses the calendar.
3. In the monitor, **Settings, Integrations**, paste the client ID and secret, then
   **Save**.
4. Press **Test the connection**. It asks RTE at once and shows its answer.
5. On the overview, press **Customize** and add the **EDF Tempo** panel, hidden by
   default. It shows today, tomorrow and the days left.

The monitor calls RTE itself, over HTTPS, so your browser's connection does not matter:
Tempo works with Nyx on plain HTTP. The monitor needs outbound access to
`digital.iservices.rte-france.com`. Answers are kept for an hour, and saving new keys
drops them.

Display pages have an **EDF Tempo** panel with the same tiles: the colours of today and
tomorrow, and the days left. It refreshes on its own, once an hour.

To be told tomorrow's colour, tick **EDF Tempo colour of tomorrow** in a notification
rule. The event comes once a day, within the hour after RTE publishes it, around 11:00.
A red day has the severity `warn`, the others `info`.

### Tempo days in a Nextcloud calendar

The monitor can copy each Tempo day into a Nextcloud calendar, as an all-day event
named `🔵 Bleu`, `⚪️ Blanc` or `🔴 Rouge`, in the matching colour. Events leave the day
free, so they do not count as busy time.

1. In Nextcloud, create a calendar for it, and an app password under **Personal
   settings, Security**.
2. In the monitor, **Settings, Integrations, EDF Tempo in Nextcloud**, enter the
   Nextcloud URL, your user, the app password and the calendar's name, as it appears in
   its link. Then **Save**.
3. Press **Sync now**. It sends every day of the season so far and tells you what went
   wrong, if anything.

From then on the monitor checks every hour and sends new days. RTE publishes tomorrow's
colour around 11:00, so it appears within the following hour. Once tomorrow is in the
calendar, the monitor leaves RTE alone until the next day. **Sync now** also brings back
events you deleted.

This is separate from the manager's Nextcloud settings, because a monitor can run
without a manager. The two can point at the same calendar or at different ones. If the
hourly check fails, the reason goes to the monitor's log.

## Proxmox console

In either server's **Settings**, fill in **Proxmox console**: the URL (for example
`https://pve.lan:8006`) and either a **user with its realm and password** (`root@pam`) or an
**API token** (`user@realm!name=secret`). **Test the connection** checks them. Tick
**Accept a self-signed certificate** while Proxmox still uses the one it made itself; it only
applies to the calls Nyx makes.

A **Console** button then opens noVNC for a guest, or the shell of a node, in a new tab. The
button goes through Nyx, which asks Proxmox for a login ticket and passes it to your browser
as the `PVEAuthCookie` Proxmox itself would set:

- with a **password**, the console opens already signed in **when Nyx and Proxmox share a
  domain** (`nyx.home.lan` and `pve.home.lan`, or the same host on two ports), as a browser
  only sends a cookie to hosts of the domain that set it. Elsewhere, such as two IP
  addresses, Proxmox shows its sign-in page, as before
- an **API token** checks the connection but cannot sign a browser in: Proxmox does not
  accept tokens in its interface

The password and token are stored in Nyx's database and shown to signed-in users in the
settings, like the other keys. Prefer a dedicated Proxmox user with the `PVEVMConsole` role
to `root@pam`.

## Meross plugs

Monitor, **Settings, Integrations, Meross plugs**.

1. **Sign in** with your Meross account (e-mail and password). Nyx calls the Meross cloud
   once to get the key that signs requests to your plugs, then forgets the password. It
   follows the regional server your account lives on. Sign in again if the key stops working.
2. **Add each plug** with a name, its **IP address** and its **MAC address**.

After that, plugs are read over the local network only, never through the Meross cloud. On
every reading Nyx asks the plug for its MAC address and compares: if the address now belongs
to another device, the plug is reported in the settings and skipped, rather than showing the
wrong device's power. Give your plugs a fixed address in your router. A plug saved without a
MAC, by an earlier version, is read without that check until you add it.

The sign-in follows the protocol documented by the community
[meross-iot](https://github.com/albertogeniola/MerossIot) project, and is not tested against a
physical plug or account.

## MCP server

Lets AI assistants read your infrastructure. All tools are read-only.

Available only over HTTPS: plain HTTP gets a 403. Create a token in **Settings,
Security**. It is shown once and only its hash is stored.

The endpoint is `https://your-server/mcp`, using Streamable HTTP.

```sh
claude mcp add --transport http nyx https://monitor.example.com/mcp \
  --header "Authorization: Bearer TOKEN"
```

For clients that cannot set headers, put the token in the URL:
`https://monitor.example.com/mcp/TOKEN`. Treat that URL as a password. Hosted
connectors, on claude.ai for instance, must be able to reach your server from the
internet and may insist on OAuth, which Nyx does not implement.

| Server | Tools |
| --- | --- |
| Monitor | `infrastructure_status`, `list_hosts`, `get_host`, `list_alerts`, `list_probes`, `list_pipelines` |
| Manager | `list_hardware`, `list_virtual`, `ipam_report`, `list_deployments`, `list_tasks`, `list_vpn_links`, `trace_route` |

Example prompt: *"Give me the overall state of my infrastructure."*

## Passkeys

Add them in **Settings, Security**. They need an `https://` `NYX_PUBLIC_URL`, and a
passkey is bound to that domain: changing the domain means registering a new one.

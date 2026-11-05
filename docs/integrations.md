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
- When a task changes on both sides between two syncs, the Nextcloud version wins.
- Times with a time zone (`TZID`) are read as UTC for now, so a due time can be off by
  your UTC offset.

## EDF Tempo

Monitor, **Settings, Integrations**. Create an application on the
[RTE data portal](https://data.rte-france.com), subscribe to the *Tempo Like Supply
Contract* API, and paste the client ID and secret. The overview's Tempo panel, hidden
by default, shows today, tomorrow and the days left.

## Proxmox console

In either server's settings, enter the Proxmox URL. A **Console** button opens noVNC in
a new tab, in the Proxmox interface. Nyx does not store Proxmox credentials: you sign
in there.

## Meross plugs

Monitor, **Settings, Integrations**. List plugs as `name=ip`, one per line. Plugs are
read over the local network only, never through the Meross cloud. Nyx needs the
device key, which is tied to your Meross account: it can be extracted with community
tools such as `meross-iot`, and is not available in the Meross app. Tested against
protocol documentation, not a physical plug.

## MCP server

Lets AI assistants read your infrastructure. All tools are read-only.

Available only over HTTPS: plain HTTP gets a 403. Create a token in **Settings,
Access**. It is shown once and only its hash is stored.

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
| Monitor | `infrastructure_status`, `list_hosts`, `get_host`, `list_alerts`, `list_probes` |
| Manager | `list_hardware`, `list_virtual`, `ipam_report`, `list_deployments`, `list_tasks`, `trace_route` |

Example prompt: *"Give me the overall state of my infrastructure."*

## Passkeys

Add them in **Settings, Access**. They need an `https://` `NYX_PUBLIC_URL`, and a
passkey is bound to that domain: changing the domain means registering a new one.

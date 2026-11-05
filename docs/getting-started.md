# Getting started

This guide takes you from nothing to a monitored host with an alert on your phone. It
uses Docker. For packages, see [deployment.md](deployment.md).

> **Before the first release,** the images in this guide are not published yet. See
> [Project status](../README.md#project-status).

## 1. Start the servers

```sh
mkdir nyx && cd nyx
curl -fsSLO https://raw.githubusercontent.com/midnights-ra1n/nyx-stack/main/packaging/docker/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/midnights-ra1n/nyx-stack/main/packaging/docker/.env.example
```

In `.env`, set `NYX_PB_PASSWORD` (`openssl rand -hex 24`) and the two public URLs. Then:

```sh
docker compose --profile monitor --profile manager up -d
```

Skip a profile if you only want one role.

## 2. Create your account

Open the monitor on port 8081. The first visit asks for an email and a password. If both
servers share a database, the same account works on the manager, on port 8082.

## 3. Add a host

1. In the monitor, open **Hosts**, then **Add host**.
2. Enter a name and pick the type: VM, physical, Proxmox or VPS.
3. Copy the line and run it on the host, as root.

The host appears within 15 seconds. To use Ansible instead, see
[agent.md](agent.md#ansible).

## 4. Add a probe

In **Network**, add a probe: a website to watch, for example. SNMP presets cover
common equipment, see [monitoring.md](monitoring.md#snmp).

## 5. Get notified

In **Settings, Notifications**:

1. Add a channel, and use **Test** to check it.
2. Add a rule: for example, state changes grouped at most every 10 minutes, and
   updates in a monthly digest.

See [notifications.md](notifications.md).

## 6. Link the manager

To fill the inventory from your agents, follow
[Linking manager and monitor](deployment.md#linking-manager-and-monitor).

## 7. Install it on your phone

Open Nyx in your phone's browser and add it to the home screen. It behaves like an app
and refreshes each time you come back to it.

## Next

- Publish a [status page](status-pages.md), or put a [wall display](status-pages.md) in a room.
- Turn on HTTPS: it is needed for [MCP and passkeys](integrations.md), and protects your
  agents' traffic.
- Read [security.md](security.md) before exposing anything to the internet.

# Deployment

Pick Docker or packages for the servers. Agents can use any method: see
[agent.md](agent.md).

> **Before the first release,** the images and packages below do not exist yet. Build
> them from source as described in [development.md](development.md), or with
> `make bins packages`. Neither path has been run end to end on Linux so far.

## Docker

Images are published for `linux/amd64` and `linux/arm64`:
`ghcr.io/midnights-ra1n/nyx-{monitor,manager,db,agent}`.

```sh
cp .env.example .env   # from packaging/docker/
# Set the public URLs.
docker compose --profile monitor --profile manager up -d
```

Use one profile for one role. A local database needs nothing else to run. For a shared
one, also set `NYX_DB_PASSWORD` (`openssl rand -hex 24`), add `--profile db`, and enter
`http://db:8090` at the [first start](#choosing-a-database). Back up the `monitor-data`,
`manager-data` and `db-data` volumes.

The monitor's compose service sets `net.ipv4.ping_group_range` so ICMP probes work
as a non-root user. If your platform forbids this sysctl, add `cap_add: [NET_RAW]`
and run the container as root.

Updating: `docker compose pull && docker compose up -d`. `NYX_VERSION` in `.env` picks
the [channel](#release-channels) or a fixed version.

## Choosing a database

The first time you open a server, it asks where to keep its data:

| Choice | Data | Accounts | Needs |
| --- | --- | --- | --- |
| **Local** | Inside this server | Its own | Nothing |
| **Remote** | On a `nyx-db` server | Shared with the other server, if it connects too | `nyx-db`, reachable from the server |

To go remote, install `nyx-db` where the data should live, then enter its URL, email and
password on both servers: `/etc/nyx/db.env` holds the last two with packages. On a
public network put it behind an HTTPS reverse proxy, because the screen refuses plain
HTTP to a public address. The second server finds the accounts already there and shows
the sign-in page. Passkeys stay bound to the address they were created on.

Upgrade `nyx-db` first: it applies new schema changes that the servers rely on.

The choice is saved in `database.json` in the data directory. To skip the screen, as with
Ansible, set [variables](configuration.md#servers). Changing it later does not move any
data, see [troubleshooting](troubleshooting.md#a-server-does-not-start-after-a-database-was-chosen).

## Monitor and manager on separate machines

The monitor and the manager are two programs with two web interfaces, and they do not
have to be in the same place. With local databases nothing is shared, including
accounts: each interface has its own login. With a shared database they have one login.

[Linking them](#linking-manager-and-monitor) is optional.

Only the manager needs to reach the monitor. The monitor never calls the manager, so
a manager behind a home connection works with a monitor on a VPS. Use an HTTPS URL
when the link leaves your network, because the token travels with every request.

If the link goes down, each side keeps working. The manager keeps its inventory and
only stops refreshing it, and site deployments wait until the monitor is reachable
again. The monitor does not depend on the manager at all.

## Packages

Debian, Ubuntu, RHEL, Fedora and Alma, on x86_64 and arm64. Download from the
[releases page](https://github.com/midnights-ra1n/nyx-stack/releases).

| Package | Contents |
| --- | --- |
| `nyx-base` | `nyx-notify`, the updater. Required by both servers |
| `nyx-monitor` | The monitor with its database, and agent binaries for both architectures |
| `nyx-manager` | The manager with its database |
| `nyx-db` | The optional shared database, on its own |
| `nyx-agent` | The agent alone |

```sh
sudo apt install ./nyx-base_*.deb ./nyx-monitor_*.deb      # Debian, Ubuntu
sudo dnf install ./nyx-base-*.rpm ./nyx-monitor-*.rpm      # RHEL, Fedora, Alma
```

The first install creates the `nyx` user, a random database password in
`/etc/nyx/db.env` for `nyx-db`, and starts the services. Data lives in `/var/lib/nyx`.

Set the public URL, then restart:

```sh
echo 'NYX_PUBLIC_URL=https://monitor.example.com' | sudo tee -a /etc/nyx/monitor.env
sudo systemctl restart nyx-monitor
```

### Updating

In **Settings, Access, Software updates**, press **Check on GitHub**, then **Update**.
Tick **Include beta versions** to be offered betas as well, on each server you want
them on. See [Release channels](#release-channels).

The server is unprivileged, so it only leaves a request file. A root systemd unit,
`nyx-update.path`, then downloads the packages, checks them against the release's
`SHA256SUMS` and installs them. GitHub is contacted only when you press the button.

Agents update themselves from the monitor, once a day at the hour set in **Settings,
Monitoring**, when **Update agents automatically** is on. You can also force one from
the host page. They always take the version their monitor ships, so a monitor on beta
moves its agents to beta too.

## Release channels

| Channel | From branch | Release | Images |
| --- | --- | --- | --- |
| Stable | `stable` | Normal release, `v1.2.3` | `:stable`, `:latest`, `:1.2.3` |
| Beta | `beta` | Pre-release, `v1.2.3-beta.4` | `:beta`, `:1.2.3-beta.4` |

With Docker, set `NYX_VERSION=beta` in `.env`, then pull.

A beta leads up to the stable version of the same number, so a stable release is offered
once it is out. Unticking **Include beta versions** does not go back: the server stays on
its beta until a newer stable version exists.

## HTTPS

HTTPS is required for MCP and passkeys, and strongly recommended for agents.

**Reverse proxy.** Bind Nyx to localhost so the proxy is the only way in, set
`NYX_BIND=127.0.0.1:8081` and an `https://` `NYX_PUBLIC_URL`. The proxy must send
`X-Forwarded-Proto: https`. Caddy does this by default:

```
monitor.example.com {
    reverse_proxy 127.0.0.1:8081
}
```

**Native TLS.** Set `NYX_TLS_CERT` and `NYX_TLS_KEY`. Reload by restarting the service.

## Linking manager and monitor

1. In the monitor: **Settings, Access, Create link token**.
2. In the manager: **Settings, Integrations, Nyx Monitor**, enter the URL and token.

Creating a new token replaces the old one.

## Backups

Everything durable is in each server's data directory: back up `/var/lib/nyx/monitor`
and `/var/lib/nyx/manager`, or `/var/lib/nyx/db` on the `nyx-db` host, or the matching
volumes. Stop the server first, or use a tool that can copy a live SQLite database.

## Upgrading from a release with a separate database

Before embedding, one PocketBase served both roles. Each server now starts from a full
copy of that database, as a local one, so accounts and settings carry over and then
evolve separately. The existing `NYX_PB_*` credentials keep it that way, with no choice
to make.

With packages this is automatic, and `/var/lib/nyx/pb` stays until you delete it.

With Docker, copy the old volume before the first start. The `nyx` prefix is your compose
project name:

```sh
docker compose stop
for role in monitor manager; do
  docker volume create nyx_$role-data
  docker run --rm -v nyx_pb-data:/from -v nyx_$role-data:/to alpine \
    sh -c 'cp -a /from /to/pb_data && chown -R 10001 /to'
done
docker compose up -d --remove-orphans
```

## Ports

| Port | Service | Reachable from |
| --- | --- | --- |
| 8081 | Monitor | Users and agents |
| 8082 | Manager | Users, and Git forges for webhooks |
| Random, loopback only | Local database | Its own server |
| 8090 | `nyx-db` | The servers only. Private network or HTTPS |

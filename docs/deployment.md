# Deployment

How to install, run, update and remove Nyx with Docker or with `.deb` and `.rpm`
packages. Agents can use any method: see [agent.md](agent.md).

The commands below install the stable channel. To follow beta instead, see
[release channels](#release-channels). To build from source, see
[development.md](development.md) or `make bins packages`.

## Which method to pick

| | Docker | Packages (`.deb`, `.rpm`) |
| --- | --- | --- |
| Systems | Anything that runs Docker | Debian, Ubuntu, RHEL, Fedora, Alma with systemd |
| Architectures | `linux/amd64`, `linux/arm64` | `amd64`/`x86_64`, `arm64`/`aarch64` |
| Updating | `docker compose pull`, then `up -d` | A button in the UI, or by hand |
| Data | Named volumes | `/var/lib/nyx` |
| Settings | `.env` | `/etc/nyx/*.env` |
| Agent on the same machine | Prefer the package: the container cannot apply system updates | Same package as any other host |

Both give the same servers. You can run the monitor one way and the manager the other.

## Docker

### What you need

- Docker Engine with the Compose plugin, so that `docker compose version` answers.
- The ports in [Ports](#ports) free on the machine.
- A public URL for each server. Plain `http://192.168.1.10:8081` is fine to start with,
  but passkeys and MCP need [HTTPS](#https).

Images are published for `linux/amd64` and `linux/arm64`, and Docker picks the right one:
`ghcr.io/midnights-ra1n/nyx-{monitor,manager,db,agent}`. Each server container runs as
the unprivileged user `nyx` (uid 10001).

### 1. Get the files

```sh
mkdir nyx && cd nyx
curl -fsSLO https://raw.githubusercontent.com/midnights-ra1n/nyx-stack/stable/packaging/docker/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/midnights-ra1n/nyx-stack/stable/packaging/docker/.env.example
```

The folder name becomes the prefix of your volumes (`nyx_monitor-data`), so keep it.

### 2. Fill in `.env`

| Variable | Needed for | Meaning |
| --- | --- | --- |
| `NYX_VERSION` | All | `latest` by default, or `stable`, `beta`, or a fixed version such as `0.1.0` |
| `NYX_MONITOR_URL` | Always | The URL users and agents reach the monitor on |
| `NYX_MANAGER_URL` | Always | The URL users reach the manager on |
| `NYX_DB_EMAIL` | `db` profile | Superuser of the shared database |
| `NYX_DB_PASSWORD` | `db` profile | Its password: `openssl rand -hex 24` |
| `NYX_AGENT_URL`, `NYX_AGENT_TOKEN`, `NYX_AGENT_KEY`, `NYX_AGENT_KIND` | `agent` profile | See [Agent in a container](#agent-in-a-container) |

Keep both URL lines even if you run a single role: Compose reads the whole file, and an
unset URL stops it with `set it in .env`. Agents use `NYX_MONITOR_URL` to call home, so it
must be reachable from them, and `localhost` will not do.

Any other [server variable](configuration.md#servers) goes under `environment:` in
`compose.yaml`.

### 3. Start what you want

Profiles pick the roles. Nothing starts without one.

```sh
docker compose --profile monitor --profile manager up -d   # both
docker compose --profile monitor up -d                     # monitoring only
docker compose --profile manager up -d                     # management only
```

For one shared login across both, add the database. It needs `NYX_DB_PASSWORD`:

```sh
docker compose --profile monitor --profile manager --profile db up -d
```

To avoid repeating the profiles, add `COMPOSE_PROFILES=monitor,manager` to `.env`, and
every command below becomes a plain `docker compose ...`.

### 4. Check it, then open it

```sh
docker compose --profile monitor --profile manager ps      # both should be "running"
docker compose logs -f monitor                             # ends with "listening on"
curl -s http://localhost:8081/api/health                   # answers ok
```

Open port 8081 or 8082. The first page asks [where to keep the data](#choosing-a-database):
**Local** needs nothing else. For a shared one choose **Remote**, enter `http://db:8090`
and the `NYX_DB_*` values. Then create your account.

### 5. Put HTTPS in front

If a reverse proxy runs on the same machine, stop publishing the ports to the network.
Create `compose.override.yaml` next to `compose.yaml` (`!override` needs a recent
Compose):

```yaml
services:
  monitor:
    ports: !override
      - 127.0.0.1:8081:8081
  manager:
    ports: !override
      - 127.0.0.1:8082:8082
```

Then set the `https://` URLs in `.env`, run `up -d` again and follow [HTTPS](#https).

### ICMP probes

The monitor's service sets `net.ipv4.ping_group_range` so ICMP probes work as a non-root
user. If your platform forbids this sysctl, add `cap_add: [NET_RAW]` and run the container
as root (`user: root`).

### Data and backups

| Volume | Contents |
| --- | --- |
| `nyx_monitor-data` | The monitor's database, its choice of database, and its local accounts |
| `nyx_manager-data` | The same for the manager |
| `nyx_db-data` | The shared database, with the `db` profile |

Stop the server so that the copy is consistent, then archive the volume:

```sh
docker compose stop monitor
docker run --rm -v nyx_monitor-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/monitor-$(date +%F).tar.gz -C /data .
docker compose start monitor
```

To restore, stop the server and unpack it into the volume, as the same uid:

```sh
docker compose stop monitor
docker run --rm -v nyx_monitor-data:/data -v "$PWD":/backup alpine \
  sh -c 'tar xzf /backup/monitor-2026-11-06.tar.gz -C /data && chown -R 10001 /data'
docker compose start monitor
```

### Updating

```sh
docker compose pull
docker compose up -d
```

Set `NYX_VERSION` in `.env` to follow a [channel](#release-channels) or to stay on one
version. To go back after a bad update, set the previous version and run the same two
commands. Restore a backup too if the new version changed the database.

With a shared database, update `db` first. **Check on GitHub** in the UI still tells you
when a version is out, but only packages update from there.

Agents come from the monitor image, so they follow once the monitor is updated.

### Agent in a container

Prefer the [package or the install line](agent.md#installing): inside a container the
agent cannot apply system updates, and its self-update is lost when the container is
recreated. For hosts where only Docker is an option, press **Add host** in the monitor,
copy the token and key into `.env`, then:

```sh
docker compose --profile agent up -d
```

This container uses the host's PID namespace and network and runs privileged, because
SMART needs raw disk access. Treat it as root on that host.

### Removing

```sh
docker compose --profile monitor --profile manager --profile db --profile agent down
```

Volumes stay. Add `--volumes` to delete them, and all your data with them.

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

Debian, Ubuntu, RHEL, Fedora and Alma, on x86_64 and arm64, with systemd. Download from
the [releases page](https://github.com/midnights-ra1n/nyx-stack/releases).

### Which packages

| Package | Contents | Install it for |
| --- | --- | --- |
| `nyx-base` | `nyx-notify`, the updater | Any server: it is required, and packages do not pull it from a repository |
| `nyx-monitor` | The monitor with its database, and agent binaries for both architectures | Monitoring |
| `nyx-manager` | The manager with its database | Management |
| `nyx-db` | The optional shared database, on its own | One login across both servers |
| `nyx-agent` | The agent alone | Each host, see [agent.md](agent.md#installing) |

Files are named after the version and the architecture:

| | x86_64 | arm64 |
| --- | --- | --- |
| Debian, Ubuntu | `nyx-monitor_0.1.0-1_amd64.deb` | `nyx-monitor_0.1.0-1_arm64.deb` |
| RHEL, Fedora, Alma | `nyx-monitor-0.1.0-1.x86_64.rpm` | `nyx-monitor-0.1.0-1.aarch64.rpm` |

### 1. Download and verify

Take the latest version from the releases page, and swap `nyx-monitor` for what you want.
On Debian or Ubuntu:

```sh
VERSION=0.1.0 ARCH=amd64    # or arm64
BASE=https://github.com/midnights-ra1n/nyx-stack/releases/download/v$VERSION
for p in nyx-base nyx-monitor; do curl -fsSLO "$BASE/${p}_$VERSION-1_$ARCH.deb"; done
curl -fsSLO "$BASE/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
```

On RHEL, Fedora or Alma:

```sh
VERSION=0.1.0 ARCH=x86_64   # or aarch64
BASE=https://github.com/midnights-ra1n/nyx-stack/releases/download/v$VERSION
for p in nyx-base nyx-monitor; do curl -fsSLO "$BASE/$p-$VERSION-1.$ARCH.rpm"; done
curl -fsSLO "$BASE/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
```

Each file must print `OK`.

### 2. Install

```sh
sudo apt install ./nyx-base_*.deb ./nyx-monitor_*.deb      # Debian, Ubuntu
sudo dnf install ./nyx-base-*.rpm ./nyx-monitor-*.rpm      # RHEL, Fedora, Alma
```

Keep the `./`: without it the package manager looks for the name in its repositories.
Install `nyx-base` in the same command, because it is a dependency of both servers.

The first install creates the `nyx` user and `/var/lib/nyx`, then starts the services.

### 3. Set the public URL

The server starts on `http://localhost:8081`, which is no use to agents. Set the URL
people and agents reach it on, then restart:

```sh
echo 'NYX_PUBLIC_URL=https://monitor.example.com' | sudo tee -a /etc/nyx/monitor.env
sudo systemctl restart nyx-monitor
```

Use `/etc/nyx/manager.env` and `nyx-manager` for the manager. Every option is in
[configuration.md](configuration.md#servers), and these files are read at each start.

### 4. Check it, then open it

```sh
systemctl status nyx-monitor               # active (running)
journalctl -u nyx-monitor -n 20            # ends with "listening on"
curl -s http://localhost:8081/api/health   # answers ok
```

Open port 8081 or 8082. The first page asks [where to keep the data](#choosing-a-database),
then you create your account. With `nyx-db`, its email and password are in
`/etc/nyx/db.env`:

```sh
sudo cat /etc/nyx/db.env
```

### 5. Open the firewall

Only what users and agents need, see [Ports](#ports). With a reverse proxy on the same
machine, open 443 instead and [bind Nyx to localhost](#https).

```sh
sudo ufw allow 8081/tcp                                        # Debian, Ubuntu
sudo firewall-cmd --permanent --add-port=8081/tcp && sudo firewall-cmd --reload   # RHEL
```

### Where things are

| Path | Contents |
| --- | --- |
| `/etc/nyx/monitor.env`, `manager.env` | Your settings, yours to create. Upgrades leave them alone |
| `/etc/nyx/db.env` | Generated credentials of `nyx-db` |
| `/var/lib/nyx/monitor`, `manager`, `db` | Data. This is what you back up |
| `/usr/share/nyx/agents` | Agent binaries the monitor hands out |
| `/usr/libexec/nyx` | `nyx-notify` and the updater |

| Service | Role |
| --- | --- |
| `nyx-monitor`, `nyx-manager`, `nyx-db` | The servers, as the `nyx` user |
| `nyx-update.path`, `nyx-update.service` | Root helper that installs updates |
| `nyx-agent` | The agent, as root |

### Updating

In **Settings, Updates**, press **Check on GitHub**, then **Update**. Tick **Include beta
versions** to be offered betas as well, on each server you want them on. See
[Release channels](#release-channels).

The server is unprivileged, so it only leaves a request file. A root systemd unit,
`nyx-update.path`, then downloads the packages, checks them against the release's
`SHA256SUMS` and installs them. GitHub is contacted only when you press the button.

To update by hand, download the new files as above and install them with the same
command. Services restart by themselves, and your settings and data stay. Upgrade `nyx-db`
first if you use it.

Agents update themselves from the monitor, once a day at the hour set in **Settings,
Monitoring**, when **Update agents automatically** is on. You can also force one from
the host page. They take the version their monitor ships, so a monitor on beta moves its
agents to beta too. **Use beta agents** does this for the agents alone, see
[agent updates](agent.md#updates).

### Removing

```sh
sudo apt remove nyx-monitor nyx-base      # Debian, Ubuntu
sudo dnf remove nyx-monitor nyx-base      # RHEL, Fedora, Alma
```

This stops the services and leaves your data and settings in place, so reinstalling
picks up where you stopped. To delete them too, once no Nyx package is left on the
machine, and after a backup:

```sh
sudo rm -rf /var/lib/nyx /etc/nyx
sudo userdel nyx
```

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

1. In the monitor: **Settings, Integrations, Manager link, Create link token**.
2. In the manager: **Settings, Integrations, Nyx Monitor**, enter the URL and token.

Creating a new token replaces the old one.

## Backups

Everything durable is in each server's data directory: back up `/var/lib/nyx/monitor`
and `/var/lib/nyx/manager`, or `/var/lib/nyx/db` on the `nyx-db` host, or the matching
volumes, as shown [for Docker](#data-and-backups). Stop the server first, or use a tool
that can copy a live SQLite database.

The manager can also export its inventory as JSON from **Settings, Data**, for reading or
for another tool. It is not a backup: nothing restores it.

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

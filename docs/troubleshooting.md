# Troubleshooting

Read the logs first:

```sh
journalctl -u nyx-monitor -n 50     # or nyx-manager, nyx-agent
docker compose logs monitor         # with Docker
```

## A server says "cannot reach PocketBase"

The server unpacks its database program into `NYX_DATA_DIR` and runs it from there, so
that directory must be writable and must not be mounted `noexec`. The reason is in the
same log, on the lines just before.

## A server does not start after a database was chosen

To choose again, stop the server, delete `database.json` from its data directory and
start it. No data is deleted or moved. With a shared database, also check that `nyx-db`
is reachable and not older than the server.

## The EDF Tempo panel shows an error

The panel and **Test the connection**, in **Settings, Integrations**, give RTE's reason.

| Message | What to do |
| --- | --- |
| RTE refused the client ID or secret | Copy both again from your application on the RTE portal |
| Not subscribed to the Tempo Like Supply Contract API | Subscribe your application to it, on the portal. Valid keys are not enough |
| RTE is limiting requests | Wait a few minutes |
| Cannot reach RTE | The monitor cannot get out: check its DNS, firewall or proxy |

## A host stays offline

- `systemctl status nyx-agent` on the host.
- From the host, `curl -I https://monitor/api/health` must succeed.
- `clock skew` or 401 in the agent logs: signed requests allow five minutes of drift.
  Sync the clock with NTP.

## A deleted host's agent keeps failing to report

Deleting a host does not touch the machine. Remove the agent there, see
[agent.md](agent.md#removing).

## Ping probes fail with "ICMP socket unavailable"

With Docker, the `ping_group_range` sysctl is missing, see
[deployment.md](deployment.md#docker). With packages, the unit grants `CAP_NET_RAW`,
so check it was not overridden.

## SMART data is missing

Check `smartctl --version` on the host, and that the type is `physical` or `proxmox`.
Disks behind a RAID controller or some USB bridges do not expose SMART.

## "Passkeys need HTTPS" or MCP answers 403

`NYX_PUBLIC_URL` must start with `https://`. Behind a proxy, it must also send
`X-Forwarded-Proto: https`.

## Notifications do not arrive

The rule shows **Failing** with the error. Use **Test** on the channel. With packages
`NYX_NOTIFIER_BIN` is set for you; elsewhere `nyx-notify` must be on the `PATH`.

## Nextcloud does not sync

Press **Sync** on the **Work** page to see the error at once. The calendar field is the
name in the calendar's link, not its display name.

## A status page or wall display says it does not exist

The page is a draft, its address changed, or, for a wall, the key in the link is wrong
or was replaced. Copy the link again from the **Sharing** tab.

## A site cannot show a status page in a frame

Tick **Let other sites show this page in a frame** in the **Sharing** tab and save. If
it still fails, a reverse proxy may be adding its own `X-Frame-Options` or
`Content-Security-Policy` header. Wall displays can never be framed.

## A wall link with `?key=` stopped working

The key now goes after a `#`: `/wall/name#key=...`. Copy the link again from the
**Sharing** tab.

## A chart says "Not enough data yet"

Live series are in RAM and start empty after a monitor restart. Wait 30 seconds. On a
status page, also check that the panel has items ticked.

## A wall display sleeps or stays on a warning

Keeping the screen on needs HTTPS and a browser with the Wake Lock API. Otherwise,
turn off sleep on the device. A "Connection lost" banner clears by itself when the
monitor answers again.

## No update or beta is offered

**Check on GitHub** reaches the repository anonymously, so it only works once the
repository is public, and it reports an error until a stable release exists. **Include
beta versions** only appears on package installs, as Docker installs pick their channel
with `NYX_VERSION`.

## An update failed or does not start

Open **Settings, Updates, Last update**: the last step says where it stopped, and the
same steps are in `/var/log/nyx/update.log`. Then:

| Last step | What to do |
| --- | --- |
| The last update request was never picked up | `sudo systemctl enable --now nyx-update.path`, then try again |
| Not enough free space | Free some, often old snapshots in `/var/backups/nyx`, then try again |
| Downloading and verifying | `journalctl -u nyx-update` shows the download error. Nothing was changed |
| Installing the packages | `journalctl -u nyx-update` shows the package manager's error. The servers were started again |
| Did not answer within 3 minutes | `journalctl -u nyx-monitor` (or the server named) shows why. To go back, see [Going back after a failed update](deployment.md#going-back-after-a-failed-update) |

## The UI shows an old version

The service worker caches assets. Reload twice, or clear the site's data.

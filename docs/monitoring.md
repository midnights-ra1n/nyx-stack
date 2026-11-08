# Monitoring

## Customizing the pages

Every page made of blocks has a **Customize** button, in the **More** menu on a phone:
the overview, hosts, host detail, containers, network, storage, alerts and logs in the
monitor, and the overview, IPAM, network map, sites and tasks in the manager.

- Slide a block where you want it, by its handle on a phone, or use the arrows from the
  keyboard.
- Close a block to hide it. Hidden blocks stay listed at the top, ready to come back.
- Choose from one to four columns. Below 1024 pixels there is always one.
- **Reset this page** goes back to the default layout. To reset every page, use
  **Settings, General**.

Some blocks are hidden by default. The overview also offers disk health, recent logs,
probes, stopped containers, pending updates, power and EDF Tempo.

Layouts are stored in your browser, separately for desktop and phone. All host pages
share one layout. A block a host cannot show, such as SMART on a VM, is skipped there
and comes back on the hosts that have it.

## Hosts

Each type has its own icon in the host list: VM, LXC container, physical server, Proxmox
server and VPS. The agent checks the type against the machine, see
[host types](agent.md#host-types). **Add host** only offers **Runs on** for a VM or a
container, and only lists your physical and Proxmox servers. A name can only be used once.

**Update all**, on the Hosts page, upgrades the packages of every online host and brings
its agent to the version of this server. A bar follows the whole run, with one per host,
and failures keep their output on screen. The same page lists the hosts that need a
restart, also marked in the table and on each host. Nyx never restarts a host on its own.
See [agent updates](agent.md#updates).

The host list is a tree: guests appear under their Proxmox host. LXC containers only
appear when that host watches them, with figures from Proxmox and no agent inside: see
[Proxmox containers](agent.md#proxmox-containers). Deleting a Proxmox host deletes its
containers too.

## Map

**Map** draws the whole homelab around one hub, updated at the refresh rate of the
interface: Proxmox and physical servers first, with their VMs and containers behind
them, then the probes. A node takes the colour of its state, and so does its link when
something is wrong. The hub takes the worst state, a stopped guest counting as a warning.

- Scroll to zoom, and drag the background to move around.
- Hover or focus a node for its address, CPU, memory and temperature, or its target and
  latency for a probe.
- Click a node, or press Enter on it, to open its page. Guests that are watched from
  Proxmox without a host of their own have no page.
- Drag a node to place it. Places are saved on the monitor, so every browser sees the
  same map. New nodes find a free spot around the hub, and **Reset layout** forgets all
  places.

Live maps can also be placed on [status pages and wall displays](status-pages.md#live-map).

## VPN links

Agents report their tunnels: Tailscale, NetBird, WireGuard, OpenVPN, ZeroTier and IPsec,
recognised by interface name, and any interface holding a 100.64.0.0/10 address. The
**Network** page lists them for the fleet, and each host for itself, with traffic.

A tunnel is down when its interface has no address, or disappears. That opens a warning
alert, sent like any state change. A tunnel gone for a day counts as removed on purpose:
it leaves the list and its alert closes.

Tunnel traffic is not counted in a host's network figures, as it would count twice, and
a tunnel address is never used as the address of a host. Tailscale in userspace
networking mode, common in unprivileged containers, has no interface and is not seen.

## Probes

Add them in **Network**. A website probe on an `https://` address also follows its
certificate: the **Certificate** column of the table shows the days left, and it alerts
like a certificate probe, without a second probe for the same site. Choose how many days
ahead to warn in the probe's settings. Its check always reads the certificate, even one
Nyx would not trust. A site whose certificate has expired is reported as down, because
the website check itself fails.

| Type | Checks |
| --- | --- |
| Ping | ICMP reachability and latency |
| Website | HTTP status and response time |
| DNS | That a name resolves, through a chosen server |
| Certificate | Days until an HTTPS certificate expires |
| SNMP | Any OID, on any device that speaks SNMP |

An alert opens after two failures in a row, so a single lost packet stays quiet.

## SNMP

SNMP v1, v2c and v3 (authentication and privacy) are supported. A probe is a list of
items, so it adapts to any equipment. Start from a preset and adjust:

Generic, Switch or router, Server, UPS (standard), UPS (APC), Printer, Synology,
MikroTik, or Custom.

Each item has:

| Field | Meaning |
| --- | --- |
| OID | The value to read, or a table with **walk** |
| Label, unit | How it is shown |
| Aggregate | For a table: `sum`, `avg`, `max`, `min` or `count` |
| Match | Count only rows equal to this value, for example ports up |
| Rate | Show the change per second, for counters such as traffic |
| Scale | Multiply the value, for example bytes to MB |
| Warn, crit | Thresholds. **Low** means lower values are worse, such as battery charge |
| Expect | Alert when the value differs, for status codes |

Reads are grouped into batches of 20 OIDs per request, and table walks use GETBULK up
to 2000 rows, to spare small devices. Each request is retried once with a 3 s timeout.

Choosing **v3** with authentication and privacy is recommended. v1 and v2c send the
community in clear text.

## Alerts and thresholds

Set warning and critical levels for usage and temperature in **Settings, Monitoring**.
Alerts need three points of margin to clear, which prevents flapping.

### Excluding a host

A test machine or a host you switch off at night can stay out of alerts. Open the host
and press **Exclude from alerts**: it is still measured and shown, but nothing about it
opens an alert or sends a notification, whether it stops answering, fills up, runs hot,
has a failing disk or has updates waiting. Its open alerts close without a notice. The
host list marks it with a muted bell. **Alert again** brings it back from its next report.

Excluding a Proxmox node does not exclude its containers: each host has its own switch.

## Storage

The **Storage** page lists every file system, fullest first, with its host, mount
point, type, device, used, free and total space. Filter it by host, or select a host
name to open its page. An offline host keeps its last known figures, marked Offline.
Older agents do not send the type and device, which then show a dash.

The **Storage** block of the overview is a tree: hosts under their Proxmox server, and
mount points under each host. A host with one mount point is one row, and a collapsed
host shows its fullest mount point, so closing it hides no problem. The list scrolls
when it gets long. Its menu, **Choose mount points**, picks what to show, per mount point
or per host. The choice is saved on this device, and new mount points show until you
hide them. Alerts and the **Storage** page always cover every file system.

## SMART

Each physical disk has a card, on the host page and on **Storage**, with a simple state
(healthy, attention or critical) and, in plain words, what smartctl knows about it:

| Field | Notes |
| --- | --- |
| Model, device, type, capacity | NVMe, SSD or HDD |
| Life left | When the drive reports wear. Attention from 20 %, critical from 10 % |
| Temperature, powered on, power cycles | |
| Bad sectors | Reallocated, pending and uncorrectable together. Any of them means attention |
| Written | Lifetime writes, when the drive counts them |
| Serial | To find the drive and for warranty claims |

Agents older than this version only send the state, life left, temperature and powered
on time, and the rest shows a dash. SMART data is read every 30 minutes, without waking
sleeping disks. Changes raise `smart` notifications.

## Status pages and wall displays

Public pages and full-screen boards have their own guide:
[status-pages.md](status-pages.md).

## History

Charts offer periods from the last hour to the last year. Choose how long history is
kept in **Settings, Monitoring**, from 30 to 365 days. The default is 30.

| Age | Detail |
| --- | --- |
| Last hour | One point every 15 seconds, in RAM |
| Up to 7 days | One point every 5 minutes |
| Beyond | One point per hour |

Lowering the retention deletes the older data at the next daily run, or when the
monitor restarts. Raising it only takes effect going forward: what was already deleted
does not come back. A year takes about 3 MB per host, see the
[measurements](architecture.md#measured-memory).

## Logs

The agent sends warnings and above once a minute. The monitor keeps the last 500 lines
per host in RAM, so they are gone after a restart. This is deliberate: Nyx is not a log
archive.

The **Logs** page shows each line as a time, a level, a service and a message. Identical
messages are folded into their latest occurrence with the number of repeats. Filter by
host, level or text, or select a service under **Noisiest services**. The host page has
the same journal as a block.

### Live logs

Pick a host and press **Go live** to follow everything from info up as it happens. The
same button is on the Logs block of a host page.

- The agent never opens a port, so it learns that someone is watching from the answer
  to its next report. The first lines take up to 15 seconds, then arrive every 2
  seconds.
- Nothing is stored. Live lines stay in RAM, up to 1000 per host, and are dropped once
  nobody watches.
- The agent stops about 15 seconds after the last browser request, which also happens
  when you hide the tab.
- Reading the journal costs a little CPU and I/O every 2 seconds on that host, only
  while someone watches.

A live view follows one host at a time. An agent too old to know about live logs never
answers, and the page says so: update it first.

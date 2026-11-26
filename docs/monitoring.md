# Monitoring

## Customizing the pages

Every page made of blocks has a **Customize** button, in the **More** menu on a phone:
the overview, hosts, host detail, containers, network, storage, alerts and logs in the
monitor, and the overview, IPAM, network map, sites and tasks in the manager.

- Slide a block where you want it, by its handle on a phone, or use the arrows from the
  keyboard.
- Close a block to hide it. Hidden blocks stay listed at the top, ready to come back.
- Choose from one to four columns. When the window is too narrow for them, each under
  380 pixels, they stack into one.
- **Reset this page** goes back to the default layout. To reset every page, use
  **Settings, General**.

Until you arrange a page yourself, its blocks are dealt between the columns by their
height, each to the shortest column so far, so that the columns end level whatever a host
has to show. Moving a block keeps what is on screen as your layout; **Reset this page**
brings the automatic one back.

Some blocks are hidden by default. The overview also offers disk health, recent logs,
probes, stopped containers, pending updates, power and EDF Tempo.

A block with an ⓘ in its header explains itself there: press it to read how the block
is filled and how often. Tables follow the width of their block rather than the
window: tighter cells in a narrow block, one labelled line per field in a very narrow
one. Numbers, sizes and dates follow the language of the interface, so French shows
`12,5 Gio` and `3,2 %`.

Layouts are stored in your browser, separately for desktop and phone. All host pages
share one layout. A block a host cannot show, such as SMART on a VM, is skipped there
and comes back on the hosts that have it.

## Hosts

Each type has its own icon in the host list: VM, LXC container, physical server, Proxmox
server and VPS. The agent checks the type against the machine, see
[host types](agent.md#host-types). **Add host** only offers **Runs on** for a VM or a
container, and only lists your physical and Proxmox servers. A name can only be used once.

**Add host** opens a page, `/hosts/new`, in two steps: describe the host, then copy the
install command shown beside it. **Open** leads to the new host, **Add another** starts
over with the same type.

The host list has a search field (name, hostname, address, OS or tag) and filters per
type, state (healthy, warning or critical, offline) and tag. Each Proxmox or physical
server that runs other hosts gets a block of its own, the server on top and its VMs and
containers below it; hosts that run nothing share the last block. A row shows the type's
icon with a dot for the state, the name, and under it the type, the system and the
hostname when it differs from the name. CPU, memory and the fullest disk show as bars
coloured by your thresholds, and the temperature turns amber or red past its own. On a
narrow screen the address, then the temperature and disk, then CPU and memory make way
for the name. The last column holds what needs a look: the state's issues, failed
services, pending updates (red when they hold security fixes, a click opens
[Updates](#updates)) and a needed restart. Click a row to open the host. Agent-less
Proxmox guests show what Proxmox knows of them, and only while no filter is set.

The pencil beside a name, on the list or on the host's page, renames the host in Nyx
only: the machine's hostname, its agent and its history stay as they are. Enter or
leaving the field saves, Escape cancels. A name can only be used once.

A VM with an agent is tied to its Proxmox guest once, by name, hostname or the address
Proxmox reports, and keeps that tie by VMID: renamed, or named differently in Proxmox, it
is still listed once, with its agent, and its **Console** button opens the VM's noVNC
console.

Each host shows the logo of its Linux distribution beside its name: Debian, Ubuntu, Fedora,
Red Hat, AlmaLinux, Rocky, CentOS, Arch, Alpine, openSUSE, NixOS and some twenty more,
read from the name the agent reports or, for a guest without an agent, the OS type
Proxmox gives. Other Linux systems get Tux. The logos come from
[Simple Icons](https://simpleicons.org) (CC0) and are bundled: nothing is fetched.

**Cards**, beside **List** above the list, shows one card per host in the manner of
Beszel: a state dot, CPU, memory and disk bars, traffic, temperature, uptime, tags, and
badges for failed services and pending updates. The choice is remembered.

A host's page opens on a line of facts under its name: uptime, address, hostname,
system, kernel and architecture, agent version, and its services, in red with the number
failed. **Details**, first on the page, says who the host is (hostname, address, type, the
host it runs on, uptime, last report, system), then gives its figures as small tiles: swap,
temperature, containers, traffic received and sent, and the agent version, in amber when a
newer agent exists. **History** is a grid of charts, one per measure with a line on what
it shows: CPU, memory, the fullest disk, bandwidth (received and sent) and temperature, over
the period picked at the top. Hosts without a sensor say so instead of drawing a flat
line.

### Services

The agent lists every loaded systemd service once a minute. A host's page has a
**Services** panel, and **Services** in the menu lists them across hosts, filtered by
host or tag; `/services?host=<id>` opens it on one host.

- Counts at the top: running, failed, enabled but not running (set to start at boot,
  yet stopped), and loaded.
- The table shows the state in words (running, done for a one-shot that ended well,
  failed, stopped, restarting), the name and description, how long it has been in that
  state, memory, CPU as a share of one core, restarts and whether it starts at boot.
  Failed ones come first; click a header to sort, or search names and descriptions.
- Click a service for its page: state and since when, memory, CPU, restarts, type, last
  result, main PID and unit file, with **Start**, **Restart** and **Stop**. Its
  **Logs** (the last 300 journal lines), **Status** (`systemctl status`) and **Unit
  file** (`systemctl cat`, drop-ins included) are read from the agent when the tab
  opens, within seconds while the page is open. The agent refuses to stop itself.

A failed service turns its host amber and opens an alert, which closes once it runs
again or is reset with `systemctl reset-failed`.

### Tags

Tags are free labels, such as `lab`, `prod` or `rack-A`, to group hosts as you see them.
Add them on a host's page: type one and press Enter, or a comma; Backspace takes the last
one off. Up to 20 per host, 32 characters each. A tag keeps its colour everywhere.

- The host list filters by tag, and its summary has one button per tag with its number of
  hosts and their worst state. Click one to show only those hosts; a tag in the table
  does the same. `/hosts?tag=prod` opens the list filtered.
- The [Updates](#updates) page acts on the hosts of a tag.
- [Charts](#charts) draw the hosts of a tag, fixed or picked at the top of the page.

The manager has tags too, on hardware, virtual assets, tasks and deployments: see
[inventory](manager.md#inventory).

## Updates

**Updates** lists every host with something waiting: pending packages, security fixes,
a restart, or an agent older than this server. Security fixes come first, then
restarts, then the most packages. The summary counts each of them for the whole fleet,
and the menu shows how many hosts have updates.

- Open a row with its arrow for the list of packages, security fixes first.
- **Check** asks the agents for a fresh list; it arrives with their next report.
- **Update** upgrades the packages and brings the agent up to date, with a bar per host
  while it runs. Nyx never restarts a host on its own.
- Both buttons act on the hosts ticked, or else on every host shown: pick a tag to act
  on its hosts only. Hosts offline, and containers watched from Proxmox without an
  agent, cannot be ticked.
- Untick **Only hosts with something to do** to see every host and its agent version.

**Update all**, on the Hosts page, still upgrades every online host at once. See
[agent updates](agent.md#updates).

## Charts

**Charts** is a page of graphs you build yourself, saved on the monitor so every browser
sees the same ones. It starts with four examples; **Bring back the examples** restores
them.

**Add chart** asks five things, with a live preview beside the form:

| Field | Choices |
| --- | --- |
| Measure | CPU, memory, fullest disk, temperature, network in, network out |
| Hosts | All hosts, the **Host** variable, the **Tag** variable, one tag, or hosts ticked in a list |
| Show | One line per host, their average, or the highest of them |
| Look | Areas, lines, or bars of the latest value, longest first |
| Title | Free text; `$host` and `$tag` read as what the variables hold |

The variables sit at the top of the page: **Host**, **Tag** and the period. Change one and
every chart that uses it follows, so one chart "CPU of `$tag`" serves every tag. They are
remembered by the browser. With a variable left on **All**, its charts take every host.

A chart draws at most 24 hosts. Each one's menu edits, duplicates, moves or deletes it,
and **Full width** gives a chart the whole row.

The host list is a tree: guests appear under their Proxmox host. LXC containers only
appear when that host watches them, with figures from Proxmox and no agent inside: see
[Proxmox containers](agent.md#proxmox-containers). Deleting a Proxmox host deletes its
containers too.

## Map

**Map** draws the whole homelab around one hub, updated at the refresh rate of the
interface: Proxmox and physical servers first, with their VMs and containers behind
them, then the probes. A node takes the colour of its state, and so does its link when
something is wrong. The hub takes the worst state, a stopped guest counting as a warning.

Three views switch at the top right of the map: the **map** itself, a **tree** (each Proxmox host
with its VMs and containers under it) and **by type**, one card per kind of device with the
worst state in its header. Status pages show the same switch to their visitors; a wall
display stays on the map.

- Scroll or pinch to zoom, and drag the background to move around. The buttons at the
  top left zoom in, zoom out, fit the whole map and go full screen; with the map
  focused, `+`, `-` and `0` do the same. On a status page, the wheel keeps scrolling the
  page: zoom there with the buttons or two fingers.
- **Find on the map** outlines the nodes whose name or details hold every word typed
  and fades the rest; Enter centres the first one.
- Hover or focus a node for its address, CPU, memory and temperature, or its target and
  latency for a probe, shown at the bottom right. Its hosts above it and its guests
  below it stay lit, with their links, and the rest fades.
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

Add them in **Network**. The page works like Uptime Kuma: on the left, every probe with
its uptime over the recent checks and a bar per check, down ones first; on the right,
the selected probe with its last 60 checks, current and average response time, uptime
over the recent checks and over 30 days, one bar per day, the response time chart and
its SNMP readings. **Pause** stops a probe without deleting it. Search and the **Show**
filter narrow the list.

Each line of the list holds a probe's state, name, target, last response time, uptime
and its last checks, so a few dozen probes fit on one screen. Sort them into
**categories**, such as Infrastructure, Services or DNS:

- **New category**, the folder button above the list, adds one. Hover a category to add
  a probe to it, rename it, move it up or down, or delete it. Deleting a category keeps
  its probes, out of any category.
- Drag a probe onto a category to move it there, or choose the category in the probe's
  settings. Probes in no category are listed last.
- A category's header counts its probes and its down and warning ones. Press it to fold
  it; folded categories are remembered in your browser.

A website probe on an `https://` address also follows its
certificate: the probe's **Certificate** figure shows the days left, and it alerts
like a certificate probe, without a second probe for the same site. Choose how many days
ahead to warn in the probe's settings. Its check always reads the certificate, even one
Nyx would not trust. A site whose certificate has expired is reported as down, because
the website check itself fails.

| Type | Checks |
| --- | --- |
| Ping | ICMP reachability and latency; the host name can resolve through a chosen server, so pings stay out of a local NextDNS or Pi-hole log |
| Website | HTTP status and response time |
| DNS | That a name resolves, through a chosen server |
| Certificate | Days until an HTTPS certificate expires |
| SNMP | Any OID, on any device that speaks SNMP |

**DNS for probes** (Settings → Monitoring) sets the DNS servers every probe resolves names through, for example `1.1.1.1, 9.9.9.9` when this server's own resolver fails or logs every check. A probe's own server still wins. Empty uses the system resolver.

**Probe DNS** at the top of the Network page shows the DNS server of every ping and website probe and changes it for one probe or for all the ticked ones at once. Empty goes back to the DNS for probes.

An alert opens after two failures in a row, so a single lost packet stays quiet.

## Docker containers

**Containers** lists the Docker containers of every host, from the agent: CPU (one core is
100 %, averaged over the minute), memory, and the share of the memory limit.
Three views: a table, cards and a list by host, with a search and a filter on running or not.

- **Start, stop, restart** a container and read its **last 200 log lines** from the row. The
  agent talks to the Docker socket, so no port is opened. Stopping asks for confirmation.
- **Biggest consumers** ranks the top containers by CPU and by memory.
- **Alerts**: a container that keeps restarting (critical), an unhealthy one, one that
  stopped with an error in the last day (warning), and one close to an explicit memory
  limit, with the thresholds of the host. A container stopped cleanly raises nothing.

## CI/CD pipelines

**Pipelines** follows the latest run of a branch on GitHub, GitLab, Forgejo or Gitea.
Add one with the forge, the repository (`owner/name`, or the full path on GitLab), the
branch and, for a private repository, an access token with read access. Forgejo and Gitea
also need the address of your server, and their Actions turned on. GitHub and GitLab
default to github.com and gitlab.com; fill the address in for GitHub Enterprise or a
self-hosted GitLab.

The monitor asks each forge every two minutes, from the server and not from your browser.
A run is *Passed*, *Failed*, *Running*, or grey (cancelled, skipped). A **failed run opens a
critical alert** and a notification of the `pipeline` type, and a later **passing run closes
it**. A run in progress or a cancelled one changes nothing, as neither proves the fix.
If the forge cannot be reached, the pipeline shows *Unreachable* and keeps its open alert.

The **Pipelines** page keeps the last 12 runs of each pipeline and shows them as **cards**,
a **timeline** (one strip of runs per pipeline, newest on the right), a **board** (failed,
running, passed) and a **list**, with **Manage** to add and edit them. Status pages and wall
displays pick one of these views in the panel's settings.

The overview has a **Pipelines** block (hidden by default, see **Customize**), and
[status pages and wall displays](status-pages.md) have a **CI/CD pipelines** panel. The
[manager](manager.md) can show the same list through its link. The token is stored with the
pipeline and shown to signed-in users only; use a read-only one.

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
| Last hour | One point per report, in RAM: every 15 seconds while the monitor is used, every 60 otherwise |
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
  to its next report. The first lines take up to a minute, then arrive every 2
  seconds.
- Nothing is stored. Live lines stay in RAM, up to 1000 per host, and are dropped once
  nobody watches.
- The agent stops about 15 seconds after the last browser request, which also happens
  when you hide the tab.
- Reading the journal costs a little CPU and I/O every 2 seconds on that host, only
  while someone watches.

A live view follows one host at a time. An agent too old to know about live logs never
answers, and the page says so: update it first.

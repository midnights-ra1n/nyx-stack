# Manager

## Navigation and language

The menu follows GLPI's: **Assets** (overview, hardware, racks, virtual), **Network**
(IPAM, network map, VPN links) and **Management** (tasks, deployments, Node.js sites).
Every page starts with its path, such as *Home › Assets › Hardware*.

The interface is in English and French. It follows the browser's language at first;
the language menu at the bottom of the sidebar, under **More** on a phone, or on the
sign-in screen changes it. The choice is kept on this device.

## Inventory

**Hardware** tracks physical equipment, with serial numbers, locations and warranty
dates. The overview flags warranties ending within 60 days. The add form starts from
the category, and offers the manufacturers, models and locations already in use.

Hardware, virtual assets, tasks and deployments take **tags**: type one and press Enter,
or a comma, and the tags already in use are offered. Lists show them as coloured chips,
the same colour for the same tag everywhere, and a **Tag** filter appears once one is in
use. The monitor has its own tags on hosts, see [tags](monitoring.md#tags).

With a [linked monitor](deployment.md#linking-manager-and-monitor), the hardware and
virtual lists gain a **Monitoring** column, and a record's page a **Monitoring** panel:
state, CPU, memory, fullest disk, uptime, pending updates and the host's tags. A record
matches the monitored host with the same name or hostname, or else the same address.

The category decides which specifications the form asks for:

| Category | Specifications |
| --- | --- |
| Server | CPU, RAM, storage, network ports, power, OS or firmware, management address (IPMI, iDRAC) |
| NAS | CPU, RAM, storage, network ports, power, OS or firmware, management address |
| Switch | Network ports, power, firmware, management address |
| Router, Firewall | CPU, network ports, firmware, management address; Wi-Fi on routers, RAM on firewalls |
| Access point | Network ports, Wi-Fi, firmware, management address |
| UPS | Power rating, battery replacement date, firmware, management address |
| Printer | Storage, firmware, management address |

Each one is free text, so "64 GB DDR4 ECC" is kept as typed. Changing the category hides
the other details without erasing them, and the search field finds them too.

Above the list, one tile per category gives the count and filters on a click; click it
again, or **All**, to clear. A search field and a filter per status sit below. Click a
column header to sort on it, again to reverse; the order is remembered on this device.
On a phone, use **Sort by**. The status and the warranty are coloured: expired in red,
ending within 60 days in amber.

**Columns** picks the columns of the list among every field, specifications and purchase
details included; the first one, the name, always stays. The choice is remembered on
this device, per list. Tick rows, or the box in the header for every row shown, to act
on them together: **Set** one field to one value on all of them (status, location,
supplier…), or **Delete** them. Fields unique to a record, such as the name or the serial
number, cannot be set in bulk. Lists of the monitor work the same way.

Each device has a page of its own, `/hardware/<id>`, opened by clicking its row, with
tabs on the left as in GLPI:

| Tab | Holds |
| --- | --- |
| General | Identity, specifications, location and status, notes. A summary beside them shows the status, the warranty, the age since purchase and a link to the management address |
| Management | Supplier, order and invoice numbers, price, purchase date, date in service and end of warranty |
| Network ports | One row per port: name, speed, MAC address, VLAN and the port of another device it is cabled to |
| Links | The **Network addresses** of the IPAM whose device or hostname matches the name, and the virtual assets that **run here** (their **Runs on** field holds the device's name) |
| History | Every change saved from this interface: when, which field, before and after |

The address keeps the tab, such as `/hardware/<id>#Management`, to share or bookmark it.
Global search leads straight to these pages.

### Network ports

**Add port** on the **Network ports** tab records a port. **Cabled to** lists the ports
of other devices that are free, as `device · port`; pick one to record the cable. A port
holds one cable: cabling it elsewhere frees the former far end. Both devices show the
cable, and the far end links to the other device's page. Cables between two devices of
the [network map](#network-map) are drawn there.

### History

Each save on a hardware or virtual page, and each change made in bulk, adds one line per
field that actually changed, with its value before and after. Long text is cut to 200
characters. A save that changes nothing writes nothing, and nothing is written in the
background: the inventory sync from a linked monitor and imports are not recorded. The
history of a deleted record stays in the database, without a page to read it.

**Virtual** tracks VMs, containers and Docker services. With a linked monitor these
fill themselves every five minutes, and rows marked `monitor` follow the agents: they
disappear when the host does. Manual rows are never touched. Physical hosts are not
copied into **Hardware**, because agents do not report serial or warranty data.

Virtual assets have the same tiles, per type, and pages of their own at
`/virtual/<id>`, with their resources and the console, a **Links** tab with their
addresses, and a **History** tab. **Runs on** links to the hardware page of that name.

With a Proxmox URL in the settings, assets with a VMID and node get a noVNC **Console**
button. You sign in to Proxmox itself.

## Overview

The overview sums up the inventory: every figure opens its page. Panels show the
progress of tasks and deployments, hardware per category, the fullest subnets,
addressing conflicts, tasks due within seven days, recent deployments and warranties
ending soon. **Customize** moves and hides them;
the layout is kept per device.

**Add widget** puts your own panels next to them. Widgets are kept on the server, so
every browser sees the same ones; open a widget's menu to edit or remove it.

| Widget | Shows |
| --- | --- |
| EDF Tempo | Today's and tomorrow's colour and the days left. Read from the linked monitor, where the RTE keys are set |
| Pipelines | State of the latest CI/CD run of each repository followed by the monitor |
| Monitoring | Hosts online, open alerts, containers and average load, from the linked monitor |
| Note | Free text |
| Links | Bookmarks, one `Label \| https://address` per line. Only `http` and `https` addresses are kept |
| Clock | Time and date, in the browser's time zone or one you name, such as `Europe/Paris` |
| Web page | A page of your own in a frame, such as a Grafana panel. Your browser loads it directly, and the page must allow being framed |

Tempo, Pipelines and Monitoring need a [linked monitor](deployment.md#linking-manager-and-monitor). Without one, they say so.

## Forms

Hardware and virtual assets are added and edited on a page of their own (**Add hardware**
leads to `/hardware/new`), never in a window. Each heading of the form is a panel, and
**Save** stays at the bottom of the screen on long forms. The form keeps what you typed
when you switch tabs, and **Save** saves every tab at once; a required field left empty
on another tab opens that tab. Saving stays on the page; adding a record opens its new
page, where the other tabs appear. **Escape** or **Back** goes back to the list.

Other records (deployments, tasks, IPAM, VPN links) open a form at the top of their page,
above the list. **Escape** or **Cancel** closes it without saving.

## IPAM

IPAM keeps the address plan: subnets, the addresses in them, VLANs, VRFs and routes.
IPv4 and IPv6 both work. Its tabs:

| Tab | Contents |
| --- | --- |
| Overview | Counts, conflicts, the fullest subnets, a subnet calculator and the routing simulation |
| Subnets | Every subnet as a tree, one table per section, with its VLAN, VRF, gateway and usage |
| Addresses | Every address with its state (Active, Reserved, DHCP, Offline), device, hostname, MAC, owner and when a scan last saw it |
| VLANs | Numbers, names and the domain they belong to, with the subnets that use them |
| VRFs | Routing tables, with an optional route distinguisher |
| Routes | Routes per device, for the simulation |

### Subnets

A subnet inside another one nests under it: add the large ranges first, then cut them
up. A **section** groups subnets, for example per site. The same prefix may be recorded
once per **VRF**. With an **Alert above** threshold, a subnet that fills up past it is
listed among the conflicts.

Open a subnet to see:

- the calculator figures: network, netmask, wildcard, broadcast, first and last host, size
- an **address map** for IPv4 subnets up to /22, one square per address, coloured by state.
  Press a free square to record it, a used one to edit it
- its addresses, its free ranges and its nested subnets
- **Not recorded**: addresses the virtual inventory or the network map give inside this
  subnet, and those that answered the last scan, each with a **Record** button

### Scanning

**Scan** pings every address of an IPv4 subnet of /22 or smaller once, from the manager.
Recorded addresses that answer get their **Last seen** date; the others are listed under
**Not recorded**. Nothing scans on its own: a scan only runs when you press the button,
and only writes the dates of the addresses that answered.

The manager needs to send ICMP: the package grants it `CAP_NET_RAW` and the Docker
service sets `net.ipv4.ping_group_range`, as the monitor does. See
[ICMP probes](deployment.md#icmp-probes). A host that blocks ping looks free.

### Conflicts

- The same prefix twice in one VRF
- The same address on two devices
- An address outside every subnet
- A network or broadcast address assigned to a device, judged against the smallest subnet that holds it
- A gateway outside its subnet
- A MAC address on several IP addresses
- A subnet past its threshold
- Invalid CIDRs and addresses

Assigning the same address to one device twice is not a conflict. The device name is
the identity, so spell it consistently. Addresses belong to the subnets that contain
them, whatever their VRF, so the same address recorded twice in two VRFs reads as a conflict.

### Routing simulation

Add **Routes** for each device: a destination, a next hop, and a metric. In **Overview**,
choose a device and an address and press **Trace**.

At each device the simulation picks the longest matching prefix, then the lowest
metric, and finds the next device from the address list. Destinations on a directly
connected subnet are reached without a route. It reports loops and black holes.

It reads your records, not your network, so firewalls and NAT are not considered.

## Racks

**Racks** draws each rack from the front, to scale, one unit per row with its number,
1 at the bottom. **Add rack** asks for a name, a location and a height in units (42 by
default). With several racks, tabs above pick one; the choice is remembered on this
device.

- Drag a device from **Not in a rack** onto the rack, or press **Place** to put it in the
  highest free spot. Racks fill from the top, as in a real cabinet.
- Drag a device inside the rack to move it. A spot it would overlap shows red and the
  move is refused. Focused with the keyboard, the up and down arrows move it one unit.
- Click a device to set its **Position (U)**, the lowest unit it fills, and its
  **Height (U)**, or to take it out of the rack.
- **Cables** lists its ports and what each one is plugged into. **Plug into** picks
  another device and the port on each side by name; a port that does not exist yet is
  created. A port holds one cable, so plugging it elsewhere unplugs it first. These are
  the same [network ports](#network-ports) as on the hardware page, and they are drawn on
  the [network map](#network-map) too. Cables between two devices of the same rack are
  drawn as blue curves on its right side.

The hardware form shows the same fields under **Where it is**: **Rack**, **Position (U)**
and **Height (U)**, and the summary links to the Racks page. Deleting a rack keeps its
devices, out of any rack. **Patch panel** and **PDU** are hardware categories of their own.

## Network map

Switch between the **diagram**, a **tree** (guests under their host) and **by type** above the map.

The map follows the hierarchy of your machines. A VM, container or other device linked
to a Proxmox, physical or server node is its guest: it is listed under that host, inside
a frame, joined to it by a tree line. Links between two hosts, or to network gear, are
drawn as blue curves that bend around the cards.

**Arrange** places every device again: routers and switches on top, then one column per
host with its guests in name order (`PVE-2` before `PVE-10`), then the devices that stand
alone, such as a VPS. It replaces the places you set by hand, so it asks first.

**Import hosts** adds monitored hosts and links guests to their parents. The first import
arranges the map; later ones put new hosts in free spots and leave the rest alone, so
press **Arrange** when you want them tidied.

Drag a device to move it; its place is saved when you let go. Double-click one to edit
it, or use the list below the map, which is the easier way on a phone. The type of a
device sets its icon and decides whether it is a host or a guest.

The row of buttons above the map adds a device of one type in one click: Internet, router,
firewall, switch, access point, server, Proxmox, NAS, VM, LXC container, Docker, VPS,
cloud service or IoT device. To link two devices, drag from the dot on the right edge of
one onto the other. **New links** sets the kind of the links you draw, and each kind has
its own line, shown in the legend:

| Kind | Line |
| --- | --- |
| Ethernet | Solid blue |
| Fibre | Thick solid green |
| Wi-Fi | Dotted amber |
| VLAN | Dash-dot blue |
| VPN | Dashed orange |
| Virtual | Faint dotted grey |

**Add link** does the same from a form, with a label. Click a link on the map to delete
it. Exports keep the links, without their kind.

The map is a canvas: drag its dotted background to move around, scroll or pinch to zoom,
or use the buttons at its top left to zoom, fit everything and go full screen (`+`, `-`
and `0` from the keyboard once the map has focus). Cards snap to an 8 px grid as you drag
them, so they line up. **Find on the map** outlines the devices whose name, address or
type holds every word typed, fades the others, and Enter centres the first one. Hovering
a device keeps it, what it is linked to and their links lit, and fades the rest.

With a [linked monitor](deployment.md#linking-manager-and-monitor), a device named like a
monitored host, or with its address, shows the host's state: a coloured bar on its
left, a dot in its corner, and a count per state at the bottom of the map. The tree and
by-type views use the same states. Other devices stay neutral, since nothing says they
are up.

A VPN link whose **From** and **To** are both device names of the map is drawn there as
a dashed orange line, and exported the same way.

A cable between [network ports](#network-ports) of two hardware devices whose names are
on the map is drawn as a grey line labelled with both ports, and exported too. Two
devices get one line, however many cables join them, and a link you drew between them
wins over the cable.

Exports: SVG, draw.io, Mermaid, Graphviz DOT and JSON.

## VPN links

**VPN links** records tunnels by hand: type, both ends, tunnel subnet and public
endpoint. Leave **To** empty for a mesh such as Tailscale or NetBird.

With a linked monitor, **Detected on your hosts** lists the tunnels agents report, and
**Track** starts a record from one. Tracked links are your own records: they do not
follow the agents, and their state is watched on the monitor. See
[VPN links](monitoring.md#vpn-links).

Addresses in 100.64.0.0/10, the range Tailscale and NetBird use, only mean something
inside the VPN. They stay out of IPAM, the inventory and the map, and rows imported
before this rule are removed at the next sync. Addresses you typed yourself are kept.

## Deployments

A log of what was deployed where, with due dates, as a board or a list. See
[boards and lists](#boards-and-lists). Planned deployments trigger a reminder ahead of
time, a day by default. Site deploys appear here on their own and follow their deploy.

## Node.js sites

Sites need a linked monitor: deploys run through the agent on the target host.

1. Agents look for Node.js apps every five minutes. These appear in **Detected Node.js
   apps**, with their directory, Git origin and what runs them. **Manage** opens the
   form filled in with what the agent saw: repository, branch, user and commands, from
   the lock file and the scripts of `package.json`.
2. Create the site. Leave the private key empty to generate an ed25519 deploy key, or
   paste an unencrypted OpenSSH key.
3. Copy the public key to the repository as a read-only deploy key.
4. Add the webhook URL and secret to the repository, for push events, as JSON.

A push to the configured branch then deploys. **Deploy** does the same by hand.

The agent fetches the branch as the run user, runs the install and build commands,
and writes and restarts a `nyx-site-<name>` systemd service. The run user must exist
on the host. The default is `www-data`.

### Running sites

Each site shows what it takes on its host: CPU (averaged since the agent's last look, every
five minutes) and memory, summed over its processes. **Show** filters sites and detected apps
running in Docker or directly on the host.

Open a site to **restart, stop or start** its service (a systemd unit or PM2 app) and to read
its **logs** (200 lines of the journal or PM2). Its **History** lists earlier deploys, and **Deploy
again** puts an earlier commit back. A push to the branch deploys it through the webhook.

In the site's settings, **Environment variables** (`NAME=value` per line) are written to a file only root
can read and loaded by the service at the next deploy; PM2 services are not covered. The
**health check address** is asked every minute: two misses in a row raise a notification, and
the first answer afterwards ends it.

### Sites that already run

An app detected under systemd or PM2 keeps its service: **Existing service** holds the
unit, or `pm2:<name>`, and a deploy restarts that instead of creating a second service
on the same port. PM2 must be in the login `PATH` of the run user. Leave the field empty
to move the site to a Nyx service; stop the old one first.

### HTTP cache between deploys

**HTTP cache** sets the `Cache-Control` header of a site's pages, so that visitors get the
new version after a deploy instead of a stale copy. **Always revalidate** (`no-cache`) is
the safe choice: browsers ask again on each visit and get a cheap `304` when nothing
changed. It is the default for new sites. A number of seconds gives `public, max-age=N`.
Choose **The app's own** to keep the headers the app sets.

The agent preloads a small module (`/usr/local/lib/nyx-agent/cache.js`, through
`NODE_OPTIONS`) on the next deploy. Hashed assets marked `immutable`, and `private` or
`no-store` answers, keep their header. For an existing systemd service the setting goes in
a drop-in, `/etc/systemd/system/<unit>.d/nyx-cache.conf`, and replaces any `NODE_OPTIONS`
the unit sets. PM2 services are not covered: set the header in the app. A CDN or reverse
proxy with its own cache must still be purged separately. See
[Site cache behind a reverse proxy](reverse-proxy-cache.md) for Nginx, Nginx Proxy
Manager, Caddy, Traefik, Zoraxy, Pangolin, NetBird and CDNs.

A deploy resets tracked files to the branch, so commit local changes first. Ignored
files, such as `.env`, stay. Apps in Docker are listed but cannot be deployed: Nyx
deploys on the host, not inside containers.

Detection goes by the `node` binary, so it finds apps run through nvm, PM2 or Next.js,
which rename their process. An app's folder comes from its script, then from its working
directory, up to the nearest `package.json`. Tools in hidden folders, such as VS Code
Server, are left out. On a Proxmox node, apps inside containers are only found by an
agent in that container: watching containers from the node does not show them.

GitHub, Gitea and Forgejo sign webhooks with `X-Hub-Signature-256`, and GitLab sends
`X-Gitlab-Token`. Both are supported.

## Tasks

Tasks can stand alone or sync with Nextcloud: see
[integrations.md](integrations.md#nextcloud). A task is to do, in progress, done or
cancelled; a cancelled task gets no reminder. Calendar events only appear in the list.
A reminder goes out a day before a task is due. Change the delay, and how early ending
warranties appear on the overview, in **Settings, General, Reminders**.

Type a title in the field above the board and press Enter to add a task at once; open it
later for the rest. A task can hold a **Checklist** of steps: tick them as you go, and
its card shows a bar with the steps done. Press Enter in a step to add the next one. The
steps are kept in the description as a Markdown checklist (`- [ ] step`, `- [x] step`),
so Nextcloud shows them too and ticks made there come back. Nyx also sends the share of
steps done to Nextcloud as the task's percent complete.

**Progress**, beside the board, sums up where everything stands:

- the overall share of work done. A closed task counts whole, an open one by its ticked
  steps, and one in progress without steps counts half. Cancelled tasks and calendar
  events do not count.
- tasks done out of the total, those in progress and those late
- one bar per tag, so a tag such as `rack-2026` reads as a project
- deployments that succeeded out of all of them, with those running or failed

## Boards and lists

Tasks and deployments show as a **Board**, one column per state, or as a **List**. The
choice is remembered on this device.

- Drag a card to another column to change its state, or use the menu on the card, which
  also works from the keyboard and on a phone. In the list, the same menu is on each row.
- Tags are typed separated by commas. Click one to show only that tag, or use **Tag**.
- A past due date on something still open shows as late.
- In the list, click a column header to sort on it.

A deployment moved to succeeded or failed gets today as its done date, unless it has one.

# Manager

## Inventory

**Hardware** tracks physical equipment, with serial numbers, locations and warranty
dates. The overview flags warranties ending within 60 days. The add form starts from
the category, and offers the manufacturers, models and locations already in use.

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

Every inventory list has a search field and a filter per category or status. Click a
column header to sort on it, again to reverse; the order is remembered on this device.
On a phone, use **Sort by**.

**Virtual** tracks VMs, containers and Docker services. With a linked monitor these
fill themselves every five minutes, and rows marked `monitor` follow the agents: they
disappear when the host does. Manual rows are never touched. Physical hosts are not
copied into **Hardware**, because agents do not report serial or warranty data.

With a Proxmox URL in the settings, assets with a VMID and node get a noVNC **Console**
button. You sign in to Proxmox itself.

## Overview

The overview sums up the inventory: every figure opens its page. Panels show hardware
per category, the fullest subnets, addressing conflicts, tasks due within seven days,
recent deployments and warranties ending soon. **Customize** moves and hides them;
the layout is kept per device.

**Add widget** puts your own panels next to them. Widgets are kept on the server, so
every browser sees the same ones; open a widget's menu to edit or remove it.

| Widget | Shows |
| --- | --- |
| EDF Tempo | Today's and tomorrow's colour and the days left. Read from the linked monitor, where the RTE keys are set |
| Monitoring | Hosts online, open alerts, containers and average load, from the linked monitor |
| Note | Free text |
| Links | Bookmarks, one `Label \| https://address` per line. Only `http` and `https` addresses are kept |
| Clock | Time and date, in the browser's time zone or one you name, such as `Europe/Paris` |
| Web page | A page of your own in a frame, such as a Grafana panel. Your browser loads it directly, and the page must allow being framed |

Tempo and Monitoring need a [linked monitor](deployment.md#linking-manager-and-monitor). Without one, they say so.

## Forms

Adding or editing a record opens a form at the top of the page, above the list, rather
than in a window. Fields are grouped under headings on the left. **Escape** or
**Cancel** closes it without saving.

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

## Network map

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

A VPN link whose **From** and **To** are both device names of the map is drawn there as
a dashed orange line, and exported the same way.

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

### Sites that already run

An app detected under systemd or PM2 keeps its service: **Existing service** holds the
unit, or `pm2:<name>`, and a deploy restarts that instead of creating a second service
on the same port. PM2 must be in the login `PATH` of the run user. Leave the field empty
to move the site to a Nyx service; stop the old one first.

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

## Boards and lists

Tasks and deployments show as a **Board**, one column per state, or as a **List**. The
choice is remembered on this device.

- Drag a card to another column to change its state, or use the menu on the card, which
  also works from the keyboard and on a phone. In the list, the same menu is on each row.
- Tags are typed separated by commas. Click one to show only that tag, or use **Tag**.
- A past due date on something still open shows as late.
- In the list, click a column header to sort on it.

A deployment moved to succeeded or failed gets today as its done date, unless it has one.

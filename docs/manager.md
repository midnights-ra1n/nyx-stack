# Manager

## Navigation and language

The menu follows GLPI's: **Assets** (overview, hardware, racks, virtual), **Network**
(IPAM, network map, VPN links) and **Management** ([work](#work): tasks, interventions and
deployments).
Every page starts with its path, such as *Home › Assets › Hardware*.

The interface is in English and French. It follows the browser's language at first;
the language menu at the bottom of the sidebar, under **More** on a phone, or on the
sign-in screen changes it. The choice is kept on this device.

## Inventory

The manager keeps an inventory of its own, typed by you: what you own, where it stands and
what runs on it. The hosts of a [linked monitor](deployment.md#linking-manager-and-monitor)
stay in the monitor and are never copied here, so the two can differ on purpose: a spare
server, a switch with no agent or a VM you plan are records, not hosts.

**Inventory** tracks physical equipment, with serial numbers, locations and warranty
dates. The overview flags warranties ending within 60 days. The add form starts from
the category, and offers the manufacturers, models and locations already in use.

It opens on the **table**, with a tile per category on top, a search, filters, the
columns you choose and bulk edits. **Tree** shows the whole inventory as one table,
grouped by [place](#places), by category or not at all: each device is followed by the
virtual assets whose **Runs on** names it, indented, and those by what runs inside them,
such as the Docker services of a VM. Virtual assets that run on nothing of the inventory
come last, under **Not on a device**. The search keeps a device when it or one of its
guests matches. The choice between table and tree is remembered on this device.

### Components

**Components** lists the parts inside the hardware, after GLPI's components: hard disks,
SSDs, CPUs, memory, GPUs, network cards, power supplies. Each has a manufacturer, model,
capacity (such as `8 TB` or `32 GB DDR4-3200 ECC`), serial number, the device it is
**fitted in** and its slot, purchase and warranty dates, and a status:

| Status | Meaning |
| --- | --- |
| In service | Used, in the device it is fitted in |
| Spare | Kept for later: on a shelf when it is fitted in nothing, a hot spare when it is |
| Decommissioned | No longer used, with the date it was taken out; kept for the record |

The tiles on top count each type; filter by device or status, or select several rows to
change them at once, for example to decommission them. A device's page lists its parts
under **Components**, where you add one already fitted in it.

Hardware, virtual assets, tasks, interventions and deployments take **tags**: type one and press Enter,
or a comma, and the tags already in use are offered. Lists show them as coloured chips,
the same colour for the same tag everywhere, and a **Tag** filter appears once one is in
use. The monitor has its own tags on hosts, see [tags](monitoring.md#tags).

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
background: imports are not recorded. The
history of a deleted record stays in the database, without a page to read it.

**Virtual** tracks VMs, containers and Docker services, typed by hand like the hardware.
**Runs on** holds the name of the device or VM it runs on, which builds the tree of the
inventory and the guests of the [network map](#network-map).

Virtual assets have the same tiles, per type, and pages of their own at
`/virtual/<id>`, with their resources and the console, an **Interventions** tab, a
**Links** tab with their addresses, and a **History** tab. **Runs on** links to the hardware page of that name.

With a Proxmox URL in the settings, assets with a VMID and node get a noVNC **Console**
button. You sign in to Proxmox itself.

## Overview

The overview sums up the inventory: every figure opens its page. Its header says when
it was last refreshed, like the monitor's. Panels show the
progress of the [work](#work), hardware per category, the fullest subnets,
addressing conflicts, tasks due within seven days, recent deployments and warranties
ending soon. **Customize** moves and hides them;
the layout is kept per device.

### Cards and charts

**Add a card** puts your own cards next to the built-in panels, as GLPI's dashboards do.
Cards are kept on the server, so every browser sees the same ones. A card's menu edits,
duplicates, moves it to another tab, shows the figures behind a chart, downloads them as
CSV or removes it.

A chart is built in three steps, with a live preview beside them:

1. **Type**: columns, bars, histogram, waterfall, columns and line, lines, areas, steps,
   scatter, pie, doughnut, half doughnut, treemap, funnel, radar, big number, several
   numbers, gauge, progress bars, summary table or a list of rows.
2. **Data**: the rows to read, filters on them, what to group by (a field, or a date by
   minute, hour, day, week, month, quarter, year, day of the week or month of the year,
   or a number cut into ranges), one series per value of another field, and the
   measures: count, count distinct, sum, average, minimum, maximum, median or last
   value, each with its own filters, as Excel's `COUNTIF` and `SUMIF`. A formula
   combines measures by their letter, such as `B / A * 100` or `round(A / 1024, 1)`,
   with `+ - * / % ^`, parentheses, `round`, `abs`, `min`, `max`, `sqrt`, `floor` and
   `ceil`. Results can show as values, shares of the total, a running total or the change
   from the previous one; keep the first few and gather the rest as **Other**.
3. **Look**: stacking, legend, labels, palette (or the colour of each state, so that
   *failed* is red), number format, decimals, prefix and suffix, scale, a reference line,
   warning and critical levels, smoothing, points, grid lines and height.

Filters take `is`, `is not`, `contains`, comparisons, `in the last … days`, `in the next …
days`, `is past`, `is empty` and more; several values are separated by commas. Points,
bars and list rows open the record they come from.

| Rows | Holds |
| --- | --- |
| Hardware | Category, status, place, rack, maker, model, supplier, price, height, dates, tags |
| Virtual assets | Type, status, host, Proxmox node, vCPU, memory, disk, address, tags |
| Components | Type, status, device, maker, model, capacity, dates, tags |
| IP addresses | State, device, hostname, owner, shared, last seen |
| Subnets | Network, section, place, VRF, VLAN, size, addresses in use, use in percent, threshold |
| Tasks, interventions, deployments | State, type, owner, target, version, dates, tags |
| Racks and shelves | Kind, place, height, devices |

The other cards need no rows:

| Card | Shows |
| --- | --- |
| EDF Tempo | Today's and tomorrow's colour and the days left. Read from the linked monitor, where the RTE keys are set |
| Pipelines | State of the latest CI/CD run of each repository followed by the monitor |
| Monitoring | Hosts online, open alerts, containers and average load, from the linked monitor |
| Note | Free text |
| Links | Bookmarks, one `Label \| https://address` per line. Only `http` and `https` addresses are kept |
| Clock | Time and date, in the browser's time zone or one you name, such as `Europe/Paris` |
| Web page | A page of your own in a frame, such as a Grafana panel. Your browser loads it directly, and the page must allow being framed |

Tempo, Pipelines and Monitoring need a [linked monitor](deployment.md#linking-manager-and-monitor). Without one, they say so.

### Tabs

**Add a tab**, after the tabs, splits a large dashboard: capacity on one, warranty and
purchases on another. Start from an empty tab or from a ready-made one, whose cards are
ordinary charts you can then edit, move or remove:

| Ready-made tab | Cards |
| --- | --- |
| Hardware fleet | Devices, value of the fleet, devices by category, status and place, purchases per year |
| Warranty and lifecycle | Warranties ending within 90 days, warranties over, the list of those ending soon, endings per year, components out of warranty |
| Virtualization | Virtual assets, vCPU allocated, assets by type and status, memory and vCPU each host gives |
| IP addressing | Use of each subnet, addresses by state, addresses in use per place, subnets per section |
| Work | Late tasks, tasks by state, tasks due within 14 days, deployments per month and by state, interventions by type |

Its names are saved in the language of whoever adds it. Double-click a tab, or use the
arrow next to the open tab, to rename it, move it or delete it with its cards. The first
tab holds the built-in panels; the others hold only your cards. Each tab keeps its own
layout.

Widgets made before tabs existed stay on the first tab.

## Forms

Hardware and virtual assets are added and edited on a page of their own (**Add hardware**
leads to `/hardware/new`), never in a window. Each heading of the form is a panel, and
**Save** stays at the bottom of the screen on long forms. The form keeps what you typed
when you switch tabs, and **Save** saves every tab at once; a required field left empty
on another tab opens that tab. Saving stays on the page; adding a record opens its new
page, where the other tabs appear. **Escape** or **Back** goes back to the list.

Other records (work, IPAM, VPN links) open a form at the top of their page,
above the list. **Escape** or **Cancel** closes it without saving.

## IPAM

IPAM keeps the address plan: subnets, the addresses in them, VLANs, VRFs and routes.
IPv4 and IPv6 both work. Its tabs:

| Tab | Contents |
| --- | --- |
| Overview | Counts, conflicts with the ways to resolve them, the fullest subnets and the IP calculator |
| Subnets | Every subnet as a tree, one table per section, with its VLAN, VRF, gateway and usage |
| Addresses | Every address with its state (Active, Reserved, DHCP, Offline), device, hostname, MAC, owner and when a scan last saw it |
| VLANs | Numbers, names and the domain they belong to, with the subnets that use them |
| VRFs | Routing tables, with an optional route distinguisher |
| Routes | Routes per device, for the simulation |
| Simulator | The network drawn from the records, and pings played hop by hop |

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

One machine recorded twice is not a conflict. Records are the same machine when they
share a name, a hostname or a MAC address, ignoring case: a host renamed in the monitor,
or recorded by hand under another name with its hostname, is recognised. Addresses
belong to the subnets that contain them, whatever their VRF, so the same address
recorded twice in two VRFs reads as a conflict.

For an address held by several machines, **Resolve** offers the ways out:

- **Keep** one record when they are the same machine. The record kept takes the
  hostname, MAC, owner and state that only the others had, and the others are deleted.
- **Change the address** of one of them, in its form.
- **Shared on purpose** marks every record of the address as shared, for VRRP, CARP or
  anycast. Shared records are no conflict between themselves, only with another machine.
  The same box is in each address's form.

### IP calculator

Type an address with its prefix length or mask: `192.168.1.37/26`,
`192.168.1.37 26` or `10.0.0.1 255.255.255.0`. Without either, /24 is assumed. It
works as you type and gives the kind of address (private, public, CGNAT, link-local,
loopback, multicast, documentation), the address in binary with the network bits
coloured, the network, netmask, wildcard, broadcast, the range of hosts and their
number, and the recorded subnet it falls in. **Split into** lists the subnets of a longer
prefix, the first 64 of them. IPv6 prefixes are worked out by the server.

### Simulator

The **Simulator** tab draws the network from the IPAM, after Cisco Packet Tracer:

- each subnet is a segment, with its VLAN, gateway and machines on a bus, the way a
  switch connects them;
- a machine with addresses in two segments, or holding a segment's gateway, is a
  **router**, drawn above them with a cable to each, labelled with its address there;
- machines outside every subnet are grouped apart;
- machines sharing an address with another are in red, and a gateway no machine holds is
  marked ⚠.

Choose the machine to send from and the machine or address to ping, or click one machine
then another, and press **Send a ping**. The envelope goes there in orange and comes back
in green, one hop at a time: play, pause, step back and forth, or start again. The
**Event list** gives each step: the machine, the address it sends from and what it
decides. The result is one of:

| Result | When |
| --- | --- |
| Reached | The request got there and the reply came back |
| Conflict | It got there, but two machines answer at that address |
| Leaves the network | It reached a router with no route further: an address on the internet, for example |
| Unreachable | Nothing is recorded at the address, a gateway is not recorded, or there is no way |
| Loop | Routes send it round in circles |

At each machine, a destination in one of its segments is reached directly. Otherwise
the longest matching **route** of that machine wins, then the lowest metric; without
one, the packet goes to the **gateway** of the segment it sends from. So most home
networks need no routes at all: record the router's address in each subnet, the
subnets' gateways, and the machines. The reply is traced back the same way.

It reads your records, not your network, so firewalls and NAT are not considered. The
conflicts are listed beside the event list, with the same ways to resolve them.

## Places

**Places** are what devices stand in or on, drawn from the front side by side on one
floor, so that a homelab without a rack is drawn too. **Add place** picks a kind:

| Kind | Drawn as | Height |
| --- | --- | --- |
| Rack | A 19" cabinet with its rails and unit numbers, 1 at the bottom | Units (42 by default) |
| Shelving unit | Posts and boards; the top board counts as a level | Levels |
| Desk or box | A top with a box under it, devices set on top | One level |

Shelving units and desks also take a width in centimetres, which makes them wider or
narrower beside the others, and a finish: wood, white, black or grey.

Across a rack unit or a shelf there are 12 columns. A device takes the whole width by
default; **Width** makes it a half, a third, a quarter and so on, so two half-width mini
PCs share one unit, or several devices one shelf. In a rack a device is as tall as its
**Height (U)**; on a shelf or a desk it takes one level.

- Drag a device from **Not placed** onto a place, or press **Put in place** to put it in
  the first free spot: highest first, then leftmost, as racks and shelves fill.
- Drag a device inside a place or from one to another. A spot it would overlap shows red
  and the move is refused. Focused with the keyboard, the arrows move it one unit or
  level up and down, one column left and right.
- Click a device for its width, its height in a rack, its record, **Take out**, and its
  **Cables**: its ports and what each one is plugged into. **Plug into** picks another
  device and the port on each side by name; a port that does not exist yet is created. A
  port holds one cable, so plugging it elsewhere unplugs it first. These are the same
  [network ports](#network-ports) as on the hardware page, and they are drawn on the
  [network map](#network-map) too.
- A spare, broken or retired device shows its status on its left edge; one in service
  needs no mark.

Switches and patch panels show their ports, servers and NAS their bays, a UPS its screen,
so that a front reads at a glance. The hardware form shows the place under **Where it
is**: **Place** and **Position (U or level)**. Deleting a place keeps its devices, out of
any place. **Patch panel** and **PDU** are hardware categories of their own.

## Network map

The map is laid out like a drawing tool: a toolbar on top, the **Devices** to add on the
left, the canvas in the middle, and the selection on the right. Switch between the
**diagram**, a **tree** (guests under their host) and **by type** in the toolbar.

The map follows the hierarchy of your machines. A VM, container or other device linked
to a Proxmox, physical or server node is its guest: it is listed under that host, inside
a frame, joined to it by a tree line. Links between two hosts, or to network gear, are
drawn as curves that bend around the cards.

**Arrange** places every device again: the network gear on top, from the Internet and the
firewall down to the switches and access points, then one column per host with its guests
in name order (`PVE-2` before `PVE-10`), then the devices that stand alone, such as a VPS.
It replaces the places you set by hand, so it asks first.

**Import the inventory** adds the hardware and the VMs and containers of the inventory,
each guest linked to the device its **Runs on** names. Spare and retired devices, patch
panels, PDUs and Docker services are left out, as they are on no network. A device already
on the map, by name, is not added twice. The first import arranges the map; later ones put
new devices in free spots and leave the rest alone, so press **Arrange** when you want
them tidied.

### Devices and links

Drag a type from **Devices** onto the canvas, or click it to add one in the middle: Internet,
router, firewall, switch, access point, server, Proxmox, NAS, VM, LXC container, Docker,
VPS, cloud service or IoT device. It is named after its type, selected, and ready to be
renamed. Each card shows the type's icon on a tile coloured by family (network gear,
machines, storage, guests, things outside), the name and the address. The arrow at the top of the list folds it to icons.

Click a device to select it. The side panel edits its name, address and type in place,
lists its connections (click one
to select that link), links it to another device from **Link to**, and opens the hardware
or virtual record of the same name. Drag a device to move it; its place is saved when you
let go. Delete, or the Delete key once the map has focus, removes the selection.

To link two devices, drag from the dot on the right edge of one onto the other; the dot
shows on hover and on the selected device. **New links**, under the map, sets the kind of
the links you draw, and each kind has its own line:

| Kind | Line |
| --- | --- |
| Ethernet | Solid blue |
| Fibre | Thick solid green |
| Wi-Fi | Dotted amber |
| VLAN | Dash-dot blue |
| VPN | Dashed orange |
| Virtual | Faint dotted grey |

Click a link to select it: the side panel changes its kind and its label, or deletes it.

### Zones

**Add zone** draws a coloured frame in the middle of the view, behind the devices, to
group them: a room, a VLAN, a site, the cloud. Drag its label to move it, with every
device whose middle lies inside; drag its bottom right corner to resize it. Selected, it
takes a name and a colour (blue, green, yellow, red, orange or grey) in the side panel,
which also counts the devices inside. Deleting a zone keeps its devices.

### Moving around

The map is a canvas: drag its dotted background to move around, scroll or pinch to zoom,
or use the buttons of the toolbar to zoom, fit everything and go full screen (`+`, `-`
and `0` from the keyboard once the map has focus). Cards snap to an 8 px grid as you drag
them, so they line up. **Find on the map** outlines the devices whose name, address or
type holds every word typed, fades the others, and Enter centres and selects the first
one. Hovering a device keeps it, what it is linked to and their links lit, and fades the
rest. **Devices and links as a list**, under the map, gives the same data as tables.

A VPN link whose **From** and **To** are both device names of the map is drawn there as
a dashed orange line, and exported the same way.

A cable between [network ports](#network-ports) of two hardware devices whose names are
on the map is drawn as a grey line labelled with both ports, and exported too. Two
devices get one line, however many cables join them, and a link you drew between them
wins over the cable.

**Export** gives SVG, draw.io, Mermaid, Graphviz DOT and JSON. SVG and draw.io draw the
zones behind the devices, and JSON lists them; Mermaid and Graphviz leave them out.

## VPN links

**VPN links** records tunnels by hand: type, both ends, tunnel subnet and public
endpoint. Leave **To** empty for a mesh such as Tailscale or NetBird.

The tunnels agents report, and their state, are on the monitor: see
[VPN links](monitoring.md#vpn-links).

## Work

**Work** holds everything to do on the homelab in one table: **tasks**, **interventions**
on the devices of the inventory, and **deployments**. The tabs on top narrow it to one
kind and count what is still to do in each; the subtitle says how much is left and how
much is late.

- The table lists the title, its target (the device of an intervention, where a
  deployment goes), the state, the due date and the tags. Click a header to sort on it.
  On **All**, an icon before the title tells the kind.
- **Show** keeps what is **To do** (the default), what is **Finished**, or all of it.
  The search looks in titles, targets and tags; click a tag to show only that tag.
- Change the state from the menu on each row, which also works from the keyboard and on
  a phone. A past due date on something still open shows as late.
- Type a title in the field above the table and press Enter to add one at once, of the
  kind of the tab (a task on **All**); open it later for the rest. **Add** opens the full
  form.
- On one kind, **Board** shows one column per state; drag a card to change its state.

An intervention or a deployment moved to a closing state (done or cancelled, succeeded or
failed) gets today as its done date, unless it has one.

### Tasks

Tasks can stand alone or sync with Nextcloud: see
[integrations.md](integrations.md#nextcloud). **Sync** fetches the changes at once. A task
is to do, in progress, done or cancelled; a cancelled task gets no reminder. Calendar
events only appear in the table, until their day has passed. A reminder goes out a day
before a task is due. Change the delay, and how early ending warranties appear on the
overview, in **Settings, General, Reminders**.

A task can hold a **Checklist** of steps: tick them as you go, and its row shows a bar with
the steps done. Press Enter in a step to add the next one. The steps are kept in the
description as a Markdown checklist (`- [ ] step`, `- [x] step`), so Nextcloud shows them
too and ticks made there come back. Nyx also sends the share of steps done to Nextcloud as
the task's percent complete.

### Interventions

An intervention is work on a device, after GLPI's: a **repair**, a part replaced, an
**upgrade**, a **maintenance** such as a UPS battery, an **installation** or a **check**.
It names a device or virtual asset of the inventory, is planned for a day, then moves to
in progress and done, with who did it and a **report**: what was found and done, the parts
used, the time spent. A reminder goes out ahead of the planned day, as for tasks.

Each hardware and virtual page has an **Interventions** tab: the history of that device,
newest first, where **Add intervention** plans one already aimed at it.

### Deployments

A log of what was deployed where, with its version and due date. Planned deployments
trigger a reminder ahead of time, a day by default. Node.js sites deployed by Nyx 1.0
appear here tagged `nodejs`, with how each one runs: see
[sites deployed by Nyx 1.0](agent.md#sites-deployed-by-nyx-10).

### Progress

The **Progress** panel of the [overview](#overview) sums up where everything stands:

- the overall share of tasks done. A closed task counts whole, an open one by its ticked
  steps, and one in progress without steps counts half. Cancelled tasks and calendar
  events do not count.
- tasks done out of the total, those in progress and those late
- one bar per tag, so a tag such as `rack-2026` reads as a project
- deployments that succeeded out of all of them, with those running or failed

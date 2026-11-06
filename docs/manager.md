# Manager

## Inventory

**Hardware** tracks physical equipment, with serial numbers, locations and warranty
dates. The overview flags warranties ending within 60 days. The add form starts from
the category, and offers the manufacturers, models and locations already in use.

Every inventory list has a search field and a filter per category or status. Click a
column header to sort on it, again to reverse; the order is remembered on this device.
On a phone, use **Sort by**.

**Virtual** tracks VMs, containers and Docker services. With a linked monitor these
fill themselves every five minutes, and rows marked `monitor` follow the agents: they
disappear when the host does. Manual rows are never touched. Physical hosts are not
copied into **Hardware**, because agents do not report serial or warranty data.

With a Proxmox URL in the settings, assets with a VMID and node get a noVNC **Console**
button. You sign in to Proxmox itself.

## IPAM

Add **Subnets**, then **Addresses**. IPv4 and IPv6 both work. **Usage** shows
occupancy and can suggest the next free address, skipping the network, broadcast and
gateway addresses.

Conflicts detected:

- Overlapping subnets
- The same address on two devices
- An address outside every subnet
- A network or broadcast address assigned to a device
- A gateway outside its subnet
- A MAC address on several IP addresses
- Invalid CIDRs and addresses

Assigning the same address to one device twice is not a conflict. The device name is
the identity, so spell it consistently.

### Routing simulation

Add **Routes** for each device: a destination, a next hop, and a metric. In **Usage**,
choose a device and an address and press **Trace**.

At each device the simulation picks the longest matching prefix, then the lowest
metric, and finds the next device from the address list. Destinations on a directly
connected subnet are reached without a route. It reports loops and black holes.

It reads your records, not your network, so firewalls and NAT are not considered.

## Network map

Drag devices to arrange them. Double-click one to edit it, or use the list below the
map, which is the easier way on a phone. **Import hosts** adds monitored hosts and
links guests to their parents. Positions are saved when you let go.

A VPN link whose **From** and **To** are both device names of the map is drawn there as
a dashed line, and exported the same way.

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
Server, are left out. On a Proxmox node, apps inside containers belong to the agent in
that container.

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

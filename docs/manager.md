# Manager

## Inventory

**Hardware** tracks physical equipment, with serial numbers, locations and warranty
dates. The overview flags warranties ending within 60 days.

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

Exports: SVG, draw.io, Mermaid, Graphviz DOT and JSON.

## Deployments

A log of what was deployed where, with planned dates. Planned deployments trigger a
reminder a day ahead. Site deploys appear here on their own.

## Node.js sites

Sites need a linked monitor: deploys run through the agent on the target host.

1. Agents report Node.js versions and running apps. These appear in **Detected
   Node.js apps**, with a **Manage** button.
2. Create the site. Leave the private key empty to generate an ed25519 deploy key, or
   paste an unencrypted OpenSSH key.
3. Copy the public key to the repository as a read-only deploy key.
4. Add the webhook URL and secret to the repository, for push events, as JSON.

A push to the configured branch then deploys. **Deploy** does the same by hand.

The agent fetches the branch as the run user, runs the install and build commands,
and writes and restarts a `nyx-site-<name>` systemd service. The run user must exist
on the host. The default is `www-data`.

GitHub, Gitea and Forgejo sign webhooks with `X-Hub-Signature-256`, and GitLab sends
`X-Gitlab-Token`. Both are supported.

## Tasks

Tasks can stand alone or sync with Nextcloud: see
[integrations.md](integrations.md#nextcloud).
A reminder goes out a day before a task is due.

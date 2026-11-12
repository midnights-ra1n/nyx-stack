# Agent

A single static binary, run by systemd as root. It opens no port: it calls the
monitor every 15 seconds while someone uses the monitor, every 60 seconds otherwise. Measured on a release build: 1.4 MB on disk, about 13 MB of
RSS, and 0.16 s of CPU over 45 s, on macOS. Figures on Linux may differ.

## Installing

### Add host

In the monitor, choose **Add host**, pick the type and copy the line:

```sh
curl -fsSL https://monitor/install.sh | sudo sh -s -- \
  --url https://monitor --token TOKEN --key KEY --kind vm
```

The line uses the monitor's public URL. If the host reaches the monitor at another
address, such as a LAN name or a VPN address, change **Monitor URL** above the command.
Your browser remembers it, and the host page offers the same with **Show install
command**. Without `NYX_PUBLIC_URL`, Nyx suggests the address in your browser.

Add `--ct-autoinstall` on Proxmox to watch its containers, see
[Proxmox containers](#proxmox-containers). On `physical` and `proxmox` the script installs smartmontools, because SMART is mandatory there.

### Ansible

The role in `packaging/ansible/roles/nyx_agent` takes the same four values:

```yaml
- hosts: nyx_hosts
  become: true
  roles:
    - role: nyx_agent
      vars:
        nyx_agent_url: https://monitor.example.com
        nyx_agent_token: "{{ vault_nyx_token }}"
        nyx_agent_key: "{{ vault_nyx_key }}"
        nyx_agent_kind: physical
```

`nyx_agent_kind` takes `vm`, `physical`, `proxmox`, `vps` or `lxc`, like the install
line. On `proxmox`, set `nyx_agent_ct_autoinstall: true` to watch the LXC containers from
the host: nothing is installed inside them. It is the **Watch LXC containers from this
host** box of the interface.

Each host needs its own token and key, so create them with **Add host** and keep them
in Ansible Vault. Changing `nyx_agent_kind` and replaying the playbook changes the
host type without reinstalling. Every variable is listed in the role's
[README](../packaging/ansible/README.md).

### Package

```sh
sudo apt install ./nyx-agent_*.deb
sudo nyx-agent configure --url https://monitor --token TOKEN --key KEY --kind vm
sudo systemctl start nyx-agent
```

### Docker

Use the `agent` profile in `compose.yaml`. It needs the host's PID namespace and
network, and privileges for SMART. It cannot apply system updates, and the
self-update is lost when the container is recreated, so prefer systemd where you can.

## Host types

| Type | SMART | Proxmox guests | Notes |
| --- | --- | --- | --- |
| `vm` | no | no | Virtual machines |
| `lxc` | no | no | LXC containers. Set by itself when the agent runs in one |
| `vps` | no | no | A rented machine, usually a VM |
| `physical` | yes | no | Bare metal without Proxmox |
| `proxmox` | yes | yes | Lists guests. Can watch its containers without an agent inside |

Change the type from the host page. The monitor sends the change to the agent, which
applies it without restarting anything or losing history.

The agent checks the choice against the machine, with `systemd-detect-virt`, and reports
what it finds. A machine picked as `vm`, `lxc` or `physical` that turns out to be something
else is listed as what it is, and SMART follows. `proxmox` and `vps` stay as picked, since
nothing on the machine shows them: a VPS is usually a VM, sometimes a container, and a
provider can hide its hypervisor. The inventory of the manager lists a VPS as a VM.

### Proxmox containers

Nothing is installed in LXC containers. The agent on the Proxmox host reads what Proxmox
already measures, with `pvesh`, and the monitor keeps a host for each container.

Turn on **Watch LXC containers from this host**, or `--ct-autoinstall` in the install
command, a name kept from when this option installed agents. Then:

- every container gets a host of its own, under its Proxmox host, of type `lxc`, including
  new ones. CPU, memory, root disk, network, uptime, OS and address follow every 30 s,
  with history, alerts and status like any host. The address is the static one, or what
  `lxc-info` reports for DHCP
- CPU is a share of the cores given to the container
- a stopped container shows as stopped, and raises the same alert as a host going silent
- a destroyed container leaves Nyx
- logs, updates, Docker state and Node.js apps need an agent, and are not available

With the option off, containers do not appear at all. Turning it off removes the hosts
of watched containers and their history. VMs are always listed under their Proxmox host,
and need an agent of their own for metrics.

Reading the figures starts `pvesh`, which is heavier than the rest of the agent. It runs
every 30 s with the option on, every 5 minutes with it off.

If you still want an agent inside a container, install it there with the type `lxc`. The
monitor ties it to the container by name and uses it instead, until it goes quiet. An
agent an earlier version installed keeps working the same way: remove it with
`nyx-agent uninstall` inside the container, and the Proxmox host takes over a minute later.

### OCI containers

Proxmox VE 9.1 and later can start a container from an OCI image. When such an image
starts anything other than an init, Proxmox writes an `entrypoint` key in
`/etc/pve/lxc/<vmid>.conf`. The container then runs that one application, with no
systemd to start the agent, and often no shell, `curl` or package manager.

The agent on the Proxmox host reads that key and reports the guest as `oci`. It is watched
like any other container, so this does not limit its figures.

An agent started by hand in an OCI container does report CPU, memory, disks and network.
The host page then warns that logs, updates and Docker state stay empty when the image
has no journald, package manager or Docker.

## Report pace

The monitor sets the pace in each answer:

| When | Every | Requests per host per day |
| --- | --- | --- |
| Nobody used the monitor's web interface in the last 2 minutes | 60 s | 1,440 |
| Someone uses it, or watches live logs | 15 s | 5,760 at most |
| A system or agent update runs | 5 s | while it lasts |

When you open the interface, each agent speeds up after its next report, so within a
minute. Commands such as a deploy or an update also start at that next report. Wall
displays, status pages and MCP calls do not speed agents up. A host goes offline after
two missed reports at its pace, plus 30 seconds: 1 minute at full pace, 2.5 minutes idle.

## What is collected

| Data | Frequency | Notes |
| --- | --- | --- |
| Uptime, CPU, RAM, swap, network, disk usage | Each report | |
| Temperature | Each report | Highest sensor |
| Docker containers | When changed | Through `/var/run/docker.sock`, skipped if absent |
| Node.js apps and version | When changed, looked for every 5 min | From running processes: folder, Git origin and branch, user, what runs them. Credentials in a Git URL stay on the host, and the binaries found are never run |
| VPN tunnels | Each report | Interface, type, address and traffic |
| Pending system updates | Daily | At the hour set in the monitor |
| SMART health and remaining life | Periodically | Physical hosts. Summarised as a simple state |
| Logs | Once a minute, when there are new lines | Warnings and above, through journald |
| Live logs | Every 2 s, only while someone watches this host | Info and above, nothing stored. See [live logs](monitoring.md#live-logs) |

| Restart needed | Each report | `/run/reboot-required`, or a newer kernel in `/lib/modules` than the running one |
| Firewall | 5 min, and right after a change | Tool, default policy, incoming rules, ports open to the network. See [Firewall](#firewall) |

Package managers supported for updates are apt and dnf.

## Firewall

The **Firewall** block of a host page shows the tool that filters incoming traffic, what
happens to traffic no rule matches, the incoming rules in the order they apply, whether
they come back after a restart, and the ports open to the network with whether anyone can
reach them. Ports bound to loopback are left out, since the network cannot reach them.

| Tool | Read | Rules added and removed |
| --- | --- | --- |
| ufw | `ufw status` | With `ufw`, saved by ufw itself |
| firewalld | Default zone: services, ports and rich rules | Runtime first, then `--permanent` once it held |
| iptables (legacy or nft) | From `INPUT` on, IPv4 and IPv6, following your own chains | In the `NYX-INPUT` chain; see [Saving iptables rules](#saving-iptables-rules) |
| nftables | Chains hooked on `input`, and the full ruleset | No: edit `/etc/nftables.conf` |

The agent picks the tool that is on: ufw, then firewalld, then nftables with its own
`inet` table, then iptables with rules. A host with ufw or firewalld installed but off
shows it as off, and rules can be added once you turn it on from the host.

### Rules already there

Every rule already on the host is listed and can be removed, whoever made it. With
iptables, the agent follows the jumps from `INPUT` into chains of your own, such as the
`FW-INPUT` chain the server-deploy playbook uses, and shows their rules in place, with the
chain name. Chains that other tools build at start are shown as a single jump and never
opened, saved or changed: Docker (`DOCKER*`), fail2ban (`f2b-*`), libvirt, Kubernetes,
CNI, Tailscale (`ts-*`), NetBird and CrowdSec. A rule removed by Nyx is removed with its
exact arguments, only if it is still listed, so a rule that changed meanwhile is left
alone.

### Adding a rule

Pick allow, drop or reject, a protocol, a port or range, and a source (empty for
anywhere). A rule for a source goes first, others last: "allow my LAN" then "drop for
everyone" works in either order of creation. In the list of open ports, **Allow** opens
a blocked port in one click. Rules added by Nyx carry the comment `nyx` unless you give
one.

With iptables, Nyx's rules go in its own chain, `NYX-INPUT`, jumped to first from `INPUT`
for all traffic but loopback. Your rules and your playbook's chains stay as they are, and
a playbook that reloads only its own chains (`iptables-restore --noflush`) leaves Nyx's
rules alone.

### Docker

A port published by Docker never reaches `INPUT`: Docker redirects it before, so ufw,
firewalld and iptables rules on the host do not apply to it. The only place that filters
it is Docker's `DOCKER-USER` chain, whatever tool the host uses.

The list of open ports takes published ports from Docker's API, with the container's
name, also when no `docker-proxy` listens on them. Their reachability comes from
`DOCKER-USER` alone. A rule for such a port goes in `DOCKER-USER` on its own, matching the
port the client asked for (`--ctorigdstport`), since Docker has already rewritten the
destination when the chain sees it. Allowed traffic goes back to Docker (`RETURN`), so
Docker's own isolation still applies.

Docker starts with an empty `DOCKER-USER` after a restart. The agent keeps the rules of
`DOCKER-USER` and `NYX-INPUT` in `/etc/nyx/firewall.rules` and puts them back when it finds
the chain empty, on its first report after a restart, then every 5 minutes. This works
with ufw and firewalld too. Emptying one of these chains by hand brings its rules back:
remove them from Nyx instead.

### Saving iptables rules

On Debian and Ubuntu, `netfilter-persistent` (package `iptables-persistent`) loads
`/etc/iptables/rules.v4` and `rules.v6` at boot. On RHEL, Fedora and Alma,
`iptables-services` loads `/etc/sysconfig/iptables` and `ip6tables`.

- **Neither is installed:** the block says so and offers to install the right package.
  The agent sets it up not to save on its own, installs it without removing anything (on
  Ubuntu it would replace ufw otherwise), then saves the current rules.
- **The live rules differ from the boot file:** shown as **Not saved**, with a **Save
  rules** button. Rules changed by hand or by a script are not lost at the next restart
  this way. Comments and counters do not count as a difference, but a file written by hand
  in another form than `iptables-save` does, until it is saved once.
- **After a change from Nyx:** the boot file is written again, but only if it matched the
  live rules before. Otherwise it is left alone and the result says so, so a change you
  were still testing by hand is not saved by surprise.

Saving writes `iptables-save` without the chains of the tools listed above, which make
their own at start: Docker's, saved, would come back at boot pointing to containers that
are gone. `DOCKER-USER` is kept. The previous file stays next to it as `.nyx-bak`.

A playbook that writes the boot file, such as server-deploy's `rules.v4`, replaces what
Nyx saved there at its next run. Rules in `NYX-INPUT` and `DOCKER-USER` still come back,
from the agent.

### Safety

Before a change, the agent saves the rules: the output of `iptables-save`, the ufw rule
files, or nothing for firewalld, whose change stays runtime until it held. After it, the
agent calls the monitor. If that fails three times in 15 seconds, it puts the rules back
and reports the failure. SSH is not tested this way: Nyx asks for confirmation before a
change that could block port 22, and since the agent does not use SSH, you can still undo
such a rule from Nyx.

## Files

| Path | Purpose |
| --- | --- |
| `/usr/local/bin/nyx-agent` | Binary (`/usr/bin` when installed from a package) |
| `/etc/nyx/agent.conf` | Configuration, mode 0600 |
| `/run/nyx-agent/` | tmpfs: journal cursors, temporary deploy keys |

## Removing

On the host, as root:

```sh
sudo "$(command -v nyx-agent)" uninstall
```

This stops and disables the service, and removes the binary, the unit and
`/etc/nyx/agent.conf`, or the package if it came from one. `/etc/nyx` goes too, unless a
server on the same host still uses it. It works without the monitor. The dialog behind
**Delete host** shows this line.

Then delete the host in the monitor, where deleting alone only stops accepting the
agent: it would keep running and being refused. Its history ages out with the retention.

Left in place on purpose: smartmontools, which other tools may use, and any
`nyx-site-*` service deployed by the manager, as those are your applications.

On a Proxmox host this also removes any agent left inside its running containers. A
stopped container keeps its agent, so start it first or run the command there later. Then
delete the host in the monitor: its LXC containers go with it, while VMs stay as hosts of
their own, each with its own agent to remove. With Docker, use `docker compose --profile agent down`.

## Updates

A system update refreshes the package list first, then runs `apt-get upgrade
--with-new-pkgs`, `apt-get dist-upgrade` on Proxmox, as it requires, or `dnf upgrade`.
While it runs the agent reports its progress every 5 s. With apt the percentage comes
from apt itself, with dnf from its package counter. Only one update runs at a time on a
host, and the agent replaces itself last, as that restarts it.

Packages can restart services when they are replaced. Upgrading Docker restarts the
containers of that host, including Nyx if it runs there. The run then disappears from
the page, while the updates themselves go on.

The agent never contacts GitHub. It takes the binary its monitor ships, which keeps its
version in step with the server.

For beta agents with a stable monitor, tick **Use beta agents** in **Settings, Monitoring**.
This applies to every agent of the monitor. The monitor then checks GitHub once an hour,
fetches the newest release's agents to its data folder, checks them against `SHA256SUMS`,
and hands them out, still signed by itself, with the daily update or **Update agent**.
Releases carry these binaries from the version that added the option. A new install takes
the shipped agent first, then moves to beta with its first update.

Unticking brings agents back to the version the monitor ships, with their next update. A
beta agent can need a newer monitor than yours, so try it on a monitor that is not far
behind. To move the servers too, see [Release channels](deployment.md#release-channels).

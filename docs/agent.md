# Agent

A single static binary, run by systemd as root. It opens no port: it calls the
monitor every 15 seconds. Measured on a release build: 1.4 MB on disk, about 13 MB of
RSS, and 0.16 s of CPU over 45 s, on macOS. Figures on Linux may differ.

## Installing

### Add host

In the monitor, choose **Add host**, pick the type and copy the line:

```sh
curl -fsSL https://monitor/install.sh | sudo sh -s -- \
  --url https://monitor --token TOKEN --key KEY --kind vm
```

Add `--ct-autoinstall` on Proxmox to cover containers. On `physical` and `proxmox` the
script installs smartmontools, because SMART is mandatory there.

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

Each host needs its own token and key, so create them with **Add host** and keep them
in Ansible Vault. Changing `nyx_agent_kind` and replaying the playbook changes the
host type without reinstalling.

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
| `vm` | no | no | Virtual machines and containers |
| `vps` | no | no | Same as `vm`, labelled for hosted machines |
| `physical` | yes | no | Bare metal without Proxmox |
| `proxmox` | yes | yes | Lists guests. Can install the agent in containers |

Change the type from the host page. The monitor sends the change to the agent, which
applies it without restarting anything or losing history.

### Proxmox containers

With container auto-install on, the agent lists containers and asks the monitor for a
token for each one it has not seen, then runs the installer inside with `pct exec`.
New containers are picked up the same way. The chosen type inside is `vm`.

## What is collected

| Data | Frequency | Notes |
| --- | --- | --- |
| Uptime, CPU, RAM, swap, network, disk usage | 15 s | |
| Temperature | 15 s | Highest sensor |
| Docker containers | When changed | Through `/var/run/docker.sock`, skipped if absent |
| Node.js apps and version | When changed | From running processes |
| Pending system updates | Daily | At the hour set in the monitor |
| SMART health and remaining life | Periodically | Physical hosts. Summarised as a simple state |
| Logs | When there are new lines | Warnings and above, through journald |

Package managers supported for updates are apt and dnf.

## Files

| Path | Purpose |
| --- | --- |
| `/usr/local/bin/nyx-agent` | Binary (`/usr/bin` when installed from a package) |
| `/etc/nyx/agent.conf` | Configuration, mode 0600 |
| `/run/nyx-agent/` | tmpfs: journal cursor, temporary deploy keys |

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

An agent inside a Proxmox container is a host of its own, so remove it there. With
Docker, use `docker compose --profile agent down`.

## Updates

The agent never contacts GitHub. It takes the binary its monitor ships, which keeps its
version in step with the server. For beta agents, put the monitor on the beta channel,
see [Release channels](deployment.md#release-channels).

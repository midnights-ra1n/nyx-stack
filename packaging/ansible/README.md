# Ansible role

See [docs/agent.md](../../docs/agent.md#ansible). Copy `roles/nyx_agent` next to your
playbook, or set `roles_path`, and start from `playbook.example.yml`.

| Variable | Required | Meaning |
| --- | --- | --- |
| `nyx_agent_url` | Yes | Monitor URL |
| `nyx_agent_token` | Yes | Host token, from **Add host** |
| `nyx_agent_key` | Yes | Host signing key, from **Add host** |
| `nyx_agent_kind` | No, `vm` | `vm`, `lxc`, `physical`, `proxmox` or `vps` |
| `nyx_agent_ct_autoinstall` | No, `false` | On `proxmox`, install the agent in its LXC containers from the host |
| `nyx_agent_dns` | No, `[]` | DNS servers the agent resolves the monitor with, such as `["1.1.1.1", "1.0.0.1"]`. Empty uses the system's |
| `nyx_agent_metrics_listen` | No, `""` | Address of the agent's own Prometheus endpoint, such as `0.0.0.0:9101`. Empty: off |
| `nyx_agent_metrics_token` | With a non-loopback address | Bearer token for that endpoint, 16 characters or more. Keep it in Ansible Vault |
| `nyx_agent_relay_key` | With the [Cloudflare relay](../../docs/cloudflare.md) | Relay key, 64 hex characters. `nyx_agent_url` is then the Worker's address. Keep it in Ansible Vault |

Run the role on the Proxmox host only: nothing goes in its containers, which then appear
in the monitor by themselves. See [Proxmox containers](../../docs/agent.md#proxmox-containers).

The agent checks `vm`, `lxc` and `physical` against the machine, and reports what it finds.
Changing a variable and running the playbook again updates the host without reinstalling.

# Configuration

Servers read environment variables. With packages, put them in
`/etc/nyx/monitor.env` or `/etc/nyx/manager.env`. Everything else is set in the UI.

## Servers

| Variable | Default | Meaning |
| --- | --- | --- |
| `NYX_PB_EMAIL` | required | PocketBase superuser email. The first migration creates it |
| `NYX_PB_PASSWORD` | required | PocketBase superuser password |
| `NYX_PB_URL` | `http://127.0.0.1:8090` | PocketBase address |
| `NYX_BIND` | `0.0.0.0:8081` monitor, `0.0.0.0:8082` manager | Listen address |
| `NYX_PUBLIC_URL` | `http://localhost:<port>` | The URL users and agents reach. Must be `https://` for MCP, passkeys and Secure cookies |
| `NYX_TLS_CERT`, `NYX_TLS_KEY` | unset | PEM files, to serve HTTPS without a reverse proxy |
| `NYX_NOTIFIER_BIN` | `nyx-notify` | Path to the notifier |
| `NYX_AGENT_DIR` | `/usr/share/nyx/agents` | Monitor only. Agent binaries served to hosts |
| `NYX_UPDATE_DIR` | unset | Enables package self-update. Set by the systemd units |

## Agent

The agent reads `/etc/nyx/agent.conf` as `KEY=VALUE` lines, mode 0600. Environment
variables of the same name win, which is how the Docker image is configured.

| Key | Meaning |
| --- | --- |
| `NYX_URL` | Monitor URL |
| `NYX_TOKEN` | Host token, from **Add host** |
| `NYX_KEY` | Host signing key, from **Add host** |
| `NYX_KIND` | `vm`, `physical`, `proxmox` or `vps` |
| `NYX_CT_AUTOINSTALL` | `1` to install the agent in Proxmox containers, including new ones |

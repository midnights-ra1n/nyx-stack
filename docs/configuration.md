# Configuration

Servers read environment variables. With packages, put them in
`/etc/nyx/monitor.env` or `/etc/nyx/manager.env`. Everything else is set in the UI.

## Servers

| Variable | Default | Meaning |
| --- | --- | --- |
| `NYX_PB_EMAIL` | unset | Database superuser email. With the password, skips the [first-start choice](deployment.md#choosing-a-database) and uses the local database |
| `NYX_PB_PASSWORD` | unset | Database superuser password |
| `NYX_DATA_DIR` | `nyx-data` in the working directory | Where the database choice and the local database live. Set by the systemd units and the images |
| `NYX_PB_URL` | unset | With the email and password, skips the choice and uses this shared database |
| `NYX_BIND` | `0.0.0.0:8081` monitor, `0.0.0.0:8082` manager | Listen address |
| `NYX_PUBLIC_URL` | `http://localhost:<port>` | The URL users and agents reach. Must be `https://` for MCP, passkeys and Secure cookies |
| `NYX_TLS_CERT`, `NYX_TLS_KEY` | unset | PEM files, to serve HTTPS without a reverse proxy |
| `NYX_NOTIFIER_BIN` | `nyx-notify` | Path to the notifier |
| `NYX_AGENT_DIR` | `/usr/share/nyx/agents` | Monitor only. Agent binaries served to hosts |
| `NYX_UPDATE_DIR` | unset | Enables package self-update. Set by the systemd units |

## Shared database

`nyx-db` reads `NYX_PB_EMAIL` and `NYX_PB_PASSWORD`, both required, then `NYX_BIND`
(default `0.0.0.0:8090`) and `NYX_DATA_DIR`. With packages they are in `/etc/nyx/db.env`.
The credentials only apply to the first start: they create the superuser.

## Agent

The agent reads `/etc/nyx/agent.conf` as `KEY=VALUE` lines, mode 0600. Environment
variables of the same name win, which is how the Docker image is configured.

| Key | Meaning |
| --- | --- |
| `NYX_URL` | Monitor URL |
| `NYX_TOKEN` | Host token, from **Add host** |
| `NYX_KEY` | Host signing key, from **Add host** |
| `NYX_KIND` | `vm`, `lxc`, `physical`, `proxmox` or `vps` |
| `NYX_CT_AUTOINSTALL` | `1` to watch the LXC containers of a Proxmox host, without an agent inside |

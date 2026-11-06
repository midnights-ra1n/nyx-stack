# Security

## Trust model

**The monitor can run commands as root on every enrolled host.** Agents run as root,
because SMART and system updates need it, and they accept update and deploy commands
from the monitor. Whoever controls the monitor, or its database, controls the fleet.
Protect it accordingly: keep it off the public internet where you can, or behind a
VPN or an authenticating proxy.

Limits on that: the agent runs only a fixed list of actions, not arbitrary commands.
Deploy steps are the exception by design, since they run the commands set for a site,
as that site's user.

## Agent traffic

- Each request is signed with HMAC-SHA256 using the host's key, and timestamped.
  Requests older than five minutes are refused. The key itself is never sent.
- Agent updates are signed the same way, and verified before replacing the binary.
- **Use HTTPS.** Signing protects integrity, but over plain HTTP metrics and the
  install line's token and key can be read on the network.

## Sessions and passwords

- Accounts are PocketBase users, with hashed passwords and login rate limiting.
- Sessions are signed `HttpOnly`, `SameSite=Strict` cookies, marked `Secure` with an
  HTTPS public URL.
- The UI sends a strict Content Security Policy and loads nothing from third parties.
  Fonts, icons and scripts are all served by Nyx.

## HTTPS gating

MCP checks the public URL and that the request really came over TLS, either directly
or through `X-Forwarded-Proto`. That header can be forged by anyone who reaches the app
directly, so when you use a reverse proxy, bind Nyx to localhost.

## Public pages

Status pages and wall displays are served without an account, so:

- Their answers are built from a list of allowed fields. A test checks that addresses,
  hostnames, targets, disk paths and identifiers cannot appear.
- Status pages expose only what was ticked. Open alerts never appear there, not even as
  a count, because their texts can name hosts and paths.
- Wall displays need a 128-bit key. A wall without a key cannot be opened. The key is
  in the link's `#` fragment, which browsers do not send, and travels in a request
  header, so it stays out of proxy logs. It is still in the browser's history, so
  replace the link if it leaks.
- Framing is refused everywhere, except for a status page whose owner ticked the
  option. That page is anonymous and read-only, so a frame cannot trick a visitor into
  doing anything. Walls can never be framed.
- Drafts and unknown addresses give the same 404.
- Texts are shown as text, never as HTML. Logos must be embedded images.

## First start

Until a database is chosen, the choice is open to anyone who can reach the port, as the
first account already is. Open a new server's port to yourself only, or skip the screen
with [variables](configuration.md#servers).

## Shared database

`nyx-db` is PocketBase with its superuser login exposed, and that login reads everything.
Keep its port on a private network or behind an HTTPS reverse proxy. The first-start
screen refuses plain HTTP to a public address, because the password and the token travel
with every request. Packages generate a long password, and with Docker you set it.

## Changing a password

**Settings, Security, Account** asks for the current password, and failures are rate
limited like logins. Sessions are signed cookies with no list on the server, so other
browsers stay signed in until their cookie expires, at most 7 days later.

## Secrets at rest

- `database.json`, mode 0600, holds the database password.
- PocketBase holds channel URLs, integration passwords and deploy keys in clear, in
  collections only the superuser can read. Protect `/var/lib/nyx` and its backups.
- Deploy keys and webhook secrets are withheld from the generic API. The site details
  page shows the secret and public key to signed-in users, and the private key is
  never returned. Settings pages return integration passwords to signed-in users, and
  every account is an administrator.
- Deploy keys reach the agent only during a deploy, and sit in tmpfs while in use.
- MCP tokens and the manager link token are stored as hashes on the side that checks
  them. The manager keeps the link token in clear to use it.

## External connections

Nyx contacts other parties only when you configure it to:

| Destination | When |
| --- | --- |
| Your notification services | When a rule sends |
| RTE | Tempo enabled |
| Your Nextcloud, Proxmox, Meross plugs | When configured |
| GitHub API and releases | Only when you press **Check on GitHub** or **Update** |

Release packages are checked against `SHA256SUMS` from the same release. This catches
corruption, not a compromised GitHub account, as releases are not signed yet.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository rather than a
public issue.

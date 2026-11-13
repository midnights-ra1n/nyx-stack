#!/bin/sh
# Nyx agent installer. Served by nyx-monitor at /install.sh; the "Add host" dialog
# in the UI generates the full command line.
#
#   curl -fsSL https://monitor/install.sh | sudo sh -s -- \
#     --url https://monitor --token TOKEN --key KEY --kind vm|lxc|physical|proxmox|vps [--ct-autoinstall]
set -eu

URL="" TOKEN="" KEY="" KIND="" CT="" BIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --kind) KIND="$2"; shift 2 ;;
    --binary) BIN="$2"; shift 2 ;; # already downloaded (a container without curl)
    --ct-autoinstall) CT="--ct-autoinstall"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$URL" ] && [ -n "$TOKEN" ] && [ -n "$KEY" ] && [ -n "$KIND" ] || {
  echo "--url, --token, --key and --kind are required" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x86_64 ;;
  aarch64 | arm64) ARCH=aarch64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

# SMART is mandatory on bare metal, so a missing smartmontools is fixed here.
case "$KIND" in
  physical | proxmox)
    if ! command -v smartctl >/dev/null 2>&1; then
      if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends smartmontools
      elif command -v dnf >/dev/null 2>&1; then
        dnf -y -q install smartmontools
      else
        echo "install smartmontools by hand: SMART monitoring needs it" >&2
      fi
    fi ;;
esac

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
if [ -n "$BIN" ]; then cp "$BIN" "$TMP"; else curl -fsSL "$URL/agent/v1/binary/nyx-agent-linux-$ARCH" -o "$TMP"; fi
install -m 0755 "$TMP" /usr/local/bin/nyx-agent

/usr/local/bin/nyx-agent configure --url "$URL" --token "$TOKEN" --key "$KEY" --kind "$KIND" $CT

cat > /etc/systemd/system/nyx-agent.service <<'UNIT'
[Unit]
Description=Nyx host agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/nyx-agent run
Restart=always
RestartSec=10
RuntimeDirectory=nyx-agent
# Yield to real work on the host.
Nice=10
IOSchedulingClass=idle
CPUWeight=20
# A system upgrade started by the agent must survive the agent restarting.
KillMode=process

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now nyx-agent
systemctl restart nyx-agent
echo "nyx-agent installed ($KIND), reporting to $URL"

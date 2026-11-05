#!/bin/sh
set -eu
id nyx >/dev/null 2>&1 || useradd --system --home-dir /var/lib/nyx --shell /usr/sbin/nologin nyx
install -d -o nyx -g nyx -m 750 /var/lib/nyx /var/lib/nyx/monitor /var/lib/nyx/manager
install -d -o nyx -g nyx -m 700 /var/lib/nyx/update
install -d -m 755 /etc/nyx
# Keep credentials across upgrades: PocketBase's superuser was created with them.
if [ ! -f /etc/nyx/server.env ]; then
  umask 077
  { echo "NYX_PB_EMAIL=nyx@localhost.invalid"; echo "NYX_PB_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"; } > /etc/nyx/server.env
  chown root:nyx /etc/nyx/server.env
  chmod 640 /etc/nyx/server.env
fi
# Beta releases ran the database as its own service: stop it so that each server
# can take its copy of the data, see monitor-post.sh and manager-post.sh.
systemctl stop nyx-pocketbase 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now nyx-update.path

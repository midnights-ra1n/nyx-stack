#!/bin/sh
set -eu
id nyx >/dev/null 2>&1 || useradd --system --home-dir /var/lib/nyx --shell /usr/sbin/nologin nyx
install -d -o nyx -g nyx -m 750 /var/lib/nyx /var/lib/nyx/pb
install -d -o nyx -g nyx -m 700 /var/lib/nyx/update
install -d -m 755 /etc/nyx
# Keep credentials across upgrades: PocketBase's superuser was created with them.
if [ ! -f /etc/nyx/server.env ]; then
  umask 077
  { echo "NYX_PB_EMAIL=nyx@localhost.invalid"; echo "NYX_PB_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"; } > /etc/nyx/server.env
  chown root:nyx /etc/nyx/server.env
  chmod 640 /etc/nyx/server.env
fi
systemctl daemon-reload
systemctl enable --now nyx-pocketbase nyx-update.path
systemctl try-restart nyx-pocketbase

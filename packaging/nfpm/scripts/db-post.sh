#!/bin/sh
set -eu
id nyx >/dev/null 2>&1 || useradd --system --home-dir /var/lib/nyx --shell /usr/sbin/nologin nyx
install -d -o nyx -g nyx -m 750 /var/lib/nyx /var/lib/nyx/db
install -d -m 755 /etc/nyx
# Keep credentials across upgrades: the superuser was created with them.
if [ ! -f /etc/nyx/db.env ]; then
  umask 077
  { echo "NYX_PB_EMAIL=nyx@localhost.invalid"; echo "NYX_PB_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"; } > /etc/nyx/db.env
  chown root:nyx /etc/nyx/db.env
  chmod 640 /etc/nyx/db.env
fi
systemctl daemon-reload
systemctl enable --now nyx-db
systemctl try-restart nyx-db

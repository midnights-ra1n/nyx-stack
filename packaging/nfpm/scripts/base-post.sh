#!/bin/sh
set -eu
id nyx >/dev/null 2>&1 || useradd --system --home-dir /var/lib/nyx --shell /usr/sbin/nologin nyx
install -d -o nyx -g nyx -m 750 /var/lib/nyx /var/lib/nyx/monitor /var/lib/nyx/manager
install -d -o nyx -g nyx -m 700 /var/lib/nyx/update
install -d -m 755 /etc/nyx
# Beta releases ran the database as its own service: stop it so that each server
# can take its copy of the data, see monitor-post.sh and manager-post.sh.
systemctl stop nyx-pocketbase 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now nyx-update.path

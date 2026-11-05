#!/bin/sh
set -eu
# Beta releases shared one database. Each server keeps a full copy, /var/lib/nyx/pb stays.
if [ -d /var/lib/nyx/pb ] && [ ! -e /var/lib/nyx/monitor/pb_data ]; then
  cp -a /var/lib/nyx/pb /var/lib/nyx/monitor/pb_data
fi
systemctl daemon-reload
systemctl enable --now nyx-monitor
systemctl try-restart nyx-monitor

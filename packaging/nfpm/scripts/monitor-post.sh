#!/bin/sh
set -eu
# Beta releases shared one local database. Each server keeps a full copy, and the old
# credentials in /etc/nyx/server.env keep it local. /var/lib/nyx/pb stays.
if [ -d /var/lib/nyx/pb ] && [ ! -e /var/lib/nyx/monitor/pb_data ]; then
  cp -a /var/lib/nyx/pb /var/lib/nyx/monitor/pb_data
fi
systemctl daemon-reload
systemctl enable nyx-monitor
# One start, also after update.sh stopped it: a second one would cut its migrations short.
systemctl restart nyx-monitor

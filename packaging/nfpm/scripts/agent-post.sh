#!/bin/sh
set -eu
systemctl daemon-reload
# Without a config there is nothing to run yet: see `nyx-agent configure`.
systemctl enable nyx-agent
systemctl try-restart nyx-agent

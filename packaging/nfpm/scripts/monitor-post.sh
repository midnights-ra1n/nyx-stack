#!/bin/sh
set -eu
systemctl daemon-reload
systemctl enable --now nyx-monitor
systemctl try-restart nyx-monitor

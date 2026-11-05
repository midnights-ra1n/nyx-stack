#!/bin/sh
set -eu
systemctl daemon-reload
systemctl enable --now nyx-manager
systemctl try-restart nyx-manager

#!/bin/sh
# dpkg passes "remove", rpm passes 0: an upgrade must leave the service running.
case "${1:-}" in remove | 0) systemctl disable --now nyx-manager 2>/dev/null || true ;; esac

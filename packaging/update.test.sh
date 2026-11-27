#!/bin/sh
# Runs update.sh against a throwaway root, with the system commands replaced by stubs
# that write down how they were called.
set -eu

script="$PWD/packaging/update.sh"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
mkdir "$dir/bin"
stub() { printf '#!/bin/sh\n%s\n' "$2" >"$dir/bin/$1" && chmod +x "$dir/bin/$1"; }
stub uname 'echo x86_64'
stub dpkg 'echo "dpkg $*" >>"$CALLS"; [ "$1" != -i ] || exit "${DPKG_EXIT:-0}"'
stub dpkg-query 'case "$2" in *Status*) case " $INSTALLED " in *" $3 "*) echo "install ok installed" ;; *) exit 1 ;; esac ;; *) echo 1.0.0-1 ;; esac'
stub systemctl 'case "$1" in is-active) exit 0 ;; show) echo 4242 ;; *) echo "systemctl $*" >>"$CALLS" ;; esac'
stub curl 'while [ "$1" != -o ]; do shift; done; echo package >"$2"; echo "curl $(basename "$2")" >>"$CALLS"'
stub sha256sum 'cat >/dev/null'
stub ss 'echo "LISTEN 0 128 0.0.0.0:8081 0.0.0.0:* users:((\"nyx-monitor\",pid=4242,fd=9))"'
export PATH="$dir/bin:$PATH" NYX_ROOT="$dir/root" CALLS="$dir/calls" INSTALLED="nyx-base nyx-monitor nyx-agent"

run() {
  mkdir -p "$NYX_ROOT/var/lib/nyx/update" && echo "$1" >"$NYX_ROOT/var/lib/nyx/update/request"
  : >"$CALLS"
  sh "$script" >/dev/null 2>&1 || true
}
log() { cut -f2- "$NYX_ROOT/var/log/nyx/update.log"; }
expect() { printf '%s\n' "$1" | grep -q "$2" || { printf 'expected %s in:\n%s\n' "$2" "$1" >&2; exit 1; }; }
refuse() { ! printf '%s\n' "$1" | grep -q "$2" || { printf 'did not expect %s in:\n%s\n' "$2" "$1" >&2; exit 1; }; }

data="$NYX_ROOT/var/lib/nyx/monitor/pb_data"
mkdir -p "$data/backups" "$NYX_ROOT/var/backups/nyx"
echo db >"$data/data.db" && echo old >"$data/backups/pb.zip"
for n in 1 2 3; do touch -t "20260101000$n" "$NYX_ROOT/var/backups/nyx/nyx-monitor-0.9.$n-1-old.tar.gz"; done

# A request that is not a tag stops everything at once.
run 'v1.2.0;reboot'
expect "$(log)" '^fail	Refused a request that is not a release tag$'
refuse "$(cat "$CALLS")" curl

# The update: downloaded before anything stops, the database saved, then awaited.
run v1.2.0
expect "$(log | head -1)" '^run	Updating to v1.2.0$'
expect "$(log)" 'Downloading and verifying nyx-monitor_1.2.0-1_amd64.deb'
expect "$(log)" 'Waiting for nyx-monitor to answer'
expect "$(log | tail -1)" '^ok	Updated to v1.2.0$'
[ "$(grep -n 'curl nyx-agent' "$CALLS" | cut -d: -f1)" -lt "$(grep -n 'systemctl stop nyx-monitor' "$CALLS" | cut -d: -f1)" ]
[ "$(grep -n 'systemctl stop' "$CALLS" | cut -d: -f1)" -lt "$(grep -n 'dpkg -i' "$CALLS" | cut -d: -f1)" ]
[ ! -e "$NYX_ROOT/var/lib/nyx/update/request" ]
snap="$(ls "$NYX_ROOT"/var/backups/nyx/nyx-monitor-1.0.0-1-*.tar.gz)"
expect "$(tar -tzf "$snap")" 'pb_data/data.db'
refuse "$(tar -tzf "$snap")" 'pb.zip'
[ "$(ls "$NYX_ROOT/var/backups/nyx" | wc -l)" -eq 3 ] || { echo "snapshots were not pruned to 3" >&2; exit 1; }
refuse "$(ls "$NYX_ROOT/var/backups/nyx")" '0.9.1'

# A failed install leaves the servers running and says where it stopped.
DPKG_EXIT=1 run v1.2.1
expect "$(cat "$CALLS")" 'systemctl start nyx-monitor'
expect "$(log)" 'Started nyx-monitor again'
expect "$(log | tail -1)" '^fail	Failed: Installing the packages. Details: journalctl -u nyx-update$'
refuse "$(log)" 'Updated to'
echo "update.sh: ok"

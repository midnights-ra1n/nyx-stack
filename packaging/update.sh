#!/bin/sh
# Upgrades the Nyx packages on this host. Started as root by nyx-update.path when
# a server drops the wanted release tag into the request file.
#
# Nothing changes until the checks pass and the packages are downloaded and verified.
# Then the servers are stopped, their databases saved to $SNAPSHOTS, the packages
# installed, and the servers awaited. Each step is a line of $LOG, shown by the
# servers in Settings: time, state (run, ok or fail), text.
set -eu

# NYX_ROOT only exists for packaging/update.test.sh.
ROOT="${NYX_ROOT:-}"
REQUEST="$ROOT/var/lib/nyx/update/request"
BASE=https://github.com/midnights-ra1n/nyx-stack/releases/download
LOG="$ROOT/var/log/nyx/update.log"
# Root's alone: the servers run as nyx, which owns everything under /var/lib/nyx.
SNAPSHOTS="$ROOT/var/backups/nyx"
KEEP=3
WAIT=90 # tries, two seconds apart

[ -f "$REQUEST" ] || exit 0
TAG="$(cat "$REQUEST")"
rm -f "$REQUEST"

install -d -m 755 "$ROOT/var/log/nyx"
install -d -m 700 "$SNAPSHOTS"
: >"$LOG"
LAST=""
NOW=""
step() {
  LAST="$1"
  NOW="$2"
  printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >>"$LOG"
  echo "$2"
}
fail() {
  step fail "$1"
  exit 1
}

TMP="$(mktemp -d)"
STOPPED=""
finish() {
  code=$?
  rm -rf "$TMP"
  [ "$code" -ne 0 ] || return 0
  what="$NOW"
  # Whatever version is installed now beats leaving the servers down.
  for s in $STOPPED; do systemctl start "$s" && step run "Started $s again" || true; done
  [ "$LAST" = fail ] || step fail "Failed: $what. Details: journalctl -u nyx-update"
}
trap finish EXIT

# The file is written by an unprivileged service, so never trust it further.
echo "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$' || fail "Refused a request that is not a release tag"
VERSION="${TAG#v}"
step run "Updating to $TAG"

if command -v dpkg >/dev/null 2>&1; then
  case "$(uname -m)" in x86_64) ARCH=amd64 ;; aarch64) ARCH=arm64 ;; *) fail "Unsupported architecture $(uname -m)" ;; esac
  installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed'; }
  current() { dpkg-query -W -f='${Version}' "$1"; }
  file() { echo "$1_${VERSION}-1_$ARCH.deb"; }
  apply() { dpkg -i "$@"; }
else
  ARCH="$(uname -m)"
  installed() { rpm -q "$1" >/dev/null 2>&1; }
  current() { rpm -q --qf '%{VERSION}' "$1"; }
  file() { echo "$1-$VERSION-1.$ARCH.rpm"; }
  apply() { rpm -U "$@"; }
fi

# Stopped in this order: a server flushes its last metrics to nyx-db as it stops.
SERVERS=""
for p in nyx-monitor nyx-manager nyx-db; do installed "$p" && SERVERS="$SERVERS $p"; done
data() { echo "$ROOT/var/lib/nyx/${1#nyx-}"; }

step run "Checking free disk space"
free_kb() { df -Pk "$1" | awk 'NR == 2 { print $4 }'; }
need=102400
for p in $SERVERS; do
  [ ! -d "$(data "$p")/pb_data" ] || need=$((need + $(du -sk "$(data "$p")/pb_data" | cut -f1)))
done
[ "$(free_kb "$SNAPSHOTS")" -gt "$need" ] || fail "Not enough free space in $SNAPSHOTS: $((need / 1024)) MB needed to save the databases"
[ "$(free_kb "$TMP")" -gt 307200 ] || fail "Not enough free space in $TMP: 300 MB needed for the packages"

curl -fsSL "$BASE/$TAG/SHA256SUMS" -o "$TMP/SHA256SUMS"
for p in nyx-base nyx-monitor nyx-manager nyx-agent nyx-db; do
  if installed "$p"; then
    f="$(file "$p")"
    step run "Downloading and verifying $f"
    curl -fsSL "$BASE/$TAG/$f" -o "$TMP/$f"
    (cd "$TMP" && grep " $f\$" SHA256SUMS | sha256sum -c -)
  fi
done
rm "$TMP/SHA256SUMS"

# Stopped, so that each copy is a database at rest.
for p in $SERVERS; do
  systemctl is-active --quiet "$p" || continue
  step run "Stopping $p"
  systemctl stop "$p"
  STOPPED="$STOPPED $p"
done
for p in $SERVERS; do
  [ -d "$(data "$p")/pb_data" ] || continue
  snap="$SNAPSHOTS/$p-$(current "$p")-$(date -u +%Y%m%d-%H%M%S).tar.gz"
  step run "Saving the database of $p to $snap"
  # PocketBase's own backups are copies already.
  tar -czf "$snap" -C "$(data "$p")" --exclude=pb_data/backups pb_data
  ls -t "$SNAPSHOTS/$p"-*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
done

step run "Installing the packages"
apply "$TMP"/*
# The packages started them again.
WAS="$STOPPED"
STOPPED=""
command -v ss >/dev/null 2>&1 || { WAS=""; step run "ss is missing (iproute2): the servers are not awaited"; }

# A server opens its port once its database answers, and nyx-db's PocketBase once it
# has migrated: a listening socket means the new version works.
listening() {
  main="$(systemctl show -P MainPID "$1")"
  pids="$main"
  [ "$1" != nyx-db ] || pids="$(pgrep -P "$main" || true)"
  for pid in $pids; do [ "$pid" -gt 0 ] && ss -ltnp | grep -q "pid=$pid," && return 0; done
  return 1
}
for p in $WAS; do
  step run "Waiting for $p to answer"
  i=0
  until listening "$p"; do
    i=$((i + 1))
    [ "$i" -lt "$WAIT" ] || fail "$p did not answer within 3 minutes. Details: journalctl -u $p"
    sleep 2
  done
done
step ok "Updated to $TAG"

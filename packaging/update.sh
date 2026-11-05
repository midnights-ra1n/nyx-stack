#!/bin/sh
# Upgrades the Nyx packages on this host. Started as root by nyx-update.path when
# a server drops the wanted release tag into the request file.
set -eu

REQUEST=/var/lib/nyx/update/request
BASE=https://github.com/midnights-ra1n/nyx-stack/releases/download

[ -f "$REQUEST" ] || exit 0
TAG="$(cat "$REQUEST")"
rm -f "$REQUEST"
# The file is written by an unprivileged service, so never trust it further.
echo "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$' || { echo "refusing tag: $TAG" >&2; exit 1; }
VERSION="${TAG#v}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if command -v dpkg >/dev/null 2>&1; then
  case "$(uname -m)" in x86_64) ARCH=amd64 ;; aarch64) ARCH=arm64 ;; *) exit 1 ;; esac
  installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed'; }
  file() { echo "$1_${VERSION}-1_$ARCH.deb"; }
  apply() { dpkg -i "$@"; }
else
  ARCH="$(uname -m)"
  installed() { rpm -q "$1" >/dev/null 2>&1; }
  file() { echo "$1-$VERSION-1.$ARCH.rpm"; }
  apply() { rpm -U "$@"; }
fi

curl -fsSL "$BASE/$TAG/SHA256SUMS" -o "$TMP/SHA256SUMS"
for p in nyx-base nyx-monitor nyx-manager nyx-agent; do
  if installed "$p"; then
    f="$(file "$p")"
    curl -fsSL "$BASE/$TAG/$f" -o "$TMP/$f"
    (cd "$TMP" && grep " $f\$" SHA256SUMS | sha256sum -c -)
  fi
done
rm "$TMP/SHA256SUMS"
apply "$TMP"/*

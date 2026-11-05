#!/bin/sh
# Prints the version of the next release on a channel: `stable` or `beta`.
# Run from the repository root, with all tags fetched.
#
# Stable takes the version in Cargo.toml, or one patch above the last release once
# that version is taken. Beta numbers its way up to that same next stable version.
set -eu

channel="$1"
wanted="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
last="$(git tag -l 'v*' | sed -n 's/^v\([0-9]*\.[0-9]*\.[0-9]*\)$/\1/p' | sort -V | tail -1)"

if [ -z "$last" ] || { [ "$wanted" != "$last" ] && [ "$(printf '%s\n%s\n' "$wanted" "$last" | sort -V | tail -1)" = "$wanted" ]; }; then
  next="$wanted"
else
  next="$(echo "$last" | awk -F. '{ print $1 "." $2 "." $3 + 1 }')"
fi

case "$channel" in
  stable) echo "$next" ;;
  beta)
    count="$(git tag -l "v$next-beta.*" | sed 's/.*-beta\.//' | sort -n | tail -1)"
    echo "$next-beta.$((${count:-0} + 1))"
    ;;
  *) echo "unknown channel: $channel" >&2; exit 1 ;;
esac

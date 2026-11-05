#!/bin/sh
# Checks next-version.sh against a throwaway repository.
set -eu

script="$PWD/packaging/next-version.sh"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
cd "$dir"
git init -q .
git -c user.name=t -c user.email=t@t commit -q --allow-empty -m first
printf '[workspace.package]\nversion = "0.2.0"\n' > Cargo.toml

check() {
  got="$(sh "$script" "$1")"
  [ "$got" = "$2" ] || { echo "next-version $1: got $got, wanted $2" >&2; exit 1; }
}

check stable 0.2.0
check beta 0.2.0-beta.1
git tag v0.2.0-beta.1
git tag v0.2.0-beta.9
git tag v0.2.0-beta.10
check beta 0.2.0-beta.11
check stable 0.2.0
git tag v0.2.0
check stable 0.2.1
check beta 0.2.1-beta.1
git tag v0.2.9
git tag v0.2.10
check stable 0.2.11
printf '[workspace.package]\nversion = "0.3.0"\n' > Cargo.toml
check stable 0.3.0
check beta 0.3.0-beta.1
if sh "$script" nightly 2>/dev/null; then echo "an unknown channel must fail" >&2; exit 1; fi
echo "next-version: ok"

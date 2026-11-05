# Development

You need Rust stable, Go, Node.js 22 with pnpm, Perl (for vendored OpenSSL) and a
PocketBase binary.

```sh
make web        # build the UI, needed once: binaries embed it
make test       # Rust, Go and web tests
```

Run a stack locally:

```sh
pocketbase serve --http 127.0.0.1:8090 --dir ./pb_data --migrationsDir pb/pb_migrations &
export NYX_PB_EMAIL=admin@nyx.local NYX_PB_PASSWORD=dev-password-123
cargo run -p nyx-monitor &
cd web && pnpm dev:monitor             # hot reload, proxies the API to :8081
```

Use `pnpm dev:manager` and `-p nyx-manager` for the manager, on port 8082.

Development builds use the PocketBase you started above. To embed it as release builds
do, point `NYX_PB_BIN` at the executable when building, for the platform you build for:

```sh
NYX_PB_BIN=$(command -v pocketbase) cargo run -p nyx-monitor   # data in ./nyx-data
```

`make pocketbase bins` does this for Linux, with the version set in the `Makefile`.

## Where things are

| Path | Contents |
| --- | --- |
| `crates/nyx-monitor/src/state.rs` | The in-memory fleet, rollups, alerts |
| `crates/nyx-monitor/src/ingest.rs` | Agent reports |
| `crates/nyx-monitor/src/probes.rs`, `snmp.rs` | Active checks |
| `crates/nyx-monitor/src/pages.rs` | Status pages and wall displays |
| `crates/nyx-manager/src/ipam.rs`, `map.rs` | Pure logic, with most of the tests |
| `crates/nyx-manager/src/sites.rs`, `nextcloud.rs` | Deploys and CalDAV |
| `crates/nyx-srv/src/` | Auth, CRUD, notifications, MCP, updates |
| `web/src/ui/` | Shared components, shell, settings |
| `web/src/monitor/display/` | Page model, panels, viewer, editor |

## Layout rules

- UI code shared by both servers goes in `web/src/ui`.
- Styling follows the tokens in `web/src/ui/tokens.css`, from `Nyx-DA-guide.pdf`.
- Nothing may load from a third party at runtime: fonts come from `@fontsource`.
- Anything added to a public page must be listed in `build` in `pages.rs`, and covered
  by the test that looks for leaks.
- New writes to PocketBase should go through the five-minute batch unless they record
  a state change.

## Contributing

Run `make test` before opening a pull request, and update the matching page in `docs/`
in the same change. Contributions are accepted under the project's licence, GPL-3.0 or
later.

## Branches and releases

| Branch | Purpose |
| --- | --- |
| `dev` | Daily work. Pushing runs the tests only |
| `beta` | Each push publishes a pre-release |
| `stable` | Each push publishes a release |

Work lands on `dev`, moves to `beta` to be tried, then to `stable`.

A push to `beta` or `stable` runs `.github/workflows/release.yml`: it runs the tests,
computes the version, builds static binaries on native x86_64 and arm64 runners, makes
the packages and multi-arch images, and publishes everything. The release creates the
tag, so nobody tags by hand.

`packaging/next-version.sh` computes the version. Stable takes `version` from the root
`Cargo.toml`, or one patch above the last release once that one is taken. Beta numbers
its way up to that same version, as `0.2.1-beta.1`, `0.2.1-beta.2` and so on. To start a
new minor or major version, change `version` in `Cargo.toml`.

`make bins` expects a musl toolchain: CI runs it in `rust:1-alpine`, as the Docker
images and packages need static binaries.

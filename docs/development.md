# Development

You need Rust stable, Go, Node.js 22 with pnpm, Perl (for vendored OpenSSL) and a
PocketBase binary.

```sh
make web        # build the UI, needed once: binaries embed it
make test       # Rust, Go and web tests (Go with -tags goolm, see below)
```

Run a stack locally:

```sh
pocketbase serve --http 127.0.0.1:8090 --dir ./pb_data --migrationsDir pb/pb_migrations &
export NYX_PB_URL=http://127.0.0.1:8090 NYX_PB_EMAIL=admin@nyx.local NYX_PB_PASSWORD=dev-password-123
cargo run -p nyx-monitor &
cd web && pnpm dev:monitor             # hot reload, proxies the API to :8081
```

Use `pnpm dev:manager` and `-p nyx-manager` for the manager, on port 8082.

### A simulated homelab

With a monitor running, and the manager if you want it linked, this creates about twenty
hosts, two Proxmox servers with their guests among them, and sends signed reports for
them as agents would:

```sh
node dev/fake-agents.mjs                      # http://127.0.0.1:8081 and :8082 by default
```

It signs in as `admin@nyx.local` / `dev-password-123` (or `NYX_SIM_EMAIL` and
`NYX_SIM_PASSWORD`), creating the account on a fresh database. Their tokens are kept in
`dev/.sim-hosts.json`, so running it again feeds the same hosts. One host stops after its
first report and one never reports, to show both states. It also adds a few probes in
three categories, one of them down and one paused.

Then `node dev/seed-manager.mjs` fills the manager with a sample homelab: hardware in a
rack, on a shelving unit and on a desk, a few cables, and a network map of the monitored
hosts behind their network gear, in zones, subnets and VLANs, the router's address in
each subnet and one address held by two machines, the parts of the NAS and of a server,
tasks in each state and a few deployments. Records are found by name, so running it again adds nothing twice.

### The notifier

`nyx-notify` is built and tested with `-tags goolm`, which picks mautrix's Olm written in
Go: without it, mautrix wants libolm and cgo. Point the servers at your build with
`NYX_NOTIFIER_BIN`:

```sh
cd notifier && CGO_ENABLED=0 go build -tags goolm -o nyx-notify . && cd ..
NYX_NOTIFIER_BIN=$PWD/notifier/nyx-notify cargo run -p nyx-monitor
```

Encrypted Matrix has an end-to-end test that needs a homeserver with open registration.
A throwaway Synapse does it:

```sh
uv venv -p 3.12 /tmp/syn && uv pip install -p /tmp/syn matrix-synapse
/tmp/syn/bin/python -m synapse.app.homeserver --server-name localhost \
  --config-path /tmp/hs.yaml --generate-config --report-stats=no
# in /tmp/hs.yaml: enable_registration: true, enable_registration_without_verification: true
/tmp/syn/bin/python -m synapse.app.homeserver --config-path /tmp/hs.yaml &
cd notifier && NYX_TEST_MATRIX=http://127.0.0.1:8008 go test -tags goolm -run E2EE -v .
```

It registers a sender and a reader, sends two messages through Nyx and checks that the
reader decrypts both, from one Nyx device.

Development builds use the PocketBase you started above. To embed it as release builds
do, point `NYX_PB_BIN` at the executable when building, for the platform you build for:

```sh
unset NYX_PB_URL NYX_PB_EMAIL NYX_PB_PASSWORD   # to see the first-start choice
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
| `crates/nyx-srv/src/` | Auth, CRUD, notifications, MCP, updates, database choice |
| `crates/nyx-db/src/` | PocketBase embedding, and the `nyx-db` program |
| `web/src/ui/` | Shared components, shell, settings |
| `web/src/monitor/display/` | Page model, panels, viewer, editor |

## Layout rules

- UI code shared by both servers goes in `web/src/ui`.
- Styling follows the tokens in `web/src/ui/tokens.css`: the colours of
  `Nyx-DA-guide.pdf`, midnight-blue surfaces and the logo's orange as accent. Use
  `rounded-control` for buttons and fields, `rounded-box` for anything that wraps text and
  `rounded-panel` for cards. Panels have a header strip; tables have no header band.
- Names typed by the user, such as a host's, never go through `t()`: pass them to
  `PageHeader`, `Check` and crumbs as an element so they show as typed.
  Tags are names too: give `Variable` options `raw: true`, as `tagOptions` does.
- Text built by the server or an agent, such as an alert, goes through `tn()`. Its
  English pattern, `{host}: memory at {p}%`, is a key of `fr.ts`; `{msg}`, `{reason}`,
  `{what}` and `{color}` parts are translated in turn, and `{n}`, `{p}`, `{t}` and
  `{days}` only match numbers. Notifications use the same patterns in
  `crates/nyx-srv/src/lang.rs`: a new message needs both.
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

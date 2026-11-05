# Third-party software

Nyx is licensed under GPL-3.0-or-later, which is compatible with every component it
links. The full dependency lists are in `Cargo.lock`, `web/pnpm-lock.yaml` and
`notifier/go.sum`.

## Main components

| Software | Licence | Use |
| --- | --- | --- |
| [PocketBase](https://ganigeorgiev.com/pocketbase/pocketbase) | MIT | Database. Its unmodified executable is embedded in `nyx-monitor`, `nyx-manager` and `nyx-db`, and runs as a child process |
| [Shoutrrr](https://github.com/nicholas-fedor/shoutrrr), maintained fork | MIT | Notification delivery, in the separate `nyx-notify` program |
| [Ubuntu font](https://design.ubuntu.com/font), through `@fontsource` | Ubuntu Font Licence 1.0 | UI typeface, served by Nyx. See below |
| [Heroicons](https://github.com/tailwindlabs/heroicons) | MIT | UI icons |
| [React](https://react.dev) | MIT | UI |
| [Tailwind CSS](https://tailwindcss.com) | MIT | UI |

## Every licence in the tree

Checked against all 379 Rust crates in the build, the 15 Go modules of `nyx-notify`
and the web dependencies.

| Licence | Components | With GPL 3 |
| --- | --- | --- |
| MIT, BSD, ISC, Zlib, Unlicense | Most of the tree, and all of `nyx-notify` | Compatible |
| Apache-2.0 | `ring`, `aws-lc-rs`, `aws-lc-sys`, `openssl` and the vendored OpenSSL 3, `minijinja`, `memo-map`, `moka`, `sync_wrapper` | Compatible with version 3, not with version 2 alone |
| MPL-2.0 | `webauthn-rs` and its companion crates, `base64urlsafedata` | Compatible, none of them opts out |
| Unicode-3.0 | ICU and Unicode data crates | Compatible |
| CDLA-Permissive-2.0 | `webpki-roots`, `webpki-root-certs` (data) | Compatible |
| EPL-2.0 with EDL-1.0 | `paho.golang`, in `nyx-notify` | Used under the BSD-style EDL-1.0 |

`ring` and `aws-lc` no longer carry the old OpenSSL licence, whose advertising clause
would conflict with the GPL.

## The Ubuntu font

The Ubuntu Font Licence is a font licence, not a software one, and it is not a GPL
licence. The font files are data served to the browser, shipped alongside Nyx rather
than linked into its code. They stay unmodified, and their licence is in
[licenses/UFL-1.0.txt](licenses/UFL-1.0.txt), which packages and images include.

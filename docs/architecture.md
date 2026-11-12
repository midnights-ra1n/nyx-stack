# Architecture

```
        browser (React PWA)                browser (React PWA)
               │                                  │
        ┌──────▼──────┐    optional link   ┌──────▼──────┐
        │ nyx-monitor │◄───────────────────│ nyx-manager │
        └──┬───────┬──┘    bearer token    └──────┬──────┘
           │       │                              │
        ┌──▼───────▼──┐                    ┌──────▼──────┐
        │ PocketBase  │  embedded in each, │ PocketBase  │
        └─────────────┘  or one in nyx-db  └─────────────┘
           │ HTTPS, signed, agent-initiated
   ┌───────▲────────┐
   │ nyx-agent (N)  │
   └────────────────┘
```

## Components

| Path | Language | Role |
| --- | --- | --- |
| `crates/nyx-proto` | Rust | Types and signatures shared by agent and monitor |
| `crates/nyx-agent` | Rust | Host agent, synchronous, no async runtime |
| `crates/nyx-srv` | Rust | Shared server code: auth, CRUD, notifications, MCP, updates, database choice |
| `crates/nyx-db` | Rust | PocketBase embedding, and the optional shared database program |
| `crates/nyx-monitor` | Rust | Monitoring server |
| `crates/nyx-manager` | Rust | Management server |
| `notifier` | Go | `nyx-notify`, a small wrapper around Shoutrrr |
| `pb/pb_migrations` | JS | PocketBase schema, embedded in both servers |
| `web` | React, Tailwind | One codebase, built once per server and embedded in its binary |

PocketBase is a Go program, so it cannot be linked into a Rust binary as a library. The
`nyx-db` crate carries the unmodified executable and the schema instead. It unpacks them
into the data directory, rewriting them only after an upgrade, then runs PocketBase. It
restarts PocketBase if it dies, and stops it last, after the final flush. Each server
uses this library for its local database, on a random loopback port, and the `nyx-db`
program uses it to serve a shared one. A server is therefore one package or image, with
one systemd unit, at the cost of about 33 MB per binary.

Our own Go is confined to `nyx-notify` because Shoutrrr is a Go library. The server starts one
short-lived process per delivery, so nothing Go-related stays in memory.

## Why it stays light

**Agent.** It has two threads: a collector and a worker for slow commands. Reports
carry slow-changing data (Docker, updates, SMART, logs) only when it changed. It opens
no port. Its systemd unit runs at low CPU and idle I/O priority. The journal cursors
sit in tmpfs, so the agent does not write to disk during normal operation. Live logs
add work only while someone watches a host: the answer to a report asks the agent to
post new journal lines every two seconds, until the monitor says nobody is left.

**Servers.** A single-threaded Tokio runtime. Live metrics live in RAM ring buffers
(240 points per host, 500 log lines), so viewing a dashboard never touches the disk.

**Writes.** Everything collected in RAM goes to PocketBase in one batch every five
minutes: rollups, probe rollups, power samples and last-seen times. State changes and
alerts are written when they happen. After a restart the RAM graphs start empty and
history comes from the rollups.

**Long history.** You choose how long history is kept, from 30 to 365 days. Five-minute
rollups are only kept for 7 days. Each day, older ones are merged into one row per hour,
which is all a chart over such a range can show anyway. A host then costs about 10 000
rows for a year instead of 105 000, so a year takes less room than a month used to. The
merge reads one hour at a time, and each merged row and the deletion of its sources
share one transaction, so an interrupted run resumes cleanly.

**Browser.** Polling stops when the tab is hidden and data reloads when it comes
back, so an idle tab costs nothing.

**Startup.** Reading a month of rollups back at every start would pull the whole table
through PocketBase's memory. So once a day the monitor saves its uptime counters and
the fleet chart as one record, and a restart reads that record plus the rollups written
since, at most one day of them. The first start of a large existing database has no
record yet and takes longer once.

**Long charts.** The fleet chart comes from RAM. A host or probe chart over 30 days walks
its rollups one page at a time, so one request cannot pile up thousands of rows.

## Measured memory

Resident memory of release builds, measured on macOS on Apple silicon with simulated
agents sending signed reports. These reports carried 15 containers, 30 pending updates
and full log buffers per host, more than most hosts have. Linux figures are not
measured yet and may differ.

| Situation | Monitor | PocketBase |
| --- | --- | --- |
| Empty install | 9 MB | 43 MB |
| 50 hosts, buffers full | 17 MB | 46 MB |
| 200 hosts and 30 probes, 30 days of history | 30 MB | 90 MB |
| Same, peak during the flush or the daily compaction and purge | 60 MB | 145 MB |
| Same, peak during a restart | 22 MB | 80 MB |

Each host adds about 115 KB to the monitor. Over 11 minutes at ten times the normal
report rate, memory did not grow once the buffers were full. The manager uses 9 MB when
idle, and the agent about 13 MB.

On disk, 200 hosts and 30 probes take about 150 MB for 30 days of history, and about
610 MB for 365 days. That is about 3 MB per host and per year. SQLite reuses the space
freed by the daily purge rather than shrinking the file, so lowering the retention frees
room for new data without making the file smaller.

## Probes at scale

ICMP sockets and the certificate HTTP client are shared. At most 32 probes run at
once, and their start times are spread over up to 30 seconds, so a long list does not
fire in a burst.

## Alerts

Alerts come from a reconcile step: each cycle computes the wanted set of open alerts
and writes only the differences. Thresholds use three points of hysteresis, so a value
hovering at the limit does not flap. A host goes offline after two missed reports at
the pace it was given, plus 30 seconds: one minute while someone uses the monitor, 2.5
minutes otherwise (see [Report pace](agent.md#report-pace)), and a grace period after a server restart prevents false alarms.

## Notifications

Every event lands in `notif_events`. Each minute, rules decide what to send. Delivery
is separate from detection, which is what makes digests possible.

## Public pages

Status pages and wall displays are the only part of the UI open without an account.
Their configuration is held in RAM, so an unknown address costs no database read. The
answer is built from a list of allowed fields and shared for 5 seconds between
visitors. Daily uptime lives in RAM and is updated by the existing five-minute flush,
so public pages add no write.
See [status-pages.md](status-pages.md).

## Local or shared database

A server decides its database before anything else starts. Variables win, then the
choice saved in `database.json`. Without either, it serves only the UI and the choice,
then continues as a normal start, so no other code runs without a database.

On a shared database the two servers use the same tables, which is why they have one set
of accounts, and only one thing changes: both run the notification loop, so each digest
is claimed first by creating a row under a unique key built from the rule and its last
send. One server wins and the other skips it. A failed send gives the claim back, and a
claim left by a crash expires. Local databases skip this, and its writes with it.

## Role separation

Monitor and manager share no code path at runtime. Each has its own binary, web
interface and port, and by default its own database. The optional
link is a read API plus a deploy endpoint on the monitor, protected by a token you
create there. See [separate machines](deployment.md#monitor-and-manager-on-separate-machines).

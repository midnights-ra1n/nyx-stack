# Monitoring

## Hosts

The host list is a tree: guests appear under their Proxmox host. The overview board
can be rearranged with **Customize**, with separate layouts for desktop and phone,
stored in your browser.

## Probes

Add them in **Network**.

| Type | Checks |
| --- | --- |
| Ping | ICMP reachability and latency |
| Website | HTTP status and response time |
| DNS | That a name resolves, through a chosen server |
| Certificate | Days until an HTTPS certificate expires |
| SNMP | Any OID, on any device that speaks SNMP |

An alert opens after two failures in a row, so a single lost packet stays quiet.

## SNMP

SNMP v1, v2c and v3 (authentication and privacy) are supported. A probe is a list of
items, so it adapts to any equipment. Start from a preset and adjust:

Generic, Switch or router, Server, UPS (standard), UPS (APC), Printer, Synology,
MikroTik, or Custom.

Each item has:

| Field | Meaning |
| --- | --- |
| OID | The value to read, or a table with **walk** |
| Label, unit | How it is shown |
| Aggregate | For a table: `sum`, `avg`, `max`, `min` or `count` |
| Match | Count only rows equal to this value, for example ports up |
| Rate | Show the change per second, for counters such as traffic |
| Scale | Multiply the value, for example bytes to MB |
| Warn, crit | Thresholds. **Low** means lower values are worse, such as battery charge |
| Expect | Alert when the value differs, for status codes |

Reads are grouped into batches of 20 OIDs per request, and table walks use GETBULK up
to 2000 rows, to spare small devices. Each request is retried once with a 3 s timeout.

Choosing **v3** with authentication and privacy is recommended. v1 and v2c send the
community in clear text.

## Alerts and thresholds

Set warning and critical levels for usage and temperature in **Settings, Monitoring**.
Alerts need three points of margin to clear, which prevents flapping.

## Storage

The **Storage** page lists every file system, fullest first, with its host, mount
point, type, device, used, free and total space. Filter it by host, or select a host
name to open its page. An offline host keeps its last known figures, marked Offline.
Older agents do not send the type and device, which then show a dash.

## SMART

Each disk has a simple state (OK, warning or critical) and an estimate of remaining
life. Details are on the host's storage panel and on the **Storage** page. Changes
raise `smart` notifications.

## Status pages and wall displays

Public pages and full-screen boards have their own guide:
[status-pages.md](status-pages.md).

## History

Charts offer periods from the last hour to the last year. Choose how long history is
kept in **Settings, Monitoring**, from 30 to 365 days. The default is 30.

| Age | Detail |
| --- | --- |
| Last hour | One point every 15 seconds, in RAM |
| Up to 7 days | One point every 5 minutes |
| Beyond | One point per hour |

Lowering the retention deletes the older data at the next daily run, or when the
monitor restarts. Raising it only takes effect going forward: what was already deleted
does not come back. A year takes about 3 MB per host, see the
[measurements](architecture.md#measured-memory).

## Logs

The agent sends warnings and above. The monitor keeps the last 500 lines per host in
RAM, so they are gone after a restart. This is deliberate: Nyx is not a log archive.

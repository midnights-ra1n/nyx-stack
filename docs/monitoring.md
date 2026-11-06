# Monitoring

## Customizing the pages

Every page made of blocks has a **Customize** button, in the **More** menu on a phone:
the overview, hosts, host detail, containers, network, storage, alerts and logs in the
monitor, and the overview, IPAM, network map, sites and tasks in the manager.

- Slide a block where you want it, by its handle on a phone, or use the arrows from the
  keyboard.
- Close a block to hide it. Hidden blocks stay listed at the top, ready to come back.
- Choose from one to four columns. Below 1024 pixels there is always one.
- **Reset this page** goes back to the default layout. To reset every page, use
  **Settings, General**.

Some blocks are hidden by default. The overview also offers disk health, recent logs,
probes, stopped containers, pending updates, power and EDF Tempo.

Layouts are stored in your browser, separately for desktop and phone. All host pages
share one layout. A block a host cannot show, such as SMART on a VM, is skipped there
and comes back on the hosts that have it.

## Hosts

**Update all**, on the Hosts page, upgrades the packages of every online host and brings
its agent to the version of this server. A bar follows the whole run, with one per host,
and failures keep their output on screen. The same page lists the hosts that need a
restart, also marked in the table and on each host. Nyx never restarts a host on its own.
See [agent updates](agent.md#updates).

The host list is a tree: guests appear under their Proxmox host. OCI containers appear there with a
note, since no agent can run in them: see [OCI containers](agent.md#oci-containers).

## Probes

Add them in **Network**. A website probe on an `https://` address also follows its
certificate: the **Certificate** column of the table shows the days left, and it alerts
like a certificate probe, without a second probe for the same site. Choose how many days
ahead to warn in the probe's settings. Its check always reads the certificate, even one
Nyx would not trust. A site whose certificate has expired is reported as down, because
the website check itself fails.

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

Each physical disk has a card, on the host page and on **Storage**, with a simple state
(healthy, attention or critical) and, in plain words, what smartctl knows about it:

| Field | Notes |
| --- | --- |
| Model, device, type, capacity | NVMe, SSD or HDD |
| Life left | When the drive reports wear. Attention from 20 %, critical from 10 % |
| Temperature, powered on, power cycles | |
| Bad sectors | Reallocated, pending and uncorrectable together. Any of them means attention |
| Written | Lifetime writes, when the drive counts them |
| Serial | To find the drive and for warranty claims |

Agents older than this version only send the state, life left, temperature and powered
on time, and the rest shows a dash. SMART data is read every 30 minutes, without waking
sleeping disks. Changes raise `smart` notifications.

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

The agent sends warnings and above once a minute. The monitor keeps the last 500 lines
per host in RAM, so they are gone after a restart. This is deliberate: Nyx is not a log
archive.

The **Logs** page shows each line as a time, a level, a service and a message. Identical
messages are folded into their latest occurrence with the number of repeats. Filter by
host, level or text, or select a service under **Noisiest services**. The host page has
the same journal as a block.

### Live logs

Pick a host and press **Go live** to follow everything from info up as it happens. The
same button is on the Logs block of a host page.

- The agent never opens a port, so it learns that someone is watching from the answer
  to its next report. The first lines take up to 15 seconds, then arrive every 2
  seconds.
- Nothing is stored. Live lines stay in RAM, up to 1000 per host, and are dropped once
  nobody watches.
- The agent stops about 15 seconds after the last browser request, which also happens
  when you hide the tab.
- Reading the journal costs a little CPU and I/O every 2 seconds on that host, only
  while someone watches.

A live view follows one host at a time. An agent too old to know about live logs never
answers, and the page says so: update it first.

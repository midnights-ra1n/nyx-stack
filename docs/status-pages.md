# Status pages and wall displays

Nyx Monitor builds two kinds of page, as many of each as you like, in **Status pages**.
Both use the same panels on a 24-column grid, in the style of Grafana.

| | Public status page | Wall display |
| --- | --- | --- |
| Made for | Your users, on any device | A large screen in a room |
| Address | `/status/<address>` | `/wall/<address>#key=<key>` |
| Who can open it | Anyone, once published | Anyone with the private link |
| Layout | Scrolls like a normal page | Always fills the screen exactly. A panel that overflows shows one page at a time |
| Other sites can frame it | Only if you allow it | Never |
| Default theme | Nyx dark | Graphite |
| Default refresh | 60 s | 15 s |
| Open alerts | Never available | Available |
| Nothing selected in a panel | Shows nothing | Shows every host and probe |

Pages start as drafts: nothing is visible until you press **Publish**.

## Creating a page

1. Open **Status pages** and choose **New page**.
2. Pick the type and an address. The page starts from a ready-made layout.
3. In **Layout**, use the cog on a panel to choose what it shows.
4. Press **Publish**, then **Open**.

Changes to a published page stay private until you press **Save**.

## Arranging panels

- Drag a panel to move it.
- Drag its bottom-right corner to resize it.
- Panels never overlap: what is in the way moves down, and gaps close on their own.
- On a phone, or with a keyboard, open the cog and enter the column, row, width and
  height.

Phones show panels one above the other, from top to bottom and left to right.

## Panels

| Panel | Shows |
| --- | --- |
| Overall status | One banner: operational, degraded or disrupted |
| Service list | Name and state, with optional 30-day uptime bars |
| State tiles | One coloured tile per host or probe |
| Big number | One value, with a small history curve for live metrics |
| Gauges | One arc per selected item |
| Bar gauges | One bar per selected item |
| Time series | The last hour of a metric, one line per item |
| Open alerts | Current alerts, the most serious first. Wall displays only |
| Text | Plain text. HTML is shown as text, never run |
| Clock | Time and date of the viewing device |

### Metrics

| For | Metrics |
| --- | --- |
| Groups (Big number) | Number online, number down, running containers, availability over 30 days, and open alerts on walls |
| Hosts | CPU, memory, swap, fullest disk, temperature, network in and out, uptime over 30 days |
| Probes | Latency, certificate days left, uptime over 30 days, and any SNMP value by its label |

Time series cover CPU, memory, disk, temperature, network and probe latency. SNMP
values can be shown in numbers and gauges, for instance a UPS charge.

## Appearance

| Setting | Notes |
| --- | --- |
| Title, description, footer | Plain text |
| Theme | Nyx dark, Graphite or Light |
| Accent colour | Any colour. Text on it switches between dark and light to stay readable |
| Logo | PNG, JPEG, WebP or SVG up to 256 KB, stored in the page |
| Notice | A banner for maintenance or an ongoing incident, in three styles |
| Refresh | 5 s to 1 hour |
| Zoom | Scales the whole page. Use 2 for a 4K screen |

Logos cannot be remote addresses, because every visitor would then call a third party.

## Sharing

**Status pages.** Share the address. To hide a real name, tick the item and type a
public name next to it.

**Wall displays.** Open the private link on the screen's browser. No account is needed.
Press the full-screen button once. The page asks the browser to keep the screen on,
which needs HTTPS. If the network drops, it keeps showing the last data with a banner,
and recovers by itself.

The key sits after the `#` in the link. Browsers never send that part to a server, so
it stays out of proxy and access logs. The page passes it in a request header instead.

**Replace the private link** in the **Sharing** tab if it leaks. Screens using the old
link stop updating at once.

**Long lists on a wall.** Nobody can scroll a wall, so a panel holding more than fits
jumps to the next page every 8 seconds and shows, for example, *Page 2 of 3*. It jumps
rather than slides, because moving text is hard to read from across a room, and it
starts each page on a whole item.

**Embedding a status page.** Tick **Let other sites show this page in a frame** in the
**Sharing** tab, then save and copy the `<iframe>` code. Any site can then frame that
page, which is safe because it is anonymous and read-only. It remains off by default
for each page, and wall displays can never be framed, as their alerts could name hosts
and paths.

## What visitors can and cannot see

Answers to anonymous visitors are built field by field. They contain:

- the texts, colours and layout of the page
- the names you chose, states and values for the items you ticked

They never contain addresses, hostnames, probe targets, disk paths, error messages or
internal identifiers. The real name of an item appears only if you gave it no public
name. Alert texts can mention hosts and paths, so they exist on wall displays only,
which always need their key.

## Uptime

Uptime comes from the rollups, and always covers the last 30 days, whatever the
retention. Days without data stay blank rather than counting as an outage.

- **Probes:** successful checks out of all checks.
- **Hosts:** rollups received out of the times the monitor was listening. The monitor
  records a heartbeat with each rollup, so time it spent stopped or being upgraded does
  not count against your hosts, and a day when it never ran stays blank. The first day
  counts from when the host appeared.

The history loads in the background at startup, usually in a few seconds, so it can be
briefly incomplete.

## Cost

A visit never touches the disk. Answers come from RAM, and are shared for 5 seconds
between visitors. In a test on a debug build, 2000 requests ran at about 8600 per
second, without any database access.

## Not included

There is no incident history, scheduled maintenance calendar, subscription by email or
rotation between several walls. Use the notice banner for incidents.

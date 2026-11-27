# Notifications

Notifications are set up separately in the monitor and the manager, in **Settings,
Notifications**. Two concepts: **channels** say where, **rules** say what and when.

## Channels

A channel is a [Shoutrrr](https://github.com/nicholas-fedor/shoutrrr) URL, but you rarely
write it yourself. Pick the service and fill in its fields: Nyx builds the URL and escapes
every special character of a password, a token or a room, so a password such as
`p@ss:w/rd?#&` is typed as it is. Opening the channel again reads the fields back from the
URL.

| Service | Fields | URL built |
| --- | --- | --- |
| Email | Server, port, user, password, from, recipients, encryption | `smtp://user:password@mail.example.com:587/?from=…&to=…` |
| Matrix | Homeserver, user and password or an access token, rooms, encryption | `matrix://user:password@matrix.example.com/?rooms=!room:example.com` |
| Discord | The webhook URL Discord gives you | `discord://token@webhook-id` |
| Ntfy | Server, topic, access token or user and password | `ntfy://ntfy.sh/topic?token=…` |
| Gotify | Server, application token | `gotify://gotify.example.com/token` |
| Telegram | Bot token, chats | `telegram://token@telegram?chats=@channel` |
| Slack, Teams | The URL, from the Shoutrrr documentation | `slack://…`, `teams://…` |

**Other** takes any Shoutrrr URL. The URL stays visible under **Shoutrrr URL**, and editing
it there fills the fields in again.

### Matrix

The account needs an invitation to each room; Nyx joins on its first message. Rooms are
IDs starting with `!` or aliases such as `#ops:example.com`. **Plain HTTP** is only for a
test homeserver on your network.

**Encrypt messages end to end** sends every message encrypted with Megolm, as Element
does, to every device of every member of the room. Use it for encrypted rooms: without it,
Shoutrrr sends clear text, which those rooms flag as unencrypted. It adds `e2ee=yes` to the
URL, and `nyx-notify` then sends through [mautrix-go](https://github.com/mautrix/go) instead
of Shoutrrr.

Nyx shows up in the account as one device called **Nyx**. Its keys, and the sessions it
shared, live in `matrix/` in the data folder, encrypted with a random key kept beside them
(readable by the Nyx user only). Nothing stays running between messages: each delivery
signs in as that same device, syncs once to learn about new devices, sends and exits. If
the folder is lost, the next message comes from a new device; you can remove the old one
from the account's sessions. You can verify the Nyx device from Element like any other.

With an access token instead of a password, the token's own device is used, and its keys
are kept per token.

## Language

Each channel has a **Language of messages**. Events are recorded in English, and a channel
in French gets every title and detail in French, the words of the default title and the
labels of the visual editor included. New channels start in the language of the interface.

## Messages

Each event is a **card** in the colour of its severity: red for critical, yellow for a
warning, blue for information, green when a problem is resolved. Its title is in bold,
its details under it, and its small print (event type, date and time) at the bottom.
How a card lands depends on the app:

| App | What it shows |
| --- | --- |
| Discord | The title of the message in bold, then an embed per card with its colour on the left, its title, its details and its small print as the footer. At most 10 embeds: past nine, the rest is listed in the last one. Mentions are turned off, so an event text never pings anyone |
| Email with **HTML message** | A card per event with its colour on the left |
| Telegram, Matrix (encrypted) | The severity icon, the title in bold, the small print in italics |
| Slack | One line per card: icon, bold title, details, small print in italics |
| Teams, Gotify | Markdown, with the severity icon before each card |
| Email in plain text, ntfy, others | Plain text, with the severity icon before each card |

To do so the server adds an option to the channel's URL when it sends: `json=yes` for
Discord, `parsemode=HTML` for Telegram, `extras` for Markdown on Gotify, `usehtml=yes`
for HTML mail. A URL that already sets one of these keeps it, and gets the plain look.

**Visual** builds the message with the mouse:

- **Title**: your text, the worst severity icon and the number of events.
- **Each event**: the event type icon before the title, and the details under it.
- **Small print, in this order**: the host (only when the title does not already name
  it), the event type, the date and time, the severity. Empty parts are skipped, with
  no stray separator.
- **Between parts**: ` · `, ` — `, ` | ` or ` : `.
- **Group by** host, event type or severity: one card per group, in the colour of its
  worst event, one line per event.
- **Order**: worst, oldest or newest first.
- **Events shown at most**: the rest is summed up as "… and 12 more".
- **First line** and **Last line**: free text before and after the cards.

The server turns the layout into templates when it sends, so a layout saved before an
update gets the new look without being saved again. Layouts saved before cards existed
start again from the default parts.

**Template** shows the templates the layout stands for, to edit by hand. Editing them by
hand turns the visual editor off for that channel; switching back to **Visual** replaces
them, after asking.

The preview beside the form renders sample events through the server, in the channel's
language. The buttons above it show the same message as an email, in Discord, Slack,
Telegram, Teams or Matrix, or as a phone notification. It is an approximation: each app
has the last word.

### Templates

Titles and bodies are Jinja-style templates ([minijinja](https://docs.rs/minijinja)).
Left empty, a channel uses the default layout. A body marks its cards with three lines
taken from Markdown and Discord:

| Line | Meaning |
| --- | --- |
| `::: crit` (or `warn`, `info`, `ok`) | Opens a card in that colour |
| `:::` alone | Closes the card; what follows is free text |
| `**title**`, first in a card | The card's title |
| `-# text` | Small print |

`**bold**` works anywhere. Blank lines inside a card are dropped, so a template need not
mind its whitespace. A body without `:::` is sent as it is. With **HTML message**, a body
with cards becomes the styled mail, and one without is taken as your own HTML.

| Variable | Meaning |
| --- | --- |
| `count`, `crit`, `warn` | Number of events, of critical ones, of warnings |
| `icon` | Emoji of the worst severity in the message |
| `hosts` | The hosts named, sorted |
| `lang` | `en` or `fr`, the channel's language |
| `events` | The list, each with the fields below |
| `e.title`, `e.message` | What happened and its details, in the channel's language |
| `e.icon` | 🔴 critical, 🟠 warning, 🔵 information, 🟢 resolved |
| `e.type_icon` | 📡 state, 📦 update, 💽 SMART, 🌡️ temperature, 📋 task, ⚡ EDF Tempo, 🔧 CI/CD pipeline |
| `e.type_label`, `e.severity_label` | The type and the severity in words |
| `e.when`, `e.time` | Local date and time, and time alone |
| `e.rank` | 0 critical to 3 resolved, to sort by |
| `e.type`, `e.severity`, `e.host`, `e.created` | The event itself |

A card per event, worst first. Any emoji can also be typed straight into a template:

```jinja
{% for e in events|sort(attribute="rank") %}::: {{ e.severity }}
**{{ e.title }}**
{% if e.message %}{{ e.message }}{% endif %}
-# {{ e.type_label }} · {{ e.when }}
{% endfor %}
```

## Rules

A rule sends some events to one channel, on a schedule.

| Event type | Raised by |
| --- | --- |
| `state` | Hosts going offline or back, probes failing or recovering |
| `update` | System updates detected |
| `smart` | Disks needing attention or critical |
| `temperature` | High temperature |
| `tempo` | EDF Tempo colour of tomorrow |
| `pipeline` | A CI/CD pipeline fails, and recovers |
| `task` | Task, intervention and deployment reminders |

**Severities** narrows a rule to critical events, warnings, information or resolved
problems. **Only these hosts** narrows it to some hosts; left empty, it covers every host
and the events about none, such as EDF Tempo.

| Schedule | Behaviour |
| --- | --- |
| As it happens, grouped | Sends right away, then waits for the minimum gap, grouping what arrives |
| Daily digest | One digest at the chosen hour |
| Weekly digest | One digest on the chosen day and hour |
| Monthly digest | One digest on the chosen day and hour. Days stop at 28, so February is not skipped |

Rules sent as it happens have three more settings, all about not being bothered for
nothing:

- **Wait before sending** holds the first event a few minutes, so that what follows
  leaves in the same message.
- **Skip problems that resolve before the message leaves**: a problem and its "Resolved"
  in the same message cancel out, and neither is sent. Pair it with a wait, so that a
  host rebooting or a disk spike does not wake anyone.
- **Quiet hours**, for instance 22:00 to 07:00: events are held, then sent together when
  they end. **Critical events still go out** lets the serious ones through.

Example: updates are checked every day, but a monthly rule on `update` sends a single
summary on the 1st at 9:00, while a rule on critical `state` events reaches the phone
at any hour.

A rule that fails shows **Failing** with the error, and tries again later with the
same events. Events are kept 40 days.

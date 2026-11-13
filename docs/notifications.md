# Notifications

Notifications are set up separately in the monitor and the manager, in **Settings,
Notifications**. Two concepts: **channels** say where, **rules** say what and when.

## Channels

A channel is a [Shoutrrr](https://github.com/nicholas-fedor/shoutrrr) URL. The form
fills in a template for the common services:

| Service | URL |
| --- | --- |
| Email | `smtp://user:password@mail.example.com:587/?from=nyx@example.com&to=you@example.com` |
| Discord | `discord://token@webhook-id` |
| Matrix | `matrix://user:password@matrix.example.com/?rooms=!room:example.com` |
| Slack | `slack://xoxb:token@channel` |
| Gotify | `gotify://gotify.example.com/token` |
| Ntfy | `ntfy://:token@ntfy.sh/topic` |
| Telegram | `telegram://token@telegram?chats=@channel` |
| Teams | `teams://group@tenant/altid/groupowner?host=org.webhook.office.com` |

Any other Shoutrrr service works too.

## Templates

Titles and bodies are Jinja-style templates. Leave them empty for the default, which
uses emojis and gives each event its own line:

```text
🔴 Nyx: 5 events

🔴 📡 backup-01 is not responding · No report for 5 minutes
🟠 💽 /dev/sda: 8 bad sectors (nas-01) · Plan a replacement
🔵 📦 12 updates available (docker-01) · 3 security updates
```

| Variable | Meaning |
| --- | --- |
| `count` | Number of events |
| `icon` | Emoji of the worst severity in the message |
| `events` | The list, each with the fields below |
| `e.icon` | 🔴 critical, 🟠 warning, 🔵 information, 🟢 resolved |
| `e.type_icon` | 📡 state, 📦 update, 💽 SMART, 🌡️ temperature, 📋 task, ⚡ EDF Tempo, 🔧 CI/CD pipeline |
| `e.type`, `e.severity`, `e.title`, `e.message`, `e.host`, `e.created` | The event itself |

Any emoji can also be typed straight into a template:

```jinja
{% for e in events %}{{ e.icon }} {{ e.title }}{% if e.message %}: {{ e.message }}{% endif %}
{% endfor %}
```

The preview beside the form uses sample events and picks the look of the service in the
URL. The buttons above it show the same message as an email, in Discord, Slack, Telegram,
Teams or Matrix, or as a phone notification. It is an approximation: each app has the
last word. Discord shows each line as a separate block, so one line per event reads best.

Tick **HTML message** for styled email: it fills in a ready-made design if the body is
empty. Values are escaped automatically in HTML.

## Rules

A rule sends some event types to one channel, on a schedule.

| Event type | Raised by |
| --- | --- |
| `state` | Hosts going offline or back, probes failing or recovering |
| `update` | System updates detected |
| `smart` | Disks needing attention or critical |
| `temperature` | High temperature |
| `tempo` | EDF Tempo colour of tomorrow |
| `pipeline` | A CI/CD pipeline fails, and recovers |
| `task` | Task and deployment reminders, deploy results |

| Schedule | Behaviour |
| --- | --- |
| As it happens, grouped | Sends right away, then waits for the minimum gap, grouping what arrives |
| Daily digest | One digest at the chosen hour |
| Weekly digest | One digest on the chosen day and hour |
| Monthly digest | One digest on the chosen day and hour. Days stop at 28, so February is not skipped |

Example: updates are checked every day, but a monthly rule on `update` sends a single
summary on the 1st at 9:00.

A rule that fails shows **Failing** with the error, and tries again later with the
same events. Events are kept 40 days.

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

Titles and bodies are Jinja-style templates, with a live preview in the form.
Variables: `count`, and `events`, each with `type`, `severity`, `title`, `message`,
`host` and `created`.

```jinja
{% for e in events %}[{{ e.severity }}] {{ e.title }} {{ e.message }}
{% endfor %}
```

Tick **HTML message** for styled email. Values are escaped automatically in HTML.

## Rules

A rule sends some event types to one channel, on a schedule.

| Event type | Raised by |
| --- | --- |
| `state` | Hosts going offline or back, probes failing or recovering |
| `update` | System updates detected |
| `smart` | Disks needing attention or critical |
| `temperature` | High temperature |
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

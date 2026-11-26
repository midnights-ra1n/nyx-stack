import { ArrowDownIcon, ArrowUpIcon, EyeIcon, EyeSlashIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useEffect, useState } from "react"
import { Button, Check, Empty, ErrorNote, Field, IconButton, Input, Modal, Panel, Select, Status, Table, Tabs, Td, TextArea, ask } from "./components"
import { api, fmt, useApi } from "./lib"
import { MessagePreview, type Rendered } from "./preview"
import { LANGS, lang as uiLang, t } from "./i18n"
import { splitTags, TagInput } from "./tags"

/* ---------- Where a message goes: one form per service, the Shoutrrr URL built from it ---------- */

type Values = Record<string, string>
interface ServiceField { key: string; label: string; kind?: "secret" | "list" | "check" | "select"; placeholder?: string; hint?: string; options?: { value: string; label: string }[]; when?: (v: Values) => boolean }
interface Service { id: string; label: string; fields: ServiceField[]; build: (v: Values) => string; parse: (u: Parsed) => Values | null }

interface Parsed { scheme: string; user: string; pass: string; host: string; path: string; query: URLSearchParams }

/** A service URL in parts, escapes undone. Null when it is not one. */
export function parseUrl(url: string): Parsed | null {
  const m = /^([a-z][a-z0-9+]*):\/\/(?:([^:@/?#]*)(?::([^@/?#]*))?@)?([^/?#]*)([^?#]*)(?:\?([^#]*))?$/i.exec(url.trim())
  if (!m) return null
  try {
    return { scheme: m[1].toLowerCase(), user: decodeURIComponent(m[2] ?? ""), pass: decodeURIComponent(m[3] ?? ""), host: m[4], path: decodeURIComponent(m[5] ?? ""), query: new URLSearchParams(m[6] ?? "") }
  } catch { return null }
}

// Every character of a password or a room survives the URL: that is the point of the forms.
const enc = encodeURIComponent
const auth = (user = "", pass = "") => (user || pass ? `${enc(user)}${pass ? `:${enc(pass)}` : ""}@` : "")
const query = (q: Record<string, string | undefined>) => {
  const s = Object.entries(q).filter(([, v]) => v).map(([k, v]) => `${k}=${enc(v!)}`).join("&")
  return s ? `?${s}` : ""
}
const yes = (v?: string) => (v === "1" ? "yes" : undefined)
const flag = (q: URLSearchParams, k: string) => (["yes", "true", "1"].includes((q.get(k) ?? "").toLowerCase()) ? "1" : "")
const list = (v?: string) => splitTags(v).join(",")

export const SERVICES: Service[] = [
  {
    id: "smtp", label: "Email",
    fields: [
      { key: "host", label: "SMTP server", placeholder: "mail.example.com" },
      { key: "port", label: "Port", placeholder: "587" },
      { key: "user", label: "User" },
      { key: "pass", label: "Password", kind: "secret", hint: "Type it as it is: special characters are taken care of." },
      { key: "from", label: "From", placeholder: "nyx@example.com" },
      { key: "to", label: "To", kind: "list", placeholder: "you@example.com" },
      { key: "enc", label: "Encryption", kind: "select", options: [{ value: "", label: "Automatic" }, { value: "ExplicitTLS", label: "STARTTLS" }, { value: "ImplicitTLS", label: "TLS" }, { value: "None", label: "None" }] },
    ],
    build: (v) => `smtp://${auth(v.user, v.pass)}${v.host ?? ""}${v.port ? `:${v.port}` : ""}/${query({ from: v.from, to: list(v.to), encryption: v.enc })}`,
    parse: (u) => {
      const [host, port = ""] = u.host.split(":")
      return { host, port, user: u.user, pass: u.pass, from: u.query.get("from") ?? u.query.get("fromaddress") ?? "", to: u.query.get("to") ?? u.query.get("toaddresses") ?? "", enc: u.query.get("encryption") ?? "" }
    },
  },
  {
    id: "matrix", label: "Matrix",
    fields: [
      { key: "host", label: "Homeserver", placeholder: "matrix.example.com", hint: "Host name, and :port when it is not 443." },
      { key: "token", label: "Sign in with an access token", kind: "check" },
      { key: "user", label: "User", placeholder: "nyx-bot", when: (v) => v.token !== "1" },
      { key: "pass", label: "Password", kind: "secret", when: (v) => v.token !== "1", hint: "Type it as it is: special characters are taken care of." },
      { key: "pass", label: "Access token", kind: "secret", when: (v) => v.token === "1" },
      { key: "rooms", label: "Rooms", kind: "list", placeholder: "!abc123:example.com", hint: "Room IDs (starting with !) or aliases (#room:example.com). The account must be invited." },
      { key: "e2ee", label: "Encrypt messages end to end", kind: "check", hint: "For encrypted rooms. Nyx keeps its keys in its data folder and shows as its own device." },
      { key: "plain", label: "Plain HTTP, for a test server on the local network", kind: "check" },
    ],
    build: (v) => `matrix://${auth(v.token === "1" ? "" : v.user, v.pass)}${v.host ?? ""}/${query({ rooms: list(v.rooms), disabletls: yes(v.plain), e2ee: yes(v.e2ee) })}`,
    parse: (u) => ({ host: u.host, user: u.user, pass: u.pass, token: !u.user && u.pass ? "1" : "", rooms: u.query.get("rooms") ?? u.query.get("room") ?? "", e2ee: flag(u.query, "e2ee"), plain: flag(u.query, "disabletls") }),
  },
  {
    id: "discord", label: "Discord",
    fields: [{ key: "hook", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…", hint: "Channel settings › Integrations › Webhooks › Copy URL." }],
    build: (v) => {
      const m = /webhooks\/(\d+)\/([\w-]+)/.exec(v.hook ?? "")
      return m ? `discord://${m[2]}@${m[1]}` : "discord://"
    },
    parse: (u) => ({ hook: u.user && u.host ? `https://discord.com/api/webhooks/${u.host}/${u.user}` : "" }),
  },
  {
    id: "ntfy", label: "Ntfy",
    fields: [
      { key: "host", label: "Server", placeholder: "ntfy.sh" },
      { key: "topic", label: "Topic", placeholder: "homelab" },
      { key: "token", label: "Access token", kind: "secret", hint: "Or a user and password below, for a protected topic." },
      { key: "user", label: "User" },
      { key: "pass", label: "Password", kind: "secret" },
    ],
    build: (v) => `ntfy://${auth(v.user, v.pass)}${v.host || "ntfy.sh"}/${enc(v.topic ?? "")}${query({ token: v.token })}`,
    parse: (u) => ({ host: u.host, topic: u.path.replace(/^\//, ""), token: u.query.get("token") ?? "", user: u.user, pass: u.pass }),
  },
  {
    id: "gotify", label: "Gotify",
    fields: [{ key: "host", label: "Server", placeholder: "gotify.example.com" }, { key: "token", label: "Application token", kind: "secret" }],
    build: (v) => `gotify://${v.host ?? ""}/${enc(v.token ?? "")}`,
    parse: (u) => ({ host: u.host, token: u.path.replace(/^\//, "") }),
  },
  {
    id: "telegram", label: "Telegram",
    fields: [{ key: "token", label: "Bot token", kind: "secret", placeholder: "123456:ABC-DEF…", hint: "From @BotFather." }, { key: "chats", label: "Chats", kind: "list", placeholder: "@channel or 12345678" }],
    // The token's own colon splits it into user and password, as Shoutrrr reads it.
    build: (v) => { const [id = "", ...rest] = (v.token ?? "").split(":"); return `telegram://${auth(id, rest.join(":"))}telegram${query({ chats: list(v.chats) })}` },
    parse: (u) => ({ token: u.pass ? `${u.user}:${u.pass}` : u.user, chats: u.query.get("chats") ?? "" }),
  },
  { id: "slack", label: "Slack", fields: [], build: () => "slack://xoxb:token@channel", parse: () => ({}) },
  { id: "teams", label: "Teams", fields: [], build: () => "teams://group@tenant/altid/groupowner?host=org.webhook.office.com", parse: () => ({}) },
]
const OTHER = "other"

function serviceOf(url: string): [string, Values] {
  const u = parseUrl(url)
  const s = SERVICES.find((x) => x.id === u?.scheme)
  return s && u ? [s.id, s.parse(u) ?? {}] : [url ? OTHER : "smtp", {}]
}

function Secret({ label, hint, value, onChange, placeholder }: { label: string; hint?: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [shown, setShown] = useState(false)
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <div className="relative">
          <input id={id} type={shown ? "text" : "password"} autoComplete="off" spellCheck={false} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="field h-9 w-full rounded-control border border-line2 bg-raised pr-11 pl-4 font-mono text-fg placeholder:text-fg3 hover:border-fg3 max-sm:h-11 max-sm:text-base" />
          <IconButton label={shown ? "Hide" : "Show"} icon={shown ? EyeSlashIcon : EyeIcon} onClick={() => setShown(!shown)} className="absolute top-0 right-0" />
        </div>
      )}
    </Field>
  )
}

function ServiceForm({ url, onChange }: { url: string; onChange: (url: string) => void }) {
  const [[svc, vals], setState] = useState(() => serviceOf(url))
  const service = SERVICES.find((s) => s.id === svc)
  const set = (k: string, v: string) => {
    const next = { ...vals, [k]: v }
    setState([svc, next])
    if (service) onChange(service.build(next))
  }
  const pick = (id: string) => {
    const s = SERVICES.find((x) => x.id === id)
    setState([id, {}])
    if (s && (!s.fields.length || !url.startsWith(`${s.id}:`))) onChange(s.fields.length ? "" : s.build({}))
  }
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label={t("Service")} className="flex flex-wrap gap-1.5">
        {[...SERVICES.map((s) => ({ id: s.id, label: s.label })), { id: OTHER, label: "Other" }].map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={svc === s.id} onClick={() => pick(s.id)}
            className={`h-8 rounded-control border px-3 text-[13px] max-sm:h-10 ${svc === s.id ? "border-accent bg-accent/10 text-fg" : "border-line2 text-fg2 hover:border-fg3 hover:text-fg"}`}>{t(s.label)}</button>
        ))}
      </div>
      {service?.fields.filter((f) => !f.when || f.when(vals)).map((f, i) => {
        const v = vals[f.key] ?? ""
        const key = `${f.key}-${i}`
        if (f.kind === "secret") return <Secret key={key} label={f.label} hint={f.hint} placeholder={f.placeholder} value={v} onChange={(x) => set(f.key, x)} />
        if (f.kind === "check") return <Check key={key} label={f.label} hint={f.hint} checked={v === "1"} onChange={(e) => set(f.key, e.target.checked ? "1" : "")} />
        if (f.kind === "list") return <TagInput key={key} label={f.label} hint={f.hint} placeholder={f.placeholder} value={splitTags(v)} onChange={(x) => set(f.key, x.join(","))} />
        if (f.kind === "select") return <Select key={key} label={f.label} value={v} options={f.options ?? []} onChange={(e) => set(f.key, e.target.value)} />
        return <Input key={key} label={f.label} hint={f.hint} placeholder={f.placeholder} value={v} spellCheck={false} onChange={(e) => set(f.key, e.target.value.trim())} />
      })}
      {service && !service.fields.length && <p className="text-xs text-fg3">{t("Fill in the URL below, as the Shoutrrr documentation for {service} shows it.", { service: service.label })}</p>}
      <details open={svc === OTHER || (service && !service.fields.length)} className="group/url">
        <summary className="cursor-pointer text-[13px] text-fg2 hover:text-fg">{t("Shoutrrr URL")}</summary>
        <div className="mt-2">
          <Input label="URL" value={url} spellCheck={false} className="font-mono" hint="Built from the fields above. Any Shoutrrr service URL works here." onChange={(e) => { onChange(e.target.value); const next = serviceOf(e.target.value); if (next[0] !== OTHER) setState(next) }} />
        </div>
      </details>
    </div>
  )
}

/* ---------- What a message says: a visual layout, or templates written by hand ---------- */

export interface Design { title: string; icon: boolean; count: boolean; header: string; footer: string; parts: [string, boolean][]; sep: string; group: string; order: string; limit: number }

// Each event is a card in the colour of its severity. Where each part goes in it; the server
// turns the layout into templates (notify.rs, design_templates).
const PARTS: Record<string, { label: string; zone: "card" | "small" }> = {
  type_icon: { label: "Event type icon before the title", zone: "card" },
  message: { label: "Details under the title", zone: "card" },
  host: { label: "Host, when the title does not name it", zone: "small" },
  type: { label: "Event type", zone: "small" },
  when: { label: "Date and time", zone: "small" },
  severity: { label: "Severity", zone: "small" },
}
export const DEFAULT_DESIGN: Design = {
  title: "Nyx", icon: true, count: true, header: "", footer: "",
  parts: [["type_icon", false], ["message", true], ["host", true], ["type", true], ["when", true], ["severity", false]],
  sep: " · ", group: "", order: "worst", limit: 0,
}
/** Layouts saved before cards had a severity icon on each line: they start from the default parts. */
export const fresh = (d: Design): Design => (d.parts?.some(([k]) => k === "icon") ? { ...d, parts: DEFAULT_DESIGN.parts } : d)
const SEPARATORS = [" · ", " — ", " | ", " : "]

function DesignEditor({ d, onChange }: { d: Design; onChange: (d: Design) => void }) {
  const set = (patch: Partial<Design>) => onChange({ ...d, ...patch })
  const toggle = (k: string, on: boolean) => set({ parts: d.parts.map((p) => (p[0] === k ? [k, on] : p)) })
  const isOn = (k: string) => d.parts.some(([p, v]) => p === k && v)
  const small = d.parts.flatMap(([k, on], i) => (PARTS[k]?.zone === "small" ? [{ k, on, i }] : []))
  const move = (j: number, by: number) => {
    const parts = [...d.parts]
    const [a, b] = [small[j].i, small[j + by].i]
    ;[parts[a], parts[b]] = [parts[b], parts[a]]
    set({ parts })
  }
  return (
    <div className="flex flex-col gap-4">
      <Input label="Title" value={d.title} onChange={(e) => set({ title: e.target.value })} />
      <div className="flex flex-wrap gap-x-6">
        <Check label="Worst severity icon" checked={d.icon} onChange={(e) => set({ icon: e.target.checked })} />
        <Check label="Number of events" checked={d.count} onChange={(e) => set({ count: e.target.checked })} />
      </div>
      <fieldset>
        <legend className="mb-1 text-[13px] text-fg2">{t("Each event is a card in the colour of its severity, its title in bold")}</legend>
        <div className="flex flex-col">
          {d.parts.filter(([k]) => PARTS[k]?.zone === "card").map(([k]) => <Check key={k} label={PARTS[k].label} checked={isOn(k)} onChange={(e) => toggle(k, e.target.checked)} />)}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1 text-[13px] text-fg2">{t("Small print, in this order")}</legend>
        <ol className="flex flex-col divide-y divide-line rounded-box border border-line">
          {small.map(({ k, on }, j) => (
            <li key={k} className="flex items-center gap-1 pr-1 pl-3">
              <div className="min-w-0 flex-1"><Check label={PARTS[k].label} checked={on} onChange={(e) => toggle(k, e.target.checked)} /></div>
              <IconButton label="Move up" icon={ArrowUpIcon} disabled={j === 0} onClick={() => move(j, -1)} />
              <IconButton label="Move down" icon={ArrowDownIcon} disabled={j === small.length - 1} onClick={() => move(j, 1)} />
            </li>
          ))}
        </ol>
      </fieldset>
      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
        <Select label="Between parts" value={d.sep} onChange={(e) => set({ sep: e.target.value })} options={SEPARATORS.map((s) => ({ value: s, label: `«${s}»` }))} />
        <Select label="Group by" value={d.group} onChange={(e) => set({ group: e.target.value })} options={[{ value: "", label: "Nothing" }, { value: "host", label: "Host" }, { value: "type", label: "Event type" }, { value: "rank", label: "Severity" }]} hint="One card per group, in the colour of its worst event." />
        <Select label="Order" value={d.order} onChange={(e) => set({ order: e.target.value })} options={[{ value: "worst", label: "Worst first" }, { value: "old", label: "Oldest first" }, { value: "new", label: "Newest first" }]} />
        <Input label="Events shown at most" type="number" min={0} value={d.limit} onChange={(e) => set({ limit: Number(e.target.value) })} hint="0: all of them." />
      </div>
      <Input label="First line" value={d.header} onChange={(e) => set({ header: e.target.value })} />
      <Input label="Last line" value={d.footer} onChange={(e) => set({ footer: e.target.value })} />
    </div>
  )
}

function ChannelEditor({ row, onDone }: { row: any | null; onDone: () => void }) {
  const lang = row?.lang || uiLang
  const design: Design | null = row ? (row.design ? fresh(row.design) : row.title_tpl || row.body_tpl ? null : DEFAULT_DESIGN) : DEFAULT_DESIGN
  const [f, setF] = useState({ name: row?.name ?? "", url: row?.url ?? "", html: row?.html ?? false, lang, design, title_tpl: row?.title_tpl ?? "", body_tpl: row?.body_tpl ?? "" })
  const [mode, setMode] = useState(design ? "visual" : "template")
  const [preview, setPreview] = useState<Rendered>()
  const [error, setError] = useState("")
  const update = (patch: Partial<typeof f>) => setF({ ...f, ...patch })
  const toVisual = async () => {
    if (!f.design && (f.title_tpl || f.body_tpl) && !await ask(t("The visual editor replaces the templates written by hand."), { action: "Replace" })) return
    setMode("visual")
    setF({ ...f, design: f.design ?? DEFAULT_DESIGN })
  }
  // Templates start from what the layout stands for.
  const toTemplate = () => {
    setMode("template")
    if (mode === "visual" && preview) setF({ ...f, title_tpl: preview.title_tpl, body_tpl: preview.body_tpl })
  }

  useEffect(() => {
    const id = setTimeout(() => {
      api<Rendered>("/api/notify/preview", { body: { title_tpl: f.title_tpl, body_tpl: f.body_tpl, html: f.html, lang: f.lang, design: mode === "visual" ? f.design : null } }).then((p) => { setPreview(p); setError("") }, (e) => setError(e.message))
    }, 300)
    return () => clearTimeout(id)
  }, [f.title_tpl, f.body_tpl, f.html, f.lang, f.design, mode])

  const save = async () => {
    try {
      await api(row ? `/api/c/notif_channels/${row.id}` : "/api/c/notif_channels", { method: row ? "PATCH" : "POST", body: { ...f, design: mode === "visual" ? f.design : null } })
      onDone()
    } catch (e) { setError((e as Error).message) }
  }
  return (
    <Modal title={row ? "Edit channel" : "Add channel"} onClose={onDone} wide>
      <div className="grid grid-cols-2 gap-6 max-md:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          <Input label="Name" required value={f.name} onChange={(e) => update({ name: e.target.value })} />
          <ServiceForm url={f.url} onChange={(url) => update({ url })} />
          <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
            <Select label="Language of messages" value={f.lang} onChange={(e) => update({ lang: e.target.value })} options={LANGS} />
            <div className="self-end"><Check label="HTML message (email)" checked={f.html} onChange={(e) => update({ html: e.target.checked })} /></div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
            <h3 className="text-[14px] font-medium">{t("Message")}</h3>
            <Tabs tabs={[{ id: "visual", label: "Visual" }, { id: "template", label: "Template" }]} value={mode} onChange={(m) => (m === "visual" ? toVisual() : toTemplate())} />
          </div>
          {mode === "visual" && f.design ? <DesignEditor d={f.design} onChange={(design) => update({ design })} /> : (
            <>
              <Input label="Title template" value={f.title_tpl} placeholder="{{ icon }} Nyx: {{ count }} events" onChange={(e) => setF({ ...f, title_tpl: e.target.value })} />
              <TextArea label="Body template" rows={10} value={f.body_tpl} onChange={(e) => setF({ ...f, body_tpl: e.target.value })} placeholder={"{% for e in events %}::: {{ e.severity }}\n**{{ e.title }}**\n-# {{ e.when }}\n{% endfor %}"}
                hint="Variables: count, crit, warn, icon (worst severity), hosts, lang, events (title, message, host, type, type_label, type_icon, severity, severity_label, icon, rank, when, time, created). A line ::: crit, warn, info or ok opens a card in that colour and ::: alone closes it. In a card, a first line in **bold** is its title and lines starting with -# are small print." />
            </>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2 md:sticky md:top-0 md:self-start">
          <div className="text-[13px] text-fg2">{t("Preview")}</div>
          <MessagePreview url={f.url} rendered={preview} html={f.html} />
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div><Button variant="primary" onClick={save} disabled={!f.name || !f.url}>{t("Save")}</Button></div>
    </Modal>
  )
}

/* ---------- When it goes: rules ---------- */

const EVENTS = [["state", "State changes"], ["update", "Updates detected"], ["smart", "SMART health"], ["temperature", "High temperature"], ["task", "Task and deployment reminders"], ["tempo", "EDF Tempo colour of tomorrow"], ["pipeline", "CI/CD pipeline failures"]]
const EVENT_SHORT: Record<string, string> = { state: "State", update: "Updates", smart: "SMART", temperature: "Temperature", task: "Tasks", tempo: "EDF Tempo", pipeline: "Pipelines" }
const SEVERITIES = [["crit", "Critical"], ["warn", "Warning"], ["info", "Info"], ["ok", "Resolved"]]
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }))
const WAITS = [0, 1, 2, 5, 10, 15, 30]

function RuleEditor({ row, channels, hosts, onDone }: { row: any | null; channels: any[]; hosts: string[]; onDone: () => void }) {
  const [f, setF] = useState({
    name: row?.name ?? "", channel: row?.channel ?? channels[0]?.id ?? "", events: (row?.events ?? ["state"]) as string[],
    schedule: row?.schedule || "instant", min_gap_s: row?.min_gap_s ?? 900, hour: row?.hour ?? 8, day: row?.day ?? 1,
    severities: (row?.severities?.length ? row.severities : SEVERITIES.map(([k]) => k)) as string[], hosts: row?.hosts ?? "",
    delay_s: row?.delay_s ?? (row ? 0 : 120), skip_resolved: row?.skip_resolved ?? !row,
    quiet_from: row?.quiet_from ?? 0, quiet_to: row?.quiet_to ?? 0, quiet_crit: row?.quiet_crit ?? true,
  })
  const [error, setError] = useState("")
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch })
  const toggle = (list: string[], k: string, on: boolean) => (on ? [...list, k] : list.filter((x) => x !== k))
  const save = async () => {
    // Every severity ticked is the same as none: the rule follows new ones too.
    const body = { ...f, severities: f.severities.length === SEVERITIES.length ? [] : f.severities }
    try {
      await api(row ? `/api/c/notif_rules/${row.id}` : "/api/c/notif_rules", { method: row ? "PATCH" : "POST", body })
      onDone()
    } catch (e) { setError((e as Error).message) }
  }
  const quiet = f.quiet_from !== f.quiet_to
  return (
    <Modal title={row ? "Edit rule" : "Add rule"} onClose={onDone} wide>
      <div className="grid grid-cols-2 gap-x-8 gap-y-4 max-md:grid-cols-1">
        <div className="flex flex-col gap-4">
          <h3 className="text-[14px] font-medium">{t("What")}</h3>
          <Input label="Name" value={f.name} onChange={(e) => set({ name: e.target.value })} />
          <Select label="Channel" value={f.channel} onChange={(e) => set({ channel: e.target.value })} options={channels.map((c) => ({ value: c.id, label: c.name }))} />
          <fieldset>
            <legend className="mb-1 text-[13px] text-fg2">{t("Events")}</legend>
            {EVENTS.map(([k, label]) => <Check key={k} label={label} checked={f.events.includes(k)} onChange={(e) => set({ events: toggle(f.events, k, e.target.checked) })} />)}
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-[13px] text-fg2">{t("Severities")}</legend>
            <div className="grid grid-cols-2">
              {SEVERITIES.map(([k, label]) => <Check key={k} label={label} checked={f.severities.includes(k)} onChange={(e) => set({ severities: toggle(f.severities, k, e.target.checked) })} />)}
            </div>
          </fieldset>
          <TagInput label="Only these hosts" placeholder="Host name, then Enter" value={splitTags(f.hosts)} known={hosts} onChange={(v) => set({ hosts: v.join(",") })} hint="Empty: every host, and events about no host such as EDF Tempo." />
        </div>
        <div className="flex flex-col gap-4">
          <h3 className="text-[14px] font-medium">{t("When")}</h3>
          <Select label="Delivery" value={f.schedule} onChange={(e) => set({ schedule: e.target.value })} options={[{ value: "instant", label: "As it happens, grouped" }, { value: "daily", label: "Daily digest" }, { value: "weekly", label: "Weekly digest" }, { value: "monthly", label: "Monthly digest" }]} />
          {f.schedule === "instant" ? (
            <>
              <Select label="Wait before sending" value={String(f.delay_s / 60)} onChange={(e) => set({ delay_s: Number(e.target.value) * 60 })} options={WAITS.map((m) => ({ value: String(m), label: m ? t("{n} min", { n: m }) : "No" }))} hint="What follows the first event in this time leaves in the same message." />
              <Input label="Minimum minutes between messages" type="number" min={0} value={f.min_gap_s / 60} onChange={(e) => set({ min_gap_s: Number(e.target.value) * 60 })} hint="Events during the gap are grouped into the next message." />
              <Check label="Skip problems that resolve before the message leaves" checked={f.skip_resolved} onChange={(e) => set({ skip_resolved: e.target.checked })} hint="Neither the problem nor its end is told. Works with a wait." />
              <fieldset>
                <legend className="mb-1 text-[13px] text-fg2">{t("Quiet hours")}</legend>
                <div className="grid grid-cols-2 gap-4">
                  <Select label="From" value={String(f.quiet_from)} onChange={(e) => set({ quiet_from: Number(e.target.value) })} options={HOURS} />
                  <Select label="To" value={String(f.quiet_to)} onChange={(e) => set({ quiet_to: Number(e.target.value) })} options={HOURS} />
                </div>
                <p className="mt-1 text-xs text-fg3">{quiet ? t("Held until {hour}, then sent together.", { hour: HOURS[f.quiet_to].label }) : t("Same hours: no quiet hours.")}</p>
                {quiet && <Check label="Critical events still go out" checked={f.quiet_crit} onChange={(e) => set({ quiet_crit: e.target.checked })} />}
              </fieldset>
            </>
          ) : (
            <>
              <Select label="Hour" value={String(f.hour)} onChange={(e) => set({ hour: Number(e.target.value) })} options={HOURS} />
              {f.schedule === "weekly" && <Select label="Day" value={String(f.day)} onChange={(e) => set({ day: Number(e.target.value) })} options={DAYS.map((d, i) => ({ value: String(i + 1), label: d }))} />}
              {f.schedule === "monthly" && <Input label="Day of month" type="number" min={1} max={28} value={f.day} onChange={(e) => set({ day: Number(e.target.value) })} />}
              <p className="text-xs text-fg3">{t("Everything since the last digest, in one message.")}</p>
            </>
          )}
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div><Button variant="primary" onClick={save} disabled={!f.channel || !f.events.length || !f.severities.length}>{t("Save")}</Button></div>
    </Modal>
  )
}

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`
export const describe = (r: any) => [
  r.schedule === "daily" ? t("Daily at {hour}", { hour: hh(r.hour) }) :
  r.schedule === "weekly" ? t("{day} at {hour}", { day: t(DAYS[r.day - 1] ?? "Monday"), hour: hh(r.hour) }) :
  r.schedule === "monthly" ? t("Day {day} at {hour}", { day: r.day, hour: hh(r.hour) }) :
  t("Grouped, at least {v0} min apart", { v0: Math.round(r.min_gap_s / 60) }),
  r.schedule === "instant" && r.delay_s > 0 && t("waits {n} min", { n: Math.round(r.delay_s / 60) }),
  r.schedule === "instant" && r.quiet_from !== r.quiet_to && t("quiet {from}–{to}", { from: hh(r.quiet_from), to: hh(r.quiet_to) }),
].filter(Boolean).join(" · ")

const scope = (r: any) => [
  (r.events ?? []).map((k: string) => t(EVENT_SHORT[k] ?? k)).join(", "),
  r.severities?.length ? r.severities.map((k: string) => t(SEVERITIES.find(([s]) => s === k)?.[1] ?? k)).join(", ") : "",
  splitTags(r.hosts).join(", "),
].filter(Boolean).join(" · ")

/** Channels and rules. `hosts` suggests names for a rule's host filter. */
export function NotificationSettings({ hosts = [] }: { hosts?: string[] }) {
  const channels = useApi("/api/c/notif_channels?sort=name", { poll: false })
  const rules = useApi("/api/c/notif_rules?sort=name", { poll: false })
  const seen = useApi("/api/c/notif_events?sort=-created&perPage=300", { poll: false })
  const known = [...new Set([...hosts, ...(seen.data?.items ?? []).map((e: any) => e.host).filter(Boolean)])].sort((a, b) => a.localeCompare(b))
  const [channel, setChannel] = useState<any | null | undefined>()
  const [rule, setRule] = useState<any | null | undefined>()
  const [note, setNote] = useState("")
  const del = async (coll: string, id: string) => {
    if (!await ask("Delete?", { action: "Delete", danger: true })) return
    await api(`/api/c/${coll}/${id}`, { method: "DELETE" })
    channels.reload(); rules.reload()
  }
  const test = async (id: string) => {
    setNote("")
    try { await api(`/api/notify/test/${id}`, { method: "POST" }); setNote(t("Test message sent.")) } catch (e) { setNote((e as Error).message) }
  }
  const serviceLabel = (url: string) => SERVICES.find((s) => s.id === url.split(":")[0])?.label ?? url.split(":")[0]
  return (
    <>
      <Panel title={t("Channels")} flush>
        {channels.data?.items.length ? (
          <Table head={["Name", "Service", "Language", ""]}>
            {channels.data.items.map((c: any) => (
              <tr key={c.id}>
                <Td className="font-medium">{c.name}</Td>
                <Td className="text-fg2">{t(serviceLabel(c.url))}{flag(parseUrl(c.url)?.query ?? new URLSearchParams(), "e2ee") ? ` · ${t("encrypted")}` : ""}</Td>
                <Td className="text-fg2">{LANGS.find((l) => l.value === (c.lang || "en"))?.label}</Td>
                <Td className="text-right whitespace-nowrap">
                  <Button variant="ghost" onClick={() => test(c.id)}>{t("Test")}</Button>
                  <Button variant="ghost" onClick={() => setChannel(c)}>{t("Edit")}</Button>
                  <IconButton label="Delete" icon={TrashIcon} onClick={() => del("notif_channels", c.id)} />
                </Td>
              </tr>
            ))}
          </Table>
        ) : <div className="px-4"><Empty>{t("No channels yet.")}</Empty></div>}
        <div className="flex items-center gap-3 p-5"><Button onClick={() => setChannel(null)}><PlusIcon className="size-5" aria-hidden />{t("Add channel")}</Button><span className="text-[13px] text-fg2">{note}</span></div>
      </Panel>
      <Panel title={t("Rules")} flush>
        {rules.data?.items.length ? (
          <Table head={["Name", "What", "When", "State", ""]}>
            {rules.data.items.map((r: any) => (
              <tr key={r.id}>
                <Td className="font-medium">{r.name || "—"}</Td>
                <Td className="text-fg2">{scope(r)}</Td>
                <Td className="text-fg2">{describe(r)}</Td>
                <Td>{r.last_error ? <span title={r.last_error}><Status level="crit" label="Failing" /></span> : <span className="text-fg3">{r.last_sent ? t("Sent {ago}", { ago: fmt.ago(r.last_sent) }) : t("Never sent")}</span>}</Td>
                <Td className="text-right whitespace-nowrap">
                  <Button variant="ghost" onClick={() => setRule(r)}>{t("Edit")}</Button>
                  <IconButton label="Delete" icon={TrashIcon} onClick={() => del("notif_rules", r.id)} />
                </Td>
              </tr>
            ))}
          </Table>
        ) : <div className="px-4"><Empty>{t("No rules: nothing is sent until you add one.")}</Empty></div>}
        <div className="p-5"><Button disabled={!channels.data?.items.length} onClick={() => setRule(null)}><PlusIcon className="size-5" aria-hidden />{t("Add rule")}</Button></div>
      </Panel>
      {channel !== undefined && <ChannelEditor row={channel} onDone={() => { setChannel(undefined); channels.reload() }} />}
      {rule !== undefined && <RuleEditor row={rule} channels={channels.data.items} hosts={known} onDone={() => { setRule(undefined); rules.reload() }} />}
    </>
  )
}

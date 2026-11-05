import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useEffect, useState } from "react"
import { Button, Check, Copy, Empty, ErrorNote, IconButton, Input, Modal, Mono, Panel, Select, Status, Table, Td, TextArea } from "./components"
import { api, fmt, useApi } from "./lib"

const SERVICES: Record<string, string> = {
  Email: "smtp://user:password@mail.example.com:587/?from=nyx@example.com&to=you@example.com",
  Discord: "discord://token@webhook-id",
  Matrix: "matrix://user:password@matrix.example.com/?rooms=!room:example.com",
  Slack: "slack://xoxb:token@channel",
  Gotify: "gotify://gotify.example.com/token",
  Ntfy: "ntfy://:token@ntfy.sh/topic",
  Telegram: "telegram://token@telegram?chats=@channel",
  Teams: "teams://group@tenant/altid/groupowner?host=org.webhook.office.com",
}
const EVENTS = [["state", "State changes"], ["update", "Updates detected"], ["smart", "SMART health"], ["temperature", "High temperature"], ["task", "Task and deployment reminders"]]
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

const HTML_SAMPLE = `<div style="font-family:sans-serif;background:#121110;color:#e7e3dd;padding:24px">
  <h2 style="color:#e38b4f">{{ count }} events</h2>
  {% for e in events %}<p><strong>{{ e.title }}</strong><br>{{ e.message }}</p>{% endfor %}
</div>`

function ChannelEditor({ row, onDone }: { row: any | null; onDone: () => void }) {
  const [f, setF] = useState({ name: row?.name ?? "", url: row?.url ?? "", title_tpl: row?.title_tpl ?? "", body_tpl: row?.body_tpl ?? "", html: row?.html ?? false })
  const [preview, setPreview] = useState<{ title: string; body: string }>()
  const [error, setError] = useState("")
  const set = (k: string, v: any) => setF({ ...f, [k]: v })

  useEffect(() => {
    const id = setTimeout(() => {
      api("/api/notify/preview", { body: { title_tpl: f.title_tpl, body_tpl: f.body_tpl, html: f.html } }).then((p) => { setPreview(p); setError("") }, (e) => setError(e.message))
    }, 300)
    return () => clearTimeout(id)
  }, [f.title_tpl, f.body_tpl, f.html])

  const save = async () => {
    try {
      await api(row ? `/api/c/notif_channels/${row.id}` : "/api/c/notif_channels", { method: row ? "PATCH" : "POST", body: f })
      onDone()
    } catch (e) { setError((e as Error).message) }
  }
  return (
    <Modal title={row ? "Edit channel" : "Add channel"} onClose={onDone} wide>
      <div className="grid grid-cols-2 gap-5 max-md:grid-cols-1">
        <div className="flex flex-col gap-4">
          <Input label="Name" required value={f.name} onChange={(e) => set("name", e.target.value)} />
          <Select label="Service" value="" onChange={(e) => e.target.value && set("url", SERVICES[e.target.value])} options={[{ value: "", label: "Fill URL from a template…" }, ...Object.keys(SERVICES).map((s) => ({ value: s, label: s }))]} />
          <Input label="Shoutrrr URL" required value={f.url} onChange={(e) => set("url", e.target.value)} className="font-mono" hint="Any Shoutrrr service URL works." />
          <Input label="Title template" value={f.title_tpl} placeholder="[Nyx] {{ count }} events" onChange={(e) => set("title_tpl", e.target.value)} />
          <TextArea label="Body template" rows={8} value={f.body_tpl} onChange={(e) => set("body_tpl", e.target.value)} placeholder="{% for e in events %}[{{ e.severity }}] {{ e.title }}&#10;{% endfor %}" hint="Variables: count, events (type, severity, title, message, host, created)." />
          <Check label="HTML message (email)" checked={f.html} onChange={(e) => setF({ ...f, html: e.target.checked, body_tpl: e.target.checked && !f.body_tpl ? HTML_SAMPLE : f.body_tpl })} />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-[13px] text-fg2">Preview</div>
          <div className="rounded-panel border border-line2 bg-bg p-4">
            <div className="mb-3 font-medium">{preview?.title}</div>
            {f.html
              ? <iframe title="Message preview" sandbox="" srcDoc={preview?.body ?? ""} className="h-80 w-full rounded-control bg-white" />
              : <pre className="font-sans whitespace-pre-wrap text-fg2">{preview?.body}</pre>}
          </div>
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div><Button variant="primary" onClick={save} disabled={!f.name || !f.url}>Save</Button></div>
    </Modal>
  )
}

function RuleEditor({ row, channels, onDone }: { row: any | null; channels: any[]; onDone: () => void }) {
  const [f, setF] = useState({ name: row?.name ?? "", channel: row?.channel ?? channels[0]?.id ?? "", events: (row?.events ?? ["state"]) as string[], schedule: row?.schedule || "instant", min_gap_s: row?.min_gap_s ?? 900, hour: row?.hour ?? 8, day: row?.day ?? 1 })
  const [error, setError] = useState("")
  const set = (k: string, v: any) => setF({ ...f, [k]: v })
  const save = async () => {
    try {
      await api(row ? `/api/c/notif_rules/${row.id}` : "/api/c/notif_rules", { method: row ? "PATCH" : "POST", body: f })
      onDone()
    } catch (e) { setError((e as Error).message) }
  }
  return (
    <Modal title={row ? "Edit rule" : "Add rule"} onClose={onDone}>
      <Input label="Name" value={f.name} onChange={(e) => set("name", e.target.value)} />
      <Select label="Channel" value={f.channel} onChange={(e) => set("channel", e.target.value)} options={channels.map((c) => ({ value: c.id, label: c.name }))} />
      <fieldset>
        <legend className="mb-1 text-[13px] text-fg2">Events</legend>
        {EVENTS.map(([k, label]) => <Check key={k} label={label} checked={f.events.includes(k)} onChange={(e) => set("events", e.target.checked ? [...f.events, k] : f.events.filter((x) => x !== k))} />)}
      </fieldset>
      <Select label="Delivery" value={f.schedule} onChange={(e) => set("schedule", e.target.value)} options={[{ value: "instant", label: "As it happens, grouped" }, { value: "daily", label: "Daily digest" }, { value: "weekly", label: "Weekly digest" }, { value: "monthly", label: "Monthly digest" }]} />
      {f.schedule === "instant" && <Input label="Minimum minutes between messages" type="number" min={0} value={f.min_gap_s / 60} onChange={(e) => set("min_gap_s", Number(e.target.value) * 60)} hint="Events during the gap are grouped into the next message." />}
      {f.schedule !== "instant" && <Input label="Hour" type="number" min={0} max={23} value={f.hour} onChange={(e) => set("hour", Number(e.target.value))} />}
      {f.schedule === "weekly" && <Select label="Day" value={String(f.day)} onChange={(e) => set("day", Number(e.target.value))} options={DAYS.map((d, i) => ({ value: String(i + 1), label: d }))} />}
      {f.schedule === "monthly" && <Input label="Day of month" type="number" min={1} max={28} value={f.day} onChange={(e) => set("day", Number(e.target.value))} />}
      <ErrorNote>{error}</ErrorNote>
      <div><Button variant="primary" onClick={save} disabled={!f.channel || !f.events.length}>Save</Button></div>
    </Modal>
  )
}

const describe = (r: any) =>
  r.schedule === "daily" ? `Daily at ${r.hour}:00` :
  r.schedule === "weekly" ? `${DAYS[r.day - 1] ?? "Monday"} at ${r.hour}:00` :
  r.schedule === "monthly" ? `Day ${r.day} at ${r.hour}:00` :
  `Grouped, at least ${Math.round(r.min_gap_s / 60)} min apart`

export function NotificationSettings() {
  const channels = useApi("/api/c/notif_channels?sort=name", { poll: false })
  const rules = useApi("/api/c/notif_rules?sort=name", { poll: false })
  const [channel, setChannel] = useState<any | null | undefined>()
  const [rule, setRule] = useState<any | null | undefined>()
  const [note, setNote] = useState("")
  const del = async (coll: string, id: string) => {
    if (!confirm("Delete?")) return
    await api(`/api/c/${coll}/${id}`, { method: "DELETE" })
    channels.reload(); rules.reload()
  }
  const test = async (id: string) => {
    setNote("")
    try { await api(`/api/notify/test/${id}`, { method: "POST" }); setNote("Test message sent.") } catch (e) { setNote((e as Error).message) }
  }
  return (
    <>
      <Panel title="Channels" flush>
        {channels.data?.items.length ? (
          <Table head={["Name", "Service", ""]}>
            {channels.data.items.map((c: any) => (
              <tr key={c.id}>
                <Td className="font-medium">{c.name}</Td>
                <Td mono>{c.url.split(":")[0]}</Td>
                <Td className="text-right whitespace-nowrap">
                  <Button variant="ghost" onClick={() => test(c.id)}>Test</Button>
                  <Button variant="ghost" onClick={() => setChannel(c)}>Edit</Button>
                  <IconButton label="Delete" icon={TrashIcon} onClick={() => del("notif_channels", c.id)} />
                </Td>
              </tr>
            ))}
          </Table>
        ) : <div className="px-5"><Empty>No channels yet.</Empty></div>}
        <div className="flex items-center gap-3 p-5"><Button onClick={() => setChannel(null)}><PlusIcon className="size-5" aria-hidden />Add channel</Button><span className="text-[13px] text-fg2">{note}</span></div>
      </Panel>
      <Panel title="Rules" flush>
        {rules.data?.items.length ? (
          <Table head={["Name", "Events", "Delivery", "State", ""]}>
            {rules.data.items.map((r: any) => (
              <tr key={r.id}>
                <Td className="font-medium">{r.name || "—"}</Td>
                <Td className="text-fg2">{(r.events ?? []).join(", ")}</Td>
                <Td className="text-fg2">{describe(r)}</Td>
                <Td>{r.last_error ? <span title={r.last_error}><Status level="crit" label="Failing" /></span> : <span className="text-fg3">{r.last_sent ? `Sent ${fmt.ago(r.last_sent)}` : "Never sent"}</span>}</Td>
                <Td className="text-right whitespace-nowrap">
                  <Button variant="ghost" onClick={() => setRule(r)}>Edit</Button>
                  <IconButton label="Delete" icon={TrashIcon} onClick={() => del("notif_rules", r.id)} />
                </Td>
              </tr>
            ))}
          </Table>
        ) : <div className="px-5"><Empty>No rules: nothing is sent until you add one.</Empty></div>}
        <div className="p-5"><Button disabled={!channels.data?.items.length} onClick={() => setRule(null)}><PlusIcon className="size-5" aria-hidden />Add rule</Button></div>
      </Panel>
      {channel !== undefined && <ChannelEditor row={channel} onDone={() => { setChannel(undefined); channels.reload() }} />}
      {rule !== undefined && <RuleEditor row={rule} channels={channels.data.items} onDone={() => { setRule(undefined); rules.reload() }} />}
    </>
  )
}

export function PasskeySettings() {
  const { data: status } = useApi("/api/auth/status", { poll: false })
  const list = useApi<any[]>(status?.passkeys ? "/api/auth/passkeys" : null, { poll: false })
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const add = async () => {
    setError("")
    try {
      const options = await api("/api/auth/passkey/register/start", { method: "POST" })
      const publicKey = (PublicKeyCredential as any).parseCreationOptionsFromJSON(options.publicKey)
      const cred = (await navigator.credentials.create({ publicKey })) as any
      await api("/api/auth/passkey/register/finish", { body: { name, credential: cred.toJSON() } })
      setName(""); list.reload()
    } catch (e) { setError((e as Error).message) }
  }
  return (
    <Panel title="Passkeys">
      {!status?.passkeys ? <Empty>Passkeys need HTTPS. Set an https:// NYX_PUBLIC_URL.</Empty> : (
        <div className="flex flex-col gap-4">
          {list.data?.map((k) => (
            <div key={k.id} className="flex items-center justify-between">
              <span>{k.name || "Passkey"} <span className="text-[13px] text-fg3">· {fmt.ago(k.created)}</span></span>
              <IconButton label="Delete passkey" icon={TrashIcon} onClick={async () => { await api(`/api/auth/passkeys/${k.id}`, { method: "DELETE" }); list.reload() }} />
            </div>
          ))}
          <div className="flex items-end gap-3">
            <div className="flex-1"><Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Laptop" /></div>
            <Button onClick={add} disabled={!name}>Add passkey</Button>
          </div>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Panel>
  )
}

export function McpSettings() {
  const { data: status } = useApi("/api/auth/status", { poll: false })
  const tokens = useApi("/api/c/mcp_tokens?sort=name", { poll: false })
  const [name, setName] = useState("")
  const [created, setCreated] = useState<{ token: string; url: string }>()
  const [error, setError] = useState("")
  const add = async () => {
    setError("")
    try { setCreated(await api("/api/mcp/tokens", { body: { name } })); setName(""); tokens.reload() } catch (e) { setError((e as Error).message) }
  }
  return (
    <Panel title="MCP server">
      {!status?.https ? <Empty>MCP is served over HTTPS only. Set an https:// NYX_PUBLIC_URL.</Empty> : (
        <div className="flex flex-col gap-4">
          <p className="text-fg2">Connect Claude, ChatGPT, Codex or any MCP client to <Mono>{status.public_url}/mcp</Mono> with a bearer token. Tools are read-only.</p>
          {tokens.data?.items.map((t: any) => (
            <div key={t.id} className="flex items-center justify-between">
              <span>{t.name} <span className="text-[13px] text-fg3">· used {fmt.ago(t.last_used)}</span></span>
              <IconButton label="Revoke token" icon={TrashIcon} onClick={async () => { await api(`/api/c/mcp_tokens/${t.id}`, { method: "DELETE" }); tokens.reload() }} />
            </div>
          ))}
          <div className="flex items-end gap-3">
            <div className="flex-1"><Input label="Client name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude" /></div>
            <Button onClick={add} disabled={!name}>Create token</Button>
          </div>
          {created && (
            <div className="flex flex-col gap-2">
              <p className="text-fg2">Copy this token now, it will not be shown again.</p>
              <Copy text={created.token} />
              <p className="text-[13px] text-fg3">For clients that only accept a URL: <Mono>{created.url}/{created.token}</Mono></p>
            </div>
          )}
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Panel>
  )
}

/** Small JSON-backed settings form. */
export function SettingForm({ title, setting, fields, children }: { title: string; setting: string; fields: { key: string; label: string; type?: string; hint?: string }[]; children?: React.ReactNode }) {
  const { data, reload } = useApi(`/api/settings/${setting}`, { poll: false })
  const [form, setForm] = useState<any>()
  const [note, setNote] = useState("")
  const value = form ?? data ?? {}
  const save = async () => {
    try { await api(`/api/settings/${setting}`, { method: "PUT", body: { ...data, ...value } }); setNote("Saved."); reload() } catch (e) { setNote((e as Error).message) }
  }
  return (
    <Panel title={title}>
      <div className="flex flex-col gap-4">
        {children}
        {fields.map((f) => f.type === "checkbox"
          ? <Check key={f.key} label={f.label} checked={!!value[f.key]} onChange={(e) => setForm({ ...value, [f.key]: e.target.checked })} />
          : <Input key={f.key} label={f.label} hint={f.hint} type={f.type ?? "text"} value={value[f.key] ?? ""} onChange={(e) => setForm({ ...value, [f.key]: f.type === "number" ? Number(e.target.value) : e.target.value })} />)}
        <div className="flex items-center gap-3"><Button onClick={save}>Save</Button><span className="text-[13px] text-fg2">{note}</span></div>
      </div>
    </Panel>
  )
}

/** GitHub is only contacted when the user presses Check. */
export function SystemUpdates({ agents }: { agents?: boolean }) {
  const { data } = useApi("/api/system/version", { poll: false })
  const { data: channel, reload } = useApi("/api/settings/updates", { poll: false })
  const [latest, setLatest] = useState<{ latest: string; available: boolean }>()
  const [note, setNote] = useState("")
  const setBeta = async (beta: boolean) => {
    try { await api("/api/settings/updates", { method: "PUT", body: { beta } }); setLatest(undefined); reload() } catch (e) { setNote((e as Error).message) }
  }
  const check = async () => { try { setLatest(await api("/api/system/check", { method: "POST" })); setNote("") } catch (e) { setNote((e as Error).message) } }
  const update = async () => {
    try { await api("/api/system/update", { body: { tag: latest!.latest } }); setNote("Update started. This page reconnects when it is done.") } catch (e) { setNote((e as Error).message) }
  }
  return (
    <Panel title="Software updates">
      <div className="flex flex-col gap-3">
        <p className="text-fg2">Version {data?.version ?? "—"}. {data?.managed ? "Installed from packages." : "Pull a new image to update a Docker install."}</p>
        {data?.managed && <Check label="Include beta versions" checked={!!channel?.beta} onChange={(e) => setBeta(e.target.checked)} />}
        {data?.managed && agents && <p className="text-[13px] text-fg3">Agents follow this server: they update to the version it ships.</p>}
        {latest && <p>{latest.available ? `${latest.latest} is available.` : "You are up to date."}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={check}>Check on GitHub</Button>
          {latest?.available && data?.managed && <Button variant="primary" onClick={update}>Update to {latest.latest}</Button>}
          <span className="text-[13px] text-fg2">{note}</span>
        </div>
      </div>
    </Panel>
  )
}

export function SignOut() {
  return <Button variant="danger" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); location.href = "/" }}>Sign out</Button>
}

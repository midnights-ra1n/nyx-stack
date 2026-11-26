import { ArrowDownIcon, ArrowPathIcon, ArrowUpIcon, ChevronRightIcon, DocumentTextIcon, FolderPlusIcon, GlobeAltIcon, PauseIcon, PencilSquareIcon, PlayIcon, PlusIcon, StopIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useEffect, useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { BarGauge, Button, Check, Empty, ErrorNote, IconButton, Input, Modal, Meter, Mono, Panel, RangeSelect, Select, Stat, StateCell, Status, Table, Td, Tabs, TextArea, TimeSeries, Variable, ask, SearchInput, Skeleton } from "../ui/components"
import { api, fmt, type Level, levelBg, levelSoft, levelText, useApi, useStored } from "../ui/lib"
import { Link, PageHeader, Section } from "../ui/shell"
import { uptimeBar } from "./display/model"
import { PRESETS } from "./snmp-presets"
import { VpnTable } from "./vpn"
import { t, tn } from "../ui/i18n"

/** Sends a command to a host's agent and waits for its answer, which comes with the next report. */
export async function onHost(hostId: string, body: object) {
  const { id } = await api(`/api/hosts/${hostId}/command`, { body })
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const r = (await api(`/api/hosts/${hostId}`)).results?.find((x: any) => x.id === id)
    if (r) return r as { ok: boolean; output: string }
  }
  throw new Error("The agent did not answer in time.")
}

function ContainerLogs({ c, onClose }: { c: any; onClose: () => void }) {
  const [text, setText] = useState("Waiting for the agent…")
  useEffect(() => { onHost(c.host_id, { action: "container", op: "logs", name: c.name }).then((r) => setText(r.output || "No logs."), (e) => setText((e as Error).message)) }, [])
  return <Modal title={t("{name} on {host}", { name: c.name, host: c.host })} onClose={onClose} wide><pre className="max-h-[28rem] min-h-32 overflow-auto rounded-box bg-bg p-3 font-mono text-[13px] whitespace-pre-wrap" aria-live="polite">{text}</pre></Modal>
}

const stateLevel = (c: any): Level => (c.state === "running" ? "ok" : c.state === "restarting" || /^Exited \((?!0\))/.test(c.status) ? "warn" : "off")
const VIEWS = [{ id: "table", label: "Table" }, { id: "cards", label: "Cards" }, { id: "hosts", label: "By host" }]

export function Containers() {
  const { data, reload } = useApi<any[]>("/api/containers")
  const [view, setView] = useState("table")
  const [q, setQ] = useState("")
  const [state, setState] = useState("all")
  const [logs, setLogs] = useState<any>()
  const [busy, setBusy] = useState("")
  const [note, setNote] = useState("")
  const rows = [...(data ?? [])].sort((a, b) => a.host.localeCompare(b.host) || a.name.localeCompare(b.name))
  const running = rows.filter((c) => c.state === "running").length
  const shown = rows.filter((c) => (state === "all" || (state === "running") === (c.state === "running")) && `${c.name} ${c.image} ${c.host}`.toLowerCase().includes(q.toLowerCase()))
  const act = async (c: any, op: string) => {
    if (op === "logs") return setLogs(c)
    if (op === "stop" && !await ask(`Stop ${c.name}?`, { action: "Stop", danger: true })) return
    setBusy(c.host_id + c.name); setNote("")
    try { const r = await onHost(c.host_id, { action: "container", op, name: c.name }); setNote(`${c.name}: ${r.ok ? r.output : `failed. ${r.output}`}`); reload() } catch (e) { setNote((e as Error).message) }
    setBusy("")
  }
  const actions = (c: any) => (
    <span className="whitespace-nowrap">
      {c.state === "running" ? <>
        <IconButton label={t("Restart {name}", { name: c.name })} icon={ArrowPathIcon} onClick={() => act(c, "restart")} />
        <IconButton label={t("Stop {name}", { name: c.name })} icon={StopIcon} onClick={() => act(c, "stop")} />
      </> : <IconButton label={t("Start {name}", { name: c.name })} icon={PlayIcon} onClick={() => act(c, "start")} />}
      <IconButton label={t("Logs of {name}", { name: c.name })} icon={DocumentTextIcon} onClick={() => act(c, "logs")} />
    </span>
  )
  const usage = (c: any) => (c.state === "running" ? <div className="flex min-w-28 flex-col gap-1 text-[13px]"><span>{fmt.pct(c.cpu_pct)} · {fmt.bytes(c.mem_used)}</span><Meter pct={c.mem_pct} /></div> : <span className="text-fg3">—</span>)
  const table = (list: any[], empty: string) => (list.length === 0 ? <div className="px-4 pb-4"><Empty>{empty}</Empty></div> : (
    <Table head={["Name", "Host", "Image", "CPU · memory", "Status", "State", ""]}>
      {list.map((c) => (
        <tr key={c.host_id + c.name} aria-busy={busy === c.host_id + c.name}>
          <Td mono>{c.name}</Td>
          <Td className="font-medium"><Link to={`/hosts/${c.host_id}`}>{c.host}</Link></Td>
          <Td mono>{c.image}</Td>
          <Td>{usage(c)}</Td>
          <Td className="text-fg2">{tn(c.status)}</Td>
          <StateCell level={stateLevel(c)} label={c.state} />
          <Td className="text-right">{actions(c)}</Td>
        </tr>
      ))}
    </Table>
  ))
  const card = (c: any) => (
    <li key={c.host_id + c.name} className={`flex flex-col gap-2 rounded-box border border-line p-3 ${levelSoft[stateLevel(c)]}`}>
      <div className="flex items-start justify-between gap-2"><span className="min-w-0"><span className="block truncate font-medium" title={c.name}>{c.name}</span><span className="block truncate font-mono text-xs text-fg3" title={c.image}>{c.image}</span></span><Status cell level={stateLevel(c)} label={c.state} /></div>
      {c.state === "running" && <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-[13px]"><span className="text-fg2">{t("CPU")}</span><Meter pct={Math.min(100, c.cpu_pct)} /><span className="text-fg2">{t("Memory")}</span><Meter pct={c.mem_pct} /></div>}
      <div className="flex items-center justify-between text-xs text-fg3"><span className="truncate">{tn(c.status)}</span>{actions(c)}</div>
    </li>
  )
  const top = (key: string, pick: (c: any) => number) => [...rows].filter((c) => c.state === "running").sort((a, b) => pick(b) - pick(a)).slice(0, 6).map((c) => ({ label: `${c.name} · ${c.host}`, pct: pick(c) })).filter((r) => r.pct > 0)
  const byHost = [...new Set(shown.map((c) => c.host_id))].map((id) => ({ id, name: shown.find((c) => c.host_id === id).host, list: shown.filter((c) => c.host_id === id) }))
  const body = view === "cards" ? <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 p-4">{shown.map(card)}</ul>
    : view === "hosts" ? <div className="flex flex-col gap-4 py-4">{byHost.map((h) => <div key={h.id}><h3 className="px-4 pb-1 text-[13px] font-medium text-fg2">{h.name} · {h.list.filter((c) => c.state === "running").length} of {h.list.length} running</h3>{table(h.list, "")}</div>)}</div>
    : table(shown, rows.length ? "Nothing matches." : "No containers reported.")
  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
      <Panel title={t("Summary")} edit={edit}>
        <div className="grid grid-cols-4 gap-4 max-sm:grid-cols-2">
          <Stat label="Running" value={running} level="ok" />
          <Stat label="Not running" value={rows.length - running} level={rows.length > running ? "warn" : "ok"} />
          <Stat label="CPU used" value={fmt.pct(rows.reduce((t, c) => t + (c.cpu_pct || 0), 0))} sub="of one core, all containers" />
          <Stat label="Memory used" value={fmt.bytes(rows.reduce((t, c) => t + (c.mem_used || 0), 0))} sub={t("{n} hosts", { n: new Set(rows.map((c) => c.host_id)).size })} />
        </div>
      </Panel>
    ) },
    { id: "top", title: "Biggest consumers", render: (edit: any) => (
      <Panel title={t("Biggest consumers")} edit={edit}>
        <div className="grid grid-cols-2 gap-6 max-md:grid-cols-1">
          <div><h3 className="mb-2 text-[13px] font-medium text-fg2">{t("CPU (one core is 100 %)")}</h3>{top("cpu", (c) => c.cpu_pct).length ? <BarGauge rows={top("cpu", (c) => Math.min(100, c.cpu_pct))} /> : <Empty>{t("No load.")}</Empty>}</div>
          <div><h3 className="mb-2 text-[13px] font-medium text-fg2">{t("Memory (of its limit)")}</h3>{top("mem", (c) => c.mem_pct).length ? <BarGauge rows={top("mem", (c) => c.mem_pct)} /> : <Empty>{t("No data yet.")}</Empty>}</div>
        </div>
      </Panel>
    ) },
    { id: "stopped", title: "Not running", render: (edit: any) => <Panel title={t("Not running")} flush edit={edit}>{table(rows.filter((c) => c.state !== "running"), "Everything is running.")}</Panel> },
    { id: "all", title: "Docker containers", render: (edit: any) => (
      <Panel title={t("Docker containers")} flush edit={edit}>
        <div className="flex flex-wrap items-center gap-3 px-4 pb-3">
          <Tabs tabs={VIEWS} value={view} onChange={setView} />
          <SearchInput placeholder="Name or image" value={q} onChange={(e) => setQ(e.target.value)} />
          <Variable label="Show" value={state} onChange={setState} options={[{ value: "all", label: "All" }, { value: "running", label: "Running" }, { value: "stopped", label: "Not running" }]} />
        </div>
        {note && <p role="status" className="px-4 pb-3 text-fg2">{note}</p>}
        {body}
      </Panel>
    ) },
  ]
  return (
    <>
      <PageHeader title={t("Containers")} subtitle={t("{n} of {total} running", { n: running, total: rows.length })} onRefresh={reload} actions={<CustomizeButton />} />
      <Board id="containers" panels={panels} desktop={{ cols: [["summary", "top", "all"]], hidden: ["stopped"] }} phone={{ cols: [["summary", "all"]], hidden: ["stopped", "top"] }} />
      {logs && <ContainerLogs c={logs} onClose={() => setLogs(undefined)} />}
    </>
  )
}

const PROBE_TYPES = [
  { value: "ping", label: "Ping (ICMP)" }, { value: "http", label: "Website (HTTP)" }, { value: "dns", label: "DNS server" },
  { value: "cert", label: "HTTPS certificate" }, { value: "snmp", label: "SNMP device" },
]
const TARGET_HINT: Record<string, string> = {
  ping: "Host name or IP address.", http: "Full URL.", dns: "Name to resolve.", cert: "Host or URL.", snmp: "Host or IP, with :port if it is not 161.",
}

function ProbeForm({ row, cats, category = "", onDone }: { row: any | null; cats: any[]; category?: string; onDone: () => void }) {
  const [f, setF] = useState<any>(row ?? { name: "", type: "ping", target: "", interval_s: 60, enabled: true, dns_server: "", expect_status: 0, warn_days: 21, category })
  const [snmp, setSnmp] = useState<any>(row?.snmp?.items ? row.snmp : { version: "v2c", community: "public", items: PRESETS["Generic device"] })
  const [items, setItems] = useState(JSON.stringify(snmp.items, null, 2))
  const [error, setError] = useState("")
  const set = (k: string, v: any) => setF({ ...f, [k]: v })
  const s = (k: string, v: any) => setSnmp({ ...snmp, [k]: v })
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const body = { ...f, snmp: f.type === "snmp" ? { ...snmp, items: JSON.parse(items) } : null }
      await api(row ? `/api/c/probes/${row.id}` : "/api/c/probes", { method: row ? "PATCH" : "POST", body })
      onDone()
    } catch (err) { setError(err instanceof SyntaxError ? "Values to read must be valid JSON." : (err as Error).message) }
  }
  return (
    <Modal title={row ? "Edit probe" : "Add probe"} onClose={onDone}>
      <form className="flex flex-col gap-4" onSubmit={save}>
        <Input label="Name" required value={f.name} onChange={(e) => set("name", e.target.value)} />
        <Select label="Type" value={f.type} onChange={(e) => set("type", e.target.value)} options={PROBE_TYPES} />
        <Input label="Target" required value={f.target} hint={TARGET_HINT[f.type]} onChange={(e) => set("target", e.target.value)} />
        {cats.length > 0 && <Select label="Category" value={f.category ?? ""} onChange={(e) => set("category", e.target.value)} options={[{ value: "", label: t("No category") }, ...cats.map((c) => ({ value: c.id, label: c.name }))]} />}
        <Input label="Interval (seconds)" type="number" min={10} value={f.interval_s} onChange={(e) => set("interval_s", Number(e.target.value))} />
        {f.type === "dns" && <Input label="DNS server" value={f.dns_server} hint="IP to query. Empty uses the DNS for probes from Settings, or the system's resolver." onChange={(e) => set("dns_server", e.target.value)} />}
        {(f.type === "ping" || f.type === "http") && <Input label="DNS server" value={f.dns_server} placeholder={t("The DNS for probes from Settings")} hint="IP that resolves the host name, for example 1.1.1.1 so the checks stay out of a local NextDNS or Pi-hole log." onChange={(e) => set("dns_server", e.target.value)} />}
        {f.type === "http" && <Input label="Expected status" type="number" value={f.expect_status || ""} hint="Empty accepts any 2xx or 3xx." onChange={(e) => set("expect_status", Number(e.target.value))} />}
        {(f.type === "cert" || (f.type === "http" && f.target.startsWith("https://"))) && <Input label="Warn this many days before the certificate expires" type="number" value={f.warn_days} onChange={(e) => set("warn_days", Number(e.target.value))} />}
        {f.type === "snmp" && <>
          <Select label="Equipment" value="" options={[{ value: "", label: "Load a profile…" }, ...Object.keys(PRESETS).map((p) => ({ value: p, label: p }))]} onChange={(e) => e.target.value && setItems(JSON.stringify(PRESETS[e.target.value], null, 2))} />
          <Select label="Version" value={snmp.version} onChange={(e) => s("version", e.target.value)} options={["v2c", "v3", "v1"]} />
          {snmp.version !== "v3" ? <Input label="Community" value={snmp.community} onChange={(e) => s("community", e.target.value)} /> : <>
            <Input label="User" required value={snmp.user ?? ""} onChange={(e) => s("user", e.target.value)} />
            <Select label="Authentication" value={snmp.auth_proto ?? "sha1"} onChange={(e) => s("auth_proto", e.target.value)} options={["sha1", "sha256", "sha512", "md5"]} />
            <Input label="Authentication password" type="password" value={snmp.auth_pass ?? ""} onChange={(e) => s("auth_pass", e.target.value)} />
            <Select label="Encryption" value={snmp.priv_proto ?? ""} onChange={(e) => s("priv_proto", e.target.value)} options={[{ value: "", label: "None" }, "aes128", "aes192", "aes256", "des"].map((o) => (typeof o === "string" ? { value: o, label: o } : o))} />
            {snmp.priv_proto && <Input label="Encryption password" type="password" value={snmp.priv_pass ?? ""} onChange={(e) => s("priv_pass", e.target.value)} />}
          </>}
          <TextArea label="Values to read" rows={10} value={items} onChange={(e) => setItems(e.target.value)} hint="Each entry has an oid and a label. Options: unit, walk with agg (sum, min, max, avg, count), matches, rate, scale, warn, crit, low, expect." />
        </>}
        <Check label="Enabled" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        <ErrorNote>{error}</ErrorNote>
        <div><Button variant="primary" type="submit">{t("Save")}</Button></div>
      </form>
    </Modal>
  )
}

const DNS_TYPES = ["ping", "http"]
/** Loose check, the monitor rejects the rest when it resolves. */
export const looksLikeIp = (s: string) => /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]*:[0-9a-f:]*$/i.test(s)

/** Sets the DNS server of one or many ping and website probes at once. */
function ProbeDns({ defs, onDone }: { defs: any[]; onDone: () => void }) {
  const probes = defs.filter((d) => DNS_TYPES.includes(d.type))
  const fallback = useApi("/api/settings/probe_dns", { poll: false }).data?.servers || "the system's resolver"
  const [dns, setDns] = useState("")
  const [picked, setPicked] = useState(new Set<string>())
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const toggle = (id: string) => { const s = new Set(picked); s.has(id) ? s.delete(id) : s.add(id); setPicked(s) }
  const apply = async (e: React.FormEvent) => {
    e.preventDefault()
    const server = dns.trim()
    if (server && !looksLikeIp(server)) return setError("The DNS server must be one IP address.")
    setBusy(true)
    try { await Promise.all([...picked].map((id) => api(`/api/c/probes/${id}`, { method: "PATCH", body: { dns_server: server } }))); onDone() }
    catch (err) { setError((err as Error).message); setBusy(false) }
  }
  return (
    <Modal title={t("Probe DNS")} onClose={onDone} wide>
      <form className="flex flex-col gap-4" onSubmit={apply}>
        <Input label="DNS server" value={dns} onChange={(e) => setDns(e.target.value)} placeholder={t("DNS for probes: {fallback}", { fallback })} hint="One IP, for example 1.1.1.1. Empty goes back to the DNS for probes from Settings." />
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[13px] text-fg2">Ping and website probes · {picked.size} of {probes.length}</legend>
          <div className="flex gap-3 text-[13px]">
            <button type="button" className="text-accent" onClick={() => setPicked(new Set(probes.map((d) => d.id)))}>{t("All")}</button>
            {DNS_TYPES.map((type) => <button key={type} type="button" className="text-accent" onClick={() => setPicked(new Set(probes.filter((d) => d.type === type).map((d) => d.id)))}>{t("{type} only", { type: TYPE_LABEL[type] })}</button>)}
            <button type="button" className="text-accent" onClick={() => setPicked(new Set())}>{t("None")}</button>
          </div>
          {probes.length === 0 ? <Empty>{t("No ping or website probe yet.")}</Empty> : (
            <div className="grid max-h-72 grid-cols-2 overflow-y-auto max-sm:grid-cols-1">
              {probes.map((d) => <Check key={d.id} label={`${d.name} · ${TYPE_LABEL[d.type]}`} hint={d.dns_server || t("DNS for probes ({fallback})", { fallback })} checked={picked.has(d.id)} onChange={() => toggle(d.id)} />)}
            </div>
          )}
        </fieldset>
        <ErrorNote>{error}</ErrorNote>
        <div><Button variant="primary" type="submit" disabled={!picked.size || busy}>{t("Apply to {n} probes", { n: picked.size })}</Button></div>
      </form>
    </Modal>
  )
}

/** Down first, then warnings, as on Uptime Kuma: what needs a look sits on top. */
const RANK: Record<Level, number> = { crit: 0, warn: 1, info: 2, ok: 3, off: 4 }
const TYPE_LABEL: Record<string, string> = { ping: "Ping", http: "HTTP", dns: "DNS", cert: "Certificate", snmp: "SNMP" }

export function probeLevel(p: any, enabled = true): Level {
  if (!enabled || p?.up == null) return "off"
  if (!p.up || p.readings.some((r: any) => r.level === "crit")) return "crit"
  return p.readings.some((r: any) => r.level === "warn") || (p.cert_days != null && p.cert_days <= p.warn_days) ? "warn" : "ok"
}

/** Share of the recent checks that passed, `null` before the first one. */
export const recentUptime = (history: boolean[] = []) => (history.length ? (history.filter(Boolean).length * 100) / history.length : null)

const pct = (v: number | null | undefined, digits = 2) => (v == null ? "—" : `${v >= 99.995 ? 100 : fmt.num(v, digits, 0)} %`)
const uptimeLevel = (v: number | null | undefined): Level => (v == null ? "off" : v >= 99.9 ? "ok" : v >= 95 ? "warn" : "crit")

/** One bar per check, newest on the right; empty slots on the left until there are enough. */
function Heartbeats({ values = [], count = 40, tall }: { values?: boolean[]; count?: number; tall?: boolean }) {
  const last = values.slice(-count)
  const slots = [...Array(count - last.length).fill(null), ...last]
  return (
    <span className={`flex ${tall ? "h-8" : "h-4"} w-full items-stretch gap-[2px]`} role="img" aria-label={t("{v0} of {n} recent checks up", { v0: last.filter(Boolean).length, n: last.length })}>
      {slots.map((v, i) => <span key={i} title={v == null ? undefined : `${count - 1 - i === 0 ? t("Latest check") : t("{n} checks ago", { n: count - 1 - i })}: ${t(v ? "up" : "down")}`} className={`min-w-0 flex-1 rounded-full ${v == null ? "bg-raised" : v ? "bg-ok" : "bg-crit"}`} />)}
    </span>
  )
}

function UptimePill({ value, level }: { value: number | null; level: Level }) {
  return <span className={`inline-flex w-[4.5rem] shrink-0 justify-center rounded-full px-2 py-0.5 text-[13px] font-medium ${levelSoft[level]} ${levelText[level]}`}>{value == null ? "—" : `${value >= 99.995 ? 100 : fmt.num(value, value >= 99 ? 1 : 0)} %`}</span>
}

/** The selected probe, Uptime Kuma style: state, recent beats, figures and the response chart. */
function ProbeView({ def, probe, onEdit, onToggle, onDelete }: { def: any; probe?: any; onEdit: () => void; onToggle: () => void; onDelete: () => void }) {
  const numeric = probe?.readings.filter((r: any) => r.value != null) ?? []
  const [metric, setMetric] = useState("")
  const [range, setRange] = useState("24h")
  const { data } = useApi<any[]>(probe ? `/api/probes/${probe.id}/series?range=${range}&metric=${encodeURIComponent(metric)}` : null)
  const unit = metric ? numeric.find((r: any) => r.label === metric)?.unit ?? "" : "ms"
  const values = (data ?? []).map((p) => ({ t: p.t, v: p.v }))
  const top = Math.max(1, ...values.map((p) => p.v)) * 1.1
  const avg = !metric && values.length ? values.reduce((t, p) => t + p.v, 0) / values.length : null
  const level = probeLevel(probe, def.enabled)
  const recent = recentUptime(probe?.history)
  const days: (number | null)[] = probe?.days ?? []
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-medium">{def.name}</h2>
          <p className="truncate text-fg2"><span className="mr-2 rounded-full bg-raised px-2 py-0.5 text-xs text-fg2">{TYPE_LABEL[def.type] ?? def.type}</span>{def.type === "http" ? <a className="font-mono text-accent" href={def.target} target="_blank" rel="noreferrer">{def.target}</a> : <Mono>{def.target}</Mono>}</p>
        </div>
        <div className="flex items-center gap-1">
          <Status level={level} label={!def.enabled ? "Paused" : probe?.up == null ? "Pending" : probe.up ? "Up" : "Down"} />
          <IconButton label={def.enabled ? "Pause" : "Resume"} icon={def.enabled ? PauseIcon : PlayIcon} onClick={onToggle} />
          <IconButton label="Edit" icon={PencilSquareIcon} onClick={onEdit} />
          <IconButton label="Delete" icon={TrashIcon} onClick={onDelete} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Heartbeats values={probe?.history} count={60} tall />
        <div className="flex justify-between gap-4 text-xs text-fg3"><span className="shrink-0">{probe?.interval_s ? t("Every {n} s", { n: probe.interval_s }) : ""}</span><span className="min-w-0 text-right break-words">{def.enabled && probe?.message}</span></div>
      </div>
      <div className="grid grid-cols-5 gap-4 max-lg:grid-cols-3 max-sm:grid-cols-2">
        <Stat label="Response" value={probe?.up ? `${probe.latency_ms.toFixed(0)} ms` : "—"} sub="Current" />
        <Stat label="Average response" value={avg == null ? "—" : `${avg.toFixed(0)} ms`} sub={range} />
        <Stat label="Uptime" value={pct(recent)} level={recent == null ? undefined : uptimeLevel(recent)} sub={probe?.history.length === 1 ? t("Last check") : t("Last {n} checks", { n: probe?.history.length ?? 0 })} />
        <Stat label="Uptime" value={pct(probe?.uptime_30d)} level={probe?.uptime_30d == null ? undefined : uptimeLevel(probe.uptime_30d)} sub="30 days" />
        {probe?.cert_days != null && <Stat label="Certificate" value={probe.cert_days < 0 ? t("Expired") : `${probe.cert_days} ${t("d")}`} level={probe.cert_days <= 7 ? "crit" : probe.cert_days <= probe.warn_days ? "warn" : "ok"} sub="Until it expires" />}
      </div>
      {days.some((d) => d != null) && (
        <div className="flex flex-col gap-1">
          <span className="flex h-8 items-stretch gap-[2px]" role="img" aria-label={t("Uptime of each of the last 30 days")}>
            {days.map((d, i) => <span key={i} title={`${days.length - 1 - i === 0 ? t("Today") : t("{v0} days ago", { v0: days.length - 1 - i })}: ${d == null ? t("no data") : `${d} %`}`} className={`min-w-0 flex-1 rounded-sm ${uptimeBar(d)}`} />)}
          </span>
          <div className="flex justify-between text-xs text-fg3"><span>{t("30 days ago")}</span><span>{t("Today")}</span></div>
        </div>
      )}
      {probe?.readings.length > 0 && (
        <ul className="divide-y divide-line">
          {probe.readings.map((r: any) => (
            <li key={r.label} className="flex min-h-9 max-sm:min-h-11 items-center justify-between gap-3">
              <span className="text-fg2">{r.label}</span>
              {r.level === "ok" ? <span className="text-right font-medium">{r.value != null ? `${fmt.num(r.value, 2, 0)} ${r.unit}` : r.text || "—"}</span> : <Status level={r.level} label={`${fmt.num(r.value, 2, 0)} ${r.unit}`} />}
            </li>
          ))}
        </ul>
      )}
      {probe && <>
        <div className="flex flex-wrap gap-3">
          <RangeSelect value={range} onChange={setRange} />
          {numeric.length > 0 && <Variable label="Value" value={metric} onChange={setMetric} options={[{ value: "", label: "Response time" }, ...numeric.map((r: any) => ({ value: r.label, label: r.label }))]} />}
        </div>
        <TimeSeries series={[{ name: metric || "Response time", color: "var(--color-s1)", values }]} max={+top.toPrecision(2)} unit={` ${unit}`} />
      </>}
    </div>
  )
}

const SHOW = [{ value: "", label: "All" }, { value: "crit", label: "Down" }, { value: "warn", label: "Warning" }, { value: "ok", label: "Up" }, { value: "off", label: "Paused or pending" }]
const WORD: Record<Level, string> = { crit: "Down", warn: "Warning", info: "Info", ok: "Up", off: "Paused or pending" }
const DRAG = "text/nyx-probe"

/** The probes in their categories, one line each, Uptime Kuma style. Drag a probe onto a category to move it there. */
function ProbeList({ rows, cats, current, onPick, onAdd, reload }: { rows: any[]; cats: any[]; current?: string; onPick: (id: string) => void; onAdd: (category: string) => void; reload: () => void }) {
  const [q, setQ] = useState("")
  const [show, setShow] = useState("")
  const [closed, setClosed] = useStored<string[]>("nyx.network.closed", [])
  const [renaming, setRenaming] = useState("")
  const [over, setOver] = useState<string | null>(null)
  const [error, setError] = useState("")
  const run = async (f: () => Promise<unknown>) => { setError(""); try { await f() } catch (e) { setError((e as Error).message) } reload() }
  const filtered = !!q || !!show
  const shown = rows.filter((r) => (!show || r.level === show) && `${r.d.name} ${r.d.target}`.toLowerCase().includes(q.toLowerCase()))
  const known = (id: string) => cats.some((c) => c.id === id)
  const groups = [...cats.map((c) => ({ id: c.id, c, rows: shown.filter((r) => r.d.category === c.id) })), { id: "", c: null as any, rows: shown.filter((r) => !known(r.d.category)) }]
    .filter((g) => g.rows.length || (g.c && !filtered))
  const move = (probe: string, category: string) => run(() => api(`/api/c/probes/${probe}`, { method: "PATCH", body: { category } }))
  const addCategory = () => run(async () => {
    const made = await api("/api/c/probe_categories", { body: { name: t("New category"), position: cats.length } })
    setRenaming(made.id)
  })
  const rename = (c: any, name: string) => { setRenaming(""); if (name.trim() && name.trim() !== c.name) run(() => api(`/api/c/probe_categories/${c.id}`, { method: "PATCH", body: { name: name.trim() } })) }
  // Positions are rewritten from the new order, so gaps and ties from older edits go away.
  const shift = (i: number, by: number) => run(async () => {
    const order = [...cats]
    ;[order[i], order[i + by]] = [order[i + by], order[i]]
    await Promise.all(order.map((c, n) => c.position !== n && api(`/api/c/probe_categories/${c.id}`, { method: "PATCH", body: { position: n } })))
  })
  const remove = async (c: any) => {
    if (!(await ask(t("Delete the category {name}? Its probes stay, out of any category.", { name: c.name }), { action: "Delete", danger: true }))) return
    run(async () => {
      await Promise.all(rows.filter((r) => r.d.category === c.id).map((r) => api(`/api/c/probes/${r.d.id}`, { method: "PATCH", body: { category: "" } })))
      await api(`/api/c/probe_categories/${c.id}`, { method: "DELETE" })
    })
  }
  const toggle = (id: string) => setClosed(closed.includes(id) ? closed.filter((x) => x !== id) : [...closed, id])
  const line = ({ d, p, level }: any) => {
    const up = d.enabled ? recentUptime(p?.history) : null
    return (
      <li key={d.id}>
        <button type="button" draggable onDragStart={(e) => { e.dataTransfer.setData(DRAG, d.id); e.dataTransfer.effectAllowed = "move" }} aria-current={current === d.id} onClick={() => onPick(d.id)}
          className={`flex h-9 max-sm:h-11 w-full min-w-0 items-center gap-2.5 border-l-2 pl-3.5 pr-3 text-left text-[13px] hover:bg-raised ${current === d.id ? "border-accent bg-raised" : "border-transparent"}`}>
          <span className={`size-2 shrink-0 rounded-full ${levelBg[level as Level]}`} aria-hidden /><span className="sr-only">{t(WORD[level as Level])}</span>
          <span className="min-w-0 flex-1 truncate"><span className="font-medium">{d.name}</span> <span className="font-mono text-xs text-fg3">{d.target}</span></span>
          <span className="w-12 shrink-0 text-right text-xs tabular-nums text-fg2">{d.enabled && p?.up ? `${fmt.num(p.latency_ms, 0)} ms` : "—"}</span>
          <span className={`w-12 shrink-0 text-right text-xs tabular-nums ${up == null ? "text-fg3" : levelText[uptimeLevel(up)]}`}>{pct(up, 1)}</span>
          <span className="w-24 shrink-0 max-sm:hidden"><Heartbeats values={p?.history} count={24} /></span>
        </button>
      </li>
    )
  }
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <SearchInput className="min-w-32 flex-1" placeholder="Name or target" value={q} onChange={(e) => setQ(e.target.value)} />
        <Variable label="Show" value={show} onChange={setShow} options={SHOW} />
        <IconButton label="New category" icon={FolderPlusIcon} onClick={addCategory} />
      </div>
      <ErrorNote>{error}</ErrorNote>
      {groups.length === 0 ? <div className="p-4"><Empty>{t("No probe matches.")}</Empty></div> : (
        <ul className="max-h-[70vh] overflow-y-auto max-lg:max-h-[50vh]">
          {groups.map((g) => {
            const open = filtered || !closed.includes(g.id || "none")
            const down = g.rows.filter((r) => r.level === "crit").length
            const warn = g.rows.filter((r) => r.level === "warn").length
            const i = cats.indexOf(g.c)
            return (
              <li key={g.id || "none"} className={over === g.id ? "bg-accent-soft" : ""}
                onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG)) { e.preventDefault(); setOver(g.id) } }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null) }}
                onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData(DRAG); if (id && rows.find((r) => r.d.id === id)?.d.category !== g.id) move(id, g.id) }}>
                {(cats.length > 0 || g.c) && (
                  <div className="group/cat flex h-9 items-center gap-1 border-b border-line bg-raised/40 pl-2 pr-1 text-[13px]">
                    {g.c && renaming === g.id ? (
                      <input autoFocus aria-label={t("Name")} defaultValue={g.c.name} className="h-7 min-w-0 flex-1 rounded-control border border-accent bg-bg px-2" onFocus={(e) => e.target.select()}
                        onBlur={(e) => rename(g.c, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenaming("") }} />
                    ) : (
                      <button type="button" aria-expanded={open} disabled={filtered} onClick={() => toggle(g.id || "none")} className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left">
                        <ChevronRightIcon className={`size-4 shrink-0 text-fg3 ${open ? "rotate-90" : ""}`} aria-hidden />
                        <span className="truncate font-medium">{g.c?.name ?? t("No category")}</span>
                        <span className="shrink-0 text-xs text-fg3">{g.rows.length}</span>
                        {down > 0 && <span className="shrink-0 rounded-full bg-crit-soft px-1.5 text-xs text-crit">{t("{n} down", { n: down })}</span>}
                        {warn > 0 && <span className="shrink-0 rounded-full bg-warn-soft px-1.5 text-xs text-warn">{t("{n} warning", { n: warn })}</span>}
                      </button>
                    )}
                    <span className="flex shrink-0 opacity-0 group-hover/cat:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                      <IconButton label="Add probe" icon={PlusIcon} onClick={() => onAdd(g.id)} />
                      {g.c && <>
                        <IconButton label="Rename" icon={PencilSquareIcon} onClick={() => setRenaming(g.id)} />
                        <IconButton label="Move up" icon={ArrowUpIcon} disabled={i === 0} onClick={() => shift(i, -1)} />
                        <IconButton label="Move down" icon={ArrowDownIcon} disabled={i === cats.length - 1} onClick={() => shift(i, 1)} />
                        <IconButton label="Delete" icon={TrashIcon} onClick={() => remove(g.c)} />
                      </>}
                    </span>
                  </div>
                )}
                {open && (g.rows.length ? <ul className="divide-y divide-line/60 border-b border-line">{g.rows.map(line)}</ul>
                  : <p className="border-b border-line px-4 py-2 text-xs text-fg3">{t("Empty. Drag a probe here, or pick this category in its form.")}</p>)}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function Network() {
  const live = useApi<any[]>("/api/probes")
  const defs = useApi("/api/c/probes?sort=name&perPage=500", { poll: false })
  const categories = useApi("/api/c/probe_categories?sort=position,name&perPage=200", { poll: false })
  const hosts = useApi<any[]>("/api/hosts")
  const tunnels = hosts.data?.flatMap((host) => (host.vpn ?? []).map((v: any) => ({ ...v, host }))) ?? []
  const cats: any[] = categories.data?.items ?? []
  const [edit, setEdit] = useState<any | null | undefined>()
  const [addTo, setAddTo] = useState("")
  const [picked, setPicked] = useState<string>()
  const [dnsOpen, setDnsOpen] = useState(false)
  const done = async () => { setEdit(undefined); setDnsOpen(false); await api("/api/probes/reload", { method: "POST" }); defs.reload(); live.reload() }
  const state = (id: string) => live.data?.find((p) => p.id === id)
  const rows = (defs.data?.items ?? []).map((d: any) => ({ d, p: state(d.id), level: probeLevel(state(d.id), d.enabled) }))
    .sort((a: any, b: any) => RANK[a.level as Level] - RANK[b.level as Level] || a.d.name.localeCompare(b.d.name))
  const current = rows.find((r: any) => r.d.id === picked) ?? rows[0]
  const count = (l: Level) => rows.filter((r: any) => r.level === l).length
  const paused = rows.filter((r: any) => !r.d.enabled).length
  const latencies = live.data?.filter((p) => p.up).map((p) => p.latency_ms) ?? []
  const certs = live.data?.filter((p) => p.cert_days != null).sort((a, b) => a.cert_days - b.cert_days) ?? []
  const toggle = async (d: any) => { await api(`/api/c/probes/${d.id}`, { method: "PATCH", body: { enabled: !d.enabled } }); done() }
  const remove = async (d: any) => { if (await ask(`Delete ${d.name}?`, { action: "Delete", danger: true })) { await api(`/api/c/probes/${d.id}`, { method: "DELETE" }); setPicked(undefined); done() } }
  const add = (category: string) => { setAddTo(category); setEdit(null) }
  const figure = (label: string, value: React.ReactNode, level?: Level, sub?: string) => (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className={`text-xl font-medium tabular-nums ${level ? levelText[level] : ""}`}>{value}</span>
      <span className="text-[13px] text-fg2">{t(label)}{sub && <span className="text-fg3"> · {sub}</span>}</span>
    </div>
  )
  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
      <Panel title={t("Summary")} edit={edit}>
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          {figure("Up", count("ok"), "ok")}
          {figure("Down", count("crit"), count("crit") ? "crit" : undefined)}
          {figure("Warning", count("warn"), count("warn") ? "warn" : undefined)}
          {figure("Paused", paused, undefined, count("off") > paused ? t("{n} pending", { n: count("off") - paused }) : undefined)}
          {figure("Average response", latencies.length ? `${fmt.num(latencies.reduce((a, b) => a + b) / latencies.length, 0)} ms` : "—")}
          {certs[0] && figure("Next certificate", `${certs[0].cert_days} ${t("d")}`, certs[0].cert_days <= certs[0].warn_days ? "warn" : undefined, certs[0].name)}
        </div>
      </Panel>
    ) },
    { id: "probes", title: "Probes", render: (edit: any) => (
      <Panel title={t("Probes")} flush edit={edit}>
        {!defs.data ? <div className="p-4"><Skeleton lines={8} /></div> : rows.length === 0 && !cats.length ? <div className="p-4"><Empty>{t("No probes yet. Add one to watch a host, a website, a DNS server or a certificate.")}</Empty></div> : (
          <div data-flush className="grid grid-cols-[minmax(22rem,5fr)_6fr] max-lg:grid-cols-1">
            <div className="min-w-0 border-r border-line max-lg:border-r-0 max-lg:border-b">
              <ProbeList rows={rows} cats={cats} current={current?.d.id} onPick={setPicked} onAdd={add} reload={() => { defs.reload(); categories.reload() }} />
            </div>
            <div className="min-w-0 p-4">{current && <ProbeView key={current.d.id} def={current.d} probe={current.p} onEdit={() => setEdit(current.d)} onToggle={() => toggle(current.d)} onDelete={() => remove(current.d)} />}</div>
          </div>
        )}
      </Panel>
    ) },
    { id: "vpn", title: "VPN links", absent: !tunnels.length, render: (edit: any) => (
      <Panel title={t("VPN links")} flush edit={edit}><VpnTable rows={tunnels} /></Panel>
    ) },
    { id: "certs", title: "Certificates", render: (edit: any) => (
      <Panel title={t("Certificates")} edit={edit}>
        {certs.length ? <ul className="divide-y divide-line">{certs.map((c) => <li key={c.id} className="flex justify-between py-2"><span>{c.name}</span><span className={c.cert_days <= c.warn_days ? "text-warn" : "text-fg2"}>{t("{n} days left", { n: c.cert_days })}</span></li>)}</ul> : <Empty>{t("No HTTPS certificates followed.")}</Empty>}
      </Panel>
    ) },
  ]
  return (
    <>
      <PageHeader title={t("Network")} subtitle="Ping, website, DNS, certificate and SNMP probes" onRefresh={live.reload} actions={<><CustomizeButton /><Button onClick={() => setDnsOpen(true)}><GlobeAltIcon className="size-5" aria-hidden />{t("Probe DNS")}</Button><Button variant="primary" onClick={() => add("")}><PlusIcon className="size-5" aria-hidden />{t("Add probe")}</Button></>} />
      <Board id="network" panels={panels} desktop={{ cols: [["summary", "probes", "vpn"]], hidden: ["certs"] }} phone={{ cols: [["summary", "probes", "vpn"]], hidden: ["certs"] }} />
      {edit !== undefined && <ProbeForm row={edit} cats={cats} category={addTo} onDone={done} />}
      {dnsOpen && <ProbeDns defs={defs.data?.items ?? []} onDone={done} />}
    </>
  )
}

export function Alerts() {
  const open = useApi("/api/c/alerts?filter=open%3Dtrue&sort=-created&perPage=200")
  const past = useApi("/api/c/alerts?filter=open%3Dfalse&sort=-resolved_at&perPage=50")
  const row = (a: any, resolved: boolean) => (
    <tr key={a.id}>
      <Td>{tn(a.message)}</Td>
      <Td className="text-fg2">{a.host || "—"}</Td>
      <Td className="text-fg2">{fmt.ago(resolved ? a.resolved_at : a.created)}</Td>
      <StateCell level={resolved ? "ok" : a.severity} label={resolved ? "Resolved" : undefined} />
    </tr>
  )
  const panels = [
    { id: "open", title: "Open", render: (edit: any) => (
      <Panel title={t("Open")} flush edit={edit}>
        {open.data?.items.length ? <Table head={["Alert", "Host", "Since", "State"]}>{open.data.items.map((a: any) => row(a, false))}</Table> : <div className="px-4 pb-4"><Empty>{t("Nothing is wrong.")}</Empty></div>}
      </Panel>
    ) },
    { id: "resolved", title: "Resolved", render: (edit: any) => (
      <Panel title={t("Resolved")} flush edit={edit}>
        {past.data?.items.length ? <Table head={["Alert", "Host", "Resolved", "State"]}>{past.data.items.map((a: any) => row(a, true))}</Table> : <div className="px-4 pb-4"><Empty>{t("No history yet.")}</Empty></div>}
      </Panel>
    ) },
  ]
  return (
    <>
      <PageHeader title={t("Alerts")} subtitle={t("{n} open", { n: open.data?.items.length ?? 0 })} onRefresh={open.reload} actions={<CustomizeButton />} />
      <Board id="alerts" panels={panels} desktop={{ cols: [["open", "resolved"]], hidden: [] }} phone={{ cols: [["open", "resolved"]], hidden: [] }} />
    </>
  )
}

export function SearchPage() {
  const initial = new URLSearchParams(location.search).get("q") ?? ""
  const [q, setQ] = useState(initial)
  const { data: hosts } = useApi<any[]>("/api/hosts", { poll: false })
  const { data: containers } = useApi<any[]>("/api/containers", { poll: false })
  const n = q.toLowerCase()
  const hit = (...v: (string | undefined)[]) => !!n && v.some((s) => s?.toLowerCase().includes(n))
  const hs = hosts?.filter((h) => hit(h.name, h.ip, h.hostname)) ?? []
  const cs = containers?.filter((c) => hit(c.name, c.image)) ?? []
  return (
    <>
      <PageHeader title={t("Search")} />
      <Section>
        <Input label="Search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
        <Panel title={t("Results")}>
          {hs.length + cs.length === 0 ? <Empty>{n ? "No results." : "Type a host, address or container."}</Empty> : (
            <ul className="flex flex-col gap-2">
              {hs.map((h) => <li key={h.id}><Link className="text-accent" to={`/hosts/${h.id}`}>{h.name}</Link> <Mono className="text-fg3">{h.ip}</Mono> <Status cell level={h.status} label="" /></li>)}
              {cs.map((c) => <li key={c.host_id + c.name}><Link className="text-accent" to={`/hosts/${c.host_id}`}>{c.name}</Link> <span className="text-fg3">on {c.host}</span></li>)}
            </ul>
          )}
        </Panel>
      </Section>
    </>
  )
}

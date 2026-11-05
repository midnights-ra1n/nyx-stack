import { PlusIcon, TrashIcon, PencilSquareIcon } from "@heroicons/react/24/outline"
import { useEffect, useState } from "react"
import { Button, Check, Empty, ErrorNote, IconButton, Input, Meter, Modal, Mono, Panel, RangeSelect, Select, StateCell, Status, Table, Td, TextArea, TimeSeries, Variable } from "../ui/components"
import { api, fmt, type Level, levelOf, useApi } from "../ui/lib"
import { Link, PageHeader, Section } from "../ui/shell"
import { PRESETS } from "./snmp-presets"

export function Containers() {
  const { data, reload } = useApi<any[]>("/api/containers")
  const rows = [...(data ?? [])].sort((a, b) => a.host.localeCompare(b.host) || a.name.localeCompare(b.name))
  return (
    <>
      <PageHeader title="Containers" subtitle={`${rows.filter((c) => c.state === "running").length} of ${rows.length} running`} onRefresh={reload} />
      <Panel title="Docker containers" flush>
        {rows.length === 0 ? <div className="px-5 pb-5"><Empty>No containers reported.</Empty></div> : (
          <Table head={["Name", "Host", "Image", "Status", "State"]}>
            {rows.map((c) => (
              <tr key={c.host_id + c.name}>
                <Td mono>{c.name}</Td>
                <Td className="font-medium"><Link to={`/hosts/${c.host_id}`}>{c.host}</Link></Td>
                <Td mono>{c.image}</Td>
                <Td className="text-fg2">{c.status}</Td>
                <StateCell level={c.state === "running" ? "ok" : c.state === "restarting" ? "warn" : "off"} label={c.state} />
              </tr>
            ))}
          </Table>
        )}
      </Panel>
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

function ProbeForm({ row, onDone }: { row: any | null; onDone: () => void }) {
  const [f, setF] = useState<any>(row ?? { name: "", type: "ping", target: "", interval_s: 60, enabled: true, dns_server: "", expect_status: 0, warn_days: 21 })
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
        <Input label="Interval (seconds)" type="number" min={10} value={f.interval_s} onChange={(e) => set("interval_s", Number(e.target.value))} />
        {f.type === "dns" && <Input label="DNS server" value={f.dns_server} hint="IP to query. Empty uses the system resolver." onChange={(e) => set("dns_server", e.target.value)} />}
        {f.type === "http" && <Input label="Expected status" type="number" value={f.expect_status || ""} hint="Empty accepts any 2xx or 3xx." onChange={(e) => set("expect_status", Number(e.target.value))} />}
        {f.type === "cert" && <Input label="Warn this many days before expiry" type="number" value={f.warn_days} onChange={(e) => set("warn_days", Number(e.target.value))} />}
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
        <div><Button variant="primary" type="submit">Save</Button></div>
      </form>
    </Modal>
  )
}

function History({ values }: { values: boolean[] }) {
  return (
    <span className="flex h-5 items-stretch gap-px" role="img" aria-label={`${values.filter(Boolean).length} of ${values.length} checks up`}>
      {values.slice(-40).map((v, i) => <span key={i} className={`w-1 rounded-[1px] ${v ? "bg-ok" : "bg-crit"}`} />)}
    </span>
  )
}

/** Latest readings and the history of one value. */
function ProbeDetail({ probe, onClose }: { probe: any; onClose: () => void }) {
  const numeric = probe.readings.filter((r: any) => r.value != null)
  const [metric, setMetric] = useState("")
  const [range, setRange] = useState("24h")
  const { data } = useApi<any[]>(`/api/probes/${probe.id}/series?range=${range}&metric=${encodeURIComponent(metric)}`)
  const unit = metric ? numeric.find((r: any) => r.label === metric)?.unit ?? "" : "ms"
  const values = (data ?? []).map((p) => ({ t: p.t, v: p.v }))
  const top = Math.max(1, ...values.map((p) => p.v)) * 1.1
  return (
    <Modal title={probe.name} onClose={onClose}>
      {probe.readings.length > 0 && (
        <ul className="divide-y divide-line">
          {probe.readings.map((r: any) => (
            <li key={r.label} className="flex min-h-11 items-center justify-between gap-3">
              <span className="text-fg2">{r.label}</span>
              {r.level === "ok" ? <span className="text-right font-medium">{r.value != null ? `${+r.value.toFixed(2)} ${r.unit}` : r.text || "—"}</span> : <Status level={r.level} label={`${+r.value.toFixed(2)} ${r.unit}`} />}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-3">
        <RangeSelect value={range} onChange={setRange} />
        {numeric.length > 0 && <Variable label="Value" value={metric} onChange={setMetric} options={[{ value: "", label: "Latency" }, ...numeric.map((r: any) => ({ value: r.label, label: r.label }))]} />}
      </div>
      <TimeSeries series={[{ name: metric || "Latency", color: "var(--color-s1)", values }]} max={+top.toPrecision(2)} unit={` ${unit}`} />
    </Modal>
  )
}

export function Network() {
  const live = useApi<any[]>("/api/probes")
  const defs = useApi("/api/c/probes?sort=name", { poll: false })
  const [edit, setEdit] = useState<any | null | undefined>()
  const [detail, setDetail] = useState<string>()
  const done = async () => { setEdit(undefined); await api("/api/probes/reload", { method: "POST" }); defs.reload(); live.reload() }
  const state = (id: string) => live.data?.find((p) => p.id === id)
  const level = (p: any): Level => (p?.up == null ? "off" : !p.up ? "crit" : p.readings.some((r: any) => r.level === "crit") ? "crit" : p.readings.some((r: any) => r.level === "warn") || (p.cert_days != null && p.cert_days <= 21) ? "warn" : "ok")
  const open = detail ? state(detail) : undefined
  return (
    <>
      <PageHeader title="Network" subtitle="Ping, website, DNS, certificate and SNMP probes" onRefresh={live.reload} actions={<Button variant="primary" onClick={() => setEdit(null)}><PlusIcon className="size-5" aria-hidden />Add probe</Button>} />
      <Panel title="Probes" flush>
        {defs.data?.items.length === 0 ? <div className="px-5 pb-5"><Empty>No probes yet.</Empty></div> : (
          <Table head={["Name", "Type", "Target", "Latency", "Result", "History", "State", ""]}>
            {defs.data?.items.map((d: any) => {
              const p = state(d.id)
              return (
                <tr key={d.id}>
                  <Td className="font-medium">{p ? <button className="min-h-11 text-left hover:text-accent" onClick={() => setDetail(d.id)}>{d.name}</button> : d.name}</Td>
                  <Td className="text-fg2">{d.type}</Td>
                  <Td mono>{d.target}</Td>
                  <Td className="text-fg2">{p?.up ? `${p.latency_ms.toFixed(0)} ms` : "—"}</Td>
                  <Td className="max-w-64 truncate text-fg2 max-sm:max-w-none max-sm:whitespace-normal">{d.enabled ? p?.message : "Disabled"}</Td>
                  <Td>{p && <History values={p.history} />}</Td>
                  <StateCell level={d.enabled ? level(p) : "off"} label={!d.enabled ? "Disabled" : p?.up == null ? "Pending" : p.up ? undefined : "Down"} />
                  <Td className="whitespace-nowrap">
                    <IconButton label="Edit" icon={PencilSquareIcon} onClick={() => setEdit(d)} />
                    <IconButton label="Delete" icon={TrashIcon} onClick={async () => { if (confirm(`Delete ${d.name}?`)) { await api(`/api/c/probes/${d.id}`, { method: "DELETE" }); done() } }} />
                  </Td>
                </tr>
              )
            })}
          </Table>
        )}
      </Panel>
      {edit !== undefined && <ProbeForm row={edit} onDone={done} />}
      {open && <ProbeDetail probe={open} onClose={() => setDetail(undefined)} />}
    </>
  )
}

export function Storage() {
  const { data, reload } = useApi("/api/storage")
  const hosts = useApi<any[]>("/api/hosts", { poll: false })
  const [host, setHost] = useState("")
  const th = data?.thresholds
  const mine = (d: any) => !host || d.host_id === host
  const disks = (data?.disks ?? []).filter(mine).sort((a: any, b: any) => b.pct - a.pct)
  const smart = (data?.smart ?? []).filter(mine)
  return (
    <>
      <PageHeader title="Storage" subtitle="Fullest file systems first" onRefresh={reload}
        variables={<Variable label="Host" value={host} onChange={setHost} options={[{ value: "", label: "All" }, ...(hosts.data ?? []).map((h) => ({ value: h.id, label: h.name }))]} />} />
      <Section>
        <Panel title="File systems" flush>
          {disks.length ? (
            <Table head={["Host", "Mount point", "Type", "Device", "Used", "Free", "Size", "Usage", "State"]}>
              {disks.map((d: any) => (
                <tr key={d.host_id + d.mount}>
                  <Td className="font-medium"><Link to={`/hosts/${d.host_id}`}>{d.host}</Link></Td>
                  <Td mono>{d.mount}</Td>
                  <Td className="text-fg2">{d.fs || "—"}</Td>
                  <Td mono>{d.device || "—"}</Td>
                  <Td className="text-fg2 whitespace-nowrap">{fmt.bytes(d.used)}</Td>
                  <Td className="text-fg2 whitespace-nowrap">{fmt.bytes(d.total - d.used)}</Td>
                  <Td className="text-fg2 whitespace-nowrap">{fmt.bytes(d.total)}</Td>
                  <Td className="min-w-44"><div className="grid grid-cols-[1fr_3rem] items-center gap-3"><Meter pct={d.pct} warn={th.warn} crit={th.crit} /><span className="text-right text-fg2">{d.pct.toFixed(0)} %</span></div></Td>
                  <StateCell level={d.online ? levelOf(d.pct, th.warn, th.crit) : "off"} />
                </tr>
              ))}
            </Table>
          ) : <div className="px-5 pb-5"><Empty>No file system reported yet.</Empty></div>}
        </Panel>
        <Panel title="Disk health" flush>
          {smart.length ? (
            <Table head={["Host", "Disk", "Model", "Life left", "Temp.", "Powered on", "State"]}>
              {smart.map((d: any) => (
                <tr key={d.host_id + d.device}>
                  <Td className="font-medium"><Link to={`/hosts/${d.host_id}`}>{d.host}</Link></Td>
                  <Td mono>{d.device}</Td>
                  <Td className="text-fg2">{d.model}</Td>
                  <Td className="text-fg2">{d.life_left_pct == null ? "—" : `${d.life_left_pct} %`}</Td>
                  <Td className="text-fg2">{fmt.temp(d.temp_c)}</Td>
                  <Td className="text-fg2">{d.power_on_hours == null ? "—" : `${Math.round(d.power_on_hours / 24)} d`}</Td>
                  <StateCell level={d.health as Level} label={d.reason || undefined} />
                </tr>
              ))}
            </Table>
          ) : <div className="px-5 pb-5"><Empty>SMART data comes from physical hosts.</Empty></div>}
        </Panel>
      </Section>
    </>
  )
}

export function Alerts() {
  const open = useApi("/api/c/alerts?filter=open%3Dtrue&sort=-created&perPage=200")
  const past = useApi("/api/c/alerts?filter=open%3Dfalse&sort=-resolved_at&perPage=50")
  const row = (a: any, resolved: boolean) => (
    <tr key={a.id}>
      <Td>{a.message}</Td>
      <Td className="text-fg2">{a.host || "—"}</Td>
      <Td className="text-fg2">{fmt.ago(resolved ? a.resolved_at : a.created)}</Td>
      <StateCell level={resolved ? "ok" : a.severity} label={resolved ? "Resolved" : undefined} />
    </tr>
  )
  return (
    <>
      <PageHeader title="Alerts" subtitle={`${open.data?.items.length ?? 0} open`} onRefresh={open.reload} />
      <Section>
        <Panel title="Open" flush>
          {open.data?.items.length ? <Table head={["Alert", "Host", "Since", "State"]}>{open.data.items.map((a: any) => row(a, false))}</Table> : <div className="px-5 pb-5"><Empty>Nothing is wrong.</Empty></div>}
        </Panel>
        <Panel title="Resolved" flush>
          {past.data?.items.length ? <Table head={["Alert", "Host", "Resolved", "State"]}>{past.data.items.map((a: any) => row(a, true))}</Table> : <div className="px-5 pb-5"><Empty>No history yet.</Empty></div>}
        </Panel>
      </Section>
    </>
  )
}

export function Logs() {
  const hosts = useApi<any[]>("/api/hosts", { poll: false })
  const [host, setHost] = useState("")
  const [q, setQ] = useState("")
  const [needle, setNeedle] = useState("")
  useEffect(() => { const id = setTimeout(() => setNeedle(q), 300); return () => clearTimeout(id) }, [q])
  const { data, reload } = useApi<any[]>(`/api/logs?host=${host}&q=${encodeURIComponent(needle)}`)
  return (
    <>
      <PageHeader title="Logs" subtitle="Warnings and errors, the last 500 lines per host" onRefresh={reload}
        variables={<>
          <Variable label="Host" value={host} onChange={setHost} options={[{ value: "", label: "All" }, ...(hosts.data ?? []).map((h) => ({ value: h.id, label: h.name }))]} />
          <div className="w-72 max-sm:w-full"><Input label="Filter" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        </>} />
      <Panel title="Journal">
        {data?.length ? (
          <div className="overflow-x-auto font-mono text-[13px] text-fg2">
            {data.map((l, i) => <div key={i} className="whitespace-pre"><span className="text-accent">{l.host}</span> {l.line}</div>)}
          </div>
        ) : <Empty>No matching lines.</Empty>}
      </Panel>
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
      <PageHeader title="Search" />
      <Section>
        <Input label="Search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
        <Panel title="Results">
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

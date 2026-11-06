import { PlusIcon, TrashIcon, PencilSquareIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { Button, Check, Empty, ErrorNote, IconButton, Input, Modal, Mono, Panel, RangeSelect, Select, Stat, StateCell, Status, Table, Td, TextArea, TimeSeries, Variable } from "../ui/components"
import { api, fmt, type Level, useApi } from "../ui/lib"
import { Link, PageHeader, Section } from "../ui/shell"
import { PRESETS } from "./snmp-presets"

export function Containers() {
  const { data, reload } = useApi<any[]>("/api/containers")
  const rows = [...(data ?? [])].sort((a, b) => a.host.localeCompare(b.host) || a.name.localeCompare(b.name))
  const running = rows.filter((c) => c.state === "running").length
  const table = (list: any[], empty: string) => (list.length === 0 ? <div className="px-4 pb-4"><Empty>{empty}</Empty></div> : (
    <Table head={["Name", "Host", "Image", "Status", "State"]}>
      {list.map((c) => (
        <tr key={c.host_id + c.name}>
          <Td mono>{c.name}</Td>
          <Td className="font-medium"><Link to={`/hosts/${c.host_id}`}>{c.host}</Link></Td>
          <Td mono>{c.image}</Td>
          <Td className="text-fg2">{c.status}</Td>
          <StateCell level={c.state === "running" ? "ok" : c.state === "restarting" ? "warn" : "off"} label={c.state} />
        </tr>
      ))}
    </Table>
  ))
  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
      <Panel title="Summary" edit={edit}>
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Running" value={running} level="ok" />
          <Stat label="Stopped" value={rows.length - running} level={rows.length > running ? "warn" : "ok"} />
          <Stat label="Hosts" value={new Set(rows.map((c) => c.host_id)).size} />
        </div>
      </Panel>
    ) },
    { id: "stopped", title: "Not running", render: (edit: any) => <Panel title="Not running" flush edit={edit}>{table(rows.filter((c) => c.state !== "running"), "Everything is running.")}</Panel> },
    { id: "all", title: "Docker containers", render: (edit: any) => <Panel title="Docker containers" flush edit={edit}>{table(rows, "No containers reported.")}</Panel> },
  ]
  return (
    <>
      <PageHeader title="Containers" subtitle={`${running} of ${rows.length} running`} onRefresh={reload} actions={<CustomizeButton />} />
      <Board id="containers" panels={panels} desktop={{ cols: [["summary", "all"]], hidden: ["stopped"] }} phone={{ cols: [["summary", "all"]], hidden: ["stopped"] }} />
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
  const [f, setF] = useState<any>(row ?? { name: "", type: "ping", target: "", interval_s: 60, enabled: true, dns_server: "", expect_status: 0, warn_days: 21, watch_cert: false })
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
        {f.type === "http" && f.target.startsWith("https://") && <Check label="Also watch the HTTPS certificate" checked={f.watch_cert} onChange={(e) => set("watch_cert", e.target.checked)} />}
        {(f.type === "cert" || (f.watch_cert && f.target.startsWith("https://"))) && <Input label="Warn this many days before expiry" type="number" value={f.warn_days} onChange={(e) => set("warn_days", Number(e.target.value))} />}
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
      {values.slice(-40).map((v, i) => <span key={i} className={`w-1 rounded-full ${v ? "bg-ok" : "bg-crit"}`} />)}
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
            <li key={r.label} className="flex min-h-9 max-sm:min-h-11 items-center justify-between gap-3">
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
  const level = (p: any): Level => (p?.up == null ? "off" : !p.up ? "crit" : p.readings.some((r: any) => r.level === "crit") ? "crit" : p.readings.some((r: any) => r.level === "warn") || (p.cert_days != null && p.cert_days <= p.warn_days) ? "warn" : "ok")
  const open = detail ? state(detail) : undefined
  const up = live.data?.filter((p) => p.up).length ?? 0
  const latencies = live.data?.filter((p) => p.up).map((p) => p.latency_ms) ?? []
  const certs = live.data?.filter((p) => p.cert_days != null).sort((a, b) => a.cert_days - b.cert_days) ?? []
  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
      <Panel title="Summary" edit={edit}>
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Up" value={`${up} / ${live.data?.length ?? 0}`} level={up === live.data?.length ? "ok" : "warn"} />
          <Stat label="Average latency" value={latencies.length ? `${(latencies.reduce((a, b) => a + b) / latencies.length).toFixed(0)} ms` : "—"} />
          <Stat label="Next certificate" value={certs.length ? `${certs[0].cert_days} d` : "—"} level={certs[0]?.cert_days <= certs[0]?.warn_days ? "warn" : undefined} sub={certs[0]?.name} />
        </div>
      </Panel>
    ) },
    { id: "certs", title: "Certificates", render: (edit: any) => (
      <Panel title="Certificates" edit={edit}>
        {certs.length ? <ul className="divide-y divide-line">{certs.map((c) => <li key={c.id} className="flex justify-between py-2"><span>{c.name}</span><span className={c.cert_days <= c.warn_days ? "text-warn" : "text-fg2"}>{c.cert_days} days left</span></li>)}</ul> : <Empty>No certificate probes.</Empty>}
      </Panel>
    ) },
    { id: "probes", title: "Probes", render: (edit: any) => (
      <Panel title="Probes" flush edit={edit}>
        {defs.data?.items.length === 0 ? <div className="px-4 pb-4"><Empty>No probes yet.</Empty></div> : (
          <Table head={["Name", "Type", "Target", "Latency", "Result", "History", "State", ""]}>
            {defs.data?.items.map((d: any) => {
              const p = state(d.id)
              return (
                <tr key={d.id}>
                  <Td className="font-medium">{p ? <button className="min-h-9 max-sm:min-h-11 text-left hover:text-accent" onClick={() => setDetail(d.id)}>{d.name}</button> : d.name}</Td>
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
    ) },
  ]
  return (
    <>
      <PageHeader title="Network" subtitle="Ping, website, DNS, certificate and SNMP probes" onRefresh={live.reload} actions={<><CustomizeButton /><Button variant="primary" onClick={() => setEdit(null)}><PlusIcon className="size-5" aria-hidden />Add probe</Button></>} />
      <Board id="network" panels={panels} desktop={{ cols: [["summary", "probes"]], hidden: ["certs"] }} phone={{ cols: [["summary", "probes"]], hidden: ["certs"] }} />
      {edit !== undefined && <ProbeForm row={edit} onDone={done} />}
      {open && <ProbeDetail probe={open} onClose={() => setDetail(undefined)} />}
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
  const panels = [
    { id: "open", title: "Open", render: (edit: any) => (
      <Panel title="Open" flush edit={edit}>
        {open.data?.items.length ? <Table head={["Alert", "Host", "Since", "State"]}>{open.data.items.map((a: any) => row(a, false))}</Table> : <div className="px-4 pb-4"><Empty>Nothing is wrong.</Empty></div>}
      </Panel>
    ) },
    { id: "resolved", title: "Resolved", render: (edit: any) => (
      <Panel title="Resolved" flush edit={edit}>
        {past.data?.items.length ? <Table head={["Alert", "Host", "Resolved", "State"]}>{past.data.items.map((a: any) => row(a, true))}</Table> : <div className="px-4 pb-4"><Empty>No history yet.</Empty></div>}
      </Panel>
    ) },
  ]
  return (
    <>
      <PageHeader title="Alerts" subtitle={`${open.data?.items.length ?? 0} open`} onRefresh={open.reload} actions={<CustomizeButton />} />
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

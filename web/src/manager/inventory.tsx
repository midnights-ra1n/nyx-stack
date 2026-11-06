import { ArrowPathIcon, ArrowsRightLeftIcon, BoltIcon, CheckCircleIcon, CircleStackIcon, CubeIcon, PencilSquareIcon, PlusIcon, PrinterIcon, ServerIcon, ShieldCheckIcon, SignalIcon, TrashIcon, WifiIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { Button, Copy, Empty, ErrorNote, type Icon, IconButton, Input, Modal, Mono, Panel, Select, Stat, Status, Table, Tabs, Td, TextArea } from "../ui/components"
import { type Col, CrudPage, RecordForm } from "../ui/crud"
import { api, fmt, useApi } from "../ui/lib"
import { Link, PageHeader, Section } from "../ui/shell"
import { deployLevel } from "./overview"
import { parseTags, type WorkItem, WorkView } from "./work"

const CATEGORIES: Record<string, Icon> = { Server: ServerIcon, Switch: ArrowsRightLeftIcon, Router: SignalIcon, Firewall: ShieldCheckIcon, NAS: CircleStackIcon, UPS: BoltIcon, "Access point": WifiIcon, Printer: PrinterIcon, Other: CubeIcon }
const categoryCell = (h: any) => {
  const I = CATEGORIES[h.category]
  return h.category ? <span className="flex items-center gap-2">{I && <I className="size-4" aria-hidden />}{h.category}</span> : "—"
}

const HARDWARE: Col[] = [
  { key: "category", label: "Category", type: "select", options: Object.keys(CATEGORIES), icons: CATEGORIES, formOnly: true },
  { key: "name", label: "Name", required: true, section: "Identity" },
  { key: "category", label: "Category", type: "select", options: Object.keys(CATEGORIES), render: categoryCell, listOnly: true },
  { key: "manufacturer", label: "Manufacturer", suggest: true },
  { key: "model", label: "Model", suggest: true },
  { key: "serial", label: "Serial number", mono: true },
  { key: "location", label: "Location", suggest: true, section: "Where it is" },
  { key: "status", label: "Status", type: "select", options: ["In service", "Spare", "Broken", "Retired"] },
  { key: "purchased_at", label: "Purchased", type: "date", formOnly: true, section: "Dates" },
  { key: "warranty_until", label: "Warranty until", type: "date" },
  { key: "notes", label: "Notes", type: "area", formOnly: true },
]
export const Hardware = () => <CrudPage title="Hardware" singular="hardware" collection="hardware" cols={HARDWARE} defaults={{ category: "Server", status: "In service" }} />

function consoleUrl(pve: string, a: any) {
  if (!pve || !a.vmid || !a.pve_node) return ""
  return `${pve.replace(/\/$/, "")}/?novnc=1&console=${a.type === "vm" ? "kvm" : "lxc"}&vmid=${a.vmid}&vmname=${encodeURIComponent(a.name)}&node=${encodeURIComponent(a.pve_node)}`
}

export function Virtual() {
  const proxmox = useApi("/api/settings/proxmox", { poll: false })
  const cols: Col[] = [
    { key: "name", label: "Name", required: true },
    { key: "type", label: "Type", type: "select", options: ["vm", "container", "docker"] },
    { key: "parent", label: "Runs on" },
    { key: "hostname", label: "Hostname", formOnly: true },
    { key: "ip", label: "Address", mono: true },
    { key: "vcpu", label: "vCPU", type: "number", formOnly: true },
    { key: "ram_mb", label: "RAM (MB)", type: "number", formOnly: true },
    { key: "disk_gb", label: "Disk (GB)", type: "number", formOnly: true },
    { key: "status", label: "Status" },
    { key: "vmid", label: "Proxmox VMID", type: "number", formOnly: true },
    { key: "pve_node", label: "Proxmox node", formOnly: true },
    { key: "source", label: "Source", listOnly: true },
    { key: "console", label: "Console", listOnly: true, render: (a) => { const url = consoleUrl(proxmox.data?.url ?? "", a); return url ? <a className="text-accent" target="_blank" rel="noreferrer" href={url}>Console</a> : "—" } },
    { key: "notes", label: "Notes", type: "area", formOnly: true },
  ]
  return <CrudPage title="Virtual" singular="asset" collection="virtual_assets" cols={cols} />
}

const DEPLOYMENTS: Col[] = [
  { key: "name", label: "Name", required: true },
  { key: "target", label: "Target" },
  { key: "version", label: "Version", mono: true },
  { key: "status", label: "State", type: "select", options: ["planned", "running", "ok", "failed"] },
  { key: "scheduled_at", label: "Due date", type: "date" },
  { key: "done_at", label: "Done", type: "date" },
  { key: "owner", label: "Owner" },
  { key: "tags", label: "Tags", hint: "Separated by commas." },
  { key: "notes", label: "Notes", type: "area" },
]
const DEPLOY_STATES = [{ id: "planned", label: "Planned", level: "off" as const }, { id: "running", label: "Running", level: "info" as const }, { id: "ok", label: "Succeeded", level: "ok" as const }, { id: "failed", label: "Failed", level: "crit" as const }]

export function Deployments() {
  const { data, reload, error } = useApi("/api/c/deployments?sort=-created&perPage=500")
  const [edit, setEdit] = useState<any | null | undefined>()
  const done = () => { setEdit(undefined); reload() }
  const move = async (d: any, status: string) => {
    const finished = (status === "ok" || status === "failed") && !d.done_at
    await api(`/api/c/deployments/${d.id}`, { method: "PATCH", body: { status, ...(finished ? { done_at: new Date().toISOString().replace("T", " ") } : {}) } })
    reload()
  }
  const remove = async (d: any) => { if (confirm(`Delete ${d.name}?`)) { await api(`/api/c/deployments/${d.id}`, { method: "DELETE" }); reload() } }
  const items: WorkItem[] = (data?.items ?? []).map((d: any) => ({
    id: d.id, title: d.name, state: d.status || "planned", tags: parseTags(d.tags), due: d.scheduled_at, open: d.status === "planned" || !d.status,
    detail: [d.target, d.version].filter(Boolean).join(" · "), row: d,
  }))
  return (
    <>
      <PageHeader title="Deployments" onRefresh={reload} actions={<Button variant="primary" onClick={() => setEdit(null)}><PlusIcon className="size-5" aria-hidden />Add deployment</Button>} />
      <Panel title="Deployments">
        <ErrorNote>{error}</ErrorNote>
        <WorkView id="deployments" states={DEPLOY_STATES} items={items} empty="No deployments yet." onMove={(w, state) => move(w.row, state)} onOpen={(w) => setEdit(w.row)} onRemove={(w) => remove(w.row)} columns={[{ label: "Target", value: (w) => w.row.target }, { label: "Version", value: (w) => w.row.version }]} />
      </Panel>
      {edit !== undefined && <RecordForm cols={DEPLOYMENTS} row={edit} collection="deployments" onDone={done} title={edit ? "Edit deployment" : "Add deployment"} defaults={{ status: "planned" }} />}
    </>
  )
}

const SUBNETS: Col[] = [
  { key: "name", label: "Name", required: true },
  { key: "cidr", label: "CIDR", mono: true, required: true, hint: "IPv4 or IPv6, for example 192.168.10.0/24." },
  { key: "gateway", label: "Gateway", mono: true },
  { key: "vlan", label: "VLAN", type: "number" },
  { key: "description", label: "Description" },
]
const ADDRESSES: Col[] = [
  { key: "address", label: "Address", mono: true, required: true },
  { key: "device", label: "Device" },
  { key: "hostname", label: "Hostname" },
  { key: "mac", label: "MAC", mono: true },
  { key: "note", label: "Note" },
]
const ROUTES: Col[] = [
  { key: "device", label: "Device", required: true, hint: "Same name as in the addresses list." },
  { key: "destination", label: "Destination", mono: true, required: true, hint: "CIDR. Use 0.0.0.0/0 for a default route." },
  { key: "next_hop", label: "Next hop", mono: true },
  { key: "metric", label: "Metric", type: "number" },
]

function Usage({ report, edit }: { report: any; edit: any }) {
  const [free, setFree] = useState<Record<string, string>>({})
  const next = async (id: string) => { const r = await api(`/api/ipam/next/${id}`); setFree({ ...free, [id]: r.address ?? "Subnet full" }) }
  return (
    <Panel title="Subnet usage" flush edit={edit}>
      {report?.subnets.length ? (
        <Table head={["Subnet", "CIDR", "VLAN", "Used", "Free address"]}>
          {report.subnets.map((s: any) => (
            <tr key={s.id}>
              <Td className="font-medium">{s.name}</Td><Td mono>{s.cidr}</Td><Td>{s.vlan || "—"}</Td>
              <Td className="text-fg2">{s.used} of {Number(s.capacity) > 1e9 ? "a lot" : s.capacity}</Td>
              <Td>{free[s.id] ? <Copy text={free[s.id]} /> : <Button variant="ghost" onClick={() => next(s.id)}>Find next</Button>}</Td>
            </tr>
          ))}
        </Table>
      ) : <div className="px-4 pb-4"><Empty>Add a subnet to see its usage.</Empty></div>}
    </Panel>
  )
}

function Simulator({ edit }: { edit: any }) {
  const [from, setFrom] = useState("")
  const [destination, setDestination] = useState("")
  const [result, setResult] = useState<any>()
  const [error, setError] = useState("")
  const run = async (e: React.FormEvent) => {
    e.preventDefault()
    try { setResult(await api("/api/ipam/simulate", { body: { from, destination } })); setError("") } catch (err) { setError((err as Error).message); setResult(undefined) }
  }
  const level = result?.status === "reached" ? "ok" : result?.status === "loop" ? "warn" : "crit"
  return (
    <Panel title="Routing simulation" edit={edit}>
      <form className="grid grid-cols-[1fr_1fr_auto] items-end gap-4 max-sm:grid-cols-1" onSubmit={run}>
        <Input label="From device" required value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input label="To address" required className="font-mono" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="10.0.2.20" />
        <Button type="submit" variant="primary">Trace</Button>
      </form>
      <div className="mt-4 flex flex-col gap-3">
        <ErrorNote>{error}</ErrorNote>
        {result && <>
          <div className="flex items-baseline gap-3"><Status level={level} /><span>{result.summary}</span></div>
          <ol className="flex flex-col gap-1">{result.hops.map((h: any, i: number) => <li key={i} className="flex flex-wrap gap-x-3"><span className="w-6 text-fg3">{i + 1}</span><span className="font-medium">{h.device}</span><Mono className="text-fg2">{h.detail}</Mono></li>)}</ol>
        </>}
      </div>
    </Panel>
  )
}

const IPAM_TABS = [{ id: "usage", label: "Usage" }, { id: "subnets", label: "Subnets" }, { id: "addresses", label: "Addresses" }, { id: "routes", label: "Routes" }]

export function Ipam() {
  const [tab, setTab] = useState("usage")
  const { data, reload } = useApi("/api/ipam/report", { poll: false })
  const tabs = <Tabs tabs={IPAM_TABS} value={tab} onChange={setTab} />
  if (tab === "subnets") return <CrudPage key={tab} heading="IPAM" variables={tabs} title="Subnets" singular="subnet" collection="subnets" cols={SUBNETS} onChanged={reload} />
  if (tab === "addresses") return <CrudPage key={tab} heading="IPAM" variables={tabs} title="Addresses" singular="address" collection="ip_addresses" cols={ADDRESSES} sort="address" onChanged={reload} />
  if (tab === "routes") return <CrudPage key={tab} heading="IPAM" variables={tabs} title="Routes" singular="route" collection="routes" cols={ROUTES} sort="device" />
  return (
    <>
      <PageHeader title="IPAM" variables={tabs} onRefresh={reload} actions={<CustomizeButton />} />
      <Board id="ipam" desktop={{ cols: [["conflicts", "usage", "simulator"]], hidden: [] }} phone={{ cols: [["conflicts", "usage", "simulator"]], hidden: [] }} panels={[
        { id: "conflicts", title: "Conflicts", render: (edit: any) => <Panel title="Conflicts" edit={edit}>
          {data?.conflicts.length ? <ul className="flex flex-col gap-2">{data.conflicts.map((c: any) => <li key={c.message} className="flex items-baseline gap-3"><Status level={c.severity} /><span>{c.message}</span></li>)}</ul> : <Empty>No conflicts.</Empty>}</Panel> },
        { id: "usage", title: "Subnet usage", render: (edit: any) => <Usage report={data} edit={edit} /> },
        { id: "simulator", title: "Routing simulation", render: (edit: any) => <Simulator edit={edit} /> },
      ]} />
    </>
  )
}

const TASK_STATES = [{ id: "todo", label: "To do", level: "off" as const }, { id: "doing", label: "In progress", level: "info" as const }, { id: "done", label: "Done", level: "ok" as const }, { id: "cancelled", label: "Cancelled", level: "warn" as const }]
const taskState = (t: any) => t.status || (t.done ? "done" : "todo")

function TaskForm({ row, onDone }: { row: any | null; onDone: () => void }) {
  const [f, setF] = useState({ title: row?.title ?? "", description: row?.description ?? "", due: row?.due?.slice(0, 10) ?? "", status: row ? taskState(row) : "todo", tags: row?.tags?.replaceAll(",", ", ") ?? "" })
  const [error, setError] = useState("")
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const body = { ...f, due: f.due ? `${f.due} 00:00:00.000Z` : "" }
    try { await api(row ? `/api/tasks/${row.id}` : "/api/tasks", { method: row ? "PATCH" : "POST", body }); onDone() } catch (err) { setError((err as Error).message) }
  }
  return (
    <Modal title={row ? "Edit task" : "Add task"} onClose={onDone}>
      <form className="grid grid-cols-2 gap-4 max-sm:grid-cols-1" onSubmit={save}>
        <div className="col-span-full"><Input label="Title" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <div className="col-span-full"><TextArea label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <Select label="State" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={TASK_STATES.map((s) => ({ value: s.id, label: s.label }))} />
        <Input label="Due date" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
        <div className="col-span-full"><Input label="Tags" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} hint="Separated by commas. They sync with Nextcloud as categories." /></div>
        <div className="col-span-full flex flex-col gap-3"><ErrorNote>{error}</ErrorNote><div><Button variant="primary" type="submit">Save</Button></div></div>
      </form>
    </Modal>
  )
}

export function Tasks() {
  const { data, reload, error } = useApi<any[]>("/api/tasks")
  const [edit, setEdit] = useState<any | null | undefined>()
  const [note, setNote] = useState("")
  const done = () => { setEdit(undefined); reload() }
  const move = async (t: any, status: string) => { await api(`/api/tasks/${t.id}`, { method: "PATCH", body: { ...t, status } }); reload() }
  const remove = async (t: any) => { if (confirm(`Delete ${t.title}?`)) { await api(`/api/tasks/${t.id}`, { method: "DELETE" }); reload() } }
  const sync = async () => { try { await api("/api/sync", { method: "POST" }); setNote("Synced."); reload() } catch (e) { setNote((e as Error).message) } }
  const open = data?.filter((t) => !t.done).length ?? 0
  const items: WorkItem[] = (data ?? []).map((t) => ({
    id: t.id, title: t.title, state: taskState(t), tags: parseTags(t.tags), due: t.due, open: !t.done, readOnly: t.kind === "event", row: t,
    detail: t.kind === "event" ? "Calendar" : t.uid ? "Nextcloud" : "",
  }))
  const panels = [
    { id: "open", title: "Open", render: (edit: any) => <Panel title="Open" edit={edit}><Stat label="Tasks" value={open} /></Panel> },
    { id: "tasks", title: "Tasks and events", render: (edit: any) => (
        <Panel title="Tasks and events" edit={edit}>
          <ErrorNote>{error}</ErrorNote>
          <WorkView id="tasks" states={TASK_STATES} items={items} empty="No tasks. Add one, or link Nextcloud in Settings to sync them." onMove={(w, state) => move(w.row, state)} onOpen={(w) => setEdit(w.row)} onRemove={(w) => remove(w.row)} columns={[{ label: "From", value: (w) => w.detail || "Nyx" }]} />
        </Panel>
    ) },
  ]
  return (
    <>
      <PageHeader title="Tasks" subtitle={note} actions={<>
        <CustomizeButton />
        <Button onClick={sync}><ArrowPathIcon className="size-5" aria-hidden />Sync</Button>
        <Button variant="primary" onClick={() => setEdit(null)}><PlusIcon className="size-5" aria-hidden />Add task</Button>
      </>} />
      <Board id="tasks" panels={panels} desktop={{ cols: [["open", "tasks"]], hidden: [] }} phone={{ cols: [["open", "tasks"]], hidden: [] }} />
      {edit !== undefined && <TaskForm row={edit} onDone={done} />}
    </>
  )
}

const VPN: Col[] = [
  { key: "name", label: "Name", required: true },
  { key: "kind", label: "Type", type: "select", options: ["WireGuard", "Tailscale", "NetBird", "OpenVPN", "ZeroTier", "IPsec", "Mesh VPN", "Other"] },
  { key: "side_a", label: "From", suggest: true, hint: "A device name. With both ends on the network map, the link is drawn there." },
  { key: "side_b", label: "To", suggest: true, hint: "Leave empty for a mesh." },
  { key: "subnet", label: "Tunnel subnet", mono: true },
  { key: "endpoint", label: "Public endpoint", mono: true },
  { key: "status", label: "Status", type: "select", options: ["Active", "Planned", "Disabled"] },
  { key: "notes", label: "Notes", type: "area", formOnly: true },
]

/** Hand-kept links, and the tunnels agents report that could become one. */
export function Vpn() {
  const monitor = useApi<any[] | null>("/api/monitor/hosts", { poll: false })
  const known = useApi("/api/c/vpn_links?perPage=500", { poll: false })
  const [track, setTrack] = useState<any>()
  const [version, setVersion] = useState(0)
  const changed = () => { known.reload(); setVersion(version + 1) }
  const tracked = (host: string, v: any) => known.data?.items.some((l: any) => l.side_a === host && l.kind === v.kind)
  const seen = (monitor.data ?? []).flatMap((h) => (h.vpn ?? []).map((v: any) => ({ ...v, host: h.name, hostId: h.id })))
  const detected = (
    <Panel title="Detected on your hosts" flush>
      {seen.length === 0 ? <div className="px-4 pb-4"><Empty>{monitor.data ? "No agent reports a tunnel." : "Link a monitor in Settings to detect VPN tunnels."}</Empty></div> : (
        <Table head={["Host", "Interface", "Type", "Address", "State", ""]}>
          {seen.map((v) => (
            <tr key={`${v.hostId}${v.iface}`}>
              <Td className="font-medium">{v.host}</Td>
              <Td mono>{v.iface}</Td>
              <Td className="text-fg2">{v.kind}</Td>
              <Td mono>{v.ip || "—"}</Td>
              <Td><Status level={v.up ? "ok" : "crit"} label={v.up ? "Up" : "Down"} /></Td>
              <Td className="text-right">{tracked(v.host, v) ? <span className="text-fg3">Tracked</span> : <Button variant="ghost" onClick={() => setTrack({ name: `${v.host} ${v.kind}`, kind: v.kind, side_a: v.host, status: "Active" })}>Track</Button>}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  )
  return (
    <>
      <CrudPage key={version} title="VPN links" singular="VPN link" collection="vpn_links" cols={VPN} extra={detected} defaults={{ status: "Active" }} onChanged={known.reload} />
      {track && <RecordForm cols={VPN} row={null} collection="vpn_links" title="Track VPN link" defaults={track} rows={known.data?.items} onDone={() => { setTrack(undefined); changed() }} />}
    </>
  )
}


const SEARCHED = [
  { coll: "hardware", to: "/hardware", fields: ["name", "serial", "model", "location"] },
  { coll: "virtual_assets", to: "/virtual", fields: ["name", "hostname", "ip"] },
  { coll: "ip_addresses", to: "/ipam", fields: ["address", "device", "hostname", "mac"] },
  { coll: "sites", to: "/sites", fields: ["name", "repo"] },
  { coll: "vpn_links", to: "/vpn", fields: ["name", "side_a", "side_b", "subnet"] },
]

function Hits({ q, coll, to, fields }: { q: string; coll: string; to: string; fields: string[] }) {
  const { data } = useApi(`/api/c/${coll}?perPage=500`, { poll: false })
  const hits = data?.items.filter((r: any) => fields.some((f) => r[f]?.toLowerCase().includes(q))) ?? []
  return hits.map((r: any) => <li key={r.id}><Link className="text-accent" to={to}>{r[fields[0]]}</Link> <span className="text-fg3">{fields.slice(1).map((f) => r[f]).filter(Boolean).join(" · ")}</span></li>)
}

export function SearchPage() {
  const [q, setQ] = useState(new URLSearchParams(location.search).get("q") ?? "")
  const n = q.trim().toLowerCase()
  return (
    <>
      <PageHeader title="Search" />
      <Section>
        <Input label="Search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
        <Panel title="Results">
          {n ? <ul className="flex flex-col gap-2">{SEARCHED.map((s) => <Hits key={s.coll} q={n} {...s} />)}</ul> : <Empty>Type a name, address, serial number or repository.</Empty>}
        </Panel>
      </Section>
    </>
  )
}

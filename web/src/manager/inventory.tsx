import { ArrowPathIcon, ArrowsRightLeftIcon, BoltIcon, CircleStackIcon, CubeIcon, PlusIcon, PrinterIcon, ServerIcon, ShieldCheckIcon, SignalIcon, WifiIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { Button, Empty, ErrorNote, type Icon, Input, Panel, Select, Stat, Status, Table, Td, TextArea } from "../ui/components"
import { type Col, CrudPage, Editor, EditorGroup, RecordForm } from "../ui/crud"
import { api, useApi } from "../ui/lib"
import { Link, PageHeader, Section } from "../ui/shell"
import { deployLevel } from "./overview"
import { parseTags, type WorkItem, WorkView } from "./work"

const CATEGORIES: Record<string, Icon> = { Server: ServerIcon, Switch: ArrowsRightLeftIcon, Router: SignalIcon, Firewall: ShieldCheckIcon, NAS: CircleStackIcon, UPS: BoltIcon, "Access point": WifiIcon, Printer: PrinterIcon, Other: CubeIcon }
const categoryCell = (h: any) => {
  const I = CATEGORIES[h.category]
  return h.category ? <span className="flex items-center gap-2">{I && <I className="size-4" aria-hidden />}{h.category}</span> : "—"
}

// Which details each category has. Plain text, so that "32 GB DDR4 ECC" fits as typed.
const COMPUTE = ["Server", "NAS", "Router", "Firewall"]
const NETWORK = ["Server", "NAS", "Switch", "Router", "Firewall", "Access point"]
const MANAGED = ["Server", "NAS", "Switch", "Router", "Firewall", "Access point", "UPS", "Printer"]
const spec = (key: string, label: string, only: string[], extra: Partial<Col> = {}): Col =>
  ({ key, label, section: "Specifications", formOnly: true, suggest: true, when: { key: "category", in: only }, ...extra })
const SPECS: Col[] = [
  spec("cpu", "CPU", COMPUTE, { hint: "Model, cores and threads." }),
  spec("ram", "RAM", ["Server", "NAS", "Firewall"], { hint: "Such as 64 GB DDR4 ECC." }),
  spec("storage", "Storage", ["Server", "NAS", "Printer"], { hint: "Disks and bays, such as 4 × 8 TB HDD, 2 free bays." }),
  spec("ports", "Network ports", NETWORK, { hint: "Such as 24 × 1 GbE, 4 × SFP+, PoE 370 W." }),
  spec("wifi", "Wi-Fi", ["Access point", "Router"], { hint: "Standard and bands, such as Wi-Fi 6E, 2.4/5/6 GHz." }),
  spec("power", "Power", ["Server", "NAS", "Switch", "UPS"], { hint: "Power supplies, or the UPS rating such as 1500 VA / 900 W." }),
  spec("battery_at", "Battery replaced", ["UPS"], { type: "date", suggest: false }),
  spec("firmware", "OS or firmware", MANAGED),
  spec("mgmt_ip", "Management address", MANAGED, { mono: true, suggest: false, hint: "Web interface, IPMI or iDRAC." }),
]

const HARDWARE: Col[] = [
  { key: "category", label: "Category", type: "select", options: Object.keys(CATEGORIES), icons: CATEGORIES, formOnly: true },
  { key: "name", label: "Name", required: true, section: "Identity" },
  { key: "category", label: "Category", type: "select", options: Object.keys(CATEGORIES), render: categoryCell, listOnly: true },
  { key: "manufacturer", label: "Manufacturer", suggest: true },
  { key: "model", label: "Model", suggest: true },
  { key: "serial", label: "Serial number", mono: true },
  ...SPECS,
  { key: "location", label: "Location", suggest: true, section: "Where it is" },
  { key: "status", label: "Status", type: "select", options: ["In service", "Spare", "Broken", "Retired"] },
  { key: "purchased_at", label: "Purchased", type: "date", formOnly: true, section: "Dates" },
  { key: "warranty_until", label: "Warranty until", type: "date" },
  { key: "notes", label: "Notes", type: "area", formOnly: true },
]
export const Hardware = () => <CrudPage title="Hardware" singular="hardware" collection="hardware" cols={HARDWARE} defaults={{ category: "Server", status: "In service" }} />

function consoleUrl(pve: string, a: any) {
  if (!pve || !a.vmid || !a.pve_node) return ""
  return `/api/proxmox/console?console=${a.type === "vm" ? "kvm" : "lxc"}&vmid=${a.vmid}&vmname=${encodeURIComponent(a.name)}&node=${encodeURIComponent(a.pve_node)}`
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
      {edit !== undefined && <RecordForm key={edit?.id ?? "new"} cols={DEPLOYMENTS} row={edit} collection="deployments" onDone={done} title={edit ? `Edit ${edit.name}` : "Add deployment"} defaults={{ status: "planned" }} />}
      <Panel title="Deployments">
        <ErrorNote>{error}</ErrorNote>
        <WorkView id="deployments" states={DEPLOY_STATES} items={items} empty="No deployments yet." onMove={(w, state) => move(w.row, state)} onOpen={(w) => setEdit(w.row)} onRemove={(w) => remove(w.row)} columns={[{ label: "Target", value: (w) => w.row.target }, { label: "Version", value: (w) => w.row.version }]} />
      </Panel>
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
    <Editor title={row ? `Edit ${row.title}` : "Add task"} onCancel={onDone} onSubmit={save} error={error}>
      <EditorGroup title="Task">
        <div className="col-span-full"><Input label="Title" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <div className="col-span-full"><TextArea label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
      </EditorGroup>
      <EditorGroup title="Planning">
        <Select label="State" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={TASK_STATES.map((s) => ({ value: s.id, label: s.label }))} />
        <Input label="Due date" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
        <div className="col-span-full"><Input label="Tags" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} hint="Separated by commas. They sync with Nextcloud as categories." /></div>
      </EditorGroup>
    </Editor>
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
      {edit !== undefined && <TaskForm key={edit?.id ?? "new"} row={edit} onDone={done} />}
      <Board id="tasks" panels={panels} desktop={{ cols: [["open", "tasks"]], hidden: [] }} phone={{ cols: [["open", "tasks"]], hidden: [] }} />
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
      <CrudPage key={version} title="VPN links" singular="VPN link" collection="vpn_links" cols={VPN} defaults={{ status: "Active" }} onChanged={known.reload} extra={<>
        {track && <RecordForm cols={VPN} row={null} collection="vpn_links" title="Track VPN link" defaults={track} rows={known.data?.items} onDone={() => { setTrack(undefined); changed() }} />}
        {detected}
      </>} />
    </>
  )
}


const SEARCHED = [
  { coll: "hardware", to: "/hardware", fields: ["name", "serial", "model", "location"] },
  { coll: "virtual_assets", to: "/virtual", fields: ["name", "hostname", "ip"] },
  { coll: "ip_addresses", to: "/ipam", fields: ["address", "device", "hostname", "mac"] },
  { coll: "subnets", to: "/ipam", fields: ["name", "cidr", "description", "section"] },
  { coll: "vlans", to: "/ipam", fields: ["name", "domain", "description"] },
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

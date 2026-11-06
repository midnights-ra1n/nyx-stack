import { ArrowPathIcon, CheckCircleIcon, PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { Button, Copy, Empty, ErrorNote, IconButton, Input, Modal, Mono, Panel, Select, Stat, Status, Table, Tabs, Td, TextArea } from "../ui/components"
import { type Col, CrudPage } from "../ui/crud"
import { api, fmt, useApi } from "../ui/lib"
import { Link, PageHeader, Section } from "../ui/shell"
import { deployLevel } from "./overview"

const HARDWARE: Col[] = [
  { key: "name", label: "Name", required: true },
  { key: "category", label: "Category", type: "select", options: ["Server", "Switch", "Router", "Firewall", "NAS", "UPS", "Access point", "Printer", "Other"] },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "model", label: "Model" },
  { key: "serial", label: "Serial number", mono: true },
  { key: "location", label: "Location" },
  { key: "status", label: "Status", type: "select", options: ["In service", "Spare", "Broken", "Retired"] },
  { key: "purchased_at", label: "Purchased", type: "date", formOnly: true },
  { key: "warranty_until", label: "Warranty until", type: "date" },
  { key: "notes", label: "Notes", type: "area", formOnly: true },
]
export const Hardware = () => <CrudPage title="Hardware" singular="hardware" collection="hardware" cols={HARDWARE} />

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
  { key: "status", label: "Status", type: "select", options: ["planned", "running", "ok", "failed"], render: (d) => <Status level={deployLevel(d.status)} label={d.status || "planned"} /> },
  { key: "scheduled_at", label: "Scheduled", type: "date" },
  { key: "done_at", label: "Done", type: "date" },
  { key: "owner", label: "Owner", formOnly: true },
  { key: "notes", label: "Notes", type: "area", formOnly: true },
]
export const Deployments = () => <CrudPage title="Deployments" singular="deployment" collection="deployments" cols={DEPLOYMENTS} sort="-created" />

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
  if (tab === "subnets") return <><div className="mb-4">{tabs}</div><CrudPage title="Subnets" singular="subnet" collection="subnets" cols={SUBNETS} onChanged={reload} /></>
  if (tab === "addresses") return <><div className="mb-4">{tabs}</div><CrudPage title="Addresses" singular="address" collection="ip_addresses" cols={ADDRESSES} sort="address" onChanged={reload} /></>
  if (tab === "routes") return <><div className="mb-4">{tabs}</div><CrudPage title="Routes" singular="route" collection="routes" cols={ROUTES} sort="device" /></>
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

function TaskForm({ row, onDone }: { row: any | null; onDone: () => void }) {
  const [f, setF] = useState({ title: row?.title ?? "", description: row?.description ?? "", due: row?.due?.slice(0, 10) ?? "", done: row?.done ?? false })
  const [error, setError] = useState("")
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const body = { ...f, due: f.due ? `${f.due} 00:00:00.000Z` : "" }
    try { await api(row ? `/api/tasks/${row.id}` : "/api/tasks", { method: row ? "PATCH" : "POST", body }); onDone() } catch (err) { setError((err as Error).message) }
  }
  return (
    <Modal title={row ? "Edit task" : "Add task"} onClose={onDone}>
      <form className="flex flex-col gap-4" onSubmit={save}>
        <Input label="Title" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <TextArea label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <Input label="Due" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
        <ErrorNote>{error}</ErrorNote>
        <div><Button variant="primary" type="submit">Save</Button></div>
      </form>
    </Modal>
  )
}

export function Tasks() {
  const { data, reload, error } = useApi<any[]>("/api/tasks")
  const [edit, setEdit] = useState<any | null | undefined>()
  const [note, setNote] = useState("")
  const done = () => { setEdit(undefined); reload() }
  const toggle = async (t: any) => { await api(`/api/tasks/${t.id}`, { method: "PATCH", body: { ...t, done: !t.done } }); reload() }
  const remove = async (t: any) => { if (confirm(`Delete ${t.title}?`)) { await api(`/api/tasks/${t.id}`, { method: "DELETE" }); reload() } }
  const sync = async () => { try { await api("/api/sync", { method: "POST" }); setNote("Synced."); reload() } catch (e) { setNote((e as Error).message) } }
  const open = data?.filter((t) => !t.done).length ?? 0
  const panels = [
    { id: "open", title: "Open", render: (edit: any) => <Panel title="Open" edit={edit}><Stat label="Tasks" value={open} /></Panel> },
    { id: "tasks", title: "Tasks and events", render: (edit: any) => (
        <Panel title="Tasks and events" flush edit={edit}>
          <ErrorNote>{error}</ErrorNote>
          {data?.length === 0 ? <div className="px-4 pb-4"><Empty>No tasks. Link Nextcloud in Settings to sync them.</Empty></div> : (
            <Table head={["Title", "Due", "From", ""]}>
              {data?.map((t) => (
                <tr key={t.id}>
                  <Td className={t.done ? "text-fg3 line-through" : "font-medium"}>{t.title}</Td>
                  <Td className="text-fg2">{fmt.date(t.due)}</Td>
                  <Td className="text-fg2">{t.kind === "event" ? "Calendar" : t.uid ? "Nextcloud" : "Nyx"}</Td>
                  <Td className="w-32 whitespace-nowrap text-right">
                    {t.kind !== "event" && <>
                      <IconButton label={t.done ? "Reopen" : "Mark done"} icon={CheckCircleIcon} onClick={() => toggle(t)} />
                      <IconButton label="Edit" icon={PencilSquareIcon} onClick={() => setEdit(t)} />
                      <IconButton label="Delete" icon={TrashIcon} onClick={() => remove(t)} />
                    </>}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
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


const SEARCHED = [
  { coll: "hardware", to: "/hardware", fields: ["name", "serial", "model", "location"] },
  { coll: "virtual_assets", to: "/virtual", fields: ["name", "hostname", "ip"] },
  { coll: "ip_addresses", to: "/ipam", fields: ["address", "device", "hostname", "mac"] },
  { coll: "sites", to: "/sites", fields: ["name", "repo"] },
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

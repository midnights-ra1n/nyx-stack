import { ArrowPathIcon, ArrowsRightLeftIcon, Bars4Icon, PencilSquareIcon, PowerIcon, TrashIcon, XMarkIcon, BoltIcon, CircleStackIcon, CommandLineIcon, ComputerDesktopIcon, CubeIcon, CubeTransparentIcon, PlusIcon, PrinterIcon, ServerIcon, ShieldCheckIcon, SignalIcon, WifiIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { Button, Empty, ErrorNote, type Icon, IconButton, Input, Mono, Panel, Progress, Select, Stat, Status, Table, Td, TextArea, ask } from "../ui/components"
import { t } from "../ui/i18n"
import { type Item, joinChecklist, ProgressSummary, splitChecklist } from "./progress"
import { type Col, CrudPage, Editor, EditorGroup, RecordForm, RecordPage } from "../ui/crud"
import { api, fmt, type Level, levelText, sortRows, useApi } from "../ui/lib"
import { Link, navigate, PageHeader, Section } from "../ui/shell"
import { deployLevel } from "./overview"
import { parseTags, type WorkItem, WorkView } from "./work"

const STATUS_LEVEL: Record<string, Level> = { "In service": "ok", Spare: "info", Broken: "crit", Retired: "off" }
const CATEGORIES: Record<string, Icon> = { Server: ServerIcon, Switch: ArrowsRightLeftIcon, Router: SignalIcon, Firewall: ShieldCheckIcon, NAS: CircleStackIcon, UPS: BoltIcon, "Access point": WifiIcon, "Patch panel": Bars4Icon, PDU: PowerIcon, Printer: PrinterIcon, Other: CubeIcon }
const categoryCell = (h: any) => {
  const I = CATEGORIES[h.category]
  return h.category ? <span className="flex items-center gap-2">{I && <I className="size-4" aria-hidden />}{t(h.category)}</span> : "—"
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
  { key: "status", label: "Status", type: "select", options: Object.keys(STATUS_LEVEL), render: (h) => h.status ? <Status cell level={STATUS_LEVEL[h.status] ?? "off"} label={h.status} /> : "—" },
  { key: "notes", label: "Notes", type: "area", formOnly: true, section: "Notes" },
  // GLPI's financial information.
  { key: "supplier", label: "Supplier", suggest: true, formOnly: true, tab: "Management", section: "Purchase" },
  { key: "order_number", label: "Order number", mono: true, formOnly: true },
  { key: "invoice_number", label: "Invoice number", mono: true, formOnly: true },
  { key: "price", label: "Price", type: "number", formOnly: true, hint: "Taxes included, in your currency." },
  { key: "purchased_at", label: "Purchased", type: "date", formOnly: true },
  { key: "in_service_at", label: "In service since", type: "date", formOnly: true, section: "Warranty and life" },
  { key: "warranty_until", label: "Warranty until", type: "date", render: (h) => { const w = warranty(h.warranty_until); return w ? <span className={levelText[w.level]}>{w.label}</span> : "—" } },
]
const HW_DEFAULTS = { category: "Server", status: "In service" }

/** The hardware fields, with where the device sits among the racks of the Racks page. */
function useHardwareCols() {
  const { data } = useApi("/api/c/racks?sort=name&perPage=200", { poll: false })
  const racks: any[] = data?.items ?? []
  const where = (h: any) => { const r = racks.find((x) => x.id === h.rack); return r ? `${r.name}${h.rack_u ? ` · U${h.rack_u}` : ""}` : "" }
  const cols = HARDWARE.flatMap((c): Col[] => c.key !== "location" ? [c] : [c,
    { key: "rack", label: "Rack", type: "select", choices: racks.map((x) => ({ value: x.id, label: x.name })), render: (h) => where(h) || "—", hint: "Drag it into place on the Racks page." },
    { key: "rack_u", label: "Position (U)", type: "number", formOnly: true, hint: "The lowest unit it fills, 1 at the bottom." },
    { key: "rack_units", label: "Height (U)", type: "number", formOnly: true },
  ])
  return { cols, where }
}

export function Hardware() {
  const { cols } = useHardwareCols()
  return <CrudPage title={t("Hardware")} singular="hardware" collection="hardware" cols={cols} defaults={HW_DEFAULTS} path="/hardware" facet="category" />
}

/** What the warranty of a device says today: gone, ending within 60 days, or running. */
export function warranty(until: string | undefined, now = Date.now()): { level: Level; label: string } | null {
  const end = until ? Date.parse(until.slice(0, 10)) : NaN
  if (Number.isNaN(end)) return null
  const days = Math.ceil((end - now) / 86_400_000)
  if (days < 0) return { level: "crit", label: t("Expired") }
  if (days <= 60) return { level: "warn", label: days === 0 ? t("Ends today") : t("Ends in {n} days", { n: days }) }
  return { level: "ok", label: t("Until {date}", { date: fmt.date(until) }) }
}

const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/** Addresses of the IPAM held by a device of this name. */
function LinkedAddresses({ device }: { device: string }) {
  const { data } = useApi("/api/c/ip_addresses?perPage=500", { poll: false })
  const rows = (data?.items ?? []).filter((a: any) => same(a.device, device) || same(a.hostname, device))
  return (
    <Panel title={t("Network addresses")} actions={[{ label: "Open IPAM", onClick: () => navigate("/ipam") }]}>
      {rows.length ? (
        <ul className="divide-y divide-line">{rows.map((a: any) => <li key={a.id} className="flex justify-between gap-3 py-1.5"><Mono>{a.address}</Mono><span className="truncate text-fg3">{a.hostname || a.kind || ""}</span></li>)}</ul>
      ) : <Empty>{device ? "No address in the IPAM names this device." : "Name the device to find its addresses."}</Empty>}
    </Panel>
  )
}

function HardwareAside(form: any, rack: string) {
  const I = CATEGORIES[form.category] ?? CubeIcon
  const w = warranty(form.warranty_until)
  const age = form.purchased_at ? Math.floor((Date.now() - Date.parse(form.purchased_at)) / (365.25 * 86_400_000)) : null
  return <>
    <Panel title={t("Summary")}>
      <div className="flex items-center gap-4">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-panel bg-raised text-fg2"><I className="size-8" aria-hidden /></span>
        <div className="min-w-0">
          <div className="truncate text-[17px] font-medium">{form.name || "Unnamed"}</div>
          <div className="truncate text-fg2">{[form.manufacturer, form.model].filter(Boolean).join(" ") || form.category}</div>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
        <dt className="text-fg2">{t("Status")}</dt><dd>{form.status ? <Status cell level={STATUS_LEVEL[form.status] ?? "off"} label={form.status} /> : "—"}</dd>
        <dt className="text-fg2">{t("Warranty")}</dt><dd className={w ? levelText[w.level] : "text-fg3"}>{w?.label ?? "Not set"}</dd>
        <dt className="text-fg2">{t("Age")}</dt><dd>{age == null || Number.isNaN(age) ? "—" : age < 1 ? t("Under a year") : t(age > 1 ? "{n} years" : "{n} year", { n: age })}</dd>
        <dt className="text-fg2">{t("Location")}</dt><dd className="truncate">{form.location || "—"}</dd>
        <dt className="text-fg2">{t("Rack")}</dt><dd className="truncate">{rack ? <Link to="/racks" className="text-accent">{rack}</Link> : "—"}</dd>
        {form.mgmt_ip && <><dt className="text-fg2">{t("Management")}</dt><dd><a className="font-mono text-accent" href={/^https?:\/\//.test(form.mgmt_ip) ? form.mgmt_ip : `https://${form.mgmt_ip}`} target="_blank" rel="noreferrer noopener">{form.mgmt_ip}</a></dd></>}
      </dl>
    </Panel>
  </>
}

/** Virtual assets that say they run on this device. */
function RunsHere({ host }: { host: string }) {
  const { data } = useApi("/api/c/virtual_assets?perPage=500", { poll: false })
  const rows = (data?.items ?? []).filter((a: any) => same(a.parent, host))
  return (
    <Panel title={t("Runs here ({n})", { n: rows.length })}>
      {rows.length ? <ul className="divide-y divide-line">{rows.map((a: any) => <li key={a.id} className="flex justify-between gap-3 py-1.5"><Link to={`/virtual/${a.id}`} className="truncate hover:text-accent">{a.name}</Link><span className="text-fg3">{a.type}</span></li>)}</ul>
        : <Empty>{t("No virtual asset names this device under Runs on.")}</Empty>}
    </Panel>
  )
}

/** The port at the other end of the cable. The link is kept on one of the two ports, either one. */
export const peerOf = (p: any, ports: any[]) => ports.find((q) => p.peer && q.id === p.peer) ?? ports.find((q) => q.peer === p.id)

const PORT_TAB = "Network ports"

/** Network ports of a device, each cabled to a port of another device, as in GLPI. */
function Ports({ device, onChange }: { device: any; onChange: () => void }) {
  const ports = useApi("/api/c/ports?perPage=500", { poll: false })
  const hw = useApi("/api/c/hardware?perPage=500", { poll: false })
  const [edit, setEdit] = useState<any | null | undefined>()
  const devices: any[] = hw.data?.items ?? []
  const deviceName = (id: string) => devices.find((h) => h.id === id)?.name ?? ""
  // shortcut: loads every port to find the far ends; filter on the server if inventories reach thousands of ports.
  const all: any[] = (ports.data?.items ?? []).filter((p: any) => deviceName(p.device))
  const mine = sortRows(all.filter((p) => p.device === device.id), (p) => p.name)
  const free = all.filter((q) => q.device !== device.id && (!peerOf(q, all) || peerOf(q, all)?.id === edit?.id))
  const cols: Col[] = [
    { key: "name", label: "Name", required: true, hint: "As the device labels it, such as eno1 or port 12." },
    { key: "speed", label: "Speed", suggest: true, hint: "Such as 1 GbE, 10 GbE SFP+." },
    { key: "mac", label: "MAC address", mono: true },
    { key: "vlan", label: "VLAN", hint: "Such as 10, or 10,20 tagged." },
    { key: "peer", label: "Cabled to", type: "select", choices: sortRows(free.map((q) => ({ value: q.id, label: `${deviceName(q.device)} · ${q.name}` })), (o) => o.label) },
    { key: "note", label: "Note" },
  ]
  // A port holds one cable: unlink whatever pointed here and is no longer the far end.
  const tidy = async (saved: any) => {
    await Promise.all(all.filter((q) => q.peer === saved.id && q.id !== saved.peer).map((q) => api(`/api/c/ports/${q.id}`, { method: "PATCH", body: { peer: "" } })))
    changed()
  }
  const changed = () => { ports.reload(); onChange() }
  const remove = async (p: any) => { if (await ask(t("Delete port {name}?", { name: p.name }), { action: "Delete", danger: true })) { await api(`/api/c/ports/${p.id}`, { method: "DELETE" }); changed() } }
  return <>
    {edit !== undefined && <RecordForm key={edit?.id ?? "new"} cols={cols} row={edit && { ...edit, peer: peerOf(edit, all)?.id ?? "" }} collection="ports" title={edit ? t("Edit port {name}", { name: edit.name }) : "Add port"}
      defaults={{ device: device.id }} rows={all} onSaved={tidy} onDone={() => { setEdit(undefined); changed() }} />}
    <Panel title={`${mine.length} ${mine.length === 1 ? "port" : "ports"}`} flush actions={[{ label: "Add port", onClick: () => setEdit(null) }]}>
      <ErrorNote>{ports.error}</ErrorNote>
      {mine.length === 0 ? <div className="px-4 pb-4"><Empty>{t("No port yet. Add them to cable this device to others; cables show on the network map.")}</Empty></div> : (
        <Table head={["Port", "Speed", "MAC", "VLAN", "Cabled to", ""]}>
          {mine.map((p) => {
            const q = peerOf(p, all)
            return (
              <tr key={p.id}>
                <Td className="font-medium">{p.name}</Td>
                <Td className="text-fg2">{p.speed || "—"}</Td>
                <Td mono>{p.mac || "—"}</Td>
                <Td className="text-fg2">{p.vlan || "—"}</Td>
                <Td>{q ? <Link className="text-accent" to={`/hardware/${q.device}#${encodeURIComponent(PORT_TAB)}`}>{deviceName(q.device)} · {q.name}</Link> : <span className="text-fg3">{t("Not cabled")}</span>}</Td>
                <Td className="w-24 whitespace-nowrap text-right">
                  <IconButton label={t("Edit port {name}", { name: p.name })} icon={PencilSquareIcon} onClick={() => setEdit(p)} />
                  <IconButton label={t("Delete port {name}", { name: p.name })} icon={TrashIcon} onClick={() => remove(p)} />
                </Td>
              </tr>
            )
          })}
        </Table>
      )}
    </Panel>
  </>
}

export function HardwareRecord({ id }: { id: string }) {
  const ports = useApi(id === "new" ? null : `/api/c/ports?filter=${encodeURIComponent(`device = '${id}'`)}&perPage=500`, { poll: false })
  const tabs = [
    { id: PORT_TAB, label: PORT_TAB, count: ports.data?.totalItems, render: (_: any, row: any) => <Ports device={row} onChange={ports.reload} /> },
    { id: "Links", label: "Links", render: (form: any) => <><LinkedAddresses device={form.name} /><RunsHere host={form.name} /></> },
  ]
  const { cols, where } = useHardwareCols()
  return <RecordPage title={t("Hardware")} singular="hardware" collection="hardware" cols={cols} path="/hardware" id={id} defaults={HW_DEFAULTS} aside={(form) => HardwareAside(form, where(form))} tabs={tabs} history />
}

function consoleUrl(pve: string, a: any) {
  if (!pve || !a.vmid || !a.pve_node) return ""
  return `/api/proxmox/console?console=${a.type === "vm" ? "kvm" : "lxc"}&vmid=${a.vmid}&vmname=${encodeURIComponent(a.name)}&node=${encodeURIComponent(a.pve_node)}`
}

const VIRTUAL_TYPES: Record<string, Icon> = { vm: ComputerDesktopIcon, container: CubeIcon, docker: CubeTransparentIcon }
const VIRTUAL: Col[] = [
  { key: "type", label: "Type", type: "select", options: Object.keys(VIRTUAL_TYPES), icons: VIRTUAL_TYPES, formOnly: true },
  { key: "name", label: "Name", required: true, section: "Identity" },
  { key: "type", label: "Type", type: "select", options: Object.keys(VIRTUAL_TYPES), listOnly: true },
  { key: "parent", label: "Runs on", suggest: true, hint: "The name of a device of the hardware inventory." },
  { key: "hostname", label: "Hostname", formOnly: true },
  { key: "ip", label: "Address", mono: true },
  { key: "status", label: "Status", suggest: true },
  { key: "vcpu", label: "vCPU", type: "number", formOnly: true, section: "Resources" },
  { key: "ram_mb", label: "RAM (MB)", type: "number", formOnly: true },
  { key: "disk_gb", label: "Disk (GB)", type: "number", formOnly: true },
  { key: "vmid", label: "Proxmox VMID", type: "number", formOnly: true, section: "Proxmox", when: { key: "type", in: ["vm", "container"] } },
  { key: "pve_node", label: "Proxmox node", formOnly: true, when: { key: "type", in: ["vm", "container"] } },
  { key: "source", label: "Source", listOnly: true },
  { key: "notes", label: "Notes", type: "area", formOnly: true, section: "Notes" },
]

export function Virtual() {
  const proxmox = useApi("/api/settings/proxmox", { poll: false })
  const cols: Col[] = [...VIRTUAL, { key: "console", label: "Console", listOnly: true, render: (a) => { const url = consoleUrl(proxmox.data?.url ?? "", a); return url ? <a className="text-accent" target="_blank" rel="noreferrer" href={url}>{t("Console")}</a> : "—" } }]
  return <CrudPage title={t("Virtual")} singular="asset" collection="virtual_assets" cols={cols} path="/virtual" facet="type" defaults={{ type: "vm" }} />
}

export function VirtualRecord({ id }: { id: string }) {
  const proxmox = useApi("/api/settings/proxmox", { poll: false })
  const devices = useApi("/api/c/hardware?perPage=500", { poll: false })
  const aside = (form: any) => {
    const url = consoleUrl(proxmox.data?.url ?? "", form)
    const host = devices.data?.items.find((h: any) => same(h.name, form.parent))
    const hw = form.parent && <Link to={host ? `/hardware/${host.id}` : `/search?q=${encodeURIComponent(form.parent)}`} className="text-accent">{form.parent}</Link>
    return <>
      <Panel title={t("Summary")}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-fg2">{t("Runs on")}</dt><dd className="truncate">{hw || "—"}</dd>
          <dt className="text-fg2">{t("Resources")}</dt><dd>{[form.vcpu && `${form.vcpu} vCPU`, form.ram_mb && `${form.ram_mb} MB`, form.disk_gb && `${form.disk_gb} GB`].filter(Boolean).join(" · ") || "—"}</dd>
          <dt className="text-fg2">{t("Address")}</dt><dd className="font-mono">{form.ip || "—"}</dd>
        </dl>
        {url && <a href={url} target="_blank" rel="noreferrer" className="mt-4 inline-block"><Button><CommandLineIcon className="size-5" aria-hidden />{t("Console")}</Button></a>}
      </Panel>
    </>
  }
  const tabs = [{ id: "Links", label: "Links", render: (form: any) => <LinkedAddresses device={form.name} /> }]
  return <RecordPage title={t("Virtual")} singular="asset" collection="virtual_assets" cols={VIRTUAL} path="/virtual" id={id} defaults={{ type: "vm" }} aside={aside} tabs={tabs} history />
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
  const remove = async (d: any) => { if (await ask(`Delete ${d.name}?`, { action: "Delete", danger: true })) { await api(`/api/c/deployments/${d.id}`, { method: "DELETE" }); reload() } }
  const items: WorkItem[] = (data?.items ?? []).map((d: any) => ({
    id: d.id, title: d.name, state: d.status || "planned", tags: parseTags(d.tags), due: d.scheduled_at, open: d.status === "planned" || !d.status,
    detail: [d.target, d.version].filter(Boolean).join(" · "), row: d,
  }))
  return (
    <>
      <PageHeader title={t("Deployments")} onRefresh={reload} actions={<Button variant="primary" onClick={() => setEdit(null)}><PlusIcon className="size-5" aria-hidden />{t("Add deployment")}</Button>} />
      {edit !== undefined && <RecordForm key={edit?.id ?? "new"} cols={DEPLOYMENTS} row={edit} collection="deployments" onDone={done} title={edit ? t("Edit {name}", { name: edit.name }) : "Add deployment"} defaults={{ status: "planned" }} />}
      <Panel title={t("Deployments")}>
        <ErrorNote>{error}</ErrorNote>
        <WorkView id="deployments" states={DEPLOY_STATES} items={items} empty="No deployments yet." onMove={(w, state) => move(w.row, state)} onOpen={(w) => setEdit(w.row)} onRemove={(w) => remove(w.row)} columns={[{ label: "Target", value: (w) => w.row.target }, { label: "Version", value: (w) => w.row.version }]} />
      </Panel>
    </>
  )
}

const TASK_STATES = [{ id: "todo", label: "To do", level: "off" as const }, { id: "doing", label: "In progress", level: "info" as const }, { id: "done", label: "Done", level: "ok" as const }, { id: "cancelled", label: "Cancelled", level: "warn" as const }]
const taskState = (t: any) => t.status || (t.done ? "done" : "todo")

function TaskForm({ row, onDone }: { row: any | null; onDone: () => void }) {
  const split = splitChecklist(row?.description)
  const [f, setF] = useState({ title: row?.title ?? "", notes: split.notes, due: row?.due?.slice(0, 10) ?? "", status: row ? taskState(row) : "todo", tags: row?.tags?.replaceAll(",", ", ") ?? "" })
  const [items, setItems] = useState<Item[]>(split.items)
  const [error, setError] = useState("")
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const { notes, ...rest } = f
    const body = { ...rest, description: joinChecklist(notes, items), due: f.due ? `${f.due} 00:00:00.000Z` : "" }
    try { await api(row ? `/api/tasks/${row.id}` : "/api/tasks", { method: row ? "PATCH" : "POST", body }); onDone() } catch (err) { setError((err as Error).message) }
  }
  const setItem = (i: number, patch: Partial<Item>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const done = items.filter((i) => i.done && i.text.trim()).length, total = items.filter((i) => i.text.trim()).length
  return (
    <Editor title={row ? t("Edit {name}", { name: row.title }) : "Add task"} onCancel={onDone} onSubmit={save} error={error}>
      <EditorGroup title={t("Task")}>
        <div className="col-span-full"><Input label="Title" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <Select label="State" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={TASK_STATES.map((s) => ({ value: s.id, label: s.label }))} />
        <Input label="Due date" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
        <div className="col-span-full"><Input label="Tags" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} hint="Separated by commas. They sync with Nextcloud as categories, and the progress is shown per tag." /></div>
      </EditorGroup>
      <EditorGroup title={t("Checklist")}>
        <div className="col-span-full flex flex-col gap-2">
          {total > 0 && <div className="flex items-center gap-3 text-[13px] text-fg2"><div className="flex-1"><Progress thin pct={Math.round((done / total) * 100)} label={t("Checklist")} /></div>{done}/{total}</div>}
          {items.map((it, i) => (
            <div key={i} className="flex items-center gap-2">
              <input type="checkbox" aria-label={t("Done")} checked={it.done} onChange={(e) => setItem(i, { done: e.target.checked })} className="size-5 shrink-0 accent-[var(--color-accent)]" />
              <input aria-label={t("Step {n}", { n: i + 1 })} value={it.text} onChange={(e) => setItem(i, { text: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setItems([...items.slice(0, i + 1), { text: "", done: false }, ...items.slice(i + 1)]) } }}
                className={`field h-9 max-sm:h-11 flex-1 rounded-control border border-line2 bg-raised px-3 ${it.done ? "text-fg3 line-through" : "text-fg"}`} />
              <IconButton label="Remove" icon={XMarkIcon} onClick={() => setItems(items.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div><Button onClick={() => setItems([...items, { text: "", done: false }])}><PlusIcon className="size-5" aria-hidden />{t("Add a step")}</Button></div>
          <p className="text-xs text-fg3">{t("Steps are saved in the description as a Markdown checklist, so Nextcloud shows them too.")}</p>
        </div>
      </EditorGroup>
      <EditorGroup title={t("Notes")}>
        <div className="col-span-full"><TextArea label="Description" rows={4} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
      </EditorGroup>
    </Editor>
  )
}

export function Tasks() {
  const { data, reload, error } = useApi<any[]>("/api/tasks")
  const [edit, setEdit] = useState<any | null | undefined>()
  const [note, setNote] = useState("")
  const [quick, setQuick] = useState("")
  const done = () => { setEdit(undefined); reload() }
  const move = async (task: any, status: string) => { await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { ...task, status } }); reload() }
  const remove = async (task: any) => { if (await ask(t("Delete {name}?", { name: task.title }), { action: "Delete", danger: true })) { await api(`/api/tasks/${task.id}`, { method: "DELETE" }); reload() } }
  const sync = async () => { try { await api("/api/sync", { method: "POST" }); setNote(t("Synced.")); reload() } catch (e) { setNote((e as Error).message) } }
  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!quick.trim()) return
    try { await api("/api/tasks", { body: { title: quick.trim(), status: "todo", description: "", due: "", tags: "" } }); setQuick(""); reload() } catch (err) { setNote((err as Error).message) }
  }
  const items: WorkItem[] = (data ?? []).map((task) => {
    const list = splitChecklist(task.description).items
    return {
      id: task.id, title: task.title, state: taskState(task), tags: parseTags(task.tags), due: task.due, open: !task.done, readOnly: task.kind === "event", row: task,
      detail: task.kind === "event" ? t("Calendar") : task.uid ? "Nextcloud" : "", checklist: { done: list.filter((i) => i.done).length, total: list.length },
    }
  })
  return (
    <>
      <PageHeader title={t("Tasks")} subtitle={note} actions={<>
        <Button onClick={sync}><ArrowPathIcon className="size-5" aria-hidden />{t("Sync")}</Button>
        <Button variant="primary" onClick={() => setEdit(null)}><PlusIcon className="size-5" aria-hidden />{t("Add task")}</Button>
      </>} />
      {edit !== undefined && <TaskForm key={edit?.id ?? "new"} row={edit} onDone={done} />}
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] items-start gap-4 max-lg:grid-cols-1">
        <Panel title={t("Tasks and events")}>
          <ErrorNote>{error}</ErrorNote>
          <form onSubmit={add} className="mb-4 flex gap-2">
            <input aria-label={t("New task")} placeholder={t("Add a task and press Enter…")} value={quick} onChange={(e) => setQuick(e.target.value)} className="field h-9 max-sm:h-11 flex-1 rounded-control border border-line2 bg-raised px-4 placeholder:text-fg3 max-sm:text-base" />
            <Button type="submit" disabled={!quick.trim()}>{t("Add")}</Button>
          </form>
          <WorkView id="tasks" states={TASK_STATES} items={items} empty="No tasks. Add one, or link Nextcloud in Settings to sync them." onMove={(w, state) => move(w.row, state)} onOpen={(w) => setEdit(w.row)} onRemove={(w) => remove(w.row)} columns={[{ label: "From", value: (w) => w.detail || "Nyx" }]} />
        </Panel>
        <Panel title={t("Progress")}><ProgressSummary /></Panel>
      </div>
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
    <Panel title={t("Detected on your hosts")} flush>
      {seen.length === 0 ? <div className="px-4 pb-4"><Empty>{monitor.data ? "No agent reports a tunnel." : "Link a monitor in Settings to detect VPN tunnels."}</Empty></div> : (
        <Table head={["Host", "Interface", "Type", "Address", "State", ""]}>
          {seen.map((v) => (
            <tr key={`${v.hostId}${v.iface}`}>
              <Td className="font-medium">{v.host}</Td>
              <Td mono>{v.iface}</Td>
              <Td className="text-fg2">{v.kind}</Td>
              <Td mono>{v.ip || "—"}</Td>
              <Td><Status level={v.up ? "ok" : "crit"} label={v.up ? "Up" : "Down"} /></Td>
              <Td className="text-right">{tracked(v.host, v) ? <span className="text-fg3">{t("Tracked")}</span> : <Button variant="ghost" onClick={() => setTrack({ name: `${v.host} ${v.kind}`, kind: v.kind, side_a: v.host, status: "Active" })}>{t("Track")}</Button>}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  )
  return (
    <>
      <CrudPage key={version} title={t("VPN links")} singular="VPN link" collection="vpn_links" cols={VPN} defaults={{ status: "Active" }} onChanged={known.reload} extra={<>
        {track && <RecordForm cols={VPN} row={null} collection="vpn_links" title={t("Track VPN link")} defaults={track} rows={known.data?.items} onDone={() => { setTrack(undefined); changed() }} />}
        {detected}
      </>} />
    </>
  )
}


const SEARCHED = [
  { coll: "hardware", to: "/hardware", fields: ["name", "serial", "model", "location"], record: true },
  { coll: "virtual_assets", to: "/virtual", fields: ["name", "hostname", "ip"], record: true },
  { coll: "ip_addresses", to: "/ipam", fields: ["address", "device", "hostname", "mac"] },
  { coll: "subnets", to: "/ipam", fields: ["name", "cidr", "description", "section"] },
  { coll: "vlans", to: "/ipam", fields: ["name", "domain", "description"] },
  { coll: "sites", to: "/sites", fields: ["name", "repo"] },
  { coll: "vpn_links", to: "/vpn", fields: ["name", "side_a", "side_b", "subnet"] },
]

function Hits({ q, coll, to, fields, record }: { q: string; coll: string; to: string; fields: string[]; record?: boolean }) {
  const { data } = useApi(`/api/c/${coll}?perPage=500`, { poll: false })
  const hits = data?.items.filter((r: any) => fields.some((f) => r[f]?.toLowerCase().includes(q))) ?? []
  return hits.map((r: any) => <li key={r.id}><Link className="text-accent" to={record ? `${to}/${r.id}` : to}>{r[fields[0]]}</Link> <span className="text-fg3">{fields.slice(1).map((f) => r[f]).filter(Boolean).join(" · ")}</span></li>)
}

export function SearchPage() {
  const [q, setQ] = useState(new URLSearchParams(location.search).get("q") ?? "")
  const n = q.trim().toLowerCase()
  return (
    <>
      <PageHeader title={t("Search")} />
      <Section>
        <Input label="Search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
        <Panel title={t("Results")}>
          {n ? <ul className="flex flex-col gap-2">{SEARCHED.map((s) => <Hits key={s.coll} q={n} {...s} />)}</ul> : <Empty>{t("Type a name, address, serial number or repository.")}</Empty>}
        </Panel>
      </Section>
    </>
  )
}

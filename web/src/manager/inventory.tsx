import { ArrowsRightLeftIcon, Bars4Icon, BoltIcon, CircleStackIcon, CommandLineIcon, ComputerDesktopIcon, CpuChipIcon, CubeIcon, CubeTransparentIcon, PencilSquareIcon, PlusIcon, PowerIcon, PrinterIcon, RectangleStackIcon, ServerIcon, ShieldCheckIcon, SignalIcon, TrashIcon, ViewColumnsIcon, WifiIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Button, Empty, ErrorNote, type Icon, IconButton, Input, Mono, Panel, SearchInput, Status, Table, Tabs, Td, Variable, ask } from "../ui/components"
import { t } from "../ui/i18n"
import { type Col, CrudPage, RecordForm, RecordPage } from "../ui/crud"
import { api, fmt, type Level, levelText, sortRows, useApi, useStored } from "../ui/lib"
import { Link, navigate, PageHeader, Section } from "../ui/shell"
import { spot } from "./racks"
import { DeviceInterventions } from "./work"

export const STATUS_LEVEL: Record<string, Level> = { "In service": "ok", Spare: "info", Broken: "crit", Retired: "off" }
export const CATEGORIES: Record<string, Icon> = { Server: ServerIcon, Switch: ArrowsRightLeftIcon, Router: SignalIcon, Firewall: ShieldCheckIcon, NAS: CircleStackIcon, UPS: BoltIcon, "Access point": WifiIcon, "Patch panel": Bars4Icon, PDU: PowerIcon, Printer: PrinterIcon, Other: CubeIcon }
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

export const HARDWARE: Col[] = [
  { key: "category", label: "Category", type: "select", options: Object.keys(CATEGORIES), icons: CATEGORIES, formOnly: true },
  { key: "name", label: "Name", required: true, section: "Identity" },
  { key: "category", label: "Category", type: "select", options: Object.keys(CATEGORIES), render: categoryCell, listOnly: true },
  { key: "manufacturer", label: "Manufacturer", suggest: true },
  { key: "model", label: "Model", suggest: true },
  { key: "serial", label: "Serial number", mono: true },
  ...SPECS,
  { key: "location", label: "Location", suggest: true, section: "Where it is" },
  { key: "status", label: "Status", type: "select", options: Object.keys(STATUS_LEVEL), render: (h) => h.status ? <Status cell level={STATUS_LEVEL[h.status] ?? "off"} label={h.status} /> : "—" },
  { key: "tags", label: "Tags", type: "tags", hint: "Free labels such as lab, prod or rack-A, to group and filter." },
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
export const HW_DEFAULTS = { category: "Server", status: "In service" }

/** The hardware fields, with where the device sits among the racks of the Racks page. */
function useHardwareCols() {
  const { data } = useApi("/api/c/racks?sort=name&perPage=200", { poll: false })
  const racks: any[] = data?.items ?? []
  const where = (h: any) => { const r = racks.find((x) => x.id === h.rack); return r ? `${r.name}${h.rack_u ? ` · ${spot(r, h)}` : ""}` : "" }
  const cols = HARDWARE.flatMap((c): Col[] => c.key !== "location" ? [c] : [c,
    { key: "rack", label: "Place", type: "select", choices: racks.map((x) => ({ value: x.id, label: x.name })), render: (h) => where(h) || "—", hint: "A rack, a shelving unit or a desk. Drag it into place on the Places page." },
    { key: "rack_u", label: "Position (U or level)", type: "number", formOnly: true, hint: "The lowest unit it fills in a rack, or the level of a shelf, 1 at the bottom." },
    { key: "rack_units", label: "Height (U)", type: "number", formOnly: true },
  ])
  return { cols, where }
}

const VIRTUAL_LABELS: Record<string, string> = { vm: "Virtual machine", container: "Container", docker: "Docker" }

/**
 * The inventory as one table, grouped by place or category: each device is followed by what
 * runs on it, and that by what runs inside, as their Runs on field says.
 */
function InventoryTree({ toggle }: { toggle: React.ReactNode }) {
  const hw = useApi("/api/c/hardware?sort=name&perPage=500", { poll: false })
  const racks = useApi("/api/c/racks?sort=name&perPage=200", { poll: false })
  const va = useApi("/api/c/virtual_assets?sort=name&perPage=500", { poll: false })
  const [query, setQuery] = useState("")
  const [group, setGroup] = useStored("nyx.inventory.group", "place")
  const all: any[] = hw.data?.items ?? []
  const virtual: any[] = va.data?.items ?? []
  const places: any[] = racks.data?.items ?? []
  const placeOf = (h: any) => places.find((p) => p.id === h.rack && h.rack_u > 0)
  const needle = query.trim().toLowerCase()
  const hit = (r: any) => !needle || [r.name, r.model, r.manufacturer, r.serial, r.location, r.ip, r.mgmt_ip, r.tags].some((v) => String(v ?? "").toLowerCase().includes(needle))
  // shortcut: a guest naming itself as its own parent would loop; depth stops at 3, enough for host, VM, Docker.
  const inside = (name: string, depth = 0): any[] => (depth > 2 ? [] : virtual.filter((g) => same(g.parent, name)))
  const matches = (r: any, depth = 0): boolean => hit(r) || inside(r.name, depth).some((g) => matches(g, depth + 1))
  const shown = all.filter((h) => matches(h))
  const loose = virtual.filter((g) => !g.parent || ![...all, ...virtual].some((r) => same(g.parent, r.name))).filter((g) => matches(g, 1))
  const groups: [string, any[]][] = group === "place"
    ? [...places.map((p) => [p.name, shown.filter((h) => placeOf(h) === p)] as [string, any[]]), [t("Not placed"), shown.filter((h) => !placeOf(h))]]
    : group === "category" ? Object.keys(CATEGORIES).map((c) => [t(c), shown.filter((h) => (h.category || "Other") === c)] as [string, any[]])
    : [["", shown]]
  /** A virtual asset, then what runs inside it, indented one step further. */
  const guestRows = (g: any, depth: number): React.ReactNode[] => {
    const G = VIRTUAL_TYPES[g.type] ?? CubeIcon
    return [
      <tr key={g.id}>
        <Td><span className="flex items-center gap-2" style={{ paddingLeft: `${Math.max(0, depth - 1) * 1.5}rem` }}>{depth > 0 && <span className="text-fg3" aria-hidden>└</span>}<G className="size-4 shrink-0 text-fg3" aria-hidden /><Link to={`/virtual/${g.id}`} className="hover:text-accent">{g.name}</Link></span>{depth === 0 && g.parent && <span className="block pl-6 text-xs text-fg3">{t("Runs on {name}, not in the inventory", { name: g.parent })}</span>}</Td>
        <Td className="text-fg2">{t(VIRTUAL_LABELS[g.type] ?? "Other")}</Td>
        <Td className="text-fg2">{[g.vcpu && `${g.vcpu} vCPU`, g.ram_mb && `${g.ram_mb} MB`, g.disk_gb && `${g.disk_gb} GB`].filter(Boolean).join(" · ") || "—"}</Td>
        <Td mono>{g.ip || "—"}</Td>
        <Td className="text-fg2">{g.status || "—"}</Td>
        <Td className="text-fg3">—</Td>
      </tr>,
      ...under(g.name, depth + 1),
    ]
  }
  const under = (name: string, depth: number) => inside(name, depth).filter((g) => matches(g, depth)).flatMap((g) => guestRows(g, depth))
  const heading = (name: string, n: number) => name ? <tr key={`g:${name}`}><Td colSpan={6} className="bg-bg text-[13px] font-medium text-fg2">{name} <span className="font-normal text-fg3">· {n}</span></Td></tr> : null
  return (
    <>
      <PageHeader title={t("Inventory")} variables={toggle} actions={<Button variant="primary" onClick={() => navigate("/hardware/new")}><PlusIcon className="size-5" aria-hidden />{t("Add hardware")}</Button>} />
      <Section>
        <ErrorNote>{hw.error || va.error}</ErrorNote>
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput placeholder="Name, model, address or serial number" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Variable label="Group by" value={group} onChange={setGroup} options={[{ value: "place", label: "Place" }, { value: "category", label: "Category" }, { value: "", label: "None" }]} />
        </div>
        <Panel title={t("{n} devices, {m} virtual", { n: all.length, m: virtual.length })} flush loading={!hw.data || !va.data}>
          {all.length === 0 && virtual.length === 0 ? <div className="px-4 pb-4"><Empty>{t("No hardware yet. Add your servers, switches and other devices, then give them a place.")}</Empty></div> : (
            <Table head={["Name", "Type", "Model or resources", "Address", "Status", "Warranty"]}>
              {groups.filter(([, rows]) => rows.length).flatMap(([name, rows]) => [heading(name, rows.length), ...rows.flatMap((h) => {
                const I = CATEGORIES[h.category] ?? CubeIcon, w = warranty(h.warranty_until), place = placeOf(h)
                return [
                  <tr key={h.id}>
                    <Td className="font-medium"><span className="flex items-center gap-2"><I className="size-4 shrink-0 text-fg3" aria-hidden /><Link to={`/hardware/${h.id}`} className="hover:text-accent">{h.name}</Link></span>{group !== "place" && place && <span className="block pl-6 text-xs font-normal text-fg3">{place.name} · {spot(place, h)}</span>}</Td>
                    <Td className="text-fg2">{t(h.category || "Other")}</Td>
                    <Td className="text-fg2">{[h.manufacturer, h.model].filter(Boolean).join(" ") || "—"}</Td>
                    <Td mono>{h.mgmt_ip || "—"}</Td>
                    <Td>{h.status ? <Status cell level={STATUS_LEVEL[h.status] ?? "off"} label={h.status} /> : "—"}</Td>
                    <Td className={w ? levelText[w.level] : "text-fg3"}>{w?.label ?? "—"}</Td>
                  </tr>,
                  ...under(h.name, 1),
                ]
              })])}
              {loose.length > 0 && [heading(t("Not on a device"), loose.length), ...loose.flatMap((g) => guestRows(g, 0))]}
            </Table>
          )}
        </Panel>
      </Section>
    </>
  )
}

export function Hardware() {
  const { cols } = useHardwareCols()
  const [mode, setMode] = useStored("nyx.inventory.mode", "table")
  const toggle = <Tabs tabs={[{ id: "table", label: "Table" }, { id: "tree", label: "Tree" }]} value={mode === "table" ? "table" : "tree"} onChange={setMode} />
  if (mode !== "table") return <InventoryTree toggle={toggle} />
  return <CrudPage title={t("Hardware")} heading={t("Inventory")} variables={toggle} singular="hardware" collection="hardware" cols={cols} defaults={HW_DEFAULTS} path="/hardware" facet="category" />
}

// The parts inside the hardware, after GLPI's components: what they are, where they are
// fitted, and whether they are used, kept as spares or decommissioned.
export const PART_TYPES: Record<string, Icon> = { "Hard disk": CircleStackIcon, SSD: RectangleStackIcon, CPU: CpuChipIcon, RAM: ViewColumnsIcon, GPU: ComputerDesktopIcon, "Network card": ArrowsRightLeftIcon, "Power supply": BoltIcon, Other: CubeIcon }
const PART_STATUS: Record<string, Level> = { "In service": "ok", Spare: "info", Decommissioned: "off" }
const partType = (c: any) => { const I = PART_TYPES[c.type]; return c.type ? <span className="flex items-center gap-2">{I && <I className="size-4" aria-hidden />}{t(c.type)}</span> : "—" }
const partStatus = (c: any) => c.status ? <Status cell level={PART_STATUS[c.status] ?? "off"} label={c.status} /> : "—"

function partCols(devices: any[]): Col[] {
  const name = (id: string) => devices.find((h) => h.id === id)?.name
  return [
    { key: "type", label: "Type", type: "select", options: Object.keys(PART_TYPES), icons: PART_TYPES, formOnly: true },
    { key: "name", label: "Name", required: true, section: "Identity", hint: "Such as Disk 2 of nas-01." },
    { key: "type", label: "Type", type: "select", options: Object.keys(PART_TYPES), render: partType, listOnly: true },
    { key: "manufacturer", label: "Manufacturer", suggest: true },
    { key: "model", label: "Model", suggest: true },
    { key: "capacity", label: "Capacity", suggest: true, hint: "Size, speed or cores, such as 8 TB, 32 GB DDR4-3200 or 8 cores." },
    { key: "serial", label: "Serial number", mono: true, formOnly: true },
    { key: "device", label: "Fitted in", type: "select", section: "Where it is", choices: sortRows(devices.map((h) => ({ value: h.id, label: h.name })), (o) => o.label),
      render: (c) => name(c.device) ? <Link to={`/hardware/${c.device}`} className="hover:text-accent">{name(c.device)}</Link> : <span className="text-fg3">{t("On a shelf")}</span>, hint: "Leave it empty for a part waiting on a shelf." },
    { key: "slot", label: "Slot", hint: "Bay, memory slot or PCIe slot." },
    { key: "status", label: "Status", type: "select", options: Object.keys(PART_STATUS), render: partStatus },
    { key: "decommissioned_at", label: "Decommissioned on", type: "date", formOnly: true, when: { key: "status", in: ["Decommissioned"] } },
    { key: "purchased_at", label: "Purchased", type: "date", formOnly: true, section: "Purchase and warranty" },
    { key: "warranty_until", label: "Warranty until", type: "date", formOnly: true },
    { key: "tags", label: "Tags", type: "tags", formOnly: true },
    { key: "notes", label: "Notes", type: "area", formOnly: true, section: "Notes" },
  ]
}
export const PART_DEFAULTS = { type: "Hard disk", status: "In service" }

export function Components() {
  const hw = useApi("/api/c/hardware?sort=name&perPage=500", { poll: false })
  return <CrudPage title={t("Components")} singular="component" collection="components" cols={partCols(hw.data?.items ?? [])} defaults={PART_DEFAULTS} facet="type" />
}

/** The parts fitted in one device, on its page. */
function Fitted({ device, parts }: { device: any; parts: ReturnType<typeof useApi<any>> }) {
  const [edit, setEdit] = useState<any | null | undefined>()
  const rows: any[] = parts.data?.items ?? []
  const cols = partCols([device])
  const remove = async (c: any) => { if (await ask(t("Delete {name}?", { name: c.name }), { action: "Delete", danger: true })) { await api(`/api/c/components/${c.id}`, { method: "DELETE" }); parts.reload() } }
  return <>
    {edit !== undefined && <RecordForm key={edit?.id ?? "new"} cols={cols} row={edit} collection="components" rows={rows} title={edit ? t("Edit {name}", { name: edit.name }) : "Add component"}
      defaults={{ ...PART_DEFAULTS, device: device.id }} onDone={() => { setEdit(undefined); parts.reload() }} />}
    <Panel title={t(rows.length === 1 ? "{n} component" : "{n} components", { n: rows.length })} flush actions={[{ label: "Add component", onClick: () => setEdit(null) }, { label: "All components", onClick: () => navigate("/components") }]}>
      <ErrorNote>{parts.error}</ErrorNote>
      {rows.length === 0 ? <div className="px-4 pb-4"><Empty>{t("No component yet. Add its disks, memory or CPU to know what it holds, what is spare and what was decommissioned.")}</Empty></div> : (
        <Table head={["Component", "Type", "Capacity", "Slot", "Status", ""]}>
          {rows.map((c) => (
            <tr key={c.id} className={c.status === "Decommissioned" ? "text-fg3" : ""}>
              <Td className="font-medium"><span className="block">{c.name}</span><span className="block text-xs font-normal text-fg3">{[c.manufacturer, c.model, c.serial].filter(Boolean).join(" · ")}</span></Td>
              <Td className="text-fg2">{partType(c)}</Td>
              <Td className="text-fg2">{c.capacity || "—"}</Td>
              <Td className="text-fg2">{c.slot || "—"}</Td>
              <Td>{partStatus(c)}</Td>
              <Td className="w-24 whitespace-nowrap text-right">
                <IconButton label={t("Edit {name}", { name: c.name })} icon={PencilSquareIcon} onClick={() => setEdit(c)} />
                <IconButton label={t("Delete {name}", { name: c.name })} icon={TrashIcon} onClick={() => remove(c)} />
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  </>
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
        <dt className="text-fg2">{t("Place")}</dt><dd className="truncate">{rack ? <Link to="/racks" className="text-accent">{rack}</Link> : "—"}</dd>
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
    <Panel title={t(mine.length === 1 ? "{n} port" : "{n} ports", { n: mine.length })} flush actions={[{ label: "Add port", onClick: () => setEdit(null) }]}>
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
  const parts = useApi(id === "new" ? null : `/api/c/components?filter=${encodeURIComponent(`device = '${id}'`)}&sort=type,name&perPage=500`, { poll: false })
  const tabs = [
    { id: "Components", label: "Components", count: parts.data?.totalItems, render: (_: any, row: any) => <Fitted device={row} parts={parts} /> },
    { id: PORT_TAB, label: PORT_TAB, count: ports.data?.totalItems, render: (_: any, row: any) => <Ports device={row} onChange={ports.reload} /> },
    { id: "Interventions", label: "Interventions", render: (_: any, row: any) => <DeviceInterventions name={row.name} /> },
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
  { key: "tags", label: "Tags", type: "tags", hint: "Free labels such as lab, prod or rack-A, to group and filter." },
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
  const tabs = [
    { id: "Interventions", label: "Interventions", render: (_: any, row: any) => <DeviceInterventions name={row.name} /> },
    { id: "Links", label: "Links", render: (form: any) => <LinkedAddresses device={form.name} /> },
  ]
  return <RecordPage title={t("Virtual")} singular="asset" collection="virtual_assets" cols={VIRTUAL} path="/virtual" id={id} defaults={{ type: "vm" }} aside={aside} tabs={tabs} history />
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

export const Vpn = () => <CrudPage title={t("VPN links")} singular="VPN link" collection="vpn_links" cols={VPN} defaults={{ status: "Active" }} />


const SEARCHED = [
  { coll: "hardware", to: "/hardware", fields: ["name", "serial", "model", "location"], record: true },
  { coll: "components", to: "/components", fields: ["name", "serial", "model", "capacity"] },
  { coll: "virtual_assets", to: "/virtual", fields: ["name", "hostname", "ip"], record: true },
  { coll: "ip_addresses", to: "/ipam", fields: ["address", "device", "hostname", "mac"] },
  { coll: "subnets", to: "/ipam", fields: ["name", "cidr", "description", "section"] },
  { coll: "vlans", to: "/ipam", fields: ["name", "domain", "description"] },
  { coll: "interventions", to: "/work", fields: ["title", "asset", "type"] },
  { coll: "deployments", to: "/work", fields: ["name", "target", "version"] },
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

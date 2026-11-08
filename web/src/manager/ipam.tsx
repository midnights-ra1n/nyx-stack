import { PencilSquareIcon, PlusIcon, SignalIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { Button, Empty, ErrorNote, IconButton, Input, Meter, Mono, Panel, Stat, Status, Table, Tabs, Td, Variable } from "../ui/components"
import { type Col, CrudPage, RecordForm } from "../ui/crud"
import { api, fmt, useApi, useStored } from "../ui/lib"
import { Link, PageHeader, Section } from "../ui/shell"

export const STATES = ["Active", "Reserved", "DHCP", "Offline"]

/** IPv4 as a number, or null for anything else. */
export function ip4(s: string): number | null {
  const p = s.trim().split(".")
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) < 256)) return null
  return p.reduce((a, x) => a * 256 + Number(x), 0)
}
export const ip4str = (n: number) => [24, 16, 8, 0].map((b) => Math.floor(n / 2 ** b) % 256).join(".")

/** Largest subnet drawn cell by cell. */
const MAP_CELLS = 1024

export type Cell = { ip: string; kind: "network" | "broadcast" | "gateway" | "free" | "alive" | "seen" | (typeof STATES)[number]; row?: any }

/** One cell per address of a small IPv4 subnet, with what holds it. */
export function addressMap(cidr: string, gateway: string, addresses: any[], alive: string[], seen: string[]): Cell[] | null {
  const [base, len] = cidr.split("/")
  const start = ip4(base), prefix = Number(len)
  if (start == null || !(prefix >= 22 && prefix <= 32)) return null
  const size = 2 ** (32 - prefix)
  if (size > MAP_CELLS) return null
  const byIp = new Map(addresses.map((a) => [a.address, a]))
  return Array.from({ length: size }, (_, i) => {
    const ip = ip4str(start + i)
    const row = byIp.get(ip)
    if (row) return { ip, kind: STATES.includes(row.state) ? row.state : "Active", row }
    if (size > 2 && i === 0) return { ip, kind: "network" }
    if (size > 2 && i === size - 1) return { ip, kind: "broadcast" }
    if (ip === gateway) return { ip, kind: "gateway" }
    if (alive.includes(ip)) return { ip, kind: "alive" }
    if (seen.includes(ip)) return { ip, kind: "seen" }
    return { ip, kind: "free" }
  })
}

const CELL: Record<string, [string, string]> = {
  Active: ["bg-accent", "Active"],
  Reserved: ["bg-warn", "Reserved"],
  DHCP: ["bg-info", "DHCP"],
  Offline: ["bg-off/50", "Offline"],
  gateway: ["bg-s3", "Gateway"],
  alive: ["bg-crit", "Answers, not recorded"],
  seen: ["border border-dashed border-fg2", "Known elsewhere"],
  network: ["bg-line", "Network / broadcast"],
  broadcast: ["bg-line", ""],
  free: ["bg-raised", "Free"],
}

const SUBNET_COLS = (vrfs: string[]): Col[] => [
  { key: "name", label: "Name", required: true, section: "Subnet" },
  { key: "cidr", label: "Prefix", mono: true, required: true, hint: "IPv4 or IPv6, for example 192.168.10.0/24. Subnets inside another one nest under it." },
  { key: "gateway", label: "Gateway", mono: true },
  { key: "description", label: "Description" },
  { key: "section", label: "Section", suggest: true, hint: "Groups subnets, for example a site or a customer.", section: "Placement" },
  { key: "vrf", label: "VRF", type: "select", options: vrfs, hint: "The same prefix may exist once per VRF." },
  { key: "vlan", label: "VLAN", type: "number" },
  { key: "location", label: "Location", suggest: true },
  { key: "threshold", label: "Alert above (%)", type: "number", hint: "Listed as a conflict once usage reaches it. 0 turns it off.", section: "Usage" },
]

const ADDRESS_COLS: Col[] = [
  { key: "address", label: "Address", mono: true, required: true, section: "Address" },
  { key: "state", label: "State", type: "select", options: STATES },
  { key: "device", label: "Device", suggest: true, hint: "Routes and the network map find devices by this name." },
  { key: "hostname", label: "Hostname" },
  { key: "mac", label: "MAC", mono: true, section: "Details" },
  { key: "owner", label: "Owner", suggest: true },
  { key: "note", label: "Note" },
  { key: "last_seen", label: "Last seen", listOnly: true, render: (a) => fmt.ago(a.last_seen) },
]

const ROUTES: Col[] = [
  { key: "device", label: "Device", required: true, hint: "Same name as in the addresses list." },
  { key: "destination", label: "Destination", mono: true, required: true, hint: "CIDR. Use 0.0.0.0/0 for a default route." },
  { key: "next_hop", label: "Next hop", mono: true },
  { key: "metric", label: "Metric", type: "number" },
]

const VRF_COLS: Col[] = [
  { key: "name", label: "Name", required: true },
  { key: "rd", label: "Route distinguisher", mono: true, hint: "For example 65000:10." },
  { key: "description", label: "Description" },
]

const usageCell = (s: any) => (
  <span className="flex min-w-36 items-center gap-3">
    <span className="flex-1"><Meter pct={s.pct} warn={s.threshold || 75} crit={Math.max(s.threshold || 90, 90)} /></span>
    <span className="w-24 whitespace-nowrap text-right text-[13px] text-fg2">{s.used} / {Number(s.capacity) > 1e9 ? "∞" : s.capacity}</span>
  </span>
)

function Conflicts({ data, edit }: { data: any; edit?: any }) {
  return (
    <Panel title="Conflicts" edit={edit} badge={data?.conflicts.length ? <Status level="warn" label={String(data.conflicts.length)} /> : undefined}>
      {data?.conflicts.length ? <ul className="flex flex-col gap-2">{data.conflicts.map((c: any) => <li key={c.message} className="flex items-baseline gap-3"><Status level={c.severity} /><span>{c.message}</span></li>)}</ul> : <Empty>No conflicts.</Empty>}
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
        <Input label="To address" required value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="10.0.2.20" />
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

const CALC_ROWS: [string, string][] = [["network", "Network"], ["prefix", "Prefix length"], ["netmask", "Netmask"], ["wildcard", "Wildcard"], ["broadcast", "Broadcast"], ["first", "First host"], ["last", "Last host"], ["usable", "Usable hosts"], ["total", "Addresses"]]

function CalcTable({ calc }: { calc: any }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
      {CALC_ROWS.filter(([k]) => calc[k] != null).map(([k, label]) => <div key={k} className="contents"><dt className="text-fg2">{label}</dt><dd><Mono>{String(calc[k])}</Mono></dd></div>)}
    </dl>
  )
}

function Calculator({ edit }: { edit: any }) {
  const [cidr, setCidr] = useState("")
  const [calc, setCalc] = useState<any>()
  const [error, setError] = useState("")
  const run = async (e: React.FormEvent) => {
    e.preventDefault()
    try { setCalc(await api(`/api/ipam/calc?cidr=${encodeURIComponent(cidr)}`)); setError("") } catch (err) { setError((err as Error).message); setCalc(undefined) }
  }
  return (
    <Panel title="Subnet calculator" edit={edit}>
      <form className="grid grid-cols-[1fr_auto] items-end gap-4" onSubmit={run}>
        <Input label="Prefix" required placeholder="192.168.1.0/24" value={cidr} onChange={(e) => setCidr(e.target.value)} />
        <Button type="submit">Calculate</Button>
      </form>
      <div className="mt-4"><ErrorNote>{error}</ErrorNote>{calc && <CalcTable calc={calc} />}</div>
    </Panel>
  )
}

function Usage({ report, edit }: { report: any; edit: any }) {
  const top = [...(report?.subnets ?? [])].sort((a, b) => b.pct - a.pct).slice(0, 8)
  return (
    <Panel title="Fullest subnets" flush edit={edit}>
      {top.length ? (
        <Table head={["Subnet", "Prefix", "Usage"]}>
          {top.map((s) => <tr key={s.id}><Td className="font-medium"><Link to={`/ipam/subnet/${s.id}`} className="hover:text-accent">{s.name}</Link></Td><Td mono>{s.cidr}</Td><Td>{usageCell(s)}</Td></tr>)}
        </Table>
      ) : <div className="px-4 pb-4"><Empty>Add a subnet to see its usage.</Empty></div>}
    </Panel>
  )
}

/** Subnets as a tree, one table per section. */
function Subnets({ report, reload, tabs }: { report: any; reload: () => void; tabs: React.ReactNode }) {
  const rows = useApi("/api/c/subnets?perPage=500", { poll: false })
  const vrfs = useApi("/api/c/vrfs?sort=name&perPage=500", { poll: false })
  const vlans = useApi("/api/c/vlans?perPage=500", { poll: false })
  const [edit, setEdit] = useState<any | null | undefined>()
  const [query, setQuery] = useState("")
  const [section, setSection] = useState("")
  const all: any[] = report?.subnets ?? []
  const record = (id: string) => rows.data?.items.find((r: any) => r.id === id)
  const sections = [...new Set(all.map((s) => s.section || ""))].sort()
  const n = query.trim().toLowerCase()
  const shown = all.filter((s) => (!section || (s.section || "") === section) && (!n || [s.name, s.cidr, s.description, s.vrf, String(s.vlan || "")].some((v) => v?.toLowerCase().includes(n))))
  const vlanName = (num: number) => vlans.data?.items.find((v: any) => v.number === num)?.name
  const done = () => { setEdit(undefined); reload(); rows.reload() }
  const remove = async (s: any) => { if (confirm(`Delete ${s.name}? Its addresses stay.`)) { await api(`/api/c/subnets/${s.id}`, { method: "DELETE" }); done() } }
  return (
    <>
      <PageHeader title="IPAM" variables={tabs} onRefresh={reload} actions={<Button variant="primary" disabled={edit === null} onClick={() => setEdit(null)}><PlusIcon className="size-5" aria-hidden />Add subnet</Button>} />
      {edit !== undefined && <RecordForm key={edit?.id ?? "new"} cols={SUBNET_COLS((vrfs.data?.items ?? []).map((v: any) => v.name))} row={edit} collection="subnets" onDone={done} title={edit ? `Edit ${edit.name}` : "Add subnet"} rows={rows.data?.items} />}
      <Section>
        {all.length > 0 && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64 max-sm:w-full"><Input label="Search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
            {sections.length > 1 && <Variable label="Section" value={section} onChange={setSection} options={[{ value: "", label: "All" }, ...sections.map((s) => ({ value: s, label: s || "No section" }))]} />}
          </div>
        )}
        {all.length === 0 && report && <Panel title="Subnets"><Empty>No subnets yet. Add the networks you use, the largest first: smaller ones nest under them.</Empty></Panel>}
        {sections.filter((sec) => shown.some((s) => (s.section || "") === sec)).map((sec) => (
          <Panel key={sec} title={sec || (sections.length > 1 ? "No section" : "Subnets")} flush>
            <Table head={["Subnet", "Prefix", "VLAN", "VRF", "Gateway", "Usage", ""]}>
              {shown.filter((s) => (s.section || "") === sec).map((s) => (
                <tr key={s.id} className="hover:bg-raised">
                  <Td className="font-medium"><span className="flex items-center gap-2" style={{ paddingLeft: (n ? 0 : s.depth) * 20 }}>{s.depth > 0 && !n && <span aria-hidden className="text-fg3">└</span>}<Link to={`/ipam/subnet/${s.id}`} className="hover:text-accent">{s.name}</Link></span></Td>
                  <Td mono>{s.cidr}</Td>
                  <Td className="text-fg2">{s.vlan ? `${s.vlan}${vlanName(s.vlan) ? ` · ${vlanName(s.vlan)}` : ""}` : "—"}</Td>
                  <Td className="text-fg2">{s.vrf || "—"}</Td>
                  <Td mono>{s.gateway || "—"}</Td>
                  <Td>{usageCell(s)}</Td>
                  <Td className="w-24 whitespace-nowrap text-right">
                    <IconButton label="Edit" icon={PencilSquareIcon} onClick={() => setEdit(record(s.id))} />
                    <IconButton label="Delete" icon={TrashIcon} onClick={() => remove(s)} />
                  </Td>
                </tr>
              ))}
            </Table>
          </Panel>
        ))}
      </Section>
    </>
  )
}

function Vlans({ report, tabs }: { report: any; tabs: React.ReactNode }) {
  const subnetsOf = (v: any) => (report?.subnets ?? []).filter((s: any) => s.vlan === v.number)
  const cols: Col[] = [
    { key: "number", label: "Number", type: "number", required: true },
    { key: "name", label: "Name", required: true },
    { key: "domain", label: "Domain", suggest: true, hint: "Switch group or site where this number means this VLAN." },
    { key: "description", label: "Description" },
    { key: "subnets", label: "Subnets", listOnly: true, render: (v) => subnetsOf(v).map((s: any) => <Link key={s.id} to={`/ipam/subnet/${s.id}`} className="mr-3 text-accent">{s.cidr}</Link>) },
  ]
  return <CrudPage heading="IPAM" variables={tabs} title="VLANs" singular="VLAN" collection="vlans" cols={cols} sort="number" />
}

const IPAM_TABS = [{ id: "overview", label: "Overview" }, { id: "subnets", label: "Subnets" }, { id: "addresses", label: "Addresses" }, { id: "vlans", label: "VLANs" }, { id: "vrfs", label: "VRFs" }, { id: "routes", label: "Routes" }]

export function Ipam() {
  const [tab, setTab] = useStored("nyx.ipam.tab", "overview")
  const { data, reload } = useApi("/api/ipam/report", { poll: false })
  const tabs = <Tabs tabs={IPAM_TABS} value={tab} onChange={setTab} />
  if (tab === "subnets") return <Subnets report={data} reload={reload} tabs={tabs} />
  if (tab === "addresses") return <CrudPage key={tab} heading="IPAM" variables={tabs} title="Addresses" singular="address" collection="ip_addresses" cols={ADDRESS_COLS} sort="address" onChanged={reload} defaults={{ state: "Active" }} />
  if (tab === "vlans") return <Vlans report={data} tabs={tabs} />
  if (tab === "vrfs") return <CrudPage key={tab} heading="IPAM" variables={tabs} title="VRFs" singular="VRF" collection="vrfs" cols={VRF_COLS} />
  if (tab === "routes") return <CrudPage key={tab} heading="IPAM" variables={tabs} title="Routes" singular="route" collection="routes" cols={ROUTES} sort="device" />
  const subnets = data?.subnets ?? []
  return (
    <>
      <PageHeader title="IPAM" variables={tabs} onRefresh={reload} actions={<CustomizeButton />} />
      <div className="mb-4 grid grid-cols-4 gap-4 max-sm:grid-cols-2">
        <Panel title="Subnets"><Stat label="Recorded" value={subnets.length} /></Panel>
        <Panel title="Addresses"><Stat label="Used" value={subnets.filter((s: any) => s.depth === 0).reduce((n: number, s: any) => n + s.used, 0)} /></Panel>
        <Panel title="Sections"><Stat label="Groups" value={new Set(subnets.map((s: any) => s.section || "")).size} /></Panel>
        <Panel title="Conflicts"><Stat label="To fix" value={data?.conflicts.length ?? "—"} level={data?.conflicts.length ? "warn" : "ok"} /></Panel>
      </div>
      <Board id="ipam" desktop={{ cols: [["conflicts", "usage"], ["calculator", "simulator"]], hidden: [] }} phone={{ cols: [["conflicts", "usage", "calculator", "simulator"]], hidden: [] }} panels={[
        { id: "conflicts", title: "Conflicts", render: (edit: any) => <Conflicts data={data} edit={edit} /> },
        { id: "usage", title: "Fullest subnets", render: (edit: any) => <Usage report={data} edit={edit} /> },
        { id: "calculator", title: "Subnet calculator", render: (edit: any) => <Calculator edit={edit} /> },
        { id: "simulator", title: "Routing simulation", render: (edit: any) => <Simulator edit={edit} /> },
      ]} />
    </>
  )
}

/** One subnet: figures, map of its addresses, free ranges, children and scan. */
export function SubnetPage({ id }: { id: string }) {
  const { data: d, reload, error } = useApi(`/api/ipam/subnet/${id}`, { poll: false })
  const all = useApi("/api/c/ip_addresses?perPage=500", { poll: false })
  const [edit, setEdit] = useState<any | null | undefined>()
  const [editSubnet, setEditSubnet] = useState(false)
  const [scan, setScan] = useState<{ alive: string[]; at: string } | null>(null)
  const [scanning, setScanning] = useState(false)
  const [note, setNote] = useState("")
  const vrfs = useApi("/api/c/vrfs?sort=name&perPage=500", { poll: false })
  if (error) return <p role="alert" className="text-crit">{error}</p>
  if (!d) return null
  const s = d.subnet
  const addresses: any[] = d.addresses
  const alive = scan?.alive ?? []
  const unknown = alive.filter((ip) => !addresses.some((a) => a.address === ip))
  const cells = addressMap(d.calc.network + "/" + d.calc.prefix, s.gateway, addresses, alive, d.seen.map((x: any) => x.address))
  const done = () => { setEdit(undefined); reload(); all.reload() }
  const add = (address: string, extra: any = {}) => setEdit({ ...extra, address, state: "Active", id: undefined, _new: true })
  const remove = async (a: any) => { if (confirm(`Delete ${a.address}?`)) { await api(`/api/c/ip_addresses/${a.id}`, { method: "DELETE" }); done() } }
  const runScan = async () => {
    setScanning(true); setNote("")
    try { setScan(await api(`/api/ipam/scan/${id}`, { method: "POST" })); reload() } catch (e) { setNote((e as Error).message) }
    setScanning(false)
  }
  const used = addresses.length, usable = Number(d.calc.usable)
  const panels = [
    { id: "details", title: "Details", render: (e: any) => (
      <Panel title="Details" edit={e}>
        <div className="mb-4 grid grid-cols-3 gap-4">
          <Stat label="Used" value={used} sub={usable < 1e9 ? `of ${usable}` : undefined} />
          <Stat label="Usage" value={usable < 1e9 ? fmt.pct((used * 100) / Math.max(usable, 1)) : "—"} />
          <Stat label="Free ranges" value={d.free.length} />
        </div>
        <CalcTable calc={d.calc} />
        {(s.description || s.location) && <p className="mt-4 text-fg2">{[s.description, s.location].filter(Boolean).join(" · ")}</p>}
      </Panel>
    ) },
    { id: "map", title: "Address map", absent: !cells, render: (e: any) => (
      <Panel title="Address map" edit={e} footer={scan ? `Scanned ${fmt.ago(scan.at)}: ${alive.length} addresses answered.` : "Press a free address to record it."}>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(18px,1fr))] gap-1" role="list" aria-label="Addresses">
          {cells?.map((c) => {
            const [bg, label] = CELL[c.kind]
            const title = `${c.ip} · ${c.row ? [c.row.device || c.row.hostname, c.kind].filter(Boolean).join(" · ") : label || "Broadcast"}${alive.includes(c.ip) ? " · answers ping" : ""}`
            const clickable = c.row || ["free", "alive", "seen"].includes(c.kind)
            return (
              <button key={c.ip} role="listitem" type="button" title={title} aria-label={title} disabled={!clickable}
                onClick={() => (c.row ? setEdit(c.row) : add(c.ip, d.seen.find((x: any) => x.address === c.ip) ? { device: d.seen.find((x: any) => x.address === c.ip).device } : {}))}
                className={`relative aspect-square rounded-[3px] ${bg} ${clickable ? "hover:outline-2 hover:outline-fg" : "cursor-default"}`}>
                {alive.includes(c.ip) && c.row && <span aria-hidden className="absolute inset-1 rounded-full bg-ok" />}
              </button>
            )
          })}
        </div>
        <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-fg2">
          {Object.entries(CELL).filter(([, [, l]]) => l).map(([k, [bg, l]]) => <li key={k} className="flex items-center gap-1.5"><span aria-hidden className={`size-3 rounded-[2px] ${bg}`} />{l}</li>)}
          {scan && <li className="flex items-center gap-1.5"><span aria-hidden className="relative size-3 rounded-[2px] bg-accent"><span className="absolute inset-[3px] rounded-full bg-ok" /></span>Answers ping</li>}
        </ul>
      </Panel>
    ) },
    { id: "addresses", title: "Addresses", render: (e: any) => (
      <Panel title={`${used} addresses`} flush edit={e}>
        {used === 0 ? <div className="px-4 pb-4"><Empty>No address recorded in this subnet.</Empty></div> : (
          <Table head={["Address", "State", "Device", "Hostname", "MAC", "Owner", "Last seen", ""]}>
            {addresses.map((a) => (
              <tr key={a.id}>
                <Td mono className="font-medium">{a.address}</Td>
                <Td className="text-fg2">{a.state || "Active"}</Td>
                <Td>{a.device || "—"}</Td>
                <Td className="text-fg2">{a.hostname || "—"}</Td>
                <Td mono>{a.mac || "—"}</Td>
                <Td className="text-fg2">{a.owner || "—"}</Td>
                <Td className="text-fg2">{alive.includes(a.address) ? <Status level="ok" label="Now" /> : fmt.ago(a.last_seen)}</Td>
                <Td className="w-24 whitespace-nowrap text-right">
                  <IconButton label="Edit" icon={PencilSquareIcon} onClick={() => setEdit(a)} />
                  <IconButton label="Delete" icon={TrashIcon} onClick={() => remove(a)} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    ) },
    { id: "found", title: "Not recorded", absent: !unknown.length && !d.seen.length, render: (e: any) => (
      <Panel title="Not recorded" flush edit={e}>
        <Table head={["Address", "Found by", ""]}>
          {unknown.map((ip) => <tr key={ip}><Td mono>{ip}</Td><Td className="text-fg2">Answered the scan</Td><Td className="text-right"><Button variant="ghost" onClick={() => add(ip)}>Record</Button></Td></tr>)}
          {d.seen.filter((x: any) => !unknown.includes(x.address)).map((x: any) => <tr key={x.address}><Td mono>{x.address}</Td><Td className="text-fg2">{x.device} ({x.from === "map_nodes" ? "network map" : "virtual inventory"})</Td><Td className="text-right"><Button variant="ghost" onClick={() => add(x.address, { device: x.device })}>Record</Button></Td></tr>)}
        </Table>
      </Panel>
    ) },
    { id: "free", title: "Free ranges", render: (e: any) => (
      <Panel title="Free ranges" flush edit={e}>
        {d.free.length === 0 ? <div className="px-4 pb-4"><Empty>No free address left.</Empty></div> : (
          <Table head={["From", "To", "Size", ""]}>
            {d.free.slice(0, 50).map((r: any) => <tr key={r.start}><Td mono>{r.start}</Td><Td mono>{r.end}</Td><Td className="text-fg2">{Number(r.size) > 1e9 ? "a lot" : r.size}</Td><Td className="text-right"><Button variant="ghost" onClick={() => add(r.start)}>Use {r.start}</Button></Td></tr>)}
          </Table>
        )}
      </Panel>
    ) },
    { id: "children", title: "Nested subnets", absent: !d.children.length, render: (e: any) => (
      <Panel title="Nested subnets" edit={e}>
        <ul className="flex flex-col gap-2">{d.children.map((c: any) => <li key={c.id} className="flex justify-between gap-3"><Link to={`/ipam/subnet/${c.id}`} className="text-accent">{c.name}</Link><Mono className="text-fg2">{c.cidr}</Mono></li>)}</ul>
      </Panel>
    ) },
  ]
  const v4 = d.calc.broadcast != null
  return (
    <>
      <PageHeader title={s.name} crumbs={[{ label: "IPAM", to: "/ipam" }, { label: s.name }]} onRefresh={reload}
        subtitle={<><Mono>{s.cidr}</Mono>{s.vlan ? ` · VLAN ${s.vlan}` : ""}{s.vrf ? ` · VRF ${s.vrf}` : ""}{s.section ? ` · ${s.section}` : ""}{s.gateway ? <> · gateway <Mono>{s.gateway}</Mono></> : ""}</>}
        actions={<>
          <CustomizeButton />
          {v4 && <Button disabled={scanning} onClick={runScan} title="Pings every address once, from the manager"><SignalIcon className="size-5" aria-hidden />{scanning ? "Scanning…" : "Scan"}</Button>}
          <Button onClick={() => setEditSubnet(true)}><PencilSquareIcon className="size-5" aria-hidden />Edit subnet</Button>
          <Button variant="primary" onClick={() => add(d.free[0]?.start ?? "")}><PlusIcon className="size-5" aria-hidden />Add address</Button>
        </>} />
      <ErrorNote>{note}</ErrorNote>
      {editSubnet && <RecordForm cols={SUBNET_COLS((vrfs.data?.items ?? []).map((v: any) => v.name))} row={s} collection="subnets" title={`Edit ${s.name}`} onDone={() => { setEditSubnet(false); reload() }} />}
      {edit !== undefined && <RecordForm key={edit?.id ?? edit?.address ?? "new"} cols={ADDRESS_COLS} row={edit?._new ? null : edit} defaults={edit?._new ? edit : undefined} collection="ip_addresses" rows={all.data?.items} onDone={done}
        title={edit?._new ? `Record ${edit.address || "an address"}` : `Edit ${edit.address}`} />}
      <Board id="subnet" panels={panels}
        desktop={{ cols: [["details", "free", "children"], ["map", "found", "addresses"]], hidden: [] }}
        phone={{ cols: [["details", "map", "found", "addresses", "free", "children"]], hidden: [] }} />
    </>
  )
}

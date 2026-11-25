import { ArrowDownTrayIcon, ArrowsRightLeftIcon, CircleStackIcon, CloudArrowUpIcon, CloudIcon, ComputerDesktopIcon, CpuChipIcon, CubeIcon, CubeTransparentIcon, GlobeAltIcon, LinkIcon, PlusIcon, ServerIcon, ServerStackIcon, ShieldCheckIcon, SignalIcon, Squares2X2Icon, TrashIcon, WifiIcon } from "@heroicons/react/24/outline"
import { useId, useRef, useState } from "react"
import { MapControls, matches, useFullscreen, usePanZoom } from "../ui/canvas"
import { findHost, liveLevel } from "./live"
import { Board, CustomizeButton } from "../ui/board"
import { Button, Empty, IconButton, Panel, Select, Status, Table, Td, Tabs, Input, Variable, ask } from "../ui/components"
import { t } from "../ui/i18n"
import { GroupedView, MAP_VIEWS, TreeView, type ViewNode } from "../ui/mapviews"
import { type Col, Editor, EditorGroup, RecordForm } from "../ui/crud"
import { api, download, type Level, useApi } from "../ui/lib"
import { ProxmoxIcon } from "../ui/brand-icons"
import { PageHeader } from "../ui/shell"
import { arrange, curve, frame, H, parents, treePath, W } from "./map-layout"

const TYPE_ICONS: Record<string, any> = { internet: GlobeAltIcon, router: SignalIcon, firewall: ShieldCheckIcon, switch: ArrowsRightLeftIcon, ap: WifiIcon, server: ServerIcon, proxmox: ProxmoxIcon, physical: ServerIcon, nas: CircleStackIcon, vm: ComputerDesktopIcon, lxc: CubeIcon, docker: CubeTransparentIcon, vps: CloudArrowUpIcon, cloud: CloudIcon, iot: CpuChipIcon }
export const TYPE_LABELS: Record<string, string> = { internet: "Internet", router: "Router", firewall: "Firewall", switch: "Switch", ap: "Access point", server: "Server", proxmox: "Proxmox", physical: "Physical", nas: "NAS", vm: "Virtual machine", lxc: "LXC container", docker: "Docker", vps: "VPS", cloud: "Cloud service", iot: "IoT device", other: "Other" }
/** How each kind of link is drawn. Cables from the inventory and VPN tunnels have their own. */
export const LINK_KINDS: Record<string, { label: string; className: string; dash?: string; width?: number }> = {
  ethernet: { label: "Ethernet", className: "stroke-info/70" },
  fiber: { label: "Fibre", className: "stroke-ok", width: 2.5 },
  wifi: { label: "Wi-Fi", className: "stroke-warn", dash: "2 5" },
  vlan: { label: "VLAN", className: "stroke-info", dash: "8 3 2 3" },
  vpn: { label: "VPN", className: "stroke-accent", dash: "6 4" },
  virtual: { label: "Virtual", className: "stroke-fg3", dash: "1 4" },
}
const STATE_WORDS: Record<Level, string> = { ok: "Operational", warn: "Warning", crit: "Critical", off: "Offline", info: "Information" }
const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const FORMATS = [["svg", "SVG"], ["drawio", "draw.io"], ["mermaid", "Mermaid"], ["dot", "Graphviz"], ["json", "JSON"]]
const NODE: Col[] = [
  { key: "name", label: "Name", required: true },
  { key: "ip", label: "Address", mono: true },
  { key: "type", label: "Type", type: "select", choices: Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label: t(label) })), hint: "A VM, container or other device linked to a Proxmox, physical or server node is drawn under it." },
]

function LinkForm({ nodes, onDone }: { nodes: any[]; onDone: () => void }) {
  const options = [{ value: "", label: "Choose…" }, ...nodes.map((n) => ({ value: n.id, label: n.name }))]
  const [f, setF] = useState({ source: "", target: "", label: "", kind: "ethernet" })
  const [error, setError] = useState("")
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try { await api("/api/c/map_links", { body: f }); onDone() } catch (err) { setError((err as Error).message) }
  }
  return (
    <Editor title={t("Add link")} onCancel={onDone} onSubmit={save} error={error}>
      <EditorGroup title={t("Between")}>
        <Select label="From" required value={f.source} options={options} onChange={(e) => setF({ ...f, source: e.target.value })} />
        <Select label="To" required value={f.target} options={options} onChange={(e) => setF({ ...f, target: e.target.value })} />
        <Select label="Kind" value={f.kind} options={Object.entries(LINK_KINDS).map(([value, k]) => ({ value, label: k.label }))} onChange={(e) => setF({ ...f, kind: e.target.value })} />
        <Input label="Label" placeholder={t("VLAN 10")} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
      </EditorGroup>
    </Editor>
  )
}

/** Cables between network ports, one line per pair of devices on the map, unless a link already joins them. Same rule as the exports. */
export function cables(links: any[], ports: any[], node: (device: string) => string | undefined) {
  const out = [...links]
  for (const p of ports) {
    const q = ports.find((q) => p.peer && q.id === p.peer)
    const [a, b] = [node(p.device), q && node(q.device)]
    if (a && b && a !== b && !out.some((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a)))
      out.push({ id: p.id, source: a, target: b, label: `${p.name} – ${q.name}`, cable: true })
  }
  return out.slice(links.length)
}

export function NetworkMap() {
  const nodes = useApi("/api/c/map_nodes?perPage=500", { poll: false })
  const links = useApi("/api/c/map_links?perPage=500", { poll: false })
  const vpn = useApi("/api/c/vpn_links?perPage=500", { poll: false })
  const ports = useApi("/api/c/ports?perPage=500", { poll: false })
  const hardware = useApi("/api/c/hardware?perPage=500", { poll: false })
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({})
  const [form, setForm] = useState<"node" | "link" | any>()
  const [note, setNote] = useState("")
  const [view, setView] = useState("diagram")
  const box = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const inner = useRef<SVGGElement>(null)
  const zoom = usePanZoom(svg)
  const full = useFullscreen(box)
  const dots = useId()
  const [query, setQuery] = useState("")
  const [hover, setHover] = useState<string>()
  // With a linked monitor, devices named like a monitored host show its state.
  const live = useApi<any[] | null>("/api/monitor/hosts")
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const [wire, setWire] = useState<{ from: string; x: number; y: number } | null>(null)
  const [kind, setKind] = useState("ethernet")

  const list: any[] = (nodes.data?.items ?? []).map((n: any) => ({ ...n, ...moved[n.id] }))
  const byId = Object.fromEntries(list.map((n) => [n.id, n]))
  // Kept on the VPN page, and drawn here when both ends are devices of this map.
  const nodeId = (name: string) => list.find((n) => n.name === name)?.id
  const tunnels = (vpn.data?.items ?? []).filter((v: any) => v.side_b && nodeId(v.side_a) && nodeId(v.side_b)).map((v: any) => ({ id: v.id, source: nodeId(v.side_a), target: nodeId(v.side_b), label: v.name, vpn: true }))
  const right = Math.max(600, ...list.map((n) => n.x + W + 40))
  const bottom = Math.max(320, ...list.map((n) => n.y + H + 40))
  const drawn: any[] = [...(links.data?.items ?? []), ...tunnels]
  const allLinks = [...drawn, ...cables(drawn, ports.data?.items ?? [], (device) => nodeId(hardware.data?.items.find((h: any) => h.id === device)?.name ?? ""))]
  const parent = parents(list, links.data?.items ?? [])
  const isTree = (l: any) => !l.vpn && (parent[l.source] === l.target || parent[l.target] === l.source)
  const hosts = list.filter((n) => Object.values(parent).includes(n.id))
  const stateOf = (n: any): Level | undefined => { const h = findHost(live.data, n); return h && liveLevel(h) }
  // Without a monitored host behind it, nothing says a device is up: neutral blue, not a green that would claim it.
  const viewNodes: ViewNode[] = list.map((n) => ({ label: n.name, state: stateOf(n) ?? "info", type: n.type || "other", parent: parent[n.id] ? list.findIndex((p) => p.id === parent[n.id]) : null, sub: n.ip }))
  const icons = Object.fromEntries(Object.entries(TYPE_ICONS).map(([k, icon]) => [k, { label: t(TYPE_LABELS[k]), icon }]))
  const found = query.trim() ? list.filter((n) => matches(query, n.name, n.ip, t(TYPE_LABELS[n.type] ?? n.type ?? ""))).map((n) => n.id) : null
  // A hovered device brings forward what it is linked to, and its host or guests.
  const near = hover ? new Set([hover, ...allLinks.flatMap((l: any) => (l.source === hover ? [l.target] : l.target === hover ? [l.source] : []))]) : null
  const lit = (id: string) => (near ? near.has(id) : found ? found.includes(id) : true)
  const states = list.map(stateOf).filter(Boolean) as Level[]
  const at = (p: { x: number; y: number }) => list.find((n) => p.x >= n.x && p.x <= n.x + W && p.y >= n.y && p.y <= n.y + H)
  /** Ends a link dragged from the handle of a device: dropped on another one, it joins them. */
  const endWire = async (e: React.PointerEvent) => {
    if (!wire) return
    const to = at(toSvg(e))
    setWire(null)
    if (!to || to.id === wire.from) return
    try { await api("/api/c/map_links", { body: { source: wire.from, target: to.id, kind } }); links.reload() } catch (err) { setNote((err as Error).message) }
  }
  // A new device from the palette lands right of everything, at the top.
  const addOfType = (type: string) => setForm({ isNew: true, type, x: list.length ? right - 40 : 40, y: 40 })

  // In drawing units, whatever the pan and zoom.
  const toSvg = (e: React.PointerEvent) => {
    const m = inner.current!.getScreenCTM()!.inverse()
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m)
    return { x: p.x, y: p.y }
  }
  const down = (e: React.PointerEvent, n: any) => {
    e.stopPropagation()
    const p = toSvg(e)
    drag.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    if (wire) return setWire({ ...wire, ...toSvg(e) })
    if (!drag.current) return
    const p = toSvg(e)
    const { id, dx, dy } = drag.current
    const snap = (v: number) => Math.max(0, Math.round(v / 8) * 8) // on the 8 px grid, so cards line up
    setMoved((m) => ({ ...m, [id]: { x: snap(p.x - dx), y: snap(p.y - dy) } }))
  }
  const up = () => {
    const id = drag.current?.id
    drag.current = null
    if (id && moved[id]) api(`/api/c/map_nodes/${id}`, { method: "PATCH", body: moved[id] }).catch((e) => setNote(e.message))
  }
  const done = () => { setForm(undefined); nodes.reload(); links.reload() }
  const remove = async (coll: string, id: string) => { await api(`/api/c/${coll}/${id}`, { method: "DELETE" }); done() }
  const removeNode = async (n: any) => {
    if (!await ask(`Delete ${n.name}?`, { action: "Delete", danger: true })) return
    for (const l of links.data.items.filter((l: any) => l.source === n.id || l.target === n.id)) await api(`/api/c/map_links/${l.id}`, { method: "DELETE" })
    remove("map_nodes", n.id)
  }
  /** Writes the tidy places of every node that is not there yet. */
  const tidy = async (all: any[], allLinks: any[]) => {
    const at = arrange(all, allLinks)
    const changed = all.filter((n) => at[n.id] && (at[n.id].x !== n.x || at[n.id].y !== n.y))
    await Promise.all(changed.map((n) => api(`/api/c/map_nodes/${n.id}`, { method: "PATCH", body: at[n.id] })))
    setMoved({})
  }
  const arrangeAll = async () => {
    if (!await ask("Place every device again: network gear on top, each host with its guests under it, the rest below? Places you set by hand are replaced.", { action: "Arrange", danger: true })) return
    try { await tidy(list, links.data?.items ?? []); setNote("Map arranged."); done() } catch (e) { setNote((e as Error).message) }
  }
  const importHosts = async () => {
    try {
      const r = await api("/api/map/import", { method: "POST" })
      // A first import is arranged right away; later ones leave your places alone.
      if (list.length === 0) {
        const [n, l] = await Promise.all([api("/api/c/map_nodes?perPage=500"), api("/api/c/map_links?perPage=500")])
        await tidy(n.items, l.items)
      }
      setNote(`${t("{n} hosts added.", { n: r.added })}${list.length && r.added ? ` ${t("Press Arrange to place them.")}` : ""}`)
      done()
    } catch (e) { setNote((e as Error).message) }
  }

  return (
    <>
      <PageHeader title={t("Network map")} subtitle={note} actions={<>
        <CustomizeButton />
        <Button onClick={importHosts}><ServerStackIcon className="size-5" aria-hidden />{t("Import hosts")}</Button>
        <Button onClick={arrangeAll} disabled={list.length < 2}><Squares2X2Icon className="size-5" aria-hidden />{t("Arrange")}</Button>
        <Button onClick={() => setForm("link")} disabled={list.length < 2}><LinkIcon className="size-5" aria-hidden />{t("Add link")}</Button>
        <Button variant="primary" onClick={() => setForm("node")}><PlusIcon className="size-5" aria-hidden />{t("Add device")}</Button>
      </>} />
      {form === "link" && <LinkForm nodes={list} onDone={done} />}
      {form && form !== "link" && <RecordForm title={form === "node" || form.isNew ? "Add device" : "Edit device"} cols={NODE} collection="map_nodes" key={form === "node" ? "new" : form.id ?? `new-${form.type}`} row={form === "node" || form.isNew ? null : form} onDone={done} defaults={form.isNew ? { type: form.type, x: form.x, y: form.y } : undefined} />}
      <Board id="map" desktop={{ cols: [["map", "export", "devices", "links"]], hidden: [] }} phone={{ cols: [["map", "export", "devices", "links"]], hidden: [] }} panels={[
        { id: "map", title: "Map", render: (edit: any) => (
        <Panel title={t("Map")} flush edit={edit} footer="Drag a device to move it, double-click it to edit. Drag from the dot on its right edge onto another device to link them, click a link to delete it. Drag the background to pan, scroll or pinch to zoom. Guests sit in the frame of their host; grey lines are cables between network ports of the hardware inventory. With a linked monitor, a coloured bar gives the state of the host of the same name.">
          <div className="flex flex-wrap gap-1.5 px-4 pb-3" role="toolbar" aria-label={t("Add to the map")}>
            {Object.entries(TYPE_LABELS).filter(([k]) => TYPE_ICONS[k] && k !== "physical").map(([k, label]) => { const I = TYPE_ICONS[k]; return <button key={k} type="button" title={t("Add {type}", { type: t(label) })} onClick={() => addOfType(k)} className="inline-flex h-8 items-center gap-1.5 rounded-control border border-line2 bg-raised px-2.5 text-[13px] text-fg2 hover:border-accent hover:text-fg"><I className="size-4" aria-hidden />{t(label)}</button> })}
          </div>
          {list.length > 0 && <div className="flex flex-wrap items-center gap-3 px-4 pb-3"><Tabs tabs={MAP_VIEWS} value={view} onChange={setView} />{view === "diagram" && <Variable label="New links" value={kind} onChange={setKind} options={Object.entries(LINK_KINDS).map(([value, k]) => ({ value, label: k.label }))} />}
            {view === "diagram" && <span className="flex flex-wrap gap-3 text-xs text-fg2">{Object.entries(LINK_KINDS).map(([k, v]) => <span key={k} className="inline-flex items-center gap-1.5"><svg width="22" height="6" aria-hidden><line x1="0" x2="22" y1="3" y2="3" strokeWidth={v.width ?? 1.5} strokeDasharray={v.dash} className={v.className} /></svg>{t(v.label)}</span>)}</span>}</div>}
          {list.length === 0 ? <div className="px-4 pb-4"><Empty>{t("Add a device or import hosts from monitoring.")}</Empty></div> : view === "tree" ? <TreeView nodes={viewNodes} icons={icons} /> : view === "groups" ? <GroupedView nodes={viewNodes} icons={icons} /> : (
            <div ref={box} className="relative h-[65vh] min-h-96 overflow-hidden border-t border-line bg-surface [&:fullscreen]:h-dvh">
              <svg ref={svg} viewBox={`0 0 ${right} ${bottom}`} tabIndex={0} onKeyDown={zoom.onKeyDown} className="size-full touch-none select-none outline-none cursor-grab active:cursor-grabbing"
                onPointerDown={zoom.handlers.onPointerDown} onPointerMove={(e) => { zoom.handlers.onPointerMove(e); if (wire) move(e) }} onPointerUp={(e) => { zoom.handlers.onPointerUp(e); endWire(e) }} onPointerCancel={zoom.handlers.onPointerCancel}
                role="img" aria-label={t("Network map with {n} devices. The same data is listed below.", { n: list.length })}>
                <defs><pattern id={dots} width={24} height={24} patternUnits="userSpaceOnUse"><circle cx={1} cy={1} r={1} className="fill-line2" /></pattern></defs>
                <g ref={inner} transform={zoom.transform}>
                <rect x={-4000} y={-4000} width={right + 8000} height={bottom + 8000} fill={`url(#${dots})`} />
                {hosts.map((h) => {
                  const f = frame(h, list.filter((n) => parent[n.id] === h.id))
                  return <rect key={`f${h.id}`} x={f.x} y={f.y} width={f.w} height={f.h} rx={12} className="fill-bg/60 stroke-line" />
                })}
                {allLinks.map((l: any) => {
                  const [a, b] = [byId[l.source], byId[l.target]]
                  if (!a || !b) return null
                  if (isTree(l)) {
                    const [p, c] = parent[l.source] === l.target ? [b, a] : [a, b]
                    return <path key={l.id} d={treePath(p, c)} fill="none" className="stroke-line2" opacity={lit(a.id) && lit(b.id) ? 1 : 0.15} />
                  }
                  const c = curve(a, b)
                  const k = LINK_KINDS[l.vpn ? "vpn" : l.kind] ?? LINK_KINDS.ethernet
                  const own = !l.vpn && !l.cable
                  return (
                    <g key={l.id} opacity={near ? (near.has(a.id) && near.has(b.id) && (a.id === hover || b.id === hover) ? 1 : 0.12) : found ? (lit(a.id) || lit(b.id) ? 1 : 0.2) : 1}>
                      <path d={c.d} fill="none" strokeWidth={l.cable ? 1.5 : k.width ?? 1.5} className={l.cable ? "stroke-fg3" : k.className} strokeDasharray={l.cable ? undefined : k.dash} />
                      {own && <path d={c.d} fill="none" stroke="transparent" strokeWidth={12} className="cursor-pointer" onClick={async () => { if (zoom.moved()) return; if (await ask(t("Delete the link between {a} and {b}?", { a: a.name, b: b.name }), { action: "Delete", danger: true })) remove("map_links", l.id) }}><title>{`${t(k.label)}${l.label ? ` · ${l.label}` : ""}`}</title></path>}
                      {l.label && <text x={c.mx} y={c.my - 6} textAnchor="middle" className="fill-fg2 text-xs" stroke="var(--color-surface)" strokeWidth={3} paintOrder="stroke">{l.label}</text>}
                    </g>
                  )
                })}
                {wire && byId[wire.from] && <line x1={byId[wire.from].x + W} y1={byId[wire.from].y + H / 2} x2={wire.x} y2={wire.y} strokeWidth={2} strokeDasharray={LINK_KINDS[kind].dash} className={`pointer-events-none ${LINK_KINDS[kind].className}`} />}
                {list.map((n) => {
                  const I = TYPE_ICONS[n.type] ?? CubeIcon
                  const host = hosts.includes(n)
                  const state = stateOf(n)
                  return (
                    <g key={n.id} transform={`translate(${n.x} ${n.y})`} opacity={lit(n.id) ? 1 : 0.25} className="cursor-grab touch-none transition-opacity [&:hover>rect.card]:stroke-accent" onPointerDown={(e) => down(e, n)} onPointerMove={move} onPointerUp={up} onDoubleClick={() => setForm(n)} onPointerEnter={() => !drag.current && !wire && setHover(n.id)} onPointerLeave={() => setHover(undefined)}>
                      <title>{`${n.name}${n.ip ? ` · ${n.ip}` : ""}${n.type ? ` · ${t(TYPE_LABELS[n.type] ?? n.type)}` : ""}${state ? ` · ${t(STATE_WORDS[state])}` : ""}`}</title>
                      {found?.includes(n.id) && <rect x={-5} y={-5} width={W + 10} height={H + 10} rx={11} fill="none" strokeWidth={2} strokeDasharray="5 4" className="stroke-accent" />}
                      <rect width={W} height={H} rx={8} className={`card ${host ? "fill-raised stroke-accent/70" : "fill-raised stroke-line2"}`} />
                      {state && <><rect width={4} height={H - 16} x={0} y={8} rx={2} fill={`var(--color-${state})`} /><circle cx={W - 12} cy={12} r={4.5} fill={`var(--color-${state})`} /></>}
                      <I x={12} y={H / 2 - 10} width={20} height={20} className={host ? "text-accent" : "text-fg3"} />
                      <text x={42} y={n.ip ? 22 : 31} className="fill-fg text-[13px] font-medium">{fit(n.name, 19)}</text>
                      {n.ip && <text x={42} y={39} className="fill-fg2 font-mono text-xs">{n.ip}</text>}
                      <circle cx={W} cy={H / 2} r={6} className="cursor-crosshair fill-surface stroke-accent" onPointerDown={(e) => { e.stopPropagation(); svg.current!.setPointerCapture(e.pointerId); setHover(undefined); setWire({ from: n.id, ...toSvg(e) }) }}><title>{t("Drag onto another device to link them")}</title></circle>
                    </g>
                  )
                })}
                </g>
              </svg>
              <MapControls className="absolute left-2 top-2" zoom={zoom} full={full} query={query} onQuery={setQuery} found={found?.length}
                onFind={() => { const n = byId[found?.[0] ?? ""]; if (n) zoom.focus({ x: n.x + W / 2, y: n.y + H / 2 }) }} />
              {states.length > 0 && <div className="absolute bottom-2 left-3 flex gap-3 rounded-control bg-surface/90 px-2 py-1">{(["ok", "warn", "crit", "off"] as Level[]).map((l) => [l, states.filter((x) => x === l).length] as const).filter(([, c]) => c).map(([l, c]) => <Status key={l} cell level={l} label={String(c)} />)}</div>}
            </div>
          )}
        </Panel>
        ) },
        { id: "export", title: "Export", render: (edit: any) => (
        <Panel title={t("Export")} edit={edit}>
          <div className="flex flex-wrap gap-2">
            {FORMATS.map(([f, label]) => <Button key={f} onClick={() => download(`/api/map/export/${f}`)}><ArrowDownTrayIcon className="size-5" aria-hidden />{label}</Button>)}
          </div>
        </Panel>
        ) },
        { id: "devices", title: "Devices", absent: list.length === 0, render: (edit: any) => (
          <Panel title={t("Devices")} flush edit={edit}>
            <Table head={["Name", "Address", "Type", ""]}>
              {list.map((n) => (
                <tr key={n.id}>
                  <Td className="font-medium"><button className="min-h-9 max-sm:min-h-11 text-left" onClick={() => setForm(n)}>{n.name}</button></Td>
                  <Td mono>{n.ip || "—"}</Td>
                  <Td className="text-fg2">{n.type ? t(TYPE_LABELS[n.type] ?? n.type) : "—"}</Td>
                  <Td className="w-12 text-right"><IconButton label="Delete" icon={TrashIcon} onClick={() => removeNode(n)} /></Td>
                </tr>
              ))}
            </Table>
          </Panel>
        ) },
        { id: "links", title: "Links", absent: !links.data?.items.length, render: (edit: any) => (
          <Panel title={t("Links")} flush edit={edit}>
            <Table head={["From", "To", "Kind", "Label", ""]}>
              {links.data?.items.map((l: any) => (
                <tr key={l.id}>
                  <Td className="font-medium">{byId[l.source]?.name ?? "—"}</Td>
                  <Td>{byId[l.target]?.name ?? "—"}</Td>
                  <Td className="text-fg2">{t(LINK_KINDS[l.kind]?.label ?? "Ethernet")}</Td>
                  <Td className="text-fg2">{l.label || "—"}</Td>
                  <Td className="w-12 text-right"><IconButton label="Delete" icon={TrashIcon} onClick={() => remove("map_links", l.id)} /></Td>
                </tr>
              ))}
            </Table>
          </Panel>
        ) },
      ]} />
    </>
  )
}

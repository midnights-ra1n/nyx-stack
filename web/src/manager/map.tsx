import { ArrowDownTrayIcon, ArrowsRightLeftIcon, ChevronDoubleLeftIcon, ChevronDoubleRightIcon, CircleStackIcon, CloudArrowUpIcon, CloudIcon, ComputerDesktopIcon, CpuChipIcon, CubeIcon, CubeTransparentIcon, GlobeAltIcon, RectangleGroupIcon, ServerIcon, ServerStackIcon, ShieldCheckIcon, SignalIcon, Squares2X2Icon, TrashIcon, WifiIcon, XMarkIcon } from "@heroicons/react/24/outline"
import { useEffect, useId, useRef, useState } from "react"
import { MapControls, matches, useFullscreen, usePanZoom } from "../ui/canvas"
import { Button, Empty, IconButton, Input, Panel, Select, Table, Td, Tabs, ask } from "../ui/components"
import { t } from "../ui/i18n"
import { GroupedView, MAP_VIEWS, TreeView, type ViewNode } from "../ui/mapviews"
import { api, download, useApi, useStored } from "../ui/lib"
import { ProxmoxIcon } from "../ui/brand-icons"
import { Link, PageHeader } from "../ui/shell"
import { arrange, curve, frame, H, parents, treePath, W } from "./map-layout"

const TYPE_ICONS: Record<string, any> = { internet: GlobeAltIcon, router: SignalIcon, firewall: ShieldCheckIcon, switch: ArrowsRightLeftIcon, ap: WifiIcon, server: ServerIcon, proxmox: ProxmoxIcon, physical: ServerIcon, nas: CircleStackIcon, vm: ComputerDesktopIcon, lxc: CubeIcon, docker: CubeTransparentIcon, vps: CloudArrowUpIcon, cloud: CloudIcon, iot: CpuChipIcon }
export const TYPE_LABELS: Record<string, string> = { internet: "Internet", router: "Router", firewall: "Firewall", switch: "Switch", ap: "Access point", server: "Server", proxmox: "Proxmox", physical: "Physical", nas: "NAS", vm: "Virtual machine", lxc: "LXC container", docker: "Docker", vps: "VPS", cloud: "Cloud service", iot: "IoT device", other: "Other" }
/** The colour of each family of devices: network gear, machines, storage, guests, things outside. */
const FAMILY: Record<string, string> = { internet: "text-fg2", router: "text-info", firewall: "text-info", switch: "text-info", ap: "text-info", server: "text-accent", proxmox: "text-accent", physical: "text-accent", nas: "text-ok", vm: "text-s3", lxc: "text-s3", docker: "text-s3", vps: "text-s4", cloud: "text-s4", iot: "text-warn" }
/** How each kind of link is drawn. Cables from the inventory and VPN tunnels have their own. */
export const LINK_KINDS: Record<string, { label: string; className: string; dash?: string; width?: number }> = {
  ethernet: { label: "Ethernet", className: "stroke-info/70" },
  fiber: { label: "Fibre", className: "stroke-ok", width: 2.5 },
  wifi: { label: "Wi-Fi", className: "stroke-warn", dash: "2 5" },
  vlan: { label: "VLAN", className: "stroke-info", dash: "8 3 2 3" },
  vpn: { label: "VPN", className: "stroke-accent", dash: "6 4" },
  virtual: { label: "Virtual", className: "stroke-fg3", dash: "1 4" },
}
/** Zone colours, as theme colours. */
const ZONE_COLORS: Record<string, [string, string]> = { blue: ["Blue", "info"], green: ["Green", "ok"], yellow: ["Yellow", "warn"], red: ["Red", "crit"], orange: ["Orange", "accent"], grey: ["Grey", "fg3"] }
const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const FORMATS = [["svg", "SVG"], ["drawio", "draw.io"], ["mermaid", "Mermaid"], ["dot", "Graphviz"], ["json", "JSON"]]
const snap = (v: number) => Math.round(v / 8) * 8 // on the 8 px grid, so cards line up

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

/** Devices whose middle lies in a zone, which move with it. */
export const inside = (z: { x: number; y: number; w: number; h: number }, nodes: { id: string; x: number; y: number }[]) =>
  nodes.filter((n) => n.x + W / 2 >= z.x && n.x + W / 2 <= z.x + z.w && n.y + H / 2 >= z.y && n.y + H / 2 <= z.y + z.h)

/** A text field that saves when it loses focus or on Enter. */
function Inline({ label, value, onSave, placeholder }: { label: string; value?: string; onSave: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value ?? "")
  useEffect(() => setV(value ?? ""), [value])
  return <Input label={label} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() !== (value ?? "") && onSave(v.trim())} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }} />
}

type Sel = { node: string } | { link: string } | { zone: string } | null

export function NetworkMap() {
  const nodes = useApi("/api/c/map_nodes?perPage=500", { poll: false })
  const links = useApi("/api/c/map_links?perPage=500", { poll: false })
  const zones = useApi("/api/c/map_zones?perPage=200", { poll: false })
  const vpn = useApi("/api/c/vpn_links?perPage=500", { poll: false })
  const ports = useApi("/api/c/ports?perPage=500", { poll: false })
  const hardware = useApi("/api/c/hardware?perPage=500", { poll: false })
  const virtual = useApi("/api/c/virtual_assets?perPage=500", { poll: false })
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({})
  const [shaped, setShaped] = useState<Record<string, { x: number; y: number; w: number; h: number }>>({})
  const [note, setNote] = useState("")
  const [view, setView] = useState("diagram")
  const [sel, setSel] = useState<Sel>(null)
  // Closed at first on a phone, where it would take half of the map.
  const [palette, setPalette] = useStored("nyx.map.palette", !matchMedia("(max-width: 639px)").matches)
  const box = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const inner = useRef<SVGGElement>(null)
  const zoom = usePanZoom(svg)
  const full = useFullscreen(box)
  const dots = useId()
  const [query, setQuery] = useState("")
  const [hover, setHover] = useState<string>()
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null)
  const zdrag = useRef<{ id: string; mode: "move" | "size"; px: number; py: number; z: any; kids: any[] } | null>(null)
  const [wire, setWire] = useState<{ from: string; x: number; y: number } | null>(null)
  const [kind, setKind] = useState("ethernet")

  const list: any[] = (nodes.data?.items ?? []).map((n: any) => ({ ...n, ...moved[n.id] }))
  const areas: any[] = (zones.data?.items ?? []).map((z: any) => { const s = { ...z, ...shaped[z.id] }; return { ...s, w: s.w || 320, h: s.h || 200 } })
  const byId = Object.fromEntries(list.map((n) => [n.id, n]))
  // Kept on the VPN page, and drawn here when both ends are devices of this map.
  const nodeId = (name: string) => list.find((n) => n.name === name)?.id
  const tunnels = (vpn.data?.items ?? []).filter((v: any) => v.side_b && nodeId(v.side_a) && nodeId(v.side_b)).map((v: any) => ({ id: v.id, source: nodeId(v.side_a), target: nodeId(v.side_b), label: v.name, vpn: true }))
  const right = Math.max(600, ...list.map((n) => n.x + W + 40), ...areas.map((z) => z.x + z.w + 40))
  const bottom = Math.max(320, ...list.map((n) => n.y + H + 40), ...areas.map((z) => z.y + z.h + 40))
  const drawn: any[] = [...(links.data?.items ?? []), ...tunnels]
  const allLinks = [...drawn, ...cables(drawn, ports.data?.items ?? [], (device) => nodeId(hardware.data?.items.find((h: any) => h.id === device)?.name ?? ""))]
  const parent = parents(list, links.data?.items ?? [])
  const isTree = (l: any) => !l.vpn && (parent[l.source] === l.target || parent[l.target] === l.source)
  const hosts = list.filter((n) => Object.values(parent).includes(n.id))
  // Nothing here says a device is up: neutral blue, not a green that would claim it.
  const viewNodes: ViewNode[] = list.map((n) => ({ label: n.name, state: "info", type: n.type || "other", parent: parent[n.id] ? list.findIndex((p) => p.id === parent[n.id]) : null, sub: n.ip }))
  const icons = Object.fromEntries(Object.entries(TYPE_ICONS).map(([k, icon]) => [k, { label: t(TYPE_LABELS[k]), icon }]))
  const found = query.trim() ? list.filter((n) => matches(query, n.name, n.ip, t(TYPE_LABELS[n.type] ?? n.type ?? ""))).map((n) => n.id) : null
  // A hovered device brings forward what it is linked to, and its host or guests.
  const near = hover ? new Set([hover, ...allLinks.flatMap((l: any) => (l.source === hover ? [l.target] : l.target === hover ? [l.source] : []))]) : null
  const lit = (id: string) => (near ? near.has(id) : found ? found.includes(id) : true)
  const at = (p: { x: number; y: number }) => list.find((n) => p.x >= n.x && p.x <= n.x + W && p.y >= n.y && p.y <= n.y + H)
  const selNode = sel && "node" in sel ? byId[sel.node] : undefined
  const selLink = sel && "link" in sel ? allLinks.find((l) => l.id === sel.link) : undefined
  const selZone = sel && "zone" in sel ? areas.find((z) => z.id === sel.zone) : undefined

  // In drawing units, whatever the pan and zoom.
  const toSvg = (e: { clientX: number; clientY: number }) => {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(inner.current!.getScreenCTM()!.inverse())
    return { x: p.x, y: p.y }
  }
  /** The middle of what is on screen, in drawing units. */
  const middle = () => { const r = svg.current!.getBoundingClientRect(); return toSvg({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }) }
  const fail = (e: unknown) => setNote((e as Error).message)
  const done = () => { nodes.reload(); links.reload(); zones.reload() }

  /** A new device, named after its type, ready to be renamed in the side panel. */
  const addNode = async (type: string, p: { x: number; y: number }) => {
    try {
      const n = await api("/api/c/map_nodes", { body: { name: t(TYPE_LABELS[type]), type, x: Math.max(0, snap(p.x - W / 2)), y: Math.max(0, snap(p.y - H / 2)) } })
      await nodes.reload()
      setSel({ node: n.id })
    } catch (e) { fail(e) }
  }
  const addZone = async () => {
    const c = middle()
    try {
      const z = await api("/api/c/map_zones", { body: { name: t("New zone"), color: "blue", x: snap(c.x - 200), y: snap(c.y - 130), w: 400, h: 260 } })
      await zones.reload()
      setSel({ zone: z.id })
    } catch (e) { fail(e) }
  }
  const patch = async (coll: string, id: string, body: any) => { try { await api(`/api/c/${coll}/${id}`, { method: "PATCH", body }); done() } catch (e) { fail(e) } }
  const link = async (source: string, target: string, k = kind) => {
    try { const l = await api("/api/c/map_links", { body: { source, target, kind: k } }); await links.reload(); setSel({ link: l.id }) } catch (e) { fail(e) }
  }
  /** Ends a link dragged from the handle of a device: dropped on another one, it joins them. */
  const endWire = (e: React.PointerEvent) => {
    if (!wire) return
    const to = at(toSvg(e))
    setWire(null)
    if (to && to.id !== wire.from) link(wire.from, to.id)
  }

  const down = (e: React.PointerEvent, n: any) => {
    e.stopPropagation()
    const p = toSvg(e)
    drag.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    if (wire) return setWire({ ...wire, ...toSvg(e) })
    if (!drag.current) return
    const p = toSvg(e)
    const { id, dx, dy } = drag.current
    const next = { x: Math.max(0, snap(p.x - dx)), y: Math.max(0, snap(p.y - dy)) }
    if (!drag.current.moved && byId[id] && next.x === byId[id].x && next.y === byId[id].y) return
    drag.current.moved = true
    setMoved((m) => ({ ...m, [id]: next }))
  }
  const up = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (!d.moved) return setSel({ node: d.id })
    if (moved[d.id]) api(`/api/c/map_nodes/${d.id}`, { method: "PATCH", body: moved[d.id] }).catch(fail)
  }
  // A zone moves by its label, with the devices in it, and grows by its corner.
  const grabZone = (e: React.PointerEvent, z: any, mode: "move" | "size") => {
    e.stopPropagation()
    const p = toSvg(e)
    zdrag.current = { id: z.id, mode, px: p.x, py: p.y, z, kids: mode === "move" ? inside(z, list) : [] }
    e.currentTarget.setPointerCapture(e.pointerId)
    setSel({ zone: z.id })
  }
  const moveZone = (e: React.PointerEvent) => {
    const d = zdrag.current
    if (!d) return
    const p = toSvg(e), dx = snap(p.x - d.px), dy = snap(p.y - d.py)
    if (d.mode === "size") return setShaped((s) => ({ ...s, [d.id]: { x: d.z.x, y: d.z.y, w: Math.max(160, d.z.w + dx), h: Math.max(96, d.z.h + dy) } }))
    setShaped((s) => ({ ...s, [d.id]: { x: Math.max(0, d.z.x + dx), y: Math.max(0, d.z.y + dy), w: d.z.w, h: d.z.h } }))
    setMoved((m) => ({ ...m, ...Object.fromEntries(d.kids.map((n) => [n.id, { x: Math.max(0, n.x + dx), y: Math.max(0, n.y + dy) }])) }))
  }
  const dropZone = async () => {
    const d = zdrag.current
    zdrag.current = null
    const z = d && shaped[d.id]
    if (!d || !z) return
    try {
      await Promise.all([api(`/api/c/map_zones/${d.id}`, { method: "PATCH", body: z }), ...d.kids.filter((n) => moved[n.id]).map((n) => api(`/api/c/map_nodes/${n.id}`, { method: "PATCH", body: moved[n.id] }))])
    } catch (e) { fail(e) }
  }

  const remove = async (coll: string, id: string) => { await api(`/api/c/${coll}/${id}`, { method: "DELETE" }); setSel(null); done() }
  const removeNode = async (n: any) => {
    if (!await ask(t("Delete {name}?", { name: n.name }), { action: "Delete", danger: true })) return
    for (const l of links.data.items.filter((l: any) => l.source === n.id || l.target === n.id)) await api(`/api/c/map_links/${l.id}`, { method: "DELETE" })
    remove("map_nodes", n.id)
  }
  const removeSelected = async () => {
    if (selNode) return removeNode(selNode)
    if (selLink && !selLink.vpn && !selLink.cable) return remove("map_links", selLink.id)
    if (selZone && await ask(t("Delete the zone {name}? The devices in it stay.", { name: selZone.name }), { action: "Delete", danger: true })) remove("map_zones", selZone.id)
  }
  /** Writes the tidy places of every node that is not there yet. */
  const tidy = async (all: any[], allLinks: any[]) => {
    const to = arrange(all, allLinks)
    const changed = all.filter((n) => to[n.id] && (to[n.id].x !== n.x || to[n.id].y !== n.y))
    await Promise.all(changed.map((n) => api(`/api/c/map_nodes/${n.id}`, { method: "PATCH", body: to[n.id] })))
    setMoved({})
  }
  const arrangeAll = async () => {
    if (!await ask("Place every device again: network gear on top, each host with its guests under it, the rest below? Places you set by hand are replaced.", { action: "Arrange", danger: true })) return
    try { await tidy(list, links.data?.items ?? []); setNote(t("Map arranged.")); done() } catch (e) { fail(e) }
  }
  const importInventory = async () => {
    try {
      const r = await api("/api/map/import", { method: "POST" })
      // A first import is arranged right away; later ones leave your places alone.
      if (list.length === 0) {
        const [n, l] = await Promise.all([api("/api/c/map_nodes?perPage=500"), api("/api/c/map_links?perPage=500")])
        await tidy(n.items, l.items)
      }
      setNote(`${t("{n} devices added.", { n: r.added })}${list.length && r.added ? ` ${t("Press Arrange to place them.")}` : ""}`)
      done()
    } catch (e) { fail(e) }
  }

  const linksOf = (n: any) => allLinks.filter((l) => l.source === n.id || l.target === n.id)
  const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()
  const kindOf = (l: any) => (l.vpn ? "vpn" : LINK_KINDS[l.kind] ? l.kind : "ethernet")
  const swatch = (k: string, cable = false) => { const v = LINK_KINDS[k]; return <svg width="22" height="6" aria-hidden className="shrink-0"><line x1="0" x2="22" y1="3" y2="3" strokeWidth={cable ? 1.5 : v.width ?? 1.5} strokeDasharray={cable ? undefined : v.dash} className={cable ? "stroke-fg3" : v.className} /></svg> }

  const inspector = selNode ? (() => {
    const n = selNode, I = TYPE_ICONS[n.type] ?? CubeIcon
    const hw = hardware.data?.items.find((r: any) => same(r.name, n.name))
    const va = virtual.data?.items.find((r: any) => same(r.name, n.name))
    return <>
      <div className="flex items-start gap-3">
        <span className={`relative flex size-11 shrink-0 items-center justify-center rounded-box ${FAMILY[n.type] ?? "text-fg2"}`}><span className="absolute inset-0 rounded-box bg-current opacity-15" /><I className="size-6" aria-hidden /></span>
        <div className="min-w-0 flex-1"><div className="truncate font-medium">{n.name}</div><div className="truncate text-xs text-fg3">{t(TYPE_LABELS[n.type] ?? "Other")}</div></div>
        <IconButton label="Close" icon={XMarkIcon} onClick={() => setSel(null)} />
      </div>
      <div className="flex flex-col gap-3">
        <Inline key={`n${n.id}`} label="Name" value={n.name} onSave={(v) => v && patch("map_nodes", n.id, { name: v })} />
        <Inline key={`i${n.id}`} label="Address" value={n.ip} placeholder="10.0.0.2" onSave={(v) => patch("map_nodes", n.id, { ip: v })} />
        <Select label="Type" value={n.type || "other"} onChange={(e) => patch("map_nodes", n.id, { type: e.target.value })} options={Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label: t(label) }))} />
      </div>
      <section>
        <h3 className="mb-1 text-[13px] font-medium text-fg2">{t("Connections ({n})", { n: linksOf(n).length })}</h3>
        {linksOf(n).length ? <ul className="flex flex-col">{linksOf(n).map((l) => { const o = byId[l.source === n.id ? l.target : l.source]; return o && (
          <li key={l.id}><button type="button" className="flex w-full items-center gap-2 rounded-control px-1 py-1 text-left text-[13px] hover:bg-raised" onClick={() => setSel({ link: l.id })}>{swatch(kindOf(l), l.cable)}<span className="min-w-0 flex-1 truncate">{o.name}</span><span className="truncate text-xs text-fg3">{l.label || t(l.cable ? "Cable" : LINK_KINDS[kindOf(l)].label)}</span></button></li>
        ) })}</ul> : <p className="text-[13px] text-fg3">{t("Drag from the dot on its right edge onto another device.")}</p>}
        <Select label="Link to" value="" onChange={(e) => e.target.value && link(n.id, e.target.value)} options={[{ value: "", label: "Choose a device…" }, ...list.filter((o) => o.id !== n.id).sort((a, b) => a.name.localeCompare(b.name)).map((o) => ({ value: o.id, label: o.name }))]} />
      </section>
      {(hw || va) && <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">{hw && <Link to={`/hardware/${hw.id}`} className="text-accent">{t("Hardware record")}</Link>}{va && <Link to={`/virtual/${va.id}`} className="text-accent">{t("Virtual record")}</Link>}</div>}
      <Button variant="danger" onClick={() => removeNode(n)}><TrashIcon className="size-5" aria-hidden />{t("Delete")}</Button>
    </>
  })() : selLink ? (() => {
    const l = selLink, a = byId[l.source], b = byId[l.target], own = !l.vpn && !l.cable
    return <>
      <div className="flex items-start gap-3">
        <span className="flex h-11 shrink-0 items-center">{swatch(kindOf(l), l.cable)}</span>
        <div className="min-w-0 flex-1"><div className="truncate font-medium">{a?.name} ↔ {b?.name}</div><div className="truncate text-xs text-fg3">{t(l.cable ? "Cable between network ports" : l.vpn ? "VPN link" : "Link")}</div></div>
        <IconButton label="Close" icon={XMarkIcon} onClick={() => setSel(null)} />
      </div>
      {own ? <>
        <Select label="Kind" value={kindOf(l)} onChange={(e) => patch("map_links", l.id, { kind: e.target.value })} options={Object.entries(LINK_KINDS).map(([value, k]) => ({ value, label: t(k.label) }))} />
        <Inline key={l.id} label="Label" value={l.label} placeholder={t("VLAN 10")} onSave={(v) => patch("map_links", l.id, { label: v })} />
        <Button variant="danger" onClick={() => remove("map_links", l.id)}><TrashIcon className="size-5" aria-hidden />{t("Delete")}</Button>
      </> : <p className="text-[13px] text-fg2">{l.cable ? <>{l.label}. {t("Change it on the ports of the hardware records.")}</> : t("Kept on the VPN links page.")}</p>}
    </>
  })() : selZone ? <>
    <div className="flex items-start gap-3">
      <RectangleGroupIcon className="size-6 shrink-0" style={{ color: `var(--color-${(ZONE_COLORS[selZone.color] ?? ZONE_COLORS.blue)[1]})` }} aria-hidden />
      <div className="min-w-0 flex-1"><div className="truncate font-medium">{selZone.name}</div><div className="truncate text-xs text-fg3">{t(inside(selZone, list).length === 1 ? "{n} device inside" : "{n} devices inside", { n: inside(selZone, list).length })}</div></div>
      <IconButton label="Close" icon={XMarkIcon} onClick={() => setSel(null)} />
    </div>
    <Inline key={selZone.id} label="Name" value={selZone.name} onSave={(v) => v && patch("map_zones", selZone.id, { name: v })} />
    <Select label="Colour" value={selZone.color || "blue"} onChange={(e) => patch("map_zones", selZone.id, { color: e.target.value })} options={Object.entries(ZONE_COLORS).map(([value, [label]]) => ({ value, label: t(label) }))} />
    <p className="text-xs text-fg3">{t("Drag the label to move the zone with its devices, the corner to resize it.")}</p>
    <Button variant="danger" onClick={removeSelected}><TrashIcon className="size-5" aria-hidden />{t("Delete")}</Button>
  </> : null

  const canvas = (
    <svg ref={svg} viewBox={`-16 -24 ${right + 32} ${bottom + 40}`} tabIndex={0} className="size-full touch-none select-none outline-none cursor-grab active:cursor-grabbing"
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); removeSelected() } else zoom.onKeyDown(e) }}
      onPointerDown={zoom.handlers.onPointerDown} onPointerMove={(e) => { zoom.handlers.onPointerMove(e); if (wire) move(e) }}
      onPointerUp={(e) => { zoom.handlers.onPointerUp(e); if (wire) endWire(e); else if (!zoom.moved() && (e.target as Element).hasAttribute("data-bg")) setSel(null) }} onPointerCancel={zoom.handlers.onPointerCancel}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("text/nyx-type")) e.preventDefault() }} onDrop={(e) => { const type = e.dataTransfer.getData("text/nyx-type"); if (type) { e.preventDefault(); addNode(type, toSvg(e)) } }}
      role="img" aria-label={t("Network map with {n} devices. The same data is listed below.", { n: list.length })}>
      <defs><pattern id={dots} width={24} height={24} patternUnits="userSpaceOnUse"><circle cx={1} cy={1} r={1} className="fill-line2" /></pattern></defs>
      <g ref={inner} transform={zoom.transform}>
        <rect data-bg x={-4000} y={-4000} width={right + 8000} height={bottom + 8000} fill={`url(#${dots})`} />
        {areas.map((z) => {
          const c = `var(--color-${(ZONE_COLORS[z.color] ?? ZONE_COLORS.blue)[1]})`, on = selZone?.id === z.id
          const label = fit(z.name, 32)
          return (
            <g key={z.id}>
              <rect data-bg x={z.x} y={z.y} width={z.w} height={z.h} rx={16} fill={c} fillOpacity={on ? 0.1 : 0.06} stroke={c} strokeOpacity={on ? 0.9 : 0.5} strokeDasharray="6 5" />
              <g className="cursor-move" onPointerDown={(e) => grabZone(e, z, "move")} onPointerMove={moveZone} onPointerUp={dropZone}>
                <rect x={z.x + 12} y={z.y - 12} width={label.length * 7 + 22} height={24} rx={12} fill="var(--color-surface)" stroke={c} />
                <text x={z.x + 23} y={z.y + 4} fill={c} className="text-xs font-medium">{label}</text>
              </g>
              <path d={`M${z.x + z.w - 4} ${z.y + z.h - 16}L${z.x + z.w - 4} ${z.y + z.h - 4}L${z.x + z.w - 16} ${z.y + z.h - 4}`} fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" />
              <rect x={z.x + z.w - 20} y={z.y + z.h - 20} width={20} height={20} fill="transparent" className="cursor-nwse-resize" onPointerDown={(e) => grabZone(e, z, "size")} onPointerMove={moveZone} onPointerUp={dropZone}><title>{t("Resize")}</title></rect>
            </g>
          )
        })}
        {hosts.map((h) => {
          const f = frame(h, list.filter((n) => parent[n.id] === h.id))
          return <rect key={`f${h.id}`} x={f.x} y={f.y} width={f.w} height={f.h} rx={12} className="pointer-events-none fill-bg/50 stroke-line" />
        })}
        {allLinks.map((l: any) => {
          const [a, b] = [byId[l.source], byId[l.target]]
          if (!a || !b) return null
          const on = selLink?.id === l.id
          if (isTree(l)) {
            const [p, c] = parent[l.source] === l.target ? [b, a] : [a, b]
            return <path key={l.id} d={treePath(p, c)} fill="none" className={on ? "stroke-accent" : "stroke-line2"} strokeWidth={on ? 2 : 1} opacity={lit(a.id) && lit(b.id) ? 1 : 0.15} />
          }
          const c = curve(a, b)
          const k = LINK_KINDS[kindOf(l)]
          return (
            <g key={l.id} opacity={near ? (near.has(a.id) && near.has(b.id) && (a.id === hover || b.id === hover) ? 1 : 0.12) : found ? (lit(a.id) || lit(b.id) ? 1 : 0.2) : 1}>
              {on && <path d={c.d} fill="none" strokeWidth={6} className="stroke-accent/30" />}
              <path d={c.d} fill="none" strokeWidth={l.cable ? 1.5 : k.width ?? 1.5} className={l.cable ? "stroke-fg3" : k.className} strokeDasharray={l.cable ? undefined : k.dash} />
              <path d={c.d} fill="none" stroke="transparent" strokeWidth={12} className="cursor-pointer" onPointerDown={(e) => e.stopPropagation()} onClick={() => setSel({ link: l.id })}><title>{`${t(l.cable ? "Cable" : k.label)}${l.label ? ` · ${l.label}` : ""}`}</title></path>
              {l.label && <text x={c.mx} y={c.my - 6} textAnchor="middle" className="pointer-events-none fill-fg2 text-xs" stroke="var(--color-surface)" strokeWidth={3} paintOrder="stroke">{l.label}</text>}
            </g>
          )
        })}
        {wire && byId[wire.from] && <line x1={byId[wire.from].x + W} y1={byId[wire.from].y + H / 2} x2={wire.x} y2={wire.y} strokeWidth={2} strokeDasharray={LINK_KINDS[kind].dash} className={`pointer-events-none ${LINK_KINDS[kind].className}`} />}
        {list.map((n) => {
          const I = TYPE_ICONS[n.type] ?? CubeIcon
          const host = hosts.includes(n), on = selNode?.id === n.id
          return (
            <g key={n.id} transform={`translate(${n.x} ${n.y})`} opacity={lit(n.id) ? 1 : 0.25} className="group cursor-grab touch-none transition-opacity" onPointerDown={(e) => down(e, n)} onPointerMove={move} onPointerUp={up}
              onPointerEnter={() => !drag.current && !wire && setHover(n.id)} onPointerLeave={() => setHover(undefined)}>
              <title>{`${n.name}${n.ip ? ` · ${n.ip}` : ""}${n.type ? ` · ${t(TYPE_LABELS[n.type] ?? n.type)}` : ""}`}</title>
              {found?.includes(n.id) && <rect x={-5} y={-5} width={W + 10} height={H + 10} rx={13} fill="none" strokeWidth={2} strokeDasharray="5 4" className="stroke-accent" />}
              <rect width={W} height={H} rx={10} strokeWidth={on ? 2 : 1} className={`fill-raised ${on ? "stroke-accent" : host ? "stroke-accent/60 group-hover:stroke-accent" : "stroke-line2 group-hover:stroke-fg3"}`} />
              <g className={FAMILY[n.type] ?? "text-fg2"}>
                <rect x={8} y={8} width={36} height={36} rx={8} fill="currentColor" opacity={0.16} />
                <I x={16} y={16} width={20} height={20} />
              </g>
              <text x={52} y={n.ip ? 23 : 31} className="fill-fg text-[13px] font-medium">{fit(n.name, 16)}</text>
              {n.ip && <text x={52} y={40} className="fill-fg3 font-mono text-[11px]">{n.ip}</text>}
              <circle cx={W} cy={H / 2} r={6} className={`cursor-crosshair fill-surface stroke-accent ${on ? "" : "opacity-0 group-hover:opacity-100"}`} onPointerDown={(e) => { e.stopPropagation(); svg.current!.setPointerCapture(e.pointerId); setHover(undefined); setWire({ from: n.id, ...toSvg(e) }) }}><title>{t("Drag onto another device to link them")}</title></circle>
            </g>
          )
        })}
      </g>
    </svg>
  )

  return (
    <>
      <PageHeader title={t("Network map")} subtitle={note} actions={<>
        <Button onClick={importInventory}><ServerStackIcon className="size-5" aria-hidden />{t("Import the inventory")}</Button>
        <Button onClick={arrangeAll} disabled={list.length < 2}><Squares2X2Icon className="size-5" aria-hidden />{t("Arrange")}</Button>
        <details className="relative">
          <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-control border border-line2 px-4 text-fg2 hover:text-fg max-sm:h-11"><ArrowDownTrayIcon className="size-5" aria-hidden />{t("Export")}</summary>
          <div className="absolute right-0 z-30 mt-1 flex w-44 flex-col rounded-panel border border-line2 bg-surface p-1 shadow-lg">
            {FORMATS.map(([f, label]) => <button key={f} type="button" className="h-9 rounded-control px-3 text-left hover:bg-raised" onClick={() => download(`/api/map/export/${f}`)}>{label}</button>)}
          </div>
        </details>
      </>} />
      <div ref={box} className="flex h-[calc(100dvh-11rem)] min-h-[30rem] flex-col overflow-hidden rounded-panel border border-line bg-surface [&:fullscreen]:h-dvh">
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
          {view === "diagram" && <MapControls zoom={zoom} full={full} query={query} onQuery={setQuery} found={found?.length}
            onFind={() => { const n = byId[found?.[0] ?? ""]; if (n) { zoom.focus({ x: n.x + W / 2, y: n.y + H / 2 }); setSel({ node: n.id }) } }} />}
          <Tabs tabs={MAP_VIEWS} value={view} onChange={setView} />
          {view === "diagram" && <Button onClick={addZone}><RectangleGroupIcon className="size-5" aria-hidden />{t("Add zone")}</Button>}
        </div>
        <div className="relative flex min-h-0 flex-1">
          {view === "diagram" && (
            <nav aria-label={t("Add to the map")} className={`flex shrink-0 flex-col border-r border-line ${palette ? "w-48 max-sm:absolute max-sm:inset-y-0 max-sm:left-0 max-sm:z-20 max-sm:bg-surface max-sm:shadow-lg" : "w-12"}`}>
              <button type="button" className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3.5 text-[13px] font-medium text-fg2 hover:text-fg" aria-expanded={palette} onClick={() => setPalette(!palette)}>
                {palette ? <><span className="flex-1 text-left">{t("Devices")}</span><ChevronDoubleLeftIcon className="size-4" aria-hidden /></> : <ChevronDoubleRightIcon className="size-4" aria-label={t("Show devices")} />}
              </button>
              <ul className="flex-1 overflow-y-auto p-1">
                {Object.entries(TYPE_LABELS).filter(([k]) => TYPE_ICONS[k] && k !== "physical").map(([k, label]) => {
                  const I = TYPE_ICONS[k]
                  return (
                    <li key={k}>
                      <button type="button" draggable onDragStart={(e) => e.dataTransfer.setData("text/nyx-type", k)} onClick={() => addNode(k, middle())} title={t("Add {type}, or drag it onto the map", { type: t(label) })} aria-label={t("Add {type}", { type: t(label) })}
                        className="flex h-9 w-full cursor-grab items-center gap-2.5 rounded-control px-2 text-left text-[13px] text-fg2 hover:bg-raised hover:text-fg">
                        <span className={`relative flex size-6 shrink-0 items-center justify-center rounded-md ${FAMILY[k] ?? "text-fg2"}`}><span className="absolute inset-0 rounded-md bg-current opacity-15" /><I className="size-4" aria-hidden /></span>
                        {palette && <span className="truncate">{t(label)}</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </nav>
          )}
          <div className="relative min-w-0 flex-1">
            {view === "tree" ? <div className="h-full overflow-auto p-2"><TreeView nodes={viewNodes} icons={icons} /></div> : view === "groups" ? <div className="h-full overflow-auto p-2"><GroupedView nodes={viewNodes} icons={icons} /></div> : canvas}
            {view === "diagram" && list.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
                <div className="pointer-events-auto max-w-sm rounded-panel border border-line bg-surface p-5 text-center">
                  <p className="mb-3 text-fg2">{t("Drag devices from the list on the left, or bring in the devices and virtual assets of the inventory.")}</p>
                  <Button onClick={importInventory}><ServerStackIcon className="size-5" aria-hidden />{t("Import the inventory")}</Button>
                </div>
              </div>
            )}
          </div>
          {view === "diagram" && inspector && <aside aria-label={t("Selection")} className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-line p-4 max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[60%] max-md:w-auto max-md:border-l-0 max-md:border-t max-md:bg-surface">{inspector}</aside>}
        </div>
        {view === "diagram" && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-1.5">
            <span />
            <div className="flex flex-wrap items-center gap-1 text-xs text-fg2" role="radiogroup" aria-label={t("New links")}>
              <span className="mr-1 text-fg3">{t("New links")}</span>
              {Object.entries(LINK_KINDS).map(([k, v]) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 ${kind === k ? "bg-accent-soft text-accent" : "hover:bg-raised"}`}>{swatch(k)}{t(v.label)}</button>
              ))}
            </div>
          </div>
        )}
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer text-[13px] text-fg2 hover:text-fg">{t("Devices and links as a list")}</summary>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <Panel title={t("Devices")} flush>
            {list.length === 0 ? <div className="px-4 pb-4"><Empty>{t("No device yet.")}</Empty></div> : (
              <Table head={["Name", "Address", "Type"]}>
                {list.map((n) => (
                  <tr key={n.id}>
                    <Td className="font-medium"><button className="min-h-9 text-left max-sm:min-h-11" onClick={() => { setView("diagram"); setSel({ node: n.id }); zoom.focus({ x: n.x + W / 2, y: n.y + H / 2 }) }}>{n.name}</button></Td>
                    <Td mono>{n.ip || "—"}</Td>
                    <Td className="text-fg2">{n.type ? t(TYPE_LABELS[n.type] ?? n.type) : "—"}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
          <Panel title={t("Links")} flush>
            {!links.data?.items.length ? <div className="px-4 pb-4"><Empty>{t("No link yet.")}</Empty></div> : (
              <Table head={["From", "To", "Kind", "Label"]}>
                {links.data.items.map((l: any) => (
                  <tr key={l.id}>
                    <Td className="font-medium">{byId[l.source]?.name ?? "—"}</Td>
                    <Td>{byId[l.target]?.name ?? "—"}</Td>
                    <Td className="text-fg2">{t(LINK_KINDS[l.kind]?.label ?? "Ethernet")}</Td>
                    <Td className="text-fg2">{l.label || "—"}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
        </div>
      </details>
    </>
  )
}

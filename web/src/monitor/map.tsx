import { HomeModernIcon, ServerIcon, SignalIcon } from "@heroicons/react/24/outline"
import { useRef, useState } from "react"
import { MapControls, matches, useFullscreen, usePanZoom, zoomed } from "../ui/canvas"
import { Button, Empty, ErrorNote, Status } from "../ui/components"
import { GroupedView, TreeView } from "../ui/mapviews"
import { api, type Level, levelText, useApi } from "../ui/lib"
import { navigate, PageHeader } from "../ui/shell"
import { HOST_TYPES } from "./hosts"
import { t } from "../ui/i18n"

export interface MapNode {
  id?: string; label: string; state: Level; type: string
  /** Position of the parent in the list. Top-level nodes hang from the hub. */
  parent: number | null
  x?: number | null; y?: number | null
  detail?: Record<string, string | null>; link?: string
}
interface At { x: number; y: number }
export { zoomed }

const RING = 150
/** Room for a node and its label along a ring. */
const SPACING = 110
const PADDING = 110
const STATES: Level[] = ["ok", "warn", "crit", "off"]

/** The hub in the middle and rings around it: each node gets a share of its parent's arc by the leaves below it, so that nothing overlaps. */
export function autoLayout(nodes: MapNode[]): At[] {
  const kids = (parent: number | null) => nodes.flatMap((n, i) => (n.parent === parent ? [i] : []))
  const leaves = (i: number): number => kids(i).reduce((sum, k) => sum + leaves(k), 0) || 1
  const roots = kids(null)
  const total = roots.reduce((sum, r) => sum + leaves(r), 0)
  const ring = Math.max(RING, (total * SPACING) / (2 * Math.PI))
  const out = nodes.map(() => ({ x: 0, y: 0 }))
  const fan = (i: number, from: number, to: number, depth: number) => {
    const mid = (from + to) / 2
    out[i] = { x: Math.round(Math.cos(mid) * ring * depth), y: Math.round(Math.sin(mid) * ring * depth) }
    let at = from
    for (const k of kids(i)) {
      const share = ((to - from) * leaves(k)) / leaves(i)
      fan(k, at, at + share, depth + 1)
      at += share
    }
  }
  let at = -Math.PI / 2
  for (const r of roots) {
    const share = (2 * Math.PI * leaves(r)) / total
    fan(r, at, at + share, 1)
    at += share
  }
  return out
}

/** A stopped guest is not an outage, but it is worth a look. */
export function hubState(nodes: MapNode[]): Level {
  if (nodes.some((n) => n.state === "crit")) return "crit"
  return nodes.some((n) => n.state === "warn" || n.state === "off") ? "warn" : "ok"
}

/** A node, the chain of hosts above it and everything below it: what a hover brings forward. */
export function family(nodes: Pick<MapNode, "parent">[], i: number) {
  const out = new Set<number>([i])
  for (let p = nodes[i].parent; p != null && !out.has(p); p = nodes[p].parent) out.add(p)
  const down = (j: number) => nodes.forEach((n, k) => { if (n.parent === j && !out.has(k)) { out.add(k); down(k) } })
  down(i)
  return out
}

const ICONS: Record<string, any> = { ...HOST_TYPES, probe: { label: "Probe", icon: SignalIcon } }
const short = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s)

function Node({ at, n, big, dim, mark, onDown, onShow, onHide }: { at: At; n: Pick<MapNode, "label" | "state" | "type" | "link">; big?: boolean; dim?: boolean; mark?: boolean; onDown?: (e: React.PointerEvent) => void; onShow?: () => void; onHide?: () => void }) {
  const I = big ? HomeModernIcon : ICONS[n.type]?.icon ?? ServerIcon
  const [r, s] = big ? [30, 30] : [22, 22]
  return (
    <g transform={`translate(${at.x} ${at.y})`} opacity={dim ? 0.2 : 1} className={`outline-none transition-opacity [&:focus-visible>circle]:stroke-accent ${n.link ? "cursor-pointer" : ""}`} tabIndex={n.link ? 0 : undefined} role={n.link ? "link" : undefined} aria-label={`${n.label}: ${n.state}`}
      onPointerDown={onDown} onPointerEnter={onShow} onPointerLeave={onHide} onFocus={onShow} onBlur={onHide} onKeyDown={(e) => { if (e.key === "Enter" && n.link) navigate(n.link) }}>
      {mark && <circle r={r + 7} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeDasharray="4 3" />}
      <circle r={r} fill="var(--color-surface)" />
      <circle r={r} fill={`var(--color-${n.state})`} fillOpacity="0.16" stroke={`var(--color-${n.state})`} strokeWidth="2.5" />
      <I x={-s / 2} y={-s / 2} width={s} height={s} className={levelText[n.state]} />
      <text y={r + 16} textAnchor="middle" fontSize="13" fill="var(--color-fg)" stroke="var(--color-surface)" strokeWidth="3" paintOrder="stroke">{short(n.label)}</text>
    </g>
  )
}

/** Nodes around a hub, drawn from whatever the server chose to send: a public page only has names and states. A wall is `still`, as nobody can reach it. */
export function LiveMap({ nodes, still, onMove }: { nodes: MapNode[]; still?: boolean; onMove?: (i: number, at: At) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const inner = useRef<SVGGElement>(null)
  const grab = useRef<{ i: number; px: number; py: number; from: At; moved: boolean } | null>(null)
  // A public page scrolls with the wheel; zooming there is left to the buttons and fingers.
  const zoom = usePanZoom(svg, { enabled: !still, wheel: !!onMove })
  const full = useFullscreen(box)
  const [dragged, setDragged] = useState<{ i: number; at: At } | null>(null)
  const [shown, setShown] = useState<number | null>(null)
  const [query, setQuery] = useState("")
  const [mode, setMode] = useState("radial")

  if (!nodes.length) return <div className="flex h-full items-center justify-center p-4"><Empty>{t("Nothing to show yet.")}</Empty></div>
  const auto = autoLayout(nodes)
  const placed = nodes.map((n, i) => (n.x != null && n.y != null ? { x: n.x, y: n.y } : auto[i]))
  const pos = (i: number) => (dragged?.i === i ? dragged.at : placed[i])
  const [left, right] = [Math.min(0, ...placed.map((p) => p.x)) - PADDING, Math.max(0, ...placed.map((p) => p.x)) + PADDING]
  const [top, low] = [Math.min(0, ...placed.map((p) => p.y)) - PADDING, Math.max(0, ...placed.map((p) => p.y)) + PADDING]
  const counts = STATES.map((l) => [l, nodes.filter((n) => n.state === l).length] as const).filter(([, n]) => n)
  const found = query.trim() ? nodes.flatMap((n, i) => (matches(query, n.label, ...Object.values(n.detail ?? {})) ? [i] : [])) : null
  const near = shown != null ? family(nodes, shown) : null
  const lit = (i: number) => (near ? near.has(i) : found ? found.includes(i) : true)

  const down = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    svg.current!.setPointerCapture(e.pointerId)
    grab.current = { i, px: e.clientX, py: e.clientY, from: placed[i], moved: false }
  }
  const move = (e: React.PointerEvent) => {
    zoom.handlers.onPointerMove(e)
    const g = grab.current
    if (!g) return
    const [dx, dy] = [e.clientX - g.px, e.clientY - g.py]
    if (!g.moved && Math.hypot(dx, dy) < 4) return
    g.moved = true
    if (!onMove) return
    const s = inner.current!.getScreenCTM()?.a ?? 1
    setDragged({ i: g.i, at: { x: Math.round(g.from.x + dx / s), y: Math.round(g.from.y + dy / s) } })
  }
  const up = (e: React.PointerEvent) => {
    zoom.handlers.onPointerUp(e)
    const g = grab.current
    grab.current = null
    if (!g) return
    if (dragged) onMove?.(dragged.i, dragged.at)
    setDragged(null)
    if (!g.moved && nodes[g.i].link) navigate(nodes[g.i].link!)
  }
  const hovered = shown == null ? undefined : nodes[shown]
  const MODES = [["radial", "Map"], ["tree", "Tree"], ["groups", "By type"]]

  return (
    <div ref={box} className="relative h-full min-h-0 overflow-hidden bg-surface">
      {!still && (
        <div role="tablist" className="absolute right-2 top-2 z-10 flex rounded-control border border-line bg-surface">
          {MODES.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => setMode(id)} className={`h-9 max-sm:h-11 rounded-control px-3 text-[13px] ${mode === id ? "bg-accent-soft text-accent" : "text-fg2 hover:text-fg"}`}>{t(label)}</button>)}
        </div>
      )}
      {!still && mode !== "radial" && <div className="h-full overflow-auto pt-14">{mode === "tree" ? <TreeView nodes={nodes.map((n) => ({ ...n, sub: n.detail?.Address ?? n.detail?.IP ?? undefined }))} icons={ICONS} /> : <GroupedView nodes={nodes} icons={ICONS} />}</div>}
      <div className={`size-full ${!still && mode !== "radial" ? "hidden" : ""}`}>
      <svg ref={svg} viewBox={`${left} ${top} ${right - left} ${low - top}`} tabIndex={still ? undefined : 0} onKeyDown={zoom.onKeyDown}
        className={`size-full select-none outline-none ${still ? "pointer-events-none" : `cursor-grab active:cursor-grabbing ${onMove ? "touch-none" : "touch-pan-y"}`}`} role="group" aria-label={t("Map of the homelab")}
        onPointerDown={zoom.handlers.onPointerDown} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <g ref={inner} transform={zoom.transform}>
          {nodes.map((n, i) => {
            const [a, b] = [pos(i), n.parent == null ? { x: 0, y: 0 } : pos(n.parent)]
            const on = lit(i) && (n.parent == null || lit(n.parent))
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={near && on ? "var(--color-accent)" : n.state === "ok" ? "var(--color-line2)" : `var(--color-${n.state})`} strokeWidth={near && on ? 2.5 : 1.5} strokeOpacity={on ? 0.8 : 0.15} />
          })}
          <Node at={{ x: 0, y: 0 }} big n={{ label: "Homelab", state: hubState(nodes), type: "" }} />
          {nodes.map((n, i) => <Node key={n.id ?? i} at={pos(i)} n={n} dim={!lit(i)} mark={!!found?.includes(i)} onDown={still ? undefined : (e) => down(e, i)} onShow={() => setShown(i)} onHide={() => setShown(null)} />)}
        </g>
      </svg>
      {!still && <MapControls className="absolute left-2 top-2" zoom={zoom} full={full} query={query} onQuery={setQuery} found={found?.length} onFind={() => found?.length && zoom.focus(pos(found[0]))} />}
      <div className="absolute bottom-2 left-3 flex gap-3">{counts.map(([l, n]) => <Status key={l} cell level={l} label={String(n)} />)}</div>
      {hovered && (
        <div className="pointer-events-none absolute bottom-2 right-2 w-56 rounded-box border border-line bg-surface p-3">
          <p className="truncate font-medium">{hovered.label}</p>
          <p className="text-[13px] text-fg3">{t(ICONS[hovered.type]?.label ?? hovered.type)}</p>
          <div className="my-1"><Status cell level={hovered.state} /></div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-[13px]">
            {Object.entries(hovered.detail ?? {}).filter(([, v]) => v).map(([k, v]) => <div key={k} className="contents"><dt className="text-fg3">{t(k)}</dt><dd className="truncate text-right">{v}</dd></div>)}
          </dl>
        </div>
      )}
      </div>
    </div>
  )
}

export function MapPage() {
  const { data, error, reload } = useApi<MapNode[]>("/api/map")
  const [moved, setMoved] = useState<Record<string, At>>({})
  const [saveError, setSaveError] = useState("")
  const nodes = (data ?? []).map((n) => ({ ...n, ...moved[n.id!] }))
  const save = (layout: Record<string, At>) => api("/api/settings/map_layout", { method: "PUT", body: layout }).then(() => setSaveError(""), (e) => setSaveError(e.message))
  const place = (i: number, at: At) => {
    const next = { ...moved, [nodes[i].id!]: at }
    setMoved(next)
    save({ ...Object.fromEntries(nodes.filter((n) => n.x != null && n.y != null).map((n) => [n.id, { x: n.x, y: n.y }])), ...next })
  }
  const reset = async () => { await save({}); setMoved({}); reload() }
  return (
    <>
      <PageHeader title={t("Map")} subtitle="Updates by itself. Drag a node to place it, open it with a click, and hover it to bring its hosts and guests forward." onRefresh={reload} actions={<Button onClick={reset}>{t("Reset layout")}</Button>} />
      <ErrorNote>{error || saveError}</ErrorNote>
      <div className="h-[calc(100dvh-13rem)] min-h-96 rounded-panel border border-line bg-surface">{data && <LiveMap nodes={nodes} onMove={place} />}</div>
    </>
  )
}

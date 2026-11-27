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

/** Each node is a card; columns of cards fan out from the hub, on both of its sides. */
const CARD_W = 184, CARD_H = 52, HUB_R = 38
/** A card and the room its connector needs to bend. */
const COLUMN = 272
const ROW = 68
const PADDING = 40
const STATES: Level[] = ["ok", "warn", "crit", "off"]
/** Seconds a dot takes to run one dash along a connector: an alert hurries. */
const FLOW: Partial<Record<Level, number>> = { ok: 1.8, info: 1.8, warn: 1.1, crit: 0.6 }
/** Milliseconds between one ring of cards popping in and the next. */
const STAGGER = 140

/**
 * The hub in the middle, top-level nodes split between its right and left so that both
 * columns stay short, children one column further out. Each leaf takes a row of its own
 * and a parent sits level with the middle of its children, so that nothing overlaps.
 */
export function autoLayout(nodes: MapNode[]): At[] {
  const kids = (parent: number | null) => nodes.flatMap((n, i) => (n.parent === parent ? [i] : []))
  const leaves = (i: number): number => kids(i).reduce((sum, k) => sum + leaves(k), 0) || 1
  const sides: number[][] = [[], []]
  const load = [0, 0]
  for (const r of kids(null)) {
    const s = load[0] <= load[1] ? 0 : 1
    sides[s].push(r)
    load[s] += leaves(r)
  }
  const out = nodes.map(() => ({ x: 0, y: 0 }))
  sides.forEach((roots, s) => {
    const dir = s ? -1 : 1
    let row = -(load[s] - 1) / 2
    const place = (i: number, depth: number): number => {
      const ys = kids(i).map((k) => place(k, depth + 1))
      const y = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : row++ * ROW
      out[i] = { x: dir * depth * COLUMN, y: Math.round(y) }
      return y
    }
    roots.forEach((r) => place(r, 1))
  })
  return out
}

/** A connector leaves the side of a box that faces the other one and bends like a cable. `aw` and `bw` are the widths of both ends. */
export function connector(a: At, aw: number, b: At, bw: number) {
  const dir = b.x >= a.x ? 1 : -1
  const from = { x: a.x + (dir * aw) / 2, y: a.y }, to = { x: b.x - (dir * bw) / 2, y: b.y }
  const bend = Math.max(40, Math.abs(to.x - from.x) / 2)
  return { from, to, d: `M${from.x} ${from.y} C${from.x + dir * bend} ${from.y} ${to.x - dir * bend} ${to.y} ${to.x} ${to.y}` }
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

/** How many hops from the hub, so that cards pop in ring after ring. */
const depthOf = (nodes: MapNode[], i: number) => {
  let d = 1
  for (let p = nodes[i].parent; p != null && d < nodes.length; p = nodes[p].parent) d++
  return d
}

const ICONS: Record<string, any> = { ...HOST_TYPES, probe: { label: "Probe", icon: SignalIcon } }
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const stroke = (l: Level) => (l === "ok" ? "var(--color-line2)" : `var(--color-${l})`)

/** The line from a parent to a child: a cable with a port at each end, and dots running down it while the child is up. */
function Connector({ d, from, to, state, lit, hot, delay, label }: ReturnType<typeof connector> & { state: Level; lit: boolean; hot: boolean; delay: number; label?: string | null }) {
  const color = hot ? "var(--color-accent)" : stroke(state)
  const off = state === "off"
  const style = { "--delay": `${delay}ms`, "--flow": `${(FLOW[state] ?? 1.8) / (hot ? 2 : 1)}s` } as React.CSSProperties
  return (
    <g opacity={lit ? 1 : 0.15} className="transition-opacity" style={style}>
      {off
        ? <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="5 5" strokeOpacity={0.7} />
        : <path d={d} fill="none" stroke={color} strokeWidth={hot ? 2.5 : 1.75} strokeOpacity={hot || state !== "ok" ? 0.9 : 0.55} pathLength={100} strokeDasharray="100" className="map-draw" />}
      {!off && <path d={d} fill="none" stroke={hot ? "var(--color-accent)" : `var(--color-${state})`} strokeWidth={3.5} strokeLinecap="round" strokeDasharray="0.5 23.5" className="map-flow" />}
      {[from, to].map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={3.5} fill="var(--color-surface)" stroke={color} strokeWidth={1.5} />)}
      {label && (
        <g transform={`translate(${(from.x + to.x) / 2} ${(from.y + to.y) / 2})`} className="map-pop" style={style}>
          <rect x={-26} y={-10} width={52} height={20} rx={10} fill="var(--color-raised)" stroke={color} strokeWidth={1} />
          <text y={4} textAnchor="middle" fontSize={11} fill="var(--color-fg2)">{label}</text>
        </g>
      )}
    </g>
  )
}

function Card({ at, n, dim, mark, delay, onDown, onShow, onHide }: { at: At; n: MapNode; dim?: boolean; mark?: boolean; delay: number; onDown?: (e: React.PointerEvent) => void; onShow?: () => void; onHide?: () => void }) {
  const I = ICONS[n.type]?.icon ?? ServerIcon
  const sub = n.detail?.Address ?? n.detail?.Target ?? t(ICONS[n.type]?.label ?? n.type)
  const [w, h] = [CARD_W, CARD_H]
  const box = { x: -w / 2, y: -h / 2, width: w, height: h, rx: 12 }
  return (
    <g transform={`translate(${at.x} ${at.y})`} opacity={dim ? 0.25 : 1} className={`outline-none transition-opacity [&:focus-visible_.card]:stroke-accent ${n.link ? "cursor-pointer" : ""}`} tabIndex={n.link ? 0 : undefined} role={n.link ? "link" : undefined} aria-label={`${n.label}: ${n.state}`}
      onPointerDown={onDown} onPointerEnter={onShow} onPointerLeave={onHide} onFocus={onShow} onBlur={onHide} onKeyDown={(e) => { if (e.key === "Enter" && n.link) navigate(n.link) }}>
      <g className="map-pop" style={{ "--delay": `${delay}ms` } as React.CSSProperties}>
        {n.state === "crit" && <rect {...box} fill="none" stroke="var(--color-crit)" strokeWidth={2} className="map-ping" />}
        {mark && <rect x={box.x - 6} y={box.y - 6} width={w + 12} height={h + 12} rx={16} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeDasharray="4 3" />}
        <rect {...box} fill="var(--color-surface)" stroke={stroke(n.state)} strokeOpacity={n.state === "ok" ? 0.6 : 1} strokeWidth={1.5} className="card" />
        <rect x={box.x + 8} y={-18} width={36} height={36} rx={9} fill={`var(--color-${n.state})`} fillOpacity={0.16} />
        <I x={box.x + 16} y={-10} width={20} height={20} className={levelText[n.state]} />
        <text x={box.x + 54} y={-3} fontSize={13} fontWeight={500} fill="var(--color-fg)">{short(n.label, 17)}</text>
        <text x={box.x + 54} y={14} fontSize={11} fill="var(--color-fg3)">{short(sub, 21)}</text>
        <circle cx={w / 2 - 12} cy={box.y + 12} r={4} fill={`var(--color-${n.state})`} />
      </g>
    </g>
  )
}

function Hub({ state }: { state: Level }) {
  return (
    <g aria-hidden>
      <circle r={HUB_R + 10} fill={`var(--color-${state})`} fillOpacity={0.14} className="map-breathe" />
      <g className="map-pop">
        <circle r={HUB_R} fill="var(--color-surface)" stroke={`var(--color-${state})`} strokeWidth={2.5} />
        <HomeModernIcon x={-13} y={-21} width={26} height={26} className={levelText[state]} />
        <text y={19} textAnchor="middle" fontSize={11} fill="var(--color-fg2)">Homelab</text>
      </g>
    </g>
  )
}

/** Cards around a hub, drawn from whatever the server chose to send: a public page only has names and states. A wall is `still`, as nobody can reach it. */
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
  const [mode, setMode] = useState("map")

  if (!nodes.length) return <div className="flex h-full items-center justify-center p-4"><Empty>{t("Nothing to show yet.")}</Empty></div>
  const auto = autoLayout(nodes)
  const placed = nodes.map((n, i) => (n.x != null && n.y != null ? { x: n.x, y: n.y } : auto[i]))
  const pos = (i: number) => (dragged?.i === i ? dragged.at : placed[i])
  const xs = placed.map((p) => p.x), ys = placed.map((p) => p.y)
  const [left, right] = [Math.min(-HUB_R, ...xs.map((x) => x - CARD_W / 2)) - PADDING, Math.max(HUB_R, ...xs.map((x) => x + CARD_W / 2)) + PADDING]
  const [top, low] = [Math.min(-HUB_R, ...ys.map((y) => y - CARD_H / 2)) - PADDING, Math.max(HUB_R, ...ys.map((y) => y + CARD_H / 2)) + PADDING]
  const counts = STATES.map((l) => [l, nodes.filter((n) => n.state === l).length] as const).filter(([, n]) => n)
  const found = query.trim() ? nodes.flatMap((n, i) => (matches(query, n.label, ...Object.values(n.detail ?? {})) ? [i] : [])) : null
  const near = shown != null ? family(nodes, shown) : null
  const lit = (i: number) => (near ? near.has(i) : found ? found.includes(i) : true)
  const delay = (i: number) => depthOf(nodes, i) * STAGGER + (i % 8) * 20

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
  const MODES = [["map", "Map"], ["tree", "Tree"], ["groups", "By type"]]

  return (
    <div ref={box} className="relative h-full min-h-0 overflow-hidden bg-surface">
      {!still && (
        <div role="tablist" className="absolute right-2 top-2 z-10 flex rounded-control border border-line bg-surface">
          {MODES.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => setMode(id)} className={`h-9 max-sm:h-11 rounded-control px-3 text-[13px] ${mode === id ? "bg-accent-soft text-accent" : "text-fg2 hover:text-fg"}`}>{t(label)}</button>)}
        </div>
      )}
      {!still && mode !== "map" && <div className="h-full overflow-auto pt-14">{mode === "tree" ? <TreeView nodes={nodes.map((n) => ({ ...n, sub: n.detail?.Address ?? n.detail?.IP ?? undefined }))} icons={ICONS} /> : <GroupedView nodes={nodes} icons={ICONS} />}</div>}
      <div className={`size-full ${!still && mode !== "map" ? "hidden" : ""}`}>
        <svg ref={svg} viewBox={`${left} ${top} ${right - left} ${low - top}`} tabIndex={still ? undefined : 0} onKeyDown={zoom.onKeyDown}
          className={`size-full select-none outline-none ${still ? "pointer-events-none" : `cursor-grab active:cursor-grabbing ${onMove ? "touch-none" : "touch-pan-y"}`}`} role="group" aria-label={t("Map of the homelab")}
          onPointerDown={zoom.handlers.onPointerDown} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <g ref={inner} transform={zoom.transform}>
            {nodes.map((n, i) => {
              const [a, aw] = n.parent == null ? [{ x: 0, y: 0 }, HUB_R * 2] : [pos(n.parent), CARD_W]
              const on = lit(i) && (n.parent == null || lit(n.parent))
              return <Connector key={n.id ?? i} {...connector(a, aw, pos(i), CARD_W)} state={n.state} lit={on} hot={!!near && on} delay={delay(i) - STAGGER / 2} label={n.detail?.Latency} />
            })}
            <Hub state={hubState(nodes)} />
            {nodes.map((n, i) => <Card key={n.id ?? i} at={pos(i)} n={n} delay={delay(i)} dim={!lit(i)} mark={!!found?.includes(i)} onDown={still ? undefined : (e) => down(e, i)} onShow={() => setShown(i)} onHide={() => setShown(null)} />)}
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
      <PageHeader title={t("Map")} subtitle="Updates by itself. Dots run along a connector while its host is up, faster on an alert. Drag a card to place it, open it with a click, hover it to bring its hosts and guests forward." onRefresh={reload} actions={<Button onClick={reset}>{t("Reset layout")}</Button>} />
      <ErrorNote>{error || saveError}</ErrorNote>
      <div className="h-[calc(100dvh-13rem)] min-h-96 rounded-panel border border-line bg-surface">{data && <LiveMap nodes={nodes} onMove={place} />}</div>
    </>
  )
}

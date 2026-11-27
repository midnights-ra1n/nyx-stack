import { LinkIcon, LinkSlashIcon, PencilSquareIcon, PlusIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline"
import { useRef, useState } from "react"
import { Button, Empty, ErrorNote, type Icon, IconButton, Input, Panel, Select, Status, ask, Skeleton } from "../ui/components"
import { type Col, RecordForm } from "../ui/crud"
import { t } from "../ui/i18n"
import { api, type Level, sortRows, useApi } from "../ui/lib"
import { Link, navigate, PageHeader } from "../ui/shell"
import { CATEGORIES, HARDWARE, HW_DEFAULTS, peerOf, STATUS_LEVEL } from "./inventory"

const icon = (body: React.ReactNode): Icon => (({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>{body}</svg>
)) as Icon
export const RackIcon = icon(<><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M8 7h8M8 11h8M8 15h8" /></>)
export const ShelfIcon = icon(<><path d="M5 3v18M19 3v18M4 6h16M4 12h16M4 18h16" /><rect x="7" y="8" width="4" height="4" /><rect x="13" y="14" width="5" height="4" /></>)
export const DeskIcon = icon(<><path d="M2 10h20" /><rect x="13" y="10" width="7" height="10" /><path d="M5 10v10M13 15h7" /><rect x="6" y="5" width="5" height="5" /></>)

/** What devices stand in or on. A rack counts rack units; a shelving unit, levels with the top one included; a desk or a box, its top. */
export const KINDS: Record<string, { label: string; icon: Icon }> = {
  rack: { label: "Rack", icon: RackIcon },
  shelf: { label: "Shelving unit", icon: ShelfIcon },
  desk: { label: "Desk or box", icon: DeskIcon },
}
export const FINISHES: Record<string, { label: string; fill: string }> = {
  wood: { label: "Wood", fill: "#9a6b3f" },
  white: { label: "White", fill: "#d5dae1" },
  black: { label: "Black", fill: "#2b3038" },
  grey: { label: "Grey", fill: "#6b7480" },
}
const choicesOf = (r: Record<string, { label: string }>) => Object.entries(r).map(([value, v]) => ({ value, label: t(v.label) }))

export const PLACE: Col[] = [
  { key: "kind", label: "Kind", type: "select", options: Object.keys(KINDS), choices: choicesOf(KINDS), icons: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.icon])) },
  { key: "name", label: "Name", required: true },
  { key: "location", label: "Location", suggest: true, hint: "Room or site, as in the hardware inventory." },
  { key: "units", label: "Height (U)", type: "number", hint: "Such as 42, 24, or 12 for a wall cabinet.", when: { key: "kind", in: ["rack", ""] } },
  { key: "units", label: "Levels", type: "number", hint: "Shelves to set devices on, the top included.", when: { key: "kind", in: ["shelf"] } },
  { key: "width_cm", label: "Width (cm)", type: "number", hint: "Drawn wider or narrower beside the others.", when: { key: "kind", in: ["shelf", "desk"] } },
  { key: "color", label: "Finish", type: "select", choices: choicesOf(FINISHES), when: { key: "kind", in: ["shelf", "desk"] } },
  { key: "notes", label: "Notes", type: "area" },
]

/** Columns across a rack unit or a shelf: a device takes some of them, so that two half-width ones share a unit. */
export const COLS = 12
export const WIDTHS = [[12, "Full width"], [9, "Three quarters"], [8, "Two thirds"], [6, "Half"], [4, "A third"], [3, "A quarter"], [2, "A sixth"]] as const

export interface Placed { id: string; rack_u: number; rack_units?: number; rack_x?: number; rack_w?: number }
export const height = (d: { rack_units?: number }) => Math.max(1, d.rack_units || 1)
export const widthOf = (d: { rack_w?: number }) => (d.rack_w && d.rack_w > 0 && d.rack_w < COLS ? d.rack_w : COLS)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
/** The first column and the width a device takes. */
export const span = (d: { rack_x?: number; rack_w?: number }) => { const w = widthOf(d); return [clamp(d.rack_x || 0, 0, COLS - w), w] as const }
/** A device is as tall as its rack units in a rack, and one level anywhere else. */
export const tall = (place: { kind?: string }, d: { rack_units?: number }) => (isRack(place) ? height(d) : 1)
export const isRack = (p: { kind?: string }) => p.kind !== "shelf" && p.kind !== "desk"

/** Whether a device of `h` rows and `w` columns fits with its lowest row at `u` (1 at the bottom) and its first column at `x`. */
export function fits(placed: Placed[], rows: number, id: string, u: number, h: number, x = 0, w = COLS) {
  if (u < 1 || u + h - 1 > rows || x < 0 || x + w > COLS) return false
  return placed.every((d) => {
    if (d.id === id) return true
    const [dx, dw] = span(d)
    return u + h - 1 < d.rack_u || d.rack_u + height(d) - 1 < u || x + w <= dx || dx + dw <= x
  })
}

/** The highest free spot, leftmost first, as racks and shelves fill from the top; null when none is left. */
export function firstFree(placed: Placed[], rows: number, h: number, id = "", w = COLS) {
  for (let u = rows - h + 1; u >= 1; u--) for (let x = 0; x + w <= COLS; x++) if (fits(placed, rows, id, u, h, x, w)) return { u, x }
  return null
}

/** Size and drawing of a place, to scale: rack units of 1.75" in a 19" rack, levels of a shelf, the top of a desk. */
export function geo(p: { kind?: string; units?: number; width_cm?: number }) {
  const rack = isRack(p), desk = p.kind === "desk"
  const rows = desk ? 1 : clamp(p.units || (rack ? 42 : 4), 1, 60)
  const rowPx = rack ? 22 : 70
  const inner = rack ? 288 : Math.round(clamp((p.width_cm || (desk ? 120 : 80)) * 2.5, 160, 640))
  const side = rack ? 36 : 14, top = 12
  const colW = inner / COLS
  const rowTop = (u: number) => top + (rows - u) * rowPx
  return {
    rows, rowPx, colW, side, top, inner, rowTop,
    width: side * 2 + inner,
    height: top + rows * rowPx + (rack ? 12 : desk ? 84 : 10),
    /** The row (1 at the bottom) and column under a point of the drawing, unclamped. */
    cell: (x: number, y: number) => ({ u: rows - Math.floor((y - top) / rowPx), col: Math.floor((x - side) / colW) }),
    box: (u: number, h: number, x: number, w: number) => rack
      ? { x: side + x * colW + 1, y: rowTop(u + h - 1) + 1, w: w * colW - 2, h: h * rowPx - 2 }
      : { x: side + x * colW + 2, y: rowTop(u) + 12, w: w * colW - 4, h: rowPx - 16 },
  }
}

/** Marks that tell a switch from a server at a glance, at the right end of its front. */
function Face({ category, w, h }: { category: string; w: number; h: number }) {
  const cy = h / 2
  if ((category === "Switch" || category === "Patch panel") && w > 140) {
    const n = Math.min(24, Math.floor((w - 130) / 8)), two = h >= 30
    return <g className="fill-bg stroke-line2">{Array.from({ length: two ? n * 2 : n }, (_, i) => <rect key={i} x={w - 10 - (Math.floor(two ? i / 2 : i) + 1) * 8} y={two ? cy - 7 + (i % 2) * 8 : cy - 3} width={6} height={5} rx={1} />)}</g>
  }
  if ((category === "Server" || category === "NAS") && w > 120) {
    const tower = category === "NAS" && h > 30
    return <g className="fill-bg stroke-line2">{Array.from({ length: tower ? 4 : 2 }, (_, i) => tower
      ? <rect key={i} x={w - 14 - i * 11} y={5} width={8} height={h - 10} rx={1.5} />
      : <rect key={i} x={w - 34 - i * 26} y={cy - Math.min(5, h / 2 - 3)} width={22} height={Math.min(10, h - 6)} rx={1.5} />)}</g>
  }
  if (category === "UPS" && w > 100) return <g><rect x={w - 44} y={cy - 5} width={22} height={10} rx={2} className="fill-ok/30 stroke-ok/50" /><circle cx={w - 12} cy={cy} r={3} className="fill-fg3" /></g>
  return null
}

const FACE_W: Record<string, (w: number) => number> = {
  Switch: (w) => (w > 140 ? Math.min(24, Math.floor((w - 130) / 8)) * 8 + 14 : 0),
  "Patch panel": (w) => (w > 140 ? Math.min(24, Math.floor((w - 130) / 8)) * 8 + 14 : 0),
  Server: (w) => (w > 120 ? 66 : 0), NAS: (w) => (w > 120 ? 66 : 0), UPS: (w) => (w > 100 ? 48 : 0),
}
const fit = (s: string, px: number) => { const n = Math.max(0, Math.floor(px / 7)); return s.length > n ? (n > 1 ? `${s.slice(0, n - 1)}…` : "") : s }

/** One device seen from the front: a status other than in service on the left edge, its icon, its name, and marks of its kind. */
function Front({ d, b, state, selected, bad }: { d: any; b: { w: number; h: number }; state?: Level; selected: boolean; bad: boolean }) {
  const I = CATEGORIES[d.category] ?? CATEGORIES.Other
  const big = b.h >= 40
  const iconSize = big ? 18 : 14
  const textX = b.w >= 40 ? 12 + iconSize : 8
  const room = b.w - textX - 8 - (FACE_W[d.category]?.(b.w) ?? 0)
  const model = [d.manufacturer, d.model].filter(Boolean).join(" ")
  return <>
    <rect width={b.w} height={b.h} rx={3} className={bad ? "fill-crit-soft stroke-crit" : selected ? "fill-accent-soft stroke-accent" : "fill-raised stroke-line2 group-hover:stroke-fg3"} />
    {state && <rect x={1} y={2} width={3} height={b.h - 4} rx={1.5} fill={`var(--color-${state})`} />}
    {b.w >= 40 && <I x={8} y={big ? b.h / 2 - iconSize / 2 - (model ? 6 : 0) : b.h / 2 - iconSize / 2} width={iconSize} height={iconSize} className="text-fg3" />}
    <text x={textX} y={big && model ? b.h / 2 - 2 : b.h / 2 + 4} className="fill-fg text-xs font-medium">{fit(d.name, room)}</text>
    {big && model && <text x={textX} y={b.h / 2 + 13} className="fill-fg3 text-[11px]">{fit(model, room)}</text>}
    <Face category={d.category} w={b.w} h={b.h} />
  </>
}

/** The frame of a place: rails and unit numbers of a rack, posts and boards of a shelving unit, the top and box of a desk. */
function Frame({ p, g }: { p: any; g: ReturnType<typeof geo> }) {
  if (isRack(p)) return <>
    <rect x={g.side - 10} y={0} width={g.inner + 20} height={g.height - 4} rx={6} className="fill-bg stroke-line2" />
    <rect x={g.side - 6} y={g.top - 2} width={5} height={g.rows * g.rowPx + 4} className="fill-line" />
    <rect x={g.side + g.inner + 1} y={g.top - 2} width={5} height={g.rows * g.rowPx + 4} className="fill-line" />
    {Array.from({ length: g.rows }, (_, i) => (
      <g key={i}>
        <line x1={g.side} x2={g.side + g.inner} y1={g.top + i * g.rowPx} y2={g.top + i * g.rowPx} className="stroke-line/60" />
        <text x={g.side - 14} y={g.top + i * g.rowPx + 15} textAnchor="end" className="fill-fg3 font-mono text-[10px]">{g.rows - i}</text>
      </g>
    ))}
    <rect x={g.side} y={g.height - 6} width={16} height={6} rx={1} className="fill-line2" />
    <rect x={g.side + g.inner - 16} y={g.height - 6} width={16} height={6} rx={1} className="fill-line2" />
  </>
  const fill = (FINISHES[p.color] ?? FINISHES.wood).fill
  const wood = { fill, stroke: "rgb(0 0 0 / 0.25)" }
  const boardY = (u: number) => g.rowTop(u) + g.rowPx - 4
  if (p.kind === "desk") {
    const y = boardY(1)
    return <>
      <rect x={g.side - 10} y={y} width={g.inner + 20} height={8} rx={2} {...wood} />
      <rect x={g.side} y={y + 8} width={g.inner} height={g.height - y - 8} rx={2} {...wood} opacity={0.85} />
      <line x1={g.side + 10} x2={g.side + g.inner - 10} y1={y + 8 + (g.height - y - 8) / 2} y2={y + 8 + (g.height - y - 8) / 2} stroke="rgb(0 0 0 / 0.3)" />
      <rect x={g.side + g.inner / 2 - 14} y={y + 20} width={28} height={4} rx={2} fill="rgb(0 0 0 / 0.3)" />
    </>
  }
  const topBoard = boardY(g.rows)
  return <>
    <rect x={g.side - 10} y={topBoard} width={8} height={g.height - topBoard} rx={2} {...wood} />
    <rect x={g.side + g.inner + 2} y={topBoard} width={8} height={g.height - topBoard} rx={2} {...wood} />
    {Array.from({ length: g.rows }, (_, i) => <rect key={i} x={g.side - 10} y={boardY(i + 1)} width={g.inner + 20} height={6} rx={1.5} {...wood} />)}
  </>
}

interface Drag { id: string; place: string; u: number; x: number; du: number; dx: number; from: string }

function Cables({ device, devices, ports, onChange }: { device: any; devices: any[]; ports: any[]; onChange: () => void }) {
  const [f, setF] = useState({ to: "", here: "", there: "" })
  const [error, setError] = useState("")
  const name = (id: string) => devices.find((d) => d.id === id)?.name ?? "?"
  const mine = sortRows(ports.filter((p) => p.device === device.id), (p) => p.name)
  /** The port of that name on that device, made if it does not exist yet. */
  const port = async (dev: string, n: string) => ports.find((p) => p.device === dev && p.name === n) ?? api("/api/c/ports", { body: { device: dev, name: n } })
  const connect = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    try {
      const [a, b] = [await port(device.id, f.here.trim()), await port(f.to, f.there.trim())]
      // A port holds one cable: whatever was plugged into either end comes out first.
      const stale = ports.filter((q) => q.id !== a.id && (q.peer === a.id || q.peer === b.id))
      await Promise.all([...stale, ...(b.peer ? [b] : [])].map((q) => api(`/api/c/ports/${q.id}`, { method: "PATCH", body: { peer: "" } })))
      await api(`/api/c/ports/${a.id}`, { method: "PATCH", body: { peer: b.id } })
      setF({ to: "", here: "", there: "" })
      onChange()
    } catch (err) { setError((err as Error).message) }
  }
  const unplug = async (p: any) => {
    const q = peerOf(p, ports)
    await api(`/api/c/ports/${p.peer ? p.id : q.id}`, { method: "PATCH", body: { peer: "" } })
    onChange()
  }
  return (
    <div className="flex flex-col gap-3">
      {mine.length ? (
        <ul className="divide-y divide-line text-[13px]">
          {mine.map((p) => {
            const q = peerOf(p, ports)
            return (
              <li key={p.id} className="flex items-center gap-2 py-1">
                <span className="w-20 truncate font-mono">{p.name}</span>
                <span className="flex-1 truncate text-fg2">{q ? `→ ${name(q.device)} · ${q.name}` : t("Not cabled")}</span>
                {q && <IconButton label={t("Unplug {port}", { port: p.name })} icon={LinkSlashIcon} onClick={() => unplug(p)} />}
              </li>
            )
          })}
        </ul>
      ) : <Empty>{t("No port yet.")}</Empty>}
      <form className="grid grid-cols-2 gap-3 border-t border-line pt-3" onSubmit={connect}>
        <div className="col-span-full"><Select label="Plug into" required value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} options={[{ value: "", label: "Choose a device…" }, ...sortRows(devices.filter((d) => d.id !== device.id), (d) => d.name).map((d) => ({ value: d.id, label: d.name }))]} /></div>
        <Input label="Port here" required placeholder={t("eth0")} value={f.here} onChange={(e) => setF({ ...f, here: e.target.value })} />
        <Input label="Port there" required placeholder={t("port 1")} value={f.there} onChange={(e) => setF({ ...f, there: e.target.value })} />
        <div className="col-span-full flex items-center gap-3"><Button type="submit"><LinkIcon className="size-5" aria-hidden />{t("Add cable")}</Button><ErrorNote>{error}</ErrorNote></div>
      </form>
    </div>
  )
}

/** Where a device sits, in words: "U12–13" in a rack, "level 2" on a shelf, "on top" of a desk. */
export function spot(p: any, d: any) {
  if (!p) return ""
  if (isRack(p)) { const h = height(d); return h > 1 ? `U${d.rack_u}–${d.rack_u + h - 1}` : `U${d.rack_u}` }
  return p.kind === "desk" ? t("on top") : t("level {n}", { n: d.rack_u })
}

/**
 * Racks, shelving units and desks side by side on one floor, drawn to scale, and the devices
 * standing in or on them. Devices are dragged in from the list, and between places.
 */
export function Racks() {
  const racks = useApi("/api/c/racks?sort=name&perPage=200", { poll: false })
  const hardware = useApi("/api/c/hardware?sort=name&perPage=500", { poll: false })
  const ports = useApi("/api/c/ports?perPage=1000", { poll: false })
  const [edit, setEdit] = useState<any | null | undefined>()
  const [adding, setAdding] = useState<any>()
  const [selected, setSelected] = useState<string>()
  const [note, setNote] = useState("")
  const [drag, setDrag] = useState<Drag | null>(null)
  // Changes shown at once, before the server answers.
  const [local, setLocal] = useState<Record<string, any>>({})
  const svgs = useRef<Record<string, SVGSVGElement | null>>({})
  // The floor holds the pointer during a drag, as the device moves from one drawing to another.
  const room = useRef<HTMLElement>(null)
  const places: any[] = racks.data?.items ?? []
  const all: any[] = (hardware.data?.items ?? []).map((h: any) => ({ ...h, ...local[h.id] }))
  const placeOf = (d: any) => places.find((p) => p.id === d.rack && d.rack_u > 0)
  const inPlace = (p: any) => all.filter((h) => h.rack === p.id && h.rack_u > 0)
  const loose = all.filter((h) => !placeOf(h))
  const sel = all.find((h) => h.id === selected)
  // A spare, broken or retired device stands out; one in service needs no mark.
  const stateOf = (d: any): Level | undefined => (d.status && d.status !== "In service" ? STATUS_LEVEL[d.status] ?? "off" : undefined)

  const reload = async () => { await Promise.all([hardware.reload(), ports.reload()]); setLocal({}) }
  const patch = async (id: string, body: any) => {
    setLocal((m) => ({ ...m, [id]: { ...m[id], ...body } }))
    try { await api(`/api/c/hardware/${id}`, { method: "PATCH", body }); setNote("") } catch (e) { setNote((e as Error).message); setLocal((m) => { const { [id]: _, ...rest } = m; return rest }) }
  }
  /** Puts a device at a spot of a place, or the nearest free one when that is taken. */
  const put = (d: any, p: any, u: number, x: number) => {
    const g = geo(p), h = tall(p, d), w = widthOf(d)
    const others = inPlace(p)
    const at = { u: clamp(u, 1, g.rows - h + 1), x: clamp(x, 0, COLS - w) }
    const free = fits(others, g.rows, d.id, at.u, h, at.x, w) ? at : firstFree(others, g.rows, h, d.id, w)
    if (!free) return setNote(t("No room left for {name} in {place}.", { name: d.name, place: p.name }))
    setSelected(d.id)
    patch(d.id, { rack: p.id, rack_u: free.u, rack_x: free.x })
  }
  /** Into the first place with room for it. */
  const putAnywhere = (d: any) => {
    const p = places.find((p) => firstFree(inPlace(p), geo(p).rows, tall(p, d), d.id, widthOf(d)))
    if (!p) return setNote(places.length ? t("No room left for {name} anywhere.", { name: d.name }) : t("Add a place first."))
    put(d, p, geo(p).rows, 0)
  }
  const resize = (d: any, body: { rack_units?: number; rack_w?: number }) => {
    const p = placeOf(d)
    const next = { ...d, ...body }
    if (p && !fits(inPlace(p), geo(p).rows, d.id, d.rack_u, tall(p, next), span(next)[0], widthOf(next))) return setNote(t("It does not fit there: move {name} first.", { name: d.name }))
    patch(d.id, { ...body, rack_x: span(next)[0] })
  }
  const removePlace = async (p: any) => {
    if (!await ask(t("Delete {name}? Its devices stay in the inventory, out of any place.", { name: p.name }), { action: "Delete", danger: true })) return
    await Promise.all(inPlace(p).map((h) => api(`/api/c/hardware/${h.id}`, { method: "PATCH", body: { rack: "", rack_u: 0 } })))
    await api(`/api/c/racks/${p.id}`, { method: "DELETE" })
    racks.reload(); reload()
  }

  /** The place, row and column under the pointer, wherever it is on the page. */
  const locate = (cx: number, cy: number) => {
    for (const p of places) {
      const el = svgs.current[p.id], r = el?.getBoundingClientRect()
      if (!el || !r || cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue
      const pt = new DOMPoint(cx, cy).matrixTransform(el.getScreenCTM()!.inverse())
      return { p, ...geo(p).cell(pt.x, pt.y) }
    }
    return null
  }
  const grab = (e: React.PointerEvent, d: any, p: any) => {
    const c = locate(e.clientX, e.clientY)
    if (!c || e.button !== 0) return
    const [x] = span(d)
    setDrag({ id: d.id, place: p.id, u: d.rack_u, x, du: c.u - d.rack_u, dx: c.col - x, from: `${p.id}:${d.rack_u}:${x}` })
    room.current?.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    const c = drag && locate(e.clientX, e.clientY)
    if (!drag || !c) return
    const d = all.find((h) => h.id === drag.id), h = tall(c.p, d), w = widthOf(d)
    setDrag({ ...drag, place: c.p.id, u: clamp(c.u - Math.min(drag.du, h - 1), 1, geo(c.p).rows - h + 1), x: clamp(c.col - Math.min(drag.dx, w - 1), 0, COLS - w) })
  }
  const drop = () => {
    if (!drag) return
    setDrag(null)
    const d = all.find((h) => h.id === drag.id), p = places.find((p) => p.id === drag.place)
    if (`${drag.place}:${drag.u}:${drag.x}` === drag.from) return setSelected(selected === drag.id ? undefined : drag.id)
    if (fits(inPlace(p), geo(p).rows, d.id, drag.u, tall(p, d), drag.x, widthOf(d))) { setSelected(d.id); patch(d.id, { rack: p.id, rack_u: drag.u, rack_x: drag.x }) }
    else setNote(t("{name} does not fit there.", { name: d.name }))
  }
  const keys = (e: React.KeyboardEvent, d: any, p: any) => {
    const [x] = span(d)
    const step: Record<string, [number, number]> = { ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(d.id) }
    const s = step[e.key]
    if (!s) return
    e.preventDefault()
    const [u2, x2] = [d.rack_u + s[0], x + s[1]]
    if (fits(inPlace(p), geo(p).rows, d.id, u2, tall(p, d), x2, widthOf(d))) patch(d.id, { rack_u: u2, rack_x: x2 })
  }

  const draw = (p: any) => {
    const g = geo(p)
    const shown = inPlace(p).filter((d) => !drag || d.id !== drag.id)
    const ghost = drag && drag.place === p.id ? all.find((h) => h.id === drag.id) : null
    const used = inPlace(p).reduce((n, d) => n + (isRack(p) ? height(d) * widthOf(d) : widthOf(d)), 0) / COLS
    const K = KINDS[p.kind] ?? KINDS.rack
    const item = (d: any, u: number, x: number, bad = false) => {
      const b = g.box(u, tall(p, d), x, widthOf(d))
      return (
        <g key={d.id} transform={`translate(${b.x} ${b.y})`} className="group cursor-grab touch-none outline-none focus-visible:[&>rect:first-child]:stroke-accent" tabIndex={0} role="button"
          aria-label={t("{name}, {spot} of {place}", { name: d.name, spot: spot(p, { ...d, rack_u: u }), place: p.name })} aria-pressed={selected === d.id}
          onPointerDown={(e) => grab(e, d, p)} onKeyDown={(e) => keys(e, d, p)}>
          <title>{[d.name, [d.manufacturer, d.model].filter(Boolean).join(" "), spot(p, { ...d, rack_u: u })].filter(Boolean).join(" · ")}</title>
          <Front d={d} b={b} state={stateOf(d)} selected={selected === d.id} bad={bad} />
        </g>
      )
    }
    return (
      <figure key={p.id} className="flex shrink-0 flex-col max-sm:max-w-full max-sm:border-b-2 max-sm:border-line2 max-sm:pb-0" style={{ width: g.width }}>
        <figcaption className="mb-2 flex items-start gap-1">
          <K.icon className="mt-0.5 size-5 shrink-0 text-fg3" />
          <span className="min-w-0 flex-1 px-1">
            <span className="block truncate font-medium">{p.name}</span>
            <span className="block truncate text-xs text-fg3">{[t(K.label), p.location, isRack(p) ? `${Math.round(used)}/${g.rows} U` : t(inPlace(p).length === 1 ? "{n} device" : "{n} devices", { n: inPlace(p).length })].filter(Boolean).join(" · ")}</span>
          </span>
          <IconButton label={t("Edit {name}", { name: p.name })} icon={PencilSquareIcon} onClick={() => setEdit(p)} />
          <IconButton label={t("Delete {name}", { name: p.name })} icon={TrashIcon} onClick={() => removePlace(p)} />
        </figcaption>
        <svg ref={(el) => { svgs.current[p.id] = el }} width={g.width} height={g.height} viewBox={`0 0 ${g.width} ${g.height}`} className="select-none overflow-visible max-sm:h-auto max-sm:max-w-full"
          role="group" aria-label={t("{name}, front view", { name: p.name })}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const d = all.find((h) => h.id === e.dataTransfer.getData("text/nyx-device")); const c = locate(e.clientX, e.clientY); if (d && c) put(d, c.p, c.u, c.col) }}>
          <Frame p={p} g={g} />
          {shown.map((d) => item(d, d.rack_u, span(d)[0]))}
          {ghost && item(ghost, drag!.u, drag!.x, !fits(inPlace(p), g.rows, ghost.id, drag!.u, tall(p, ghost), drag!.x, widthOf(ghost)))}
        </svg>
      </figure>
    )
  }

  const P = sel && placeOf(sel)
  const SI = sel ? CATEGORIES[sel.category] ?? CATEGORIES.Other : null
  return (
    <>
      <PageHeader title={t("Places")} subtitle={note || t("Racks, shelves and desks, side by side. Drag a device onto one, or between them; click it for its details and cables.")} actions={<>
        <Button onClick={() => setAdding({})}><PlusIcon className="size-5" aria-hidden />{t("Add hardware")}</Button>
        <Button variant="primary" onClick={() => setEdit(null)}><PlusIcon className="size-5" aria-hidden />{t("Add place")}</Button>
      </>} />
      {edit !== undefined && <RecordForm key={edit?.id ?? "new"} cols={PLACE} row={edit} collection="racks" rows={places} defaults={{ kind: "rack", units: 42, color: "wood" }} title={edit ? t("Edit {name}", { name: edit.name }) : "Add place"}
        onDone={() => { setEdit(undefined); racks.reload() }} />}
      {adding && <RecordForm cols={HARDWARE} row={null} collection="hardware" rows={all} defaults={HW_DEFAULTS} title="Add hardware" onDone={() => { setAdding(undefined); reload() }} />}
      <ErrorNote>{racks.error || hardware.error}</ErrorNote>
      <div className="flex flex-col gap-4">
        <section ref={room} aria-label={t("Places")} onPointerMove={move} onPointerUp={drop} onPointerCancel={() => setDrag(null)} className="min-w-0 overflow-x-auto rounded-panel border border-line bg-surface px-5 pt-4">
          {!racks.data ? <Skeleton lines={4} className="w-full pb-4" /> : places.length === 0 ? <div className="pb-4"><Empty>{t("No place yet. Add a rack, a shelving unit or a desk, then drag your devices onto it.")}</Empty></div> : (
            <div className="flex min-w-max items-end gap-8 border-b-2 border-line2 pb-0 max-sm:min-w-0 max-sm:flex-col max-sm:items-center max-sm:border-b-0">{places.map(draw)}</div>
          )}
          <p className="py-3 text-xs text-fg3">{t("The coloured edge of a device is the state of the monitored host of the same name. Arrow keys move a selected device.")}</p>
        </section>
        <div className="grid items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {sel && SI && (
            <Panel title={sel.name} actions={[{ label: "Open the record", onClick: () => navigate(`/hardware/${sel.id}`) }]}>
              <div className="mb-4 flex items-center gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-box bg-raised text-fg2"><SI className="size-6" aria-hidden /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-fg2">{[sel.manufacturer, sel.model].filter(Boolean).join(" ") || t(sel.category || "Other")}</span><span className="block truncate text-xs text-fg3">{P ? `${P.name} · ${spot(P, sel)}` : t("Not placed")}</span></span>
                {stateOf(sel) && <Status cell level={stateOf(sel)!} label={sel.status} />}
                <IconButton label="Close" icon={XMarkIcon} onClick={() => setSelected(undefined)} />
              </div>
              <div className="mb-4 grid grid-cols-2 gap-3">
                <Select label="Width" value={String(widthOf(sel))} onChange={(e) => resize(sel, { rack_w: Number(e.target.value) })} options={WIDTHS.map(([w, label]) => ({ value: String(w), label }))} />
                {P && isRack(P) && <Select label="Height (U)" value={String(height(sel))} onChange={(e) => resize(sel, { rack_units: Number(e.target.value) })} options={Array.from({ length: 10 }, (_, i) => String(i + 1))} />}
              </div>
              <div className="mb-4 flex flex-wrap gap-3">
                <Link to={`/hardware/${sel.id}`} className="inline-flex h-9 items-center text-accent">{t("Open the record")}</Link>
                {P ? <Button onClick={() => { setSelected(undefined); patch(sel.id, { rack: "", rack_u: 0 }) }}>{t("Take out")}</Button> : <Button onClick={() => putAnywhere(sel)}>{t("Put in place")}</Button>}
              </div>
              <h3 className="mb-2 text-[13px] font-medium text-fg2">{t("Cables")}</h3>
              <Cables device={sel} devices={all} ports={ports.data?.items ?? []} onChange={reload} />
            </Panel>
          )}
          <Panel title={t("Not placed")} flush>
            {loose.length === 0 ? <div className="px-4 pb-4"><Empty>{all.length ? t("Every device has a place.") : t("No hardware yet.")}</Empty></div> : (
              <ul className="max-h-96 divide-y divide-line overflow-y-auto">
                {loose.map((h) => {
                  const I = CATEGORIES[h.category] ?? CATEGORIES.Other
                  return (
                    <li key={h.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/nyx-device", h.id)} className={`flex cursor-grab items-center gap-3 px-4 py-1.5 ${selected === h.id ? "bg-accent-soft/40" : ""}`}>
                      <I className="size-5 shrink-0 text-fg3" aria-hidden />
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelected(h.id)}><span className="block truncate font-medium">{h.name}</span><span className="block truncate text-xs text-fg3">{t(h.category || "Other")}</span></button>
                      <Button onClick={() => putAnywhere(h)} disabled={!places.length}>{t("Put in place")}</Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}

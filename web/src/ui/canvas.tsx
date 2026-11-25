import { ArrowsPointingInIcon, ArrowsPointingOutIcon, MagnifyingGlassIcon, MinusIcon, PlusIcon } from "@heroicons/react/24/outline"
import { type RefObject, useEffect, useRef, useState } from "react"
import { IconButton } from "./components"
import { t } from "./i18n"

/** Pan and zoom of a map, applied inside an SVG whose viewBox already fits the whole drawing. */
export interface View { x: number; y: number; k: number }
export const FIT: View = { k: 1, x: 0, y: 0 }
export const MIN_ZOOM = 0.3, MAX_ZOOM = 4, ZOOM_STEP = 1.3

/** Zoom by `f` around a point, which stays where it is on screen. */
export function zoomed(v: View, px: number, py: number, f: number): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * f))
  return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }
}

/** The view that puts drawing point `p` at `center` of the viewBox, at zoom `k`. */
export const centered = (p: { x: number; y: number }, center: { x: number; y: number }, k: number): View => ({ k, x: center.x - p.x * k, y: center.y - p.y * k })

/** Whether a node matches a search: every word of the query, in its name or other text. */
export const matches = (query: string, ...text: (string | null | undefined)[]) => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const hay = text.filter(Boolean).join(" ").toLowerCase()
  return words.length > 0 && words.every((w) => hay.includes(w))
}

/**
 * Wheel and pinch zoom around the pointer, drag on the empty canvas to pan, and +, - and 0
 * from the keyboard. Only pointers that went down on the canvas itself pan it, so nodes
 * can be dragged with their own handlers.
 */
export function usePanZoom(svg: RefObject<SVGSVGElement | null>, { enabled = true, wheel = true }: { enabled?: boolean; wheel?: boolean } = {}) {
  const [view, setView] = useState(FIT)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const start = useRef<{ view: View; pts: { x: number; y: number }[] } | null>(null)
  const moved = useRef(false)
  const toBox = (x: number, y: number) => new DOMPoint(x, y).matrixTransform(svg.current!.getScreenCTM()!.inverse())
  const center = () => { const b = svg.current?.viewBox.baseVal; return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : { x: 0, y: 0 } }

  useEffect(() => {
    const el = svg.current
    if (!el || !enabled || !wheel) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = toBox(e.clientX, e.clientY)
      setView((v) => zoomed(v, p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  })

  const snapshot = () => { start.current = { view, pts: [...pointers.current.values()] } }
  const onPointerDown = (e: React.PointerEvent) => {
    if (!enabled || e.button !== 0) return
    svg.current!.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved.current = false
    snapshot()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !start.current) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const now = [...pointers.current.values()], was = start.current.pts, v0 = start.current.view
    const s = svg.current!.getScreenCTM()?.a ?? 1
    if (now.length === 1 && was.length === 1) {
      const [dx, dy] = [now[0].x - was[0].x, now[0].y - was[0].y]
      if (!moved.current && Math.hypot(dx, dy) < 4) return
      moved.current = true
      setView({ ...v0, x: v0.x + dx / s, y: v0.y + dy / s })
    } else if (now.length >= 2 && was.length >= 2) {
      // Pinch: zoom by the change of distance between two fingers, around where they started.
      moved.current = true
      const dist = (p: { x: number; y: number }[]) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1
      const mid = (p: { x: number; y: number }[]) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 })
      const [m0, m1] = [mid(was), mid(now)], at = toBox(m0.x, m0.y)
      const z = zoomed(v0, at.x, at.y, dist(now) / dist(was))
      setView({ ...z, x: z.x + (m1.x - m0.x) / s, y: z.y + (m1.y - m0.y) / s })
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return
    // A finger lifted from a pinch keeps panning from where the view is now.
    start.current = pointers.current.size ? { view, pts: [...pointers.current.values()] } : null
  }
  const zoomBy = (f: number) => { const c = center(); setView((v) => zoomed(v, c.x, c.y, f)) }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP)
    else if (e.key === "-") zoomBy(1 / ZOOM_STEP)
    else if (e.key === "0") setView(FIT)
    else return
    e.preventDefault()
  }
  return {
    view, setView, zoomBy, onKeyDown,
    transform: `translate(${view.x} ${view.y}) scale(${view.k})`,
    fit: () => setView(FIT),
    /** Brings a drawing point to the middle, zoomed in enough to read it. */
    focus: (p: { x: number; y: number }) => setView(centered(p, center(), Math.max(view.k, 1.4))),
    /** True when the last gesture panned or pinched, so that a click is not also a click. */
    moved: () => moved.current,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  }
}

export function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const sync = () => setOn(document.fullscreenElement === ref.current)
    document.addEventListener("fullscreenchange", sync)
    return () => document.removeEventListener("fullscreenchange", sync)
  }, [ref])
  const toggle = () => (on ? document.exitFullscreen() : ref.current?.requestFullscreen())?.catch(() => {})
  return { on, toggle, supported: !!globalThis.document?.fullscreenEnabled }
}

/** Zoom, fit, full screen and search, floating over a map. */
export function MapControls({ zoom, full, query, onQuery, onFind, found, className = "" }: { zoom: ReturnType<typeof usePanZoom>; full?: ReturnType<typeof useFullscreen>; query?: string; onQuery?: (q: string) => void; onFind?: () => void; found?: number; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <div className="flex rounded-control border border-line bg-surface">
        <IconButton label="Zoom in" icon={PlusIcon} onClick={() => zoom.zoomBy(ZOOM_STEP)} />
        <IconButton label="Zoom out" icon={MinusIcon} onClick={() => zoom.zoomBy(1 / ZOOM_STEP)} />
        <IconButton label="Fit to view" icon={ArrowsPointingInIcon} onClick={zoom.fit} />
        {full?.supported && <IconButton label={full.on ? "Exit full screen" : "Full screen"} icon={full.on ? ArrowsPointingInIcon : ArrowsPointingOutIcon} onClick={full.toggle} />}
      </div>
      {onQuery && (
        <form role="search" className="relative" onSubmit={(e) => { e.preventDefault(); onFind?.() }}>
          <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-fg3" aria-hidden />
          <input type="search" aria-label={t("Find on the map")} placeholder={t("Find on the map…")} value={query} onChange={(e) => onQuery(e.target.value)}
            className="h-9 w-48 rounded-control border border-line bg-surface pl-8 pr-2 text-[13px] placeholder:text-fg3 max-sm:h-11 max-sm:w-40 max-sm:text-base" />
          {query && <span role="status" className="ml-2 text-xs text-fg2">{t("{n} found", { n: found ?? 0 })}</span>}
        </form>
      )}
    </div>
  )
}

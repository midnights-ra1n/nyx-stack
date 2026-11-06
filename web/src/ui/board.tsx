import { ArrowPathIcon, Bars3Icon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, PencilSquareIcon, CheckIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Button, IconButton, Variable } from "./components"
import { useMedia, useStored } from "./lib"
import { useCustomize } from "./shell"

export interface Layout { cols: string[][]; hidden: string[] }

/** Pure layout edits, kept apart from React so they can be unit tested. */
export function move(l: Layout, id: string, dir: "up" | "down" | "left" | "right"): Layout {
  const cols = l.cols.map((c) => [...c])
  const c = cols.findIndex((col) => col.includes(id))
  if (c < 0) return l
  const i = cols[c].indexOf(id)
  if (dir === "up" || dir === "down") {
    const j = i + (dir === "up" ? -1 : 1)
    if (j < 0 || j >= cols[c].length) return l
    ;[cols[c][i], cols[c][j]] = [cols[c][j], cols[c][i]]
  } else {
    const t = c + (dir === "left" ? -1 : 1)
    if (t < 0 || t >= cols.length) return l
    cols[c].splice(i, 1)
    cols[t].push(id)
  }
  return { ...l, cols }
}

/** Puts a panel at `index` of column `c`, counted as if the panel had left the board. */
export function place(l: Layout, id: string, c: number, index: number): Layout {
  const cols = l.cols.map((col) => col.filter((p) => p !== id))
  cols[c].splice(index, 0, id)
  return { ...l, cols }
}

export interface ColumnBox { left: number; right: number; top: number; bottom: number; mids: number[] }

/** The column nearest to the pointer, and how many of its panels are above it. */
export function slotAt(cols: ColumnBox[], x: number, y: number) {
  const gap = (b: ColumnBox) => Math.max(b.left - x, x - b.right, 0) + Math.max(b.top - y, y - b.bottom, 0)
  const c = cols.reduce((best, col, i) => (gap(col) < gap(cols[best]) ? i : best), 0)
  return { c, index: cols[c].mids.filter((m) => m < y).length }
}

export const hide = (l: Layout, id: string): Layout => ({ cols: l.cols.map((c) => c.filter((p) => p !== id)), hidden: [...l.hidden, id] })

/** A restored panel goes to the least filled column. */
export function show(l: Layout, id: string): Layout {
  const cols = l.cols.map((c) => [...c])
  cols.reduce((a, b) => (b.length < a.length ? b : a)).push(id)
  return { cols, hidden: l.hidden.filter((p) => p !== id) }
}

/** Changes the number of columns. Panels of a removed column join the last one left. */
export function columns(l: Layout, n: number): Layout {
  const cols = Array.from({ length: n }, (_, i) => [...(l.cols[i] ?? [])])
  cols[n - 1].push(...l.cols.slice(n).flat())
  return { ...l, cols }
}

/** Takes out the panels that have nothing to show, as the Board only edits the rest. */
export function without(l: Layout, gone: string[]): Layout {
  const keep = (p: string) => !gone.includes(p)
  return { cols: l.cols.map((c) => c.filter(keep)), hidden: l.hidden.filter(keep) }
}

/** Puts back the panels `without` took out, so that they return on the hosts that have them. */
// shortcut: they go to the bottom of their column, keep their exact place if someone misses it.
export function restore(l: Layout, from: Layout, gone: string[]): Layout {
  const cols = l.cols.map((c, i) => [...c, ...(from.cols[i] ?? []).filter((p) => gone.includes(p))])
  cols[cols.length - 1].push(...from.cols.slice(cols.length).flat().filter((p) => gone.includes(p)))
  return { cols, hidden: [...l.hidden, ...from.hidden.filter((p) => gone.includes(p))] }
}

/** Forget panels that no longer exist and surface new ones as hidden. */
export function reconcile(l: Layout, ids: string[]): Layout {
  const cols = l.cols.map((c) => c.filter((p) => ids.includes(p)))
  const known = [...cols.flat(), ...l.hidden]
  return { cols, hidden: [...l.hidden.filter((p) => ids.includes(p)), ...ids.filter((p) => !known.includes(p))] }
}

/** `absent` marks a panel with nothing to show here that keeps its place for pages that do. */
export interface BoardPanel { id: string; title: string; absent?: boolean; render: (edit?: ReactNode) => ReactNode }

/** Free columns of panels with the guide's customize mode. Layouts are per device. */
export function Board({ id, panels, desktop, phone }: { id: string; panels: BoardPanel[]; desktop: Layout; phone: Layout }) {
  const mobile = useMedia("(max-width: 639px)")
  const { editing, setEditing, register } = useCustomize()
  useEffect(() => { register(true); return () => { register(false); setEditing(false) } }, [register, setEditing])
  const [dLayout, setD] = useStored(`nyx.layout.${id}`, desktop)
  const [pLayout, setP] = useStored(`nyx.layout.${id}.phone`, phone)
  const gone = panels.filter((p) => p.absent).map((p) => p.id)
  const full = reconcile(mobile ? pLayout : dLayout, panels.map((p) => p.id))
  const layout = without(full, gone)
  const save = (l: Layout) => (mobile ? setP : setD)(restore(l, full, gone))
  const byId = (pid: string) => panels.find((p) => p.id === pid)!
  const grid = useRef<HTMLDivElement>(null)
  const current = useRef(layout)
  current.current = layout
  const [dragged, setDragged] = useState<string>()

  // Listens on window: moving a panel to another column remounts the element being dragged.
  const grab = (e: React.PointerEvent<HTMLElement>, pid: string) => {
    const target = e.target as HTMLElement
    if (e.button || target.closest("button, a, select, input, textarea")) return
    if (e.pointerType !== "mouse" && !target.closest("[data-grip]")) return // A finger elsewhere scrolls the page.
    e.preventDefault()
    const box = e.currentTarget.getBoundingClientRect()
    const dx = e.clientX - box.left, dy = e.clientY - box.top
    const ghost = e.currentTarget.cloneNode(true) as HTMLElement
    ghost.className = "drag-ghost"
    ghost.style.width = `${box.width}px`
    const follow = (x: number, y: number) => { ghost.style.transform = `translate(${x - dx}px, ${y - dy}px) rotate(1deg)` }
    follow(e.clientX, e.clientY)
    document.body.append(ghost)
    setDragged(pid)
    const onMove = (m: PointerEvent) => {
      follow(m.clientX, m.clientY)
      if (m.clientY < 64) scrollBy(0, -16)
      if (m.clientY > innerHeight - 64) scrollBy(0, 16)
      const cols = [...grid.current!.children].map((col) => {
        const { left, right, top, bottom } = col.getBoundingClientRect()
        const others = [...col.children].filter((p) => (p as HTMLElement).dataset.pid !== pid)
        return { left, right, top, bottom, mids: others.map((p) => { const r = p.getBoundingClientRect(); return (r.top + r.bottom) / 2 }) }
      })
      const { c, index } = slotAt(cols, m.clientX, m.clientY)
      const next = place(current.current, pid, c, index)
      if (JSON.stringify(next.cols) !== JSON.stringify(current.current.cols)) save(next)
    }
    const stop = () => {
      ghost.remove()
      setDragged(undefined)
      removeEventListener("pointermove", onMove)
      removeEventListener("pointerup", stop)
      removeEventListener("pointercancel", stop)
    }
    addEventListener("pointermove", onMove)
    addEventListener("pointerup", stop)
    addEventListener("pointercancel", stop)
  }

  const bar = (pid: string, col: string[], c: number) => {
    const i = col.indexOf(pid)
    return (
      <>
        <span data-grip aria-hidden className="mr-auto flex size-9 max-sm:size-11 cursor-grab touch-none items-center justify-center text-fg2 hover:text-fg"><Bars3Icon className="size-5" /></span>
        {!mobile && <IconButton label="Move to left column" icon={ChevronLeftIcon} disabled={c === 0} onClick={() => save(move(layout, pid, "left"))} />}
        <IconButton label="Move up" icon={ChevronUpIcon} disabled={i === 0} onClick={() => save(move(layout, pid, "up"))} />
        <IconButton label="Move down" icon={ChevronDownIcon} disabled={i === col.length - 1} onClick={() => save(move(layout, pid, "down"))} />
        {!mobile && <IconButton label="Move to right column" icon={ChevronRightIcon} disabled={c === layout.cols.length - 1} onClick={() => save(move(layout, pid, "right"))} />}
        <IconButton label="Hide panel" icon={XMarkIcon} className="text-crit hover:text-crit" onClick={() => save(hide(layout, pid))} />
      </>
    )
  }

  return (
    <>
      {editing && (
        <div className="mb-4 rounded-panel border border-dashed border-line2 bg-surface p-5">
          <p className="text-fg2">{mobile ? "Slide a panel by its handle, or hide it." : "Slide panels where you want them and hide the ones you do not need."} The arrows do the same from the keyboard. Each panel keeps the height of its content.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {layout.hidden.length === 0 && <span className="text-[13px] text-fg3">No hidden panels</span>}
            {layout.hidden.map((p) => <Button key={p} onClick={() => save(show(layout, p))}><PlusIcon className="size-4" aria-hidden />{byId(p).title}</Button>)}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {!mobile && <Variable label="Columns" value={String(layout.cols.length)} onChange={(n) => save(columns(layout, Number(n)))} options={["1", "2", "3", "4"].map((n) => ({ value: n, label: n }))} />}
            <Button onClick={() => (mobile ? setP(phone) : setD(desktop))}><ArrowPathIcon className="size-4" aria-hidden />Reset this page</Button>
          </div>
          {mobile && <Button variant="primary" className="mt-3 w-full" onClick={() => setEditing(false)}>Done</Button>}
        </div>
      )}
      {/* While editing, columns stretch so that the whole height of a short one accepts a drop. */}
      <div ref={grid} style={{ "--cols": layout.cols.length } as React.CSSProperties} className={`grid grid-cols-[repeat(var(--cols),minmax(0,1fr))] gap-4 max-lg:grid-cols-1 ${editing ? "select-none" : "items-start"}`}>
        {layout.cols.map((col, c) => (
          <div key={c} className={`flex min-w-0 flex-col gap-4 ${editing ? "min-h-40 rounded-panel outline-2 outline-offset-2 outline-line outline-dashed" : ""}`}>
            {col.map((pid) => (
              <div key={pid} data-pid={pid} onPointerDown={editing ? (e) => grab(e, pid) : undefined} className={`${editing ? "cursor-grab" : ""} ${dragged === pid ? "opacity-30" : ""}`}>
                {byId(pid).render(editing ? bar(pid, col, c) : undefined)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

export function CustomizeButton() {
  const { editing, setEditing } = useCustomize()
  return editing
    ? <Button variant="primary" onClick={() => setEditing(false)}><CheckIcon className="size-5" aria-hidden />Done</Button>
    : <Button className="max-sm:hidden" onClick={() => setEditing(true)}><PencilSquareIcon className="size-5" aria-hidden />Customize</Button>
}

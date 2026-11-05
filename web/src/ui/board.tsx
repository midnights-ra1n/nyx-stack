import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, PencilSquareIcon, CheckIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline"
import { type ReactNode, useEffect } from "react"
import { Button, IconButton } from "./components"
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

export const hide = (l: Layout, id: string): Layout => ({ cols: l.cols.map((c) => c.filter((p) => p !== id)), hidden: [...l.hidden, id] })

/** A restored panel goes to the least filled column. */
export function show(l: Layout, id: string): Layout {
  const cols = l.cols.map((c) => [...c])
  cols.reduce((a, b) => (b.length < a.length ? b : a)).push(id)
  return { cols, hidden: l.hidden.filter((p) => p !== id) }
}

/** Forget panels that no longer exist and surface new ones as hidden. */
export function reconcile(l: Layout, ids: string[]): Layout {
  const cols = l.cols.map((c) => c.filter((p) => ids.includes(p)))
  const known = [...cols.flat(), ...l.hidden]
  return { cols, hidden: [...l.hidden.filter((p) => ids.includes(p)), ...ids.filter((p) => !known.includes(p))] }
}

export interface BoardPanel { id: string; title: string; render: (edit?: ReactNode) => ReactNode }

/** Free columns of panels with the guide's customize mode. Layouts are per device. */
export function Board({ id, panels, desktop, phone }: { id: string; panels: BoardPanel[]; desktop: Layout; phone: Layout }) {
  const mobile = useMedia("(max-width: 639px)")
  const { editing, setEditing, register } = useCustomize()
  useEffect(() => { register(true); return () => { register(false); setEditing(false) } }, [register, setEditing])
  const [dLayout, setD] = useStored(`nyx.layout.${id}`, desktop)
  const [pLayout, setP] = useStored(`nyx.layout.${id}.phone`, phone)
  const ids = panels.map((p) => p.id)
  const layout = reconcile(mobile ? pLayout : dLayout, ids)
  const save = mobile ? setP : setD
  const byId = (pid: string) => panels.find((p) => p.id === pid)!

  const bar = (pid: string, col: string[], c: number) => {
    const i = col.indexOf(pid)
    return (
      <>
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
        <div className="mb-5 rounded-panel border border-dashed border-line2 bg-surface p-5">
          <p className="text-fg2">{mobile ? "Move or hide panels." : "Move panels with the arrows and hide the ones you do not need."} Each panel keeps the height of its content.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {layout.hidden.length === 0 && <span className="text-[13px] text-fg3">No hidden panels</span>}
            {layout.hidden.map((p) => <Button key={p} onClick={() => save(show(layout, p))}><PlusIcon className="size-4" aria-hidden />{byId(p).title}</Button>)}
          </div>
          {mobile && <Button variant="primary" className="mt-3 w-full" onClick={() => setEditing(false)}>Done</Button>}
        </div>
      )}
      <div className="grid grid-cols-2 items-start gap-5 max-lg:grid-cols-1 max-sm:grid-cols-1">
        {layout.cols.map((col, c) => (
          <div key={c} className="flex min-w-0 flex-col gap-5">
            {col.map((pid) => <div key={pid}>{byId(pid).render(editing ? bar(pid, col, c) : undefined)}</div>)}
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

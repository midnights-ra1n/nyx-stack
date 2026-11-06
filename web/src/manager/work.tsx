import { ExclamationTriangleIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/24/outline"
import { type ReactNode, useState } from "react"
import { Empty, IconButton, Status, Table, Tabs, Td, Variable } from "../ui/components"
import { fmt, isOverdue, type Level, sortRows, useStored } from "../ui/lib"

export interface WorkState { id: string; label: string; level: Level }
export interface WorkItem {
  id: string
  title: string
  state: string
  tags: string[]
  due?: string
  /** Still to be done: only then a past due date is late. */
  open: boolean
  detail?: string
  /** Shown in the list only, as calendar events have no state of ours. */
  readOnly?: boolean
  row: any
}
export interface WorkColumn { label: string; value: (w: WorkItem) => ReactNode }

export const parseTags = (tags?: string) => (tags ?? "").split(",").map((t) => t.trim()).filter(Boolean)

const VIEWS = [{ id: "board", label: "Board" }, { id: "list", label: "List" }]

function Due({ item }: { item: WorkItem }) {
  if (!item.due) return <span className="text-fg3">No due date</span>
  const late = item.open && isOverdue(item.due)
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap ${late ? "text-crit" : "text-fg2"}`}>{late && <ExclamationTriangleIcon className="size-4" aria-hidden />}{late ? "Late, " : ""}{fmt.date(item.due)}</span>
}

function Tags({ tags, onPick }: { tags: string[]; onPick: (t: string) => void }) {
  return <span className="flex flex-wrap gap-1">{tags.map((t) => <button key={t} type="button" title={`Show only ${t}`} className="rounded-full bg-raised px-2 text-xs leading-6 text-fg2 hover:text-fg" onClick={() => onPick(t)}>{t}</button>)}</span>
}

/** What moves an item by keyboard or on a phone, where dragging does not work. */
function StateSelect({ item, states, onMove }: { item: WorkItem; states: WorkState[]; onMove: (state: string) => void }) {
  return (
    <select aria-label={`State of ${item.title}`} value={item.state} onChange={(e) => onMove(e.target.value)} className="h-7 max-sm:h-9 max-w-28 rounded-control bg-raised px-1 text-[13px] text-fg2">
      {states.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
    </select>
  )
}

function Card({ item, states, onMove, onOpen, onPick }: { item: WorkItem; states: WorkState[]; onMove: (state: string) => void; onOpen: () => void; onPick: (t: string) => void }) {
  return (
    <li draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", item.id)} className="flex cursor-grab flex-col gap-2 rounded-box border border-line bg-surface p-3 active:cursor-grabbing">
      <button type="button" className="text-left font-medium hover:text-accent" onClick={onOpen}>{item.title}</button>
      {item.detail && <span className="truncate font-mono text-[13px] text-fg3">{item.detail}</span>}
      {item.tags.length > 0 && <Tags tags={item.tags} onPick={onPick} />}
      <div className="flex items-center justify-between gap-2 text-[13px]">
        <Due item={item} />
        <StateSelect item={item} states={states} onMove={onMove} />
      </div>
    </li>
  )
}

function Kanban({ items, states, onMove, onOpen, onPick }: { items: WorkItem[]; states: WorkState[]; onMove: (w: WorkItem, state: string) => void; onOpen: (w: WorkItem) => void; onPick: (t: string) => void }) {
  const [over, setOver] = useState<string>()
  const drop = (e: React.DragEvent, state: string) => {
    e.preventDefault()
    setOver(undefined)
    const item = items.find((w) => w.id === e.dataTransfer.getData("text/plain"))
    if (item && item.state !== state) onMove(item, state)
  }
  return (
    <div className="grid auto-cols-[minmax(240px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-1">
      {states.map((s) => {
        const cards = items.filter((w) => w.state === s.id)
        return (
          <section key={s.id} aria-label={s.label} onDragOver={(e) => { e.preventDefault(); setOver(s.id) }} onDragLeave={() => setOver(undefined)} onDrop={(e) => drop(e, s.id)} className={`flex min-h-40 flex-col gap-2 rounded-box p-2 ${over === s.id ? "bg-accent-soft" : "bg-bg"}`}>
            <h3 className="flex items-center justify-between px-1"><Status cell level={s.level} label={s.label} /><span className="text-[13px] text-fg3">{cards.length}</span></h3>
            <ul className="flex flex-col gap-2">{cards.map((w) => <Card key={w.id} item={w} states={states} onMove={(state) => onMove(w, state)} onOpen={() => onOpen(w)} onPick={onPick} />)}</ul>
          </section>
        )
      })}
    </div>
  )
}

const STATE = 1, TAGS = 2, DUE = 3

/** Tasks or deployments, as a Kanban board or as a sortable list. */
export function WorkView({ id, states, items, empty, columns = [], onMove, onOpen, onRemove }: { id: string; states: WorkState[]; items: WorkItem[]; empty: string; columns?: WorkColumn[]; onMove: (w: WorkItem, state: string) => void; onOpen: (w: WorkItem) => void; onRemove: (w: WorkItem) => void }) {
  const [view, setView] = useStored(`nyx.view.${id}`, "board")
  const [tag, setTag] = useState("")
  const [order, setOrder] = useStored(`nyx.sort.${id}`, { col: DUE, desc: false })
  const tags = [...new Set(items.flatMap((w) => w.tags))].sort()
  const shown = items.filter((w) => !tag || w.tags.includes(tag))
  const label = (w: WorkItem) => states.find((s) => s.id === w.state)
  const value = (w: WorkItem) => (order.col === STATE ? states.indexOf(label(w)!) : order.col === TAGS ? w.tags.join() : order.col === DUE ? w.due : order.col === 0 ? w.title : String(columns[order.col - DUE - 1]?.value(w) ?? ""))
  const toolbar = (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <Tabs tabs={VIEWS} value={view} onChange={setView} />
      {tags.length > 0 && <Variable label="Tag" value={tag} onChange={setTag} options={[{ value: "", label: "All" }, ...tags.map((t) => ({ value: t, label: t }))]} />}
    </div>
  )
  if (!items.length) return <Empty>{empty}</Empty>
  if (view === "board") return <>{toolbar}<Kanban items={shown.filter((w) => !w.readOnly)} states={states} onMove={onMove} onOpen={onOpen} onPick={setTag} /></>
  return (
    <>
      {toolbar}
      <div className="-mx-4 -mb-4">
        <Table head={["Title", "State", "Tags", "Due", ...columns.map((c) => c.label), ""]} sort={order} onSort={(col) => setOrder({ col, desc: order.col === col && !order.desc })}>
          {sortRows(shown, value, order.desc).map((w) => (
            <tr key={w.id}>
              <Td className={w.open ? "font-medium" : "text-fg3 line-through"}>{w.readOnly ? w.title : <button type="button" className="min-h-9 max-sm:min-h-11 text-left hover:text-accent" onClick={() => onOpen(w)}>{w.title}</button>}</Td>
              <Td>{w.readOnly ? <span className="text-fg3">Event</span> : <StateSelect item={w} states={states} onMove={(state) => onMove(w, state)} />}</Td>
              <Td><Tags tags={w.tags} onPick={setTag} /></Td>
              <Td className="text-[13px]"><Due item={w} /></Td>
              {columns.map((c) => <Td key={c.label} className="text-fg2">{c.value(w) || "—"}</Td>)}
              <Td className="w-24 whitespace-nowrap text-right">
                {!w.readOnly && <>
                  <IconButton label="Edit" icon={PencilSquareIcon} onClick={() => onOpen(w)} />
                  <IconButton label="Delete" icon={TrashIcon} onClick={() => onRemove(w)} />
                </>}
              </Td>
            </tr>
          ))}
        </Table>
      </div>
    </>
  )
}

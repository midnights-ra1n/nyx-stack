import { ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon, PencilSquareIcon, PlusIcon, RocketLaunchIcon, TrashIcon, WrenchScrewdriverIcon, XMarkIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Button, Empty, ErrorNote, type Icon, IconButton, Input, Panel, Progress, SearchInput, Select, Status, Table, Tabs, Td, TextArea, Variable, ask } from "../ui/components"
import { type Col, Editor, EditorGroup, RecordForm } from "../ui/crud"
import { t } from "../ui/i18n"
import { api, fmt, isOverdue, type Level, sortRows, useApi, useStored } from "../ui/lib"
import { Link, PageHeader, Section } from "../ui/shell"
import { splitTags, TagInput, TagList, tagOptions } from "../ui/tags"
import { type Item, joinChecklist, splitChecklist } from "./progress"

export interface WorkState { id: string; label: string; level: Level }
export type Kind = "task" | "intervention" | "deployment"

const TASK_STATES: WorkState[] = [{ id: "todo", label: "To do", level: "off" }, { id: "doing", label: "In progress", level: "info" }, { id: "done", label: "Done", level: "ok" }, { id: "cancelled", label: "Cancelled", level: "warn" }]
const DEPLOY_STATES: WorkState[] = [{ id: "planned", label: "Planned", level: "off" }, { id: "running", label: "Running", level: "info" }, { id: "ok", label: "Succeeded", level: "ok" }, { id: "failed", label: "Failed", level: "crit" }]

/** The three kinds of work: where each is kept, its states, and which of them close it. */
const KINDS: Record<Kind, { label: string; add: string; quick: string; icon: Icon; api: string; states: WorkState[]; closed: string[] }> = {
  task: { label: "Tasks", add: "Add task", quick: "Add a task and press Enter…", icon: CheckCircleIcon, api: "/api/tasks", states: TASK_STATES, closed: ["done", "cancelled"] },
  intervention: { label: "Interventions", add: "Add intervention", quick: "Add an intervention and press Enter…", icon: WrenchScrewdriverIcon, api: "/api/c/interventions", states: TASK_STATES, closed: ["done", "cancelled"] },
  deployment: { label: "Deployments", add: "Add deployment", quick: "Add a deployment and press Enter…", icon: RocketLaunchIcon, api: "/api/c/deployments", states: DEPLOY_STATES, closed: ["ok", "failed"] },
}

export interface WorkItem {
  id: string
  kind: Kind
  title: string
  state: string
  tags: string[]
  due?: string
  /** Still to be done: only then a past due date is late. */
  open: boolean
  /** The device or service it is about. */
  target?: string
  /** Where it comes from, when not from Nyx. */
  from?: string
  /** Calendar events: shown, but owned by Nextcloud. */
  readOnly?: boolean
  checklist?: { done: number; total: number }
  row: any
}

export const fromTask = (x: any): WorkItem => {
  const list = splitChecklist(x.description).items
  const event = x.kind === "event"
  return {
    id: x.id, kind: "task", title: x.title, state: x.status || (x.done ? "done" : "todo"), tags: splitTags(x.tags), due: x.due,
    // A calendar event is behind us once its day has passed.
    open: event ? !isOverdue(x.due) : !x.done, readOnly: event, from: event ? "Calendar" : x.uid ? "Nextcloud" : "",
    checklist: { done: list.filter((i) => i.done).length, total: list.length }, row: x,
  }
}
export const fromIntervention = (x: any): WorkItem => ({
  id: x.id, kind: "intervention", title: x.title, state: x.status || "todo", tags: splitTags(x.tags), due: x.scheduled_at,
  open: !KINDS.intervention.closed.includes(x.status), target: x.asset, from: x.type, row: x,
})
export const fromDeployment = (x: any): WorkItem => ({
  id: x.id, kind: "deployment", title: x.name, state: x.status || "planned", tags: splitTags(x.tags), due: x.scheduled_at,
  open: !KINDS.deployment.closed.includes(x.status), target: x.target, from: x.version, row: x,
})

const INTERVENTION_TYPES = ["Maintenance", "Repair", "Upgrade", "Installation", "Check"]
const interventionCols = (assets: string[]): Col[] => [
  { key: "title", label: "Title", required: true, hint: "Such as Replace disk 2, or Clean the dust filters." },
  { key: "type", label: "Type", type: "select", options: INTERVENTION_TYPES },
  { key: "asset", label: "Device", type: "select", choices: assets.map((a) => ({ value: a, label: a })), hint: "A device or virtual asset of the inventory." },
  { key: "status", label: "State", type: "select", choices: TASK_STATES.map((s) => ({ value: s.id, label: s.label })) },
  { key: "scheduled_at", label: "Planned for", type: "date" },
  { key: "done_at", label: "Done on", type: "date", when: { key: "status", in: ["done"] } },
  { key: "owner", label: "Who", suggest: true },
  { key: "tags", label: "Tags", type: "tags" },
  { key: "notes", label: "Report", type: "area", hint: "What was found and done, the parts used, the time spent." },
]
const DEPLOYMENT_COLS: Col[] = [
  { key: "name", label: "Name", required: true },
  { key: "target", label: "Target", suggest: true, hint: "The machine or service it goes to." },
  { key: "version", label: "Version", mono: true },
  { key: "status", label: "State", type: "select", choices: DEPLOY_STATES.map((s) => ({ value: s.id, label: s.label })) },
  { key: "scheduled_at", label: "Due date", type: "date" },
  { key: "done_at", label: "Done", type: "date" },
  { key: "owner", label: "Who", suggest: true },
  { key: "tags", label: "Tags", type: "tags" },
  { key: "notes", label: "Notes", type: "area" },
]

/** Names of the inventory's devices and virtual assets, for what an intervention is about. */
function useAssets() {
  const hw = useApi("/api/c/hardware?sort=name&perPage=500&fields=name", { poll: false })
  const va = useApi("/api/c/virtual_assets?sort=name&perPage=500&fields=name", { poll: false })
  return [...new Set([...(hw.data?.items ?? []), ...(va.data?.items ?? [])].map((r: any) => r.name))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

const pbNow = () => new Date().toISOString().replace("T", " ")
const pathOf = (w: WorkItem) => `${KINDS[w.kind].api}/${w.id}`

/** Moves an item to another state; one that closes it records the day, once. */
async function move(w: WorkItem, state: string) {
  if (w.kind === "task") return api(pathOf(w), { method: "PATCH", body: { ...w.row, status: state } })
  const closing = KINDS[w.kind].closed.includes(state) && !w.row.done_at
  return api(pathOf(w), { method: "PATCH", body: { status: state, ...(closing ? { done_at: pbNow() } : {}) } })
}

function Due({ item }: { item: WorkItem }) {
  if (!item.due) return <span className="text-fg3">—</span>
  const late = item.open && isOverdue(item.due)
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap ${late ? "text-crit" : "text-fg2"}`}>{late && <ExclamationTriangleIcon className="size-4" aria-hidden />}{late ? t("Late, {date}", { date: fmt.date(item.due) }) : fmt.date(item.due)}</span>
}

function Checklist({ item }: { item: WorkItem }) {
  const c = item.checklist
  if (!c?.total) return null
  return <span className="mt-1 flex items-center gap-2 text-xs text-fg3"><span className="w-full max-w-32"><Progress thin pct={Math.round((c.done / c.total) * 100)} label={t("Checklist of {title}", { title: item.title })} /></span><span className="whitespace-nowrap">{c.done}/{c.total}</span></span>
}

/** What moves an item by keyboard or on a phone, where dragging does not work. */
function StateSelect({ item, onMove }: { item: WorkItem; onMove: (state: string) => void }) {
  return (
    <select aria-label={t("State of {title}", { title: item.title })} value={item.state} onChange={(e) => onMove(e.target.value)} className="h-7 max-sm:h-9 max-w-32 rounded-control bg-raised px-1 text-[13px] text-fg2">
      {KINDS[item.kind].states.map((s) => <option key={s.id} value={s.id}>{t(s.label)}</option>)}
    </select>
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
    <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
      {states.map((s) => {
        const cards = items.filter((w) => w.state === s.id)
        return (
          <section key={s.id} aria-label={t(s.label)} onDragOver={(e) => { e.preventDefault(); setOver(s.id) }} onDragLeave={() => setOver(undefined)} onDrop={(e) => drop(e, s.id)} className={`flex min-h-40 flex-col gap-2 rounded-box p-2 ${over === s.id ? "bg-accent-soft" : "bg-bg"}`}>
            <h3 className="flex items-center justify-between px-1"><Status cell level={s.level} label={s.label} /><span className="text-[13px] text-fg3">{cards.length}</span></h3>
            <ul className="flex flex-col gap-2">
              {cards.map((w) => (
                <li key={w.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", w.id)} className="flex cursor-grab flex-col gap-2 rounded-box border border-line bg-surface p-3 active:cursor-grabbing">
                  <button type="button" className="text-left font-medium hover:text-accent" onClick={() => onOpen(w)}>{w.title}</button>
                  {(w.target || w.from) && <span className="truncate text-[13px] text-fg3">{[w.target, w.from && t(w.from)].filter(Boolean).join(" · ")}</span>}
                  <Checklist item={w} />
                  {w.tags.length > 0 && <TagList tags={w.tags} onPick={onPick} />}
                  <div className="flex items-center justify-between gap-2 text-[13px]"><Due item={w} /><StateSelect item={w} onMove={(state) => onMove(w, state)} /></div>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function TaskForm({ row, onDone }: { row: any | null; onDone: () => void }) {
  const split = splitChecklist(row?.description)
  const [f, setF] = useState({ title: row?.title ?? "", notes: split.notes, due: row?.due?.slice(0, 10) ?? "", status: row ? fromTask(row).state : "todo", tags: row?.tags?.replaceAll(",", ", ") ?? "" })
  const [items, setItems] = useState<Item[]>(split.items)
  const [error, setError] = useState("")
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const { notes, ...rest } = f
    const body = { ...rest, description: joinChecklist(notes, items), due: f.due ? `${f.due} 00:00:00.000Z` : "" }
    try { await api(row ? `/api/tasks/${row.id}` : "/api/tasks", { method: row ? "PATCH" : "POST", body }); onDone() } catch (err) { setError((err as Error).message) }
  }
  const setItem = (i: number, patch: Partial<Item>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const done = items.filter((i) => i.done && i.text.trim()).length, total = items.filter((i) => i.text.trim()).length
  return (
    <Editor title={row ? t("Edit {name}", { name: row.title }) : "Add task"} onCancel={onDone} onSubmit={save} error={error}>
      <EditorGroup title={t("Task")}>
        <div className="col-span-full"><Input label="Title" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <Select label="State" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={TASK_STATES.map((s) => ({ value: s.id, label: s.label }))} />
        <Input label="Due date" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
        <div className="col-span-full"><TagInput label="Tags" value={splitTags(f.tags)} onChange={(v) => setF({ ...f, tags: v.join(", ") })} hint="They sync with Nextcloud as categories, and the progress is shown per tag." /></div>
      </EditorGroup>
      <EditorGroup title={t("Checklist")}>
        <div className="col-span-full flex flex-col gap-2">
          {total > 0 && <div className="flex items-center gap-3 text-[13px] text-fg2"><div className="flex-1"><Progress thin pct={Math.round((done / total) * 100)} label={t("Checklist")} /></div>{done}/{total}</div>}
          {items.map((it, i) => (
            <div key={i} className="flex items-center gap-2">
              <input type="checkbox" aria-label={t("Done")} checked={it.done} onChange={(e) => setItem(i, { done: e.target.checked })} className="size-5 shrink-0 accent-[var(--color-accent)]" />
              <input aria-label={t("Step {n}", { n: i + 1 })} value={it.text} onChange={(e) => setItem(i, { text: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setItems([...items.slice(0, i + 1), { text: "", done: false }, ...items.slice(i + 1)]) } }}
                className={`field h-9 max-sm:h-11 flex-1 rounded-control border border-line2 bg-raised px-3 ${it.done ? "text-fg3 line-through" : "text-fg"}`} />
              <IconButton label="Remove" icon={XMarkIcon} onClick={() => setItems(items.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div><Button onClick={() => setItems([...items, { text: "", done: false }])}><PlusIcon className="size-5" aria-hidden />{t("Add a step")}</Button></div>
          <p className="text-xs text-fg3">{t("Steps are saved in the description as a Markdown checklist, so Nextcloud shows them too.")}</p>
        </div>
      </EditorGroup>
      <EditorGroup title={t("Notes")}>
        <div className="col-span-full"><TextArea label="Description" rows={4} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
      </EditorGroup>
    </Editor>
  )
}

/** The form of any kind of work: a task with its checklist, or a record of the other two. */
function WorkForm({ kind, row, defaults, onDone }: { kind: Kind; row: any | null; defaults?: any; onDone: () => void }) {
  const assets = useAssets()
  if (kind === "task") return <TaskForm row={row} onDone={onDone} />
  const title = row ? t("Edit {name}", { name: row.title ?? row.name }) : t(KINDS[kind].add)
  return kind === "intervention"
    ? <RecordForm cols={interventionCols(assets)} row={row} collection="interventions" title={title} defaults={{ status: "todo", ...defaults }} onDone={onDone} />
    : <RecordForm cols={DEPLOYMENT_COLS} row={row} collection="deployments" title={title} defaults={{ status: "planned", ...defaults }} onDone={onDone} />
}

/** "Add" for one kind, or a choice of the three. */
function AddButton({ kind, onAdd }: { kind: Kind | ""; onAdd: (k: Kind) => void }) {
  if (kind) return <Button variant="primary" onClick={() => onAdd(kind)}><PlusIcon className="size-5" aria-hidden />{t(KINDS[kind].add)}</Button>
  return (
    <details className="relative">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-control bg-accent px-4 font-medium text-accent-ink hover:bg-accent-hover max-sm:h-11"><PlusIcon className="size-5" aria-hidden />{t("Add")}</summary>
      <div className="absolute right-0 z-30 mt-1 flex w-48 flex-col rounded-panel border border-line2 bg-surface p-1 shadow-lg">
        {(Object.keys(KINDS) as Kind[]).map((k) => { const I = KINDS[k].icon; return <button key={k} type="button" className="flex h-9 items-center gap-2 rounded-control px-3 text-left hover:bg-raised" onClick={(e) => { e.currentTarget.closest("details")!.open = false; onAdd(k) }}><I className="size-5 text-fg3" aria-hidden />{t(KINDS[k].add)}</button> })}
      </div>
    </details>
  )
}

const VIEWS = [{ id: "table", label: "Table" }, { id: "board", label: "Board" }]
const SHOW = [{ value: "open", label: "To do" }, { value: "closed", label: "Finished" }, { value: "all", label: "All" }]
const TITLE = 0, TARGET = 1, STATE = 2, DUE = 3, TAGS = 4

/**
 * Everything to do on the homelab in one table: tasks (synced with Nextcloud), interventions
 * on the inventory's devices, and deployments. A tab narrows it to one kind, which can then
 * be shown as a board too.
 */
export function Work({ initial = "" }: { initial?: Kind | "" }) {
  const tasks = useApi<any[]>("/api/tasks")
  const interventions = useApi("/api/c/interventions?sort=-created&perPage=500")
  const deployments = useApi("/api/c/deployments?sort=-created&perPage=500")
  const [kind, setKind] = useState<Kind | "">(initial)
  const [show, setShow] = useStored("nyx.work.show", "open")
  const [view, setView] = useStored("nyx.work.view", "table")
  const [order, setOrder] = useStored("nyx.work.sort", { col: DUE, desc: false })
  const [tag, setTag] = useState("")
  const [query, setQuery] = useState("")
  const [quick, setQuick] = useState("")
  const [note, setNote] = useState("")
  const [edit, setEdit] = useState<{ kind: Kind; row: any | null }>()
  const reload = () => { tasks.reload(); interventions.reload(); deployments.reload() }
  const run = async (f: () => Promise<unknown>) => { try { await f(); setNote(""); reload() } catch (e) { setNote((e as Error).message) } }

  const all = [...(tasks.data ?? []).map(fromTask), ...(interventions.data?.items ?? []).map(fromIntervention), ...(deployments.data?.items ?? []).map(fromDeployment)]
  const mine = all.filter((w) => !kind || w.kind === kind)
  const needle = query.trim().toLowerCase()
  const matching = mine.filter((w) => (!tag || w.tags.includes(tag)) && (!needle || [w.title, w.target, w.from, ...w.tags].some((v) => v?.toLowerCase().includes(needle))))
  // The board shows every state in its columns; the table only what is asked.
  const shown = matching.filter((w) => show === "all" || (show === "open") === w.open)
  const tags = [...new Set(mine.flatMap((w) => w.tags))].sort()
  const pending = all.filter((w) => w.open && !w.readOnly)
  const late = pending.filter((w) => isOverdue(w.due)).length
  const count = (k: Kind | "") => pending.filter((w) => !k || w.kind === k).length
  const value = (w: WorkItem) => (order.col === TITLE ? w.title : order.col === TARGET ? w.target : order.col === STATE ? KINDS[w.kind].states.findIndex((s) => s.id === w.state) : order.col === TAGS ? w.tags.join() : w.due)
  const loading = !tasks.data && !tasks.error
  const quickKind = KINDS[kind || "task"]

  const open = (w: WorkItem) => !w.readOnly && setEdit({ kind: w.kind, row: w.row })
  const remove = async (w: WorkItem) => { if (await ask(t("Delete {name}?", { name: w.title }), { action: "Delete", danger: true })) run(() => api(pathOf(w), { method: "DELETE" })) }
  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const title = quick.trim(), k = kind || "task"
    if (!title) return
    run(async () => { await api(KINDS[k].api, { body: k === "deployment" ? { name: title, status: "planned" } : { title, status: "todo" } }); setQuick("") })
  }

  return (
    <>
      <PageHeader title={t("Work")} subtitle={note || [t("{n} to do", { n: pending.length }), late > 0 && t("{n} late", { n: late })].filter(Boolean).join(" · ")} onRefresh={reload} actions={<>
        {(kind === "" || kind === "task") && <Button onClick={() => run(() => api("/api/sync", { method: "POST" }))}><ArrowPathIcon className="size-5" aria-hidden />{t("Sync")}</Button>}
        <AddButton kind={kind} onAdd={(k) => setEdit({ kind: k, row: null })} />
      </>} />
      {edit && <WorkForm key={`${edit.kind}${edit.row?.id ?? "new"}`} kind={edit.kind} row={edit.row} onDone={() => { setEdit(undefined); reload() }} />}
      <Section>
        <div className="flex flex-wrap items-center gap-3">
          <Tabs tabs={[{ id: "", label: `${t("All")} ${count("")}` }, ...(Object.keys(KINDS) as Kind[]).map((k) => ({ id: k, label: `${t(KINDS[k].label)} ${count(k)}` }))]} value={kind} onChange={(k) => { setKind(k as Kind | ""); setTag("") }} />
          <SearchInput placeholder={t("Title, device or tag")} value={query} onChange={(e) => setQuery(e.target.value)} />
          {!(kind && view === "board") && <Variable label="Show" value={show} onChange={setShow} options={SHOW} />}
          {tags.length > 0 && <Variable label="Tag" value={tag} onChange={setTag} options={tagOptions(tags)} />}
          {kind && <div className="ml-auto max-sm:ml-0"><Tabs tabs={VIEWS} value={view} onChange={setView} /></div>}
        </div>
        <ErrorNote>{tasks.error || interventions.error || deployments.error}</ErrorNote>
        {kind && view === "board" ? <Kanban items={matching.filter((w) => !w.readOnly)} states={KINDS[kind].states} onMove={(w, s) => run(() => move(w, s))} onOpen={open} onPick={setTag} /> : (
          <Panel title={t(kind ? KINDS[kind].label : "Everything to do")} flush loading={loading}>
            <form onSubmit={add} className="flex gap-2 px-4 pb-3">
              <input aria-label={t(quickKind.add)} placeholder={t(quickKind.quick)} value={quick} onChange={(e) => setQuick(e.target.value)} className="field h-9 max-sm:h-11 flex-1 rounded-control border border-line2 bg-raised px-4 placeholder:text-fg3 max-sm:text-base" />
              <Button type="submit" disabled={!quick.trim()}>{t("Add")}</Button>
            </form>
            {!loading && shown.length === 0 ? <div className="px-4 pb-4"><Empty>{mine.length ? t("Nothing matches.") : t("Nothing to do. Add a task, plan an intervention on a device or a deployment, or link Nextcloud in Settings to sync your tasks.")}</Empty></div> : (
              <Table head={["Title", "Target", "State", "Due", "Tags", ""]} sort={order} onSort={(col) => col <= TAGS && setOrder({ col, desc: order.col === col && !order.desc })}>
                {sortRows(shown, value, order.desc).map((w) => {
                  const I = KINDS[w.kind].icon
                  return (
                    <tr key={`${w.kind}${w.id}`}>
                      <Td className={w.open ? "font-medium" : "text-fg3"}>
                        <span className="flex items-center gap-2">
                          {!kind && <I className="size-4 shrink-0 text-fg3" aria-label={t(KINDS[w.kind].label)} />}
                          {w.readOnly ? w.title : <button type="button" className="min-h-9 max-sm:min-h-11 text-left hover:text-accent" onClick={() => open(w)}>{w.title}</button>}
                        </span>
                        {w.from && <span className="block text-xs font-normal text-fg3">{t(w.from)}</span>}
                        <Checklist item={w} />
                      </Td>
                      <Td className="text-fg2">{w.target ? <Link to={`/search?q=${encodeURIComponent(w.target)}`} className="hover:text-accent">{w.target}</Link> : "—"}</Td>
                      <Td>{w.readOnly ? <span className="text-fg3">{t("Event")}</span> : <StateSelect item={w} onMove={(s) => run(() => move(w, s))} />}</Td>
                      <Td className="text-[13px]"><Due item={w} /></Td>
                      <Td><TagList tags={w.tags} onPick={setTag} /></Td>
                      <Td className="w-24 whitespace-nowrap text-right">
                        {!w.readOnly && <>
                          <IconButton label="Edit" icon={PencilSquareIcon} onClick={() => open(w)} />
                          <IconButton label="Delete" icon={TrashIcon} onClick={() => remove(w)} />
                        </>}
                      </Td>
                    </tr>
                  )
                })}
              </Table>
            )}
          </Panel>
        )}
      </Section>
    </>
  )
}

const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/** On a device's page: what was done to it and what is planned, as GLPI's intervention history. */
export function DeviceInterventions({ name }: { name: string }) {
  const { data, reload, error } = useApi("/api/c/interventions?sort=-scheduled_at&perPage=500", { poll: false })
  const [edit, setEdit] = useState<any | null | undefined>()
  const rows = (data?.items ?? []).filter((x: any) => same(x.asset, name)).map(fromIntervention)
  const done = () => { setEdit(undefined); reload() }
  return <>
    {edit !== undefined && <WorkForm key={edit?.id ?? "new"} kind="intervention" row={edit} defaults={{ asset: name }} onDone={done} />}
    <Panel title={t(rows.length === 1 ? "{n} intervention" : "{n} interventions", { n: rows.length })} flush actions={[{ label: "Add intervention", onClick: () => setEdit(null) }]}>
      <ErrorNote>{error}</ErrorNote>
      {rows.length === 0 ? <div className="px-4 pb-4"><Empty>{t("No intervention yet. Plan a repair, an upgrade or a check, then write down what was done.")}</Empty></div> : (
        <Table head={["Intervention", "Type", "State", "Date", ""]}>
          {rows.map((w: WorkItem) => (
            <tr key={w.id}>
              <Td className={w.open ? "font-medium" : "text-fg2"}><button type="button" className="min-h-9 text-left hover:text-accent" onClick={() => setEdit(w.row)}>{w.title}</button></Td>
              <Td className="text-fg2">{w.from ? t(w.from) : "—"}</Td>
              <Td><StateSelect item={w} onMove={async (s) => { await move(w, s); reload() }} /></Td>
              <Td className="text-[13px]">{w.open ? <Due item={w} /> : <span className="text-fg2">{fmt.date(w.row.done_at || w.due)}</span>}</Td>
              <Td className="w-12 text-right"><IconButton label={t("Edit {name}", { name: w.title })} icon={PencilSquareIcon} onClick={() => setEdit(w.row)} /></Td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  </>
}

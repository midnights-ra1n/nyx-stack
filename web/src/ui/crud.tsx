import { PencilSquareIcon, PlusIcon, TrashIcon, ViewColumnsIcon, XMarkIcon } from "@heroicons/react/24/outline"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { Button, Check, Empty, ErrorNote, type Icon, IconButton, Input, Panel, Select, Table, Td, TextArea, Variable, ask } from "./components"
import { t } from "./i18n"
import { api, fmt, sortRows, useApi, useStored } from "./lib"
import { Link, navigate, PageHeader, Section } from "./shell"

export interface Col {
  key: string
  label: string
  type?: "text" | "number" | "date" | "bool" | "area" | "select"
  options?: string[]
  mono?: boolean
  hint?: string
  /** Shown in the form only. */
  formOnly?: boolean
  /** Shown in the list only. */
  listOnly?: boolean
  required?: boolean
  render?: (row: any) => ReactNode
  /** Heading in the form, above this field and the next ones. */
  section?: string
  /** A select shown as a row of tiles, one icon per option. */
  icons?: Record<string, Icon>
  /** Offers the values already in use while typing. */
  suggest?: boolean
  /** In the form only while another field holds one of these values. */
  when?: { key: string; in: string[] }
  /** Tab of the record page, for this field and the next ones. */
  tab?: string
  /** Options of a select whose value differs from what it shows, such as a record id. */
  choices?: { value: string; label: string }[]
}

const toInput = (c: Col, v: any) => (c.type === "date" ? (v ? String(v).slice(0, 10) : "") : v ?? "")
const fromInput = (c: Col, v: any) => {
  if (c.type === "number") return v === "" || v == null ? 0 : Number(v)
  if (c.type === "date") return v ? `${v} 00:00:00.000Z` : ""
  return v
}

function Tiles({ col, value, onChange }: { col: Col; value: string; onChange: (v: string) => void }) {
  return (
    <fieldset className="col-span-full">
      <legend className="mb-1 text-[13px] text-fg2">{t(col.label)}</legend>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
        {col.options?.map((o) => {
          const I = col.icons![o]
          return (
            <label key={o} className={`flex h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-box border text-[13px] has-focus-visible:outline-2 has-focus-visible:outline-accent ${value === o ? "border-accent bg-accent-soft text-accent" : "border-line2 bg-raised text-fg2 hover:border-fg3"}`}>
              <input type="radio" className="sr-only" name={col.key} checked={value === o} onChange={() => onChange(o)} />
              <I className="size-5" aria-hidden />{t(o)}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/** Fields grouped under their `section` heading. Fields before the first heading form an untitled group. */
export function groups(cols: Col[]) {
  const out: { title?: string; cols: Col[] }[] = []
  for (const c of cols) {
    if (out.length === 0 || (c.section && c.section !== out[out.length - 1].title)) out.push({ title: c.section, cols: [] })
    out[out.length - 1].cols.push(c)
  }
  return out
}

/** A flat editor in the page, above what it edits: headings on the left, fields on the right. */
export function Editor({ title, onCancel, onSubmit, error, children, footer }: { title: string; onCancel: () => void; onSubmit: (e: React.FormEvent) => void; error?: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "start", behavior: "smooth" })
    ref.current?.querySelector<HTMLElement>("input:not([type=radio]), select, textarea")?.focus({ preventScroll: true })
  }, [])
  return (
    <section ref={ref} aria-label={t(title)} className="mb-6 scroll-mt-4 rounded-panel border border-accent/40 bg-surface" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <header className="flex h-12 items-center justify-between gap-3 border-b border-line pl-5 pr-2">
        <h2 className="text-[15px] font-medium">{t(title)}</h2>
        <IconButton label="Close" icon={XMarkIcon} onClick={onCancel} />
      </header>
      <form onSubmit={onSubmit}>
        <div className="divide-y divide-line">{children}</div>
        <footer className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3">
          <Button variant="primary" type="submit">{t("Save")}</Button>
          <Button type="button" onClick={onCancel}>{t("Cancel")}</Button>
          {footer}
          <div className="ml-auto"><ErrorNote>{error}</ErrorNote></div>
        </footer>
      </form>
    </section>
  )
}

/** One group of an `Editor`. */
export function EditorGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-6 px-5 py-5 max-md:grid-cols-1 max-md:gap-3">
      <h3 className="text-[13px] font-medium text-fg2">{title && t(title)}</h3>
      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">{children}</div>
    </div>
  )
}

/** Field values, what shows and how a record is saved: shared by the inline editor and the record page. */
function useRecord(all: Col[], row: any | null, collection: string, defaults?: any) {
  const cols = all.filter((c) => !c.listOnly)
  const [form, setForm] = useState<any>(() => Object.fromEntries(cols.map((c) => [c.key, toInput(c, (row ?? defaults)?.[c.key])])))
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }))
  // Hidden fields are left out of the save, so switching the category back finds them again.
  const visible = cols.filter((c) => !c.when || c.when.in.includes(form[c.when.key]))
  const save = () => {
    // A new record also takes the defaults no field shows, such as the device a port belongs to.
    const body = { ...(row ? {} : defaults), ...Object.fromEntries(visible.map((c) => [c.key, fromInput(c, form[c.key])])) }
    return api(row ? `/api/c/${collection}/${row.id}` : `/api/c/${collection}`, { method: row ? "PATCH" : "POST", body })
  }
  return { form, set, visible, save }
}

function Field({ c, form, set, rows }: { c: Col; form: any; set: (k: string, v: any) => void; rows: any[] }) {
  const common = { label: c.label, hint: c.hint, required: c.required }
  const onChange = (e: any) => set(c.key, e.target.value)
  const known = c.suggest ? [...new Set(rows.map((r) => r[c.key]).filter(Boolean))] as string[] : []
  const input = () => {
    if (c.icons) return <Tiles col={c} value={form[c.key]} onChange={(v) => set(c.key, v)} />
    if (c.type === "bool") return <Check label={c.label} hint={c.hint} checked={!!form[c.key]} onChange={(e) => set(c.key, e.target.checked)} />
    if (c.type === "area") return <div className="col-span-full"><TextArea {...common} rows={4} value={form[c.key]} onChange={onChange} /></div>
    if (c.type === "select") return <Select {...common} value={form[c.key]} onChange={onChange} options={[c.choices ? { value: "", label: "None" } : "", ...(c.choices ?? c.options ?? [])]} />
    return <Input {...common} list={known.length ? `suggest-${c.key}` : undefined} type={c.type === "number" ? "number" : c.type === "date" ? "date" : "text"} step={c.type === "number" ? "any" : undefined} value={form[c.key]} onChange={onChange} />
  }
  return (
    <>
      {input()}
      {known.length > 0 && <datalist id={`suggest-${c.key}`}>{known.map((v) => <option key={v} value={v} />)}</datalist>}
    </>
  )
}

export function RecordForm({ cols, row, collection, onDone, title, defaults, rows = [], onSaved }: { cols: Col[]; row: any | null; collection: string; onDone: () => void; title: string; defaults?: any; rows?: any[]; onSaved?: (rec: any) => void }) {
  const { form, set, visible, save } = useRecord(cols, row, collection, defaults)
  const [error, setError] = useState("")
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try { onSaved?.(await save()); onDone() } catch (err) { setError((err as Error).message) }
  }
  return (
    <Editor title={title} onCancel={onDone} onSubmit={submit} error={error}>
      {groups(visible).map((g, i) => <EditorGroup key={i} title={g.title}>{g.cols.map((c) => <Field key={c.key} c={c} form={form} set={set} rows={rows} />)}</EditorGroup>)}
    </Editor>
  )
}

export const recordName = (r: any, singular: string) => r?.name ?? r?.title ?? r?.address ?? singular

/** A tab of the record page that is not part of the form, such as linked records. Shown once the record exists. */
export interface RecordTab {
  id: string
  label: string
  count?: number
  render: (form: any, row: any) => ReactNode
}

export interface RecordPageProps {
  /** The list, in plural: the first crumb. */
  title: string
  singular: string
  collection: string
  cols: Col[]
  /** The list's address; the record lives at `${path}/${id}`, a new one at `${path}/new`. */
  path: string
  id: string
  defaults?: any
  /** Beside the form: a summary from the values being typed. */
  aside?: (form: any, row: any | null) => ReactNode
  /** After the tabs of the form. */
  tabs?: RecordTab[]
  /** The collection keeps a history of changes: adds a History tab. */
  history?: boolean
}

/** Form fields per tab: a field with `tab` opens a tab, the next ones follow it. */
export function tabsOf(cols: Col[]) {
  const out: { id: string; cols: Col[] }[] = []
  for (const c of cols) {
    const id = c.tab ?? out[out.length - 1]?.id ?? "General"
    if (out[out.length - 1]?.id !== id) out.push({ id, cols: [] })
    out[out.length - 1].cols.push(c)
  }
  return out
}

/** One record on a page of its own, like an item in GLPI: tabs on the left, the open one beside them. */
export function RecordPage(p: RecordPageProps) {
  const isNew = p.id === "new"
  const rec = useApi(isNew ? null : `/api/c/${p.collection}/${p.id}`, { poll: false })
  const list = useApi(`/api/c/${p.collection}?perPage=500`, { poll: false })
  if (!isNew && rec.error) return <><PageHeader title={p.title} crumbs={[{ label: p.title, to: p.path }]} /><ErrorNote>{rec.error}</ErrorNote></>
  if (!isNew && !rec.data) return <Empty>{t("Loading…")}</Empty>
  return <RecordBody key={p.id} {...p} row={isNew ? null : rec.data} rows={list.data?.items ?? []} reload={rec.reload} />
}

function RecordBody({ title, singular, collection, cols, path, defaults, aside, tabs = [], history, row, rows, reload }: RecordPageProps & { row: any | null; rows: any[]; reload: () => void }) {
  const { form, set, visible, save } = useRecord(cols, row, collection, defaults)
  const [error, setError] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [saves, setSaves] = useState(0)
  const formId = useId()
  const name = row ? recordName(row, singular) : t(`New ${singular}`)
  // Tabs come from all fields, so a field hidden by `when` never takes its tab away.
  const formTabs = tabsOf(cols.filter((c) => !c.listOnly))
  const extra: RecordTab[] = row ? [...tabs, ...(history ? [{ id: "History", label: "History", render: () => <History key={saves} collection={collection} id={row.id} cols={cols} /> }] : [])] : []
  const all = [...formTabs.map((x) => ({ id: x.id, label: x.id, count: undefined })), ...extra]
  const [tab, setTab] = useState(() => all.find((x) => x.id === decodeURIComponent(location.hash.slice(1)))?.id ?? all[0].id)
  const pick = (id: string) => { setTab(id); window.history.replaceState(window.history.state, "", `#${encodeURIComponent(id)}`) }
  const open = extra.find((x) => x.id === tab)
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    // The form has no browser validation: a required field may sit on a tab that is not shown, so open it first.
    const bad = e.currentTarget.querySelector<HTMLInputElement>("input:invalid, select:invalid, textarea:invalid")
    if (bad) {
      const id = bad.closest<HTMLElement>("[data-tab]")?.dataset.tab
      if (id) pick(id)
      setTimeout(() => bad.reportValidity())
      return
    }
    setBusy(true)
    setError("")
    try {
      const saved = await save()
      if (row) { reload(); setSaves(saves + 1); setNote(t("Saved.")) } else navigate(`${path}/${saved.id}`)
    } catch (err) { setError((err as Error).message) }
    setBusy(false)
  }
  const remove = async () => {
    if (!await ask(t("Delete {name}?", { name }), { action: "Delete", danger: true })) return
    try { await api(`/api/c/${collection}/${row.id}`, { method: "DELETE" }); navigate(path) } catch (err) { setError((err as Error).message) }
  }
  const side = aside?.(form, row)
  return (
    <div>
      <PageHeader title={name} crumbs={[{ label: title, to: path }, { label: name }]}
        subtitle={row ? t("Updated {ago}", { ago: fmt.ago(row.updated) }) : undefined}
        actions={row && <Button variant="danger" onClick={remove}><TrashIcon className="size-5" aria-hidden />{t("Delete")}</Button>} />
      <div className="grid items-start gap-4 lg:grid-cols-[180px_minmax(0,1fr)]">
        <nav role="tablist" aria-label={t("{name} tabs", { name })} aria-orientation="vertical" className="flex gap-1 overflow-x-auto max-lg:pb-1 lg:sticky lg:top-4 lg:flex-col">
          {all.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={x.id === tab} onClick={() => pick(x.id)}
              className={`flex h-9 shrink-0 items-center justify-between gap-3 rounded-control px-3 text-left whitespace-nowrap max-sm:h-11 ${x.id === tab ? "bg-accent-soft text-accent" : "text-fg2 hover:bg-raised hover:text-fg"}`}>
              {t(x.label)}{x.count ? <span className="text-xs text-fg3">{x.count}</span> : null}
            </button>
          ))}
        </nav>
        <div role="tabpanel" aria-label={t(tab)} className="min-w-0">
          <form id={formId} noValidate onSubmit={submit} hidden={!!open} onKeyDown={(e) => e.key === "Escape" && navigate(path)}>
            <div className={`grid items-start gap-4 ${side ? "xl:grid-cols-[minmax(0,1fr)_320px]" : ""}`}>
              <div className="flex flex-col gap-4">
                {formTabs.map((x) => (
                  <div key={x.id} data-tab={x.id} hidden={x.id !== tab} className="flex flex-col gap-4">
                    {groups(visible.filter((c) => x.cols.includes(c))).map((g, i) => (
                      <Panel key={i} title={g.title ?? x.id}>
                        <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">{g.cols.map((c) => <Field key={c.key} c={c} form={form} set={set} rows={rows} />)}</div>
                      </Panel>
                    ))}
                  </div>
                ))}
              </div>
              {side && <aside className="flex flex-col gap-4 xl:sticky xl:top-4">{side}</aside>}
            </div>
          </form>
          {open && <div className="flex flex-col gap-4">{open.render(form, row)}</div>}
        </div>
      </div>
      {/* Stays in reach on a long form, without covering it. The form keeps its values while another tab is open. */}
      <footer className="sticky bottom-0 z-10 -mx-1 mt-4 flex flex-wrap items-center gap-3 border-t border-line bg-bg/95 px-1 py-3 backdrop-blur">
        <Button variant="primary" type="submit" form={formId} disabled={busy}>{row ? t("Save") : t(`Add ${singular}`)}</Button>
        <Button onClick={() => navigate(path)}>{t(row ? "Back" : "Cancel")}</Button>
        <span role="status" className="text-fg2">{note}</span>
        <div className="ml-auto"><ErrorNote>{error}</ErrorNote></div>
      </footer>
    </div>
  )
}

const shown = (c: Col | undefined, v: any) => {
  if (v === "" || v == null) return t("empty")
  if (c?.type === "date") return fmt.date(v)
  if (c?.type === "bool") return t(v ? "Yes" : "No")
  return c?.choices?.find((o) => o.value === v)?.label ?? String(v)
}

/** Who changed what: every save from the web interface, newest first. */
function History({ collection, id, cols }: { collection: string; id: string; cols: Col[] }) {
  const { data, error } = useApi<any[]>(`/api/c/${collection}/${id}/history`, { poll: false })
  const col = (k: string) => cols.find((c) => c.key === k && !c.listOnly) ?? cols.find((c) => c.key === k)
  return (
    <Panel title={t("History")} flush>
      <ErrorNote>{error}</ErrorNote>
      {data && data.length === 0 ? <div className="px-4 pb-4"><Empty>{t("No change recorded yet. Saves made here are recorded; imports and syncs are not.")}</Empty></div> : (
        <Table head={["When", "Field", "Before", "After"]}>
          {(data ?? []).flatMap((h) => (h.action === "create" ? [{ k: "", from: "", to: "" }] : (h.changes ?? []).map((c: any) => ({ k: c.field, from: c.from, to: c.to }))).map((c: any, i: number) => (
            <tr key={`${h.id}${i}`}>
              <Td className="whitespace-nowrap text-fg2">{i === 0 ? <span title={new Date(h.created.replace(" ", "T")).toLocaleString()}>{fmt.ago(h.created)}</span> : ""}</Td>
              {h.action === "create" ? <Td colSpan={3}>{t("Created")}</Td> : <>
                <Td className="font-medium">{t(col(c.k)?.label ?? c.k)}</Td>
                <Td className="text-fg3 line-through decoration-fg3/50">{shown(col(c.k), c.from)}</Td>
                <Td>{shown(col(c.k), c.to)}</Td>
              </>}
            </tr>
          )))}
        </Table>
      )}
    </Panel>
  )
}

/** Every field that can be a column, once each: the list's own version of a field wins over the form's. Long text cannot. */
export function columnChoices(cols: Col[]) {
  const by = new Map<string, Col>()
  // Deleting first moves the key to where the list's version sits.
  for (const c of cols) if (c.type !== "area" && (!by.has(c.key) || (by.get(c.key)!.formOnly && !c.formOnly))) { by.delete(c.key); by.set(c.key, c) }
  return [...by.values()]
}

const cell = (c: Col, row: any) => c.render ? c.render(row) : c.type === "date" ? fmt.date(row[c.key]) : c.type === "bool" ? t(row[c.key] ? "Yes" : "No") : row[c.key] || row[c.key] === 0 ? row[c.key] : "—"

/** List, add, edit and delete records of one collection. With `path`, a record opens on a page of its own rather than in the list. */
export function CrudPage({ title, heading = title, variables, singular, collection, cols, sort = "name", crumbs, extra, onChanged, defaults, path, facet }: { title: string; heading?: string; variables?: ReactNode; singular: string; collection: string; cols: Col[]; sort?: string; crumbs?: { label: string; to?: string }[]; extra?: ReactNode; onChanged?: () => void; defaults?: any; path?: string; facet?: string }) {
  const { data, reload, error } = useApi(`/api/c/${collection}?sort=${sort}&perPage=500`, { poll: false })
  const [edit, setEdit] = useState<any | null | undefined>()
  const [order, setOrder] = useStored(`nyx.sort.${collection}`, { key: "", desc: false })
  const [picks, setPicks] = useStored<Record<string, boolean>>(`nyx.cols.${collection}`, {})
  const [query, setQuery] = useState("")
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const choices = columnChoices(cols)
  // The first column names the record and always stays.
  const lead = choices.find((c) => !c.formOnly) ?? choices[0]
  const shown = [lead, ...choices.filter((c) => c !== lead && (picks[c.key] ?? !c.formOnly))]
  const filters = choices.filter((c) => c.type === "select" && !c.formOnly && c.key !== facet)
  const all: any[] = data?.items ?? []
  const needle = query.trim().toLowerCase()
  const matching = all.filter((r) => [...filters.map((c) => c.key), ...(facet ? [facet] : [])].every((k) => !picked[k] || r[k] === picked[k]) && (!needle || cols.some((c) => String(r[c.key] ?? "").toLowerCase().includes(needle))))
  const rows = order.key ? sortRows(matching, (r) => r[order.key], order.desc) : matching
  const chosen = rows.filter((r) => selected.has(r.id))
  const sortBy = (key: string) => setOrder({ key, desc: order.key === key && !order.desc })
  const done = () => { setEdit(undefined); setSelected(new Set()); reload(); onChanged?.() }
  const open = (row: any | null) => (path ? navigate(`${path}/${row ? row.id : "new"}`) : setEdit(row))
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const remove = async (row: any) => {
    if (!await ask(t("Delete {name}?", { name: recordName(row, t("this record")) }), { action: "Delete", danger: true })) return
    await api(`/api/c/${collection}/${row.id}`, { method: "DELETE" })
    done()
  }
  const sortCol = shown.findIndex((c) => c.key === order.key)
  return (
    <>
      <PageHeader title={heading} variables={variables} crumbs={crumbs} actions={<Button variant="primary" disabled={edit === null} onClick={() => open(null)}><PlusIcon className="size-5" aria-hidden />{t(`Add ${singular}`)}</Button>} />
      {edit !== undefined && <RecordForm key={edit?.id ?? "new"} cols={cols} row={edit} collection={collection} onDone={done} title={edit ? t("Edit {name}", { name: recordName(edit, singular) }) : t(`Add ${singular}`)} defaults={defaults} rows={all} />}
      <Section>
        {facet && all.length > 0 && <Facets col={cols.find((c) => c.key === facet && c.icons) ?? cols.find((c) => c.key === facet)!} rows={all} value={picked[facet] ?? ""} onChange={(v) => setPicked({ ...picked, [facet]: v })} />}
        {extra}
        {all.length > 0 && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64 max-sm:w-full"><Input label="Search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
            {filters.map((c) => <Variable key={c.key} label={c.label} value={picked[c.key] ?? ""} onChange={(v) => setPicked({ ...picked, [c.key]: v })} options={[{ value: "", label: "All" }, ...[...new Set(all.map((r) => r[c.key]).filter(Boolean))].map((v) => ({ value: v, label: c.choices?.find((o) => o.value === v)?.label ?? v }))]} />)}
            {/* The table turns into a list on phones, without its headers. */}
            <div className="sm:hidden"><Variable label="Sort by" value={order.key} onChange={sortBy} options={[{ value: "", label: "Default" }, ...shown.map((c) => ({ value: c.key, label: c.label }))]} /></div>
            <details className="relative ml-auto max-sm:ml-0">
              <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-control border border-line2 px-4 text-fg2 hover:text-fg max-sm:h-11"><ViewColumnsIcon className="size-5" aria-hidden />{t("Columns")}</summary>
              <fieldset className="absolute right-0 z-20 mt-1 flex max-h-96 w-64 flex-col overflow-y-auto rounded-panel border border-line2 bg-surface p-3 shadow-lg max-sm:left-0">
                <legend className="sr-only">{t("Columns shown")}</legend>
                {choices.map((c) => <Check key={c.key} label={c.label} checked={shown.includes(c)} disabled={c === lead} onChange={(e) => setPicks({ ...picks, [c.key]: e.target.checked })} />)}
              </fieldset>
            </details>
          </div>
        )}
        {chosen.length > 0 && <Bulk cols={cols} rows={chosen} all={all} collection={collection} onDone={done} onClear={() => setSelected(new Set())} />}
        <Panel title={rows.length === all.length ? `${all.length} · ${t(title)}` : t("{n} of {total}", { n: rows.length, total: all.length }) + ` · ${t(title)}`} flush>
          <ErrorNote>{error}</ErrorNote>
          {all.length === 0 && data ? <div className="px-4 pb-4"><Empty>{t("Nothing here yet.")}</Empty></div> : rows.length === 0 && data ? <div className="px-4 pb-4"><Empty>{t("Nothing matches.")}</Empty></div> : (
            <Table head={[<input key="all" type="checkbox" aria-label={t("Select all shown")} className="size-4 accent-accent" checked={chosen.length > 0 && chosen.length === rows.length} ref={(el) => { if (el) el.indeterminate = chosen.length > 0 && chosen.length < rows.length }} onChange={(e) => setSelected(new Set(e.target.checked ? rows.map((r) => r.id) : []))} />, ...shown.map((c) => t(c.label)), ""]}
              sort={sortCol >= 0 ? { col: sortCol + 1, desc: order.desc } : undefined} onSort={(i) => i > 0 && i <= shown.length && sortBy(shown[i - 1].key)}>
              {rows.map((row: any) => (
                <tr key={row.id} className={`${path ? "cursor-pointer hover:bg-raised" : ""} ${selected.has(row.id) ? "bg-accent-soft/40" : ""}`} onClick={path ? (e) => { if (!(e.target as HTMLElement).closest("a, button, input, label")) open(row) } : undefined}>
                  <Td className="w-10"><input type="checkbox" aria-label={t("Select {name}", { name: recordName(row, singular) })} className="size-4 accent-accent" checked={selected.has(row.id)} onChange={() => toggle(row.id)} /></Td>
                  {shown.map((c, i) => (
                    <Td key={c.key} mono={c.mono} className={i === 0 ? "font-medium" : "text-fg2"}>
                      {i === 0 && path ? <Link to={`${path}/${row.id}`} className="hover:text-accent">{cell(c, row)}</Link> : cell(c, row)}
                    </Td>
                  ))}
                  <Td className="w-24 whitespace-nowrap text-right">
                    <IconButton label="Edit" icon={PencilSquareIcon} onClick={() => open(row)} />
                    <IconButton label="Delete" icon={TrashIcon} onClick={() => remove(row)} />
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </Section>
    </>
  )
}

/** Fields a value can be set on for many records at once: short ones that are not unique to a record. */
export const bulkFields = (cols: Col[]) => columnChoices(cols.filter((c) => !c.listOnly && !c.required && !c.mono && c.type !== "bool" && c.type !== "number"))

/** One field set to one value on every selected record, or all of them deleted. */
function Bulk({ cols, rows, all, collection, onDone, onClear }: { cols: Col[]; rows: any[]; all: any[]; collection: string; onDone: () => void; onClear: () => void }) {
  const fields = bulkFields(cols)
  const [key, setKey] = useState(fields[0]?.key ?? "")
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  const c = fields.find((f) => f.key === key)
  const each = async (f: (r: any) => Promise<unknown>) => {
    setError("")
    const failed = (await Promise.allSettled(rows.map(f))).filter((r) => r.status === "rejected").length
    if (failed) setError(t("{n} of {total} failed.", { n: failed, total: rows.length }))
    else onDone()
  }
  const apply = (e: React.FormEvent) => { e.preventDefault(); if (c) each((r) => api(`/api/c/${collection}/${r.id}`, { method: "PATCH", body: { [c.key]: fromInput(c, value) } })) }
  const removeAll = async () => (await ask(t("Delete {n} records?", { n: rows.length }), { action: "Delete", danger: true })) && each((r) => api(`/api/c/${collection}/${r.id}`, { method: "DELETE" }))
  const known = [...new Set(all.map((r) => r[key]).filter(Boolean))] as string[]
  return (
    <form onSubmit={apply} aria-label={t("Change the selected records")} className="flex flex-wrap items-end gap-3 rounded-panel border border-accent/40 bg-surface p-3">
      <span className="flex h-9 items-center font-medium max-sm:h-11">{t("{n} selected", { n: rows.length })}</span>
      {c && <>
        <Variable label="Set" value={key} onChange={(k) => { setKey(k); setValue("") }} options={fields.map((f) => ({ value: f.key, label: f.label }))} />
        <div className="w-56 max-sm:w-full">
          {c.type === "select" ? <Select label="To" value={value} onChange={(e) => setValue(e.target.value)} options={[c.choices ? { value: "", label: "None" } : "", ...(c.choices ?? c.options ?? [])]} />
            : <><Input label="To" list={`bulk-${key}`} type={c.type === "date" ? "date" : "text"} value={value} onChange={(e) => setValue(e.target.value)} /><datalist id={`bulk-${key}`}>{known.map((v) => <option key={v} value={v} />)}</datalist></>}
        </div>
        <Button variant="primary" type="submit">{t("Apply")}</Button>
      </>}
      <Button variant="danger" onClick={removeAll}><TrashIcon className="size-5" aria-hidden />{t("Delete")}</Button>
      <Button variant="ghost" onClick={onClear}>{t("Clear selection")}</Button>
      <ErrorNote>{error}</ErrorNote>
    </form>
  )
}

/** One tile per value with its count, as a filter: the shape of the inventory at a glance. */
function Facets({ col, rows, value, onChange }: { col: Col; rows: any[]; value: string; onChange: (v: string) => void }) {
  const count = (v: string) => rows.filter((r) => r[col.key] === v).length
  const values = (col.options ?? [...new Set(rows.map((r) => r[col.key]).filter(Boolean))]).filter((v) => count(v) > 0)
  const tile = (v: string, label: string, n: number, I?: Icon) => (
    <button key={v || "all"} type="button" aria-pressed={value === v} onClick={() => onChange(value === v && v ? "" : v)}
      className={`flex h-16 min-w-32 items-center gap-3 rounded-panel border px-4 text-left ${value === v ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-fg2 hover:border-line2 hover:text-fg"}`}>
      {I && <I className="size-6 shrink-0" aria-hidden />}
      <span className="flex flex-col"><span className="text-[20px] leading-6 font-medium text-fg">{n}</span><span className="text-xs">{t(label)}</span></span>
    </button>
  )
  return (
    <nav aria-label={t("Filter by {what}", { what: t(col.label).toLowerCase() })} className="flex gap-2 overflow-x-auto pb-1">
      {tile("", "All", rows.length)}
      {values.map((v) => tile(v, v, count(v), col.icons?.[v]))}
    </nav>
  )
}

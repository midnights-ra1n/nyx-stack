import { PencilSquareIcon, PlusIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline"
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react"
import { Button, Check, Empty, ErrorNote, type Icon, IconButton, Input, Panel, Select, Table, Td, TextArea, Variable } from "./components"
import { api, fmt, sortRows, useApi, useStored } from "./lib"
import { PageHeader, Section } from "./shell"

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
      <legend className="mb-1 text-[13px] text-fg2">{col.label}</legend>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
        {col.options?.map((o) => {
          const I = col.icons![o]
          return (
            <label key={o} className={`flex h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-box border text-[13px] has-focus-visible:outline-2 has-focus-visible:outline-accent ${value === o ? "border-accent bg-accent-soft text-accent" : "border-line2 bg-raised text-fg2 hover:border-fg3"}`}>
              <input type="radio" className="sr-only" name={col.key} checked={value === o} onChange={() => onChange(o)} />
              <I className="size-5" aria-hidden />{o}
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
    <section ref={ref} aria-label={title} className="mb-6 scroll-mt-4 rounded-panel border border-accent/40 bg-surface" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <header className="flex h-12 items-center justify-between gap-3 border-b border-line pl-5 pr-2">
        <h2 className="text-[15px] font-medium">{title}</h2>
        <IconButton label="Close" icon={XMarkIcon} onClick={onCancel} />
      </header>
      <form onSubmit={onSubmit}>
        <div className="divide-y divide-line">{children}</div>
        <footer className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3">
          <Button variant="primary" type="submit">Save</Button>
          <Button type="button" onClick={onCancel}>Cancel</Button>
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
      <h3 className="text-[13px] font-medium text-fg2">{title}</h3>
      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">{children}</div>
    </div>
  )
}

export function RecordForm({ cols: all, row, collection, onDone, title, defaults, rows = [], onSaved }: { cols: Col[]; row: any | null; collection: string; onDone: () => void; title: string; defaults?: any; rows?: any[]; onSaved?: (rec: any) => void }) {
  const cols = all.filter((c) => !c.listOnly)
  const [form, setForm] = useState<any>(() => Object.fromEntries(cols.map((c) => [c.key, toInput(c, (row ?? defaults)?.[c.key])])))
  const [error, setError] = useState("")
  const set = (k: string, v: any) => setForm({ ...form, [k]: v })
  // Hidden fields are left out of the save, so switching the category back finds them again.
  const visible = cols.filter((c) => !c.when || c.when.in.includes(form[c.when.key]))
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const body = Object.fromEntries(visible.map((c) => [c.key, fromInput(c, form[c.key])]))
    try {
      const rec = await api(row ? `/api/c/${collection}/${row.id}` : `/api/c/${collection}`, { method: row ? "PATCH" : "POST", body })
      onSaved?.(rec)
      onDone()
    } catch (err) { setError((err as Error).message) }
  }
  const field = (c: Col) => {
    const common = { label: c.label, hint: c.hint, required: c.required }
    const onChange = (e: any) => set(c.key, e.target.value)
    const known = c.suggest ? [...new Set(rows.map((r) => r[c.key]).filter(Boolean))] as string[] : []
    const input = () => {
      if (c.icons) return <Tiles col={c} value={form[c.key]} onChange={(v) => set(c.key, v)} />
      if (c.type === "bool") return <Check label={c.label} checked={!!form[c.key]} onChange={(e) => set(c.key, e.target.checked)} />
      if (c.type === "area") return <div className="col-span-full"><TextArea {...common} rows={3} value={form[c.key]} onChange={onChange} /></div>
      if (c.type === "select") return <Select {...common} value={form[c.key]} onChange={onChange} options={["", ...(c.options ?? [])]} />
      return <Input {...common} list={known.length ? `suggest-${c.key}` : undefined} type={c.type === "number" ? "number" : c.type === "date" ? "date" : "text"} value={form[c.key]} onChange={onChange} />
    }
    return (
      <Fragment key={c.key}>
        {input()}
        {known.length > 0 && <datalist id={`suggest-${c.key}`}>{known.map((v) => <option key={v} value={v} />)}</datalist>}
      </Fragment>
    )
  }
  return (
    <Editor title={title} onCancel={onDone} onSubmit={submit} error={error}>
      {groups(visible).map((g, i) => <EditorGroup key={i} title={g.title}>{g.cols.map(field)}</EditorGroup>)}
    </Editor>
  )
}

/** List, add, edit and delete records of one collection. */
export function CrudPage({ title, heading = title, variables, singular, collection, cols, sort = "name", crumbs, extra, onChanged, defaults }: { title: string; heading?: string; variables?: ReactNode; singular: string; collection: string; cols: Col[]; sort?: string; crumbs?: { label: string; to?: string }[]; extra?: ReactNode; onChanged?: () => void; defaults?: any }) {
  const { data, reload, error } = useApi(`/api/c/${collection}?sort=${sort}&perPage=500`, { poll: false })
  const [edit, setEdit] = useState<any | null | undefined>()
  const [order, setOrder] = useStored(`nyx.sort.${collection}`, { key: "", desc: false })
  const [query, setQuery] = useState("")
  const [picked, setPicked] = useState<Record<string, string>>({})
  const shown = cols.filter((c) => !c.formOnly)
  const filters = shown.filter((c) => c.type === "select")
  const all: any[] = data?.items ?? []
  const needle = query.trim().toLowerCase()
  const matching = all.filter((r) => filters.every((c) => !picked[c.key] || r[c.key] === picked[c.key]) && (!needle || cols.some((c) => String(r[c.key] ?? "").toLowerCase().includes(needle))))
  const rows = order.key ? sortRows(matching, (r) => r[order.key], order.desc) : matching
  const sortBy = (key: string) => setOrder({ key, desc: order.key === key && !order.desc })
  const done = () => { setEdit(undefined); reload(); onChanged?.() }
  const remove = async (row: any) => {
    if (!confirm(`Delete ${row.name ?? row.title ?? row.address ?? "this record"}?`)) return
    await api(`/api/c/${collection}/${row.id}`, { method: "DELETE" })
    done()
  }
  return (
    <>
      <PageHeader title={heading} variables={variables} crumbs={crumbs} actions={<Button variant="primary" disabled={edit === null} onClick={() => setEdit(null)}><PlusIcon className="size-5" aria-hidden />Add {singular}</Button>} />
      {edit !== undefined && <RecordForm key={edit?.id ?? "new"} cols={cols} row={edit} collection={collection} onDone={done} title={edit ? `Edit ${edit.name ?? edit.title ?? edit.address ?? singular}` : `Add ${singular}`} defaults={defaults} rows={all} />}
      <Section>
        {extra}
        {all.length > 0 && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64 max-sm:w-full"><Input label="Search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
            {filters.map((c) => <Variable key={c.key} label={c.label} value={picked[c.key] ?? ""} onChange={(v) => setPicked({ ...picked, [c.key]: v })} options={[{ value: "", label: "All" }, ...[...new Set(all.map((r) => r[c.key]).filter(Boolean))].map((v) => ({ value: v, label: v }))]} />)}
            {/* The table turns into a list on phones, without its headers. */}
            <div className="sm:hidden"><Variable label="Sort by" value={order.key} onChange={sortBy} options={[{ value: "", label: "Default" }, ...shown.map((c) => ({ value: c.key, label: c.label }))]} /></div>
          </div>
        )}
        <Panel title={rows.length === all.length ? `${all.length} ${title}` : `${rows.length} of ${all.length} ${title}`} flush>
          <ErrorNote>{error}</ErrorNote>
          {all.length === 0 && data ? <div className="px-4 pb-4"><Empty>Nothing here yet.</Empty></div> : rows.length === 0 && data ? <div className="px-4 pb-4"><Empty>Nothing matches.</Empty></div> : (
            <Table head={[...shown.map((c) => c.label), ""]} sort={order.key ? { col: shown.findIndex((c) => c.key === order.key), desc: order.desc } : undefined} onSort={(i) => sortBy(shown[i].key)}>
              {rows.map((row: any) => (
                <tr key={row.id}>
                  {shown.map((c, i) => (
                    <Td key={c.key} mono={c.mono} className={i === 0 ? "font-medium" : "text-fg2"}>
                      {c.render ? c.render(row) : c.type === "date" ? fmt.date(row[c.key]) : c.type === "bool" ? (row[c.key] ? "Yes" : "No") : row[c.key] || "—"}
                    </Td>
                  ))}
                  <Td className="w-24 whitespace-nowrap text-right">
                    <IconButton label="Edit" icon={PencilSquareIcon} onClick={() => setEdit(row)} />
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

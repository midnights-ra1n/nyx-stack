import { PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline"
import { Fragment, type ReactNode, useState } from "react"
import { Button, Check, Empty, ErrorNote, type Icon, IconButton, Input, Modal, Panel, Select, Table, Td, TextArea, Variable } from "./components"
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

export function RecordForm({ cols: all, row, collection, onDone, title, defaults, rows = [] }: { cols: Col[]; row: any | null; collection: string; onDone: () => void; title: string; defaults?: any; rows?: any[] }) {
  const cols = all.filter((c) => !c.listOnly)
  const [form, setForm] = useState<any>(() => Object.fromEntries(cols.map((c) => [c.key, toInput(c, (row ?? defaults)?.[c.key])])))
  const [error, setError] = useState("")
  const set = (k: string, v: any) => setForm({ ...form, [k]: v })
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const body = Object.fromEntries(cols.map((c) => [c.key, fromInput(c, form[c.key])]))
    try {
      await api(row ? `/api/c/${collection}/${row.id}` : `/api/c/${collection}`, { method: row ? "PATCH" : "POST", body })
      onDone()
    } catch (err) { setError((err as Error).message) }
  }
  return (
    <Modal title={title} onClose={onDone}>
      <form className="grid grid-cols-2 gap-4 max-sm:grid-cols-1" onSubmit={submit}>
        {cols.map((c) => {
          const common = { label: c.label, hint: c.hint, required: c.required }
          const onChange = (e: any) => set(c.key, e.target.value)
          const known = c.suggest ? [...new Set(rows.map((r) => r[c.key]).filter(Boolean))] as string[] : []
          const field = () => {
            if (c.icons) return <Tiles col={c} value={form[c.key]} onChange={(v) => set(c.key, v)} />
            if (c.type === "bool") return <Check label={c.label} checked={!!form[c.key]} onChange={(e) => set(c.key, e.target.checked)} />
            if (c.type === "area") return <div className="col-span-full"><TextArea {...common} rows={3} value={form[c.key]} onChange={onChange} /></div>
            if (c.type === "select") return <Select {...common} value={form[c.key]} onChange={onChange} options={["", ...(c.options ?? [])]} />
            return <Input {...common} list={known.length ? `suggest-${c.key}` : undefined} type={c.type === "number" ? "number" : c.type === "date" ? "date" : "text"} value={form[c.key]} onChange={onChange} />
          }
          return (
            <Fragment key={c.key}>
              {c.section && <h3 className="col-span-full border-b border-line pb-1 text-[13px] font-medium text-fg2">{c.section}</h3>}
              {field()}
              {known.length > 0 && <datalist id={`suggest-${c.key}`}>{known.map((v) => <option key={v} value={v} />)}</datalist>}
            </Fragment>
          )
        })}
        <div className="col-span-full flex flex-col gap-3">
          <ErrorNote>{error}</ErrorNote>
          <div><Button variant="primary" type="submit">Save</Button></div>
        </div>
      </form>
    </Modal>
  )
}

/** List, add, edit and delete records of one collection. */
export function CrudPage({ title, singular, collection, cols, sort = "name", crumbs, extra, onChanged, defaults }: { title: string; singular: string; collection: string; cols: Col[]; sort?: string; crumbs?: { label: string; to?: string }[]; extra?: ReactNode; onChanged?: () => void; defaults?: any }) {
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
      <PageHeader title={title} crumbs={crumbs} actions={<Button variant="primary" onClick={() => setEdit(null)}><PlusIcon className="size-5" aria-hidden />Add {singular}</Button>} />
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
      {edit !== undefined && <RecordForm cols={cols} row={edit} collection={collection} onDone={done} title={edit ? `Edit ${singular}` : `Add ${singular}`} defaults={defaults} rows={all} />}
    </>
  )
}

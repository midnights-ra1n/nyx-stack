import { PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline"
import { type ReactNode, useState } from "react"
import { Button, Check, Empty, ErrorNote, IconButton, Input, Modal, Panel, Select, Table, Td, TextArea } from "./components"
import { api, fmt, useApi } from "./lib"
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
}

const toInput = (c: Col, v: any) => (c.type === "date" ? (v ? String(v).slice(0, 10) : "") : v ?? "")
const fromInput = (c: Col, v: any) => {
  if (c.type === "number") return v === "" || v == null ? 0 : Number(v)
  if (c.type === "date") return v ? `${v} 00:00:00.000Z` : ""
  return v
}

export function RecordForm({ cols: all, row, collection, onDone, title, defaults }: { cols: Col[]; row: any | null; collection: string; onDone: () => void; title: string; defaults?: any }) {
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
          if (c.type === "bool") return <Check key={c.key} label={c.label} checked={!!form[c.key]} onChange={(e) => set(c.key, e.target.checked)} />
          if (c.type === "area") return <div key={c.key} className="col-span-full"><TextArea {...common} value={form[c.key]} onChange={onChange} /></div>
          if (c.type === "select") return <Select key={c.key} {...common} value={form[c.key]} onChange={onChange} options={["", ...(c.options ?? [])]} />
          return <Input key={c.key} {...common} type={c.type === "number" ? "number" : c.type === "date" ? "date" : "text"} value={form[c.key]} onChange={onChange} />
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
export function CrudPage({ title, singular, collection, cols, sort = "name", crumbs, extra, onChanged }: { title: string; singular: string; collection: string; cols: Col[]; sort?: string; crumbs?: { label: string; to?: string }[]; extra?: ReactNode; onChanged?: () => void }) {
  const { data, reload, error } = useApi(`/api/c/${collection}?sort=${sort}&perPage=500`, { poll: false })
  const [edit, setEdit] = useState<any | null | undefined>()
  const shown = cols.filter((c) => !c.formOnly)
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
        <Panel title={`${data?.items.length ?? 0} ${title.toLowerCase()}`} flush>
          <ErrorNote>{error}</ErrorNote>
          {data?.items.length === 0 ? <div className="px-4 pb-4"><Empty>Nothing here yet.</Empty></div> : (
            <Table head={[...shown.map((c) => c.label), ""]}>
              {data?.items.map((row: any) => (
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
      {edit !== undefined && <RecordForm cols={cols} row={edit} collection={collection} onDone={done} title={edit ? `Edit ${singular}` : `Add ${singular}`} />}
    </>
  )
}

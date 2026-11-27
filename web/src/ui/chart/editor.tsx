// The settings of a chart card: its type, the rows it reads and how it looks.
import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useId, type ReactNode } from "react"
import { Button, Check, fieldClass, IconButton, Input, Select } from "../components"
import { t } from "../i18n"
import { useLoad } from "../lib"
import { BUCKETS, evaluate, FNS, OPS, tagsOf, type Cond, type Dataset, type Field, type Measure, type Query, type Row } from "./data"
import { ROWWISE, SINGLE, swatches, type ChartCard, type ChartType, type Look } from "./draw"

export const RANGES = [["1h", "Last hour"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["90d", "Last 90 days"], ["365d", "Last year"]]

/** The rows of a dataset, kept fresh like any page. */
export const useRows = (ds: Dataset | undefined, range: string) =>
  useLoad<Row[]>(ds ? `dataset:${ds.id}:${ds.timed ? range : ""}` : null, () => ds!.load(range))

export const TYPES: { type: ChartType; label: string; group: string }[] = [
  { type: "column", label: "Columns", group: "Columns and bars" },
  { type: "bar", label: "Bars", group: "Columns and bars" },
  { type: "histogram", label: "Histogram", group: "Columns and bars" },
  { type: "waterfall", label: "Waterfall", group: "Columns and bars" },
  { type: "combo", label: "Columns and line", group: "Columns and bars" },
  { type: "line", label: "Lines", group: "Lines and areas" },
  { type: "area", label: "Areas", group: "Lines and areas" },
  { type: "step", label: "Steps", group: "Lines and areas" },
  { type: "scatter", label: "Scatter", group: "Lines and areas" },
  { type: "pie", label: "Pie", group: "Shares" },
  { type: "doughnut", label: "Doughnut", group: "Shares" },
  { type: "half", label: "Half doughnut", group: "Shares" },
  { type: "treemap", label: "Treemap", group: "Shares" },
  { type: "funnel", label: "Funnel", group: "Shares" },
  { type: "radar", label: "Radar", group: "Shares" },
  { type: "number", label: "Number", group: "Cards" },
  { type: "numbers", label: "Numbers", group: "Cards" },
  { type: "gauge", label: "Gauge", group: "Cards" },
  { type: "progress", label: "Progress bars", group: "Cards" },
  { type: "table", label: "Summary table", group: "Tables" },
  { type: "list", label: "List of rows", group: "Tables" },
]

/** Small drawings of each type, in the spirit of a spreadsheet's chart menu. */
export function TypeIcon({ type, className = "size-7" }: { type: ChartType | string; className?: string }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const }
  const f = { fill: "currentColor" }
  const shapes: Record<string, ReactNode> = {
    column: <><rect x="4" y="12" width="4" height="8" {...f} /><rect x="10" y="6" width="4" height="14" {...f} /><rect x="16" y="9" width="4" height="11" {...f} opacity=".6" /></>,
    bar: <><rect x="4" y="4" width="10" height="4" {...f} /><rect x="4" y="10" width="16" height="4" {...f} /><rect x="4" y="16" width="7" height="4" {...f} opacity=".6" /></>,
    histogram: <><rect x="3" y="14" width="3.6" height="6" {...f} opacity=".6" /><rect x="7" y="8" width="3.6" height="12" {...f} /><rect x="11" y="4" width="3.6" height="16" {...f} /><rect x="15" y="10" width="3.6" height="10" {...f} /><rect x="19" y="16" width="2.5" height="4" {...f} opacity=".6" /></>,
    waterfall: <><rect x="3" y="12" width="4" height="8" {...f} /><rect x="8" y="7" width="4" height="5" {...f} opacity=".7" /><rect x="13" y="7" width="4" height="4" {...f} opacity=".45" /><rect x="18" y="11" width="3.5" height="9" {...f} /></>,
    combo: <><rect x="4" y="12" width="4" height="8" {...f} opacity=".6" /><rect x="10" y="9" width="4" height="11" {...f} opacity=".6" /><rect x="16" y="13" width="4" height="7" {...f} opacity=".6" /><path d="M3 10 9 6l6 3 6-5" {...p} /></>,
    line: <path d="M3 17 8 11l4 3 5-8 4 3" {...p} />,
    area: <><path d="M3 20V15l5-6 4 3 5-7 4 3v12Z" {...f} opacity=".35" /><path d="M3 15l5-6 4 3 5-7 4 3" {...p} /></>,
    step: <path d="M3 17h4v-5h5v3h4V7h5" {...p} />,
    scatter: <>{[[6, 16], [9, 11], [12, 14], [14, 8], [17, 10], [19, 5], [8, 7]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="1.7" {...f} />)}</>,
    pie: <><circle cx="12" cy="12" r="8" {...p} /><path d="M12 12V4a8 8 0 0 1 7.4 11Z" {...f} /></>,
    doughnut: <><circle cx="12" cy="12" r="7" {...p} strokeWidth="4" opacity=".4" /><path d="M12 5a7 7 0 0 1 6.6 9.3" {...p} strokeWidth="4" strokeLinecap="butt" /></>,
    half: <><path d="M4 17a8 8 0 0 1 16 0" {...p} strokeWidth="4" strokeLinecap="butt" opacity=".4" /><path d="M4 17a8 8 0 0 1 8-8" {...p} strokeWidth="4" strokeLinecap="butt" /></>,
    treemap: <><rect x="3" y="4" width="10" height="16" rx="1" {...f} /><rect x="14" y="4" width="7" height="9" rx="1" {...f} opacity=".7" /><rect x="14" y="14" width="7" height="6" rx="1" {...f} opacity=".45" /></>,
    funnel: <><rect x="3" y="4" width="18" height="4" rx="1" {...f} /><rect x="6" y="10" width="12" height="4" rx="1" {...f} opacity=".75" /><rect x="9" y="16" width="6" height="4" rx="1" {...f} opacity=".5" /></>,
    radar: <><path d="M12 3 20.5 9.2 17.3 19H6.7L3.5 9.2Z" {...p} opacity=".5" /><path d="M12 7 17 10.5 14.5 16H9L7.5 10.5Z" {...f} opacity=".6" /></>,
    number: <text x="12" y="16.5" textAnchor="middle" fontSize="11" fontWeight="700" fill="currentColor">123</text>,
    numbers: <><rect x="3" y="4" width="8" height="7" rx="1.5" {...p} /><rect x="13" y="4" width="8" height="7" rx="1.5" {...p} /><rect x="3" y="13" width="8" height="7" rx="1.5" {...p} /><rect x="13" y="13" width="8" height="7" rx="1.5" {...p} /></>,
    gauge: <><path d="M4 17a8 8 0 0 1 16 0" {...p} opacity=".4" /><path d="M12 17l4-6" {...p} /></>,
    progress: <><rect x="3" y="5" width="18" height="3" rx="1.5" {...f} opacity=".3" /><rect x="3" y="5" width="13" height="3" rx="1.5" {...f} /><rect x="3" y="11" width="18" height="3" rx="1.5" {...f} opacity=".3" /><rect x="3" y="11" width="7" height="3" rx="1.5" {...f} /><rect x="3" y="17" width="18" height="3" rx="1.5" {...f} opacity=".3" /><rect x="3" y="17" width="16" height="3" rx="1.5" {...f} /></>,
    table: <><rect x="3" y="4" width="18" height="16" rx="1.5" {...p} /><path d="M3 9h18M3 14h18M10 4v16" {...p} /></>,
    list: <><path d="M8 6h13M8 12h13M8 18h13" {...p} /><circle cx="4.5" cy="6" r="1.2" {...f} /><circle cx="4.5" cy="12" r="1.2" {...f} /><circle cx="4.5" cy="18" r="1.2" {...f} /></>,
  }
  return <svg viewBox="0 0 24 24" className={className} aria-hidden>{shapes[type] ?? <rect x="4" y="4" width="16" height="16" rx="3" {...p} />}</svg>
}

/** A type keeps the fields it can use; the rest get values that make sense for it. */
export function retype(c: ChartCard, type: ChartType, ds: Dataset | undefined): ChartCard {
  const q: Query = { ...c.query }
  const fields = ds?.fields ?? []
  const first = (kind: Field["kind"], skip: string[] = []) => fields.find((f) => f.kind === kind && !skip.includes(f.key))?.key
  if (type === "scatter" && (!q.x || !q.y)) { q.x = first("number"); q.y = first("number", [q.x ?? ""]) ?? q.x }
  if (type === "histogram" && fields.find((f) => f.key === q.group)?.kind !== "number") q.group = first("number")
  if (type === "list" && !q.columns?.length) q.columns = [ds?.name ?? fields[0]?.key, ...fields.filter((f) => f.key !== ds?.name).slice(0, 3).map((f) => f.key)].filter((k): k is string => !!k)
  // Lines run over time. A number left by a histogram, each value its own point, draws a line of itself.
  const groupKind = fields.find((f) => f.key === q.group)?.kind
  if (["line", "area", "step"].includes(type) && (!q.group || (groupKind === "number" && !q.bins))) q.group = first("date") ?? q.group
  if (type === "progress" && q.measures.length < 1) q.measures = [{ id: "A", fn: "count" }]
  return { query: q, look: { ...c.look, type } }
}

export function freshChart(ds: Dataset, type: ChartType = "column"): ChartCard {
  const group = ds.fields.find((f) => f.kind === "text" && f.key !== ds.name)?.key
  return retype({ query: { dataset: ds.id, where: [], group, measures: [{ id: "A", fn: "count" }] }, look: { type: "column", legend: "auto", palette: "nyx" } }, type, ds)
}

const fieldOptions = (fields: Field[], kinds?: Field["kind"][], none?: string) => [
  ...(none ? [{ value: "", label: none }] : []),
  ...fields.filter((f) => !kinds || kinds.includes(f.kind)).map((f) => ({ value: f.key, label: f.label })),
]

/** Distinct values seen in a field, offered while typing a filter. */
function valuesSeen(rows: Row[], f?: Field): string[] {
  if (!f || f.kind === "date" || f.kind === "number") return []
  const all = new Set<string>()
  for (const r of rows) for (const v of f.kind === "tags" ? tagsOf(r[f.key]) : [String(r[f.key] ?? "")]) if (v) all.add(v)
  return [...all].sort().slice(0, 200)
}

function Conditions({ value, onChange, fields, rows, add = "Add a filter" }: { value: Cond[]; onChange: (c: Cond[]) => void; fields: Field[]; rows: Row[]; add?: string }) {
  const id = useId()
  const set = (i: number, patch: Partial<Cond>) => onChange(value.map((c, j) => (i === j ? { ...c, ...patch } : c)))
  return (
    <div className="flex flex-col gap-2">
      {value.map((c, i) => {
        const f = fields.find((x) => x.key === c.field)
        const ops = OPS.filter((o) => o.kinds.includes(f?.kind ?? "text"))
        const op = OPS.find((o) => o.value === c.op)
        const seen = valuesSeen(rows, f)
        return (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
            <select aria-label={t("Field")} className={fieldClass} value={c.field} onChange={(e) => { const nf = fields.find((x) => x.key === e.target.value); set(i, { field: e.target.value, op: OPS.find((o) => o.value === c.op)?.kinds.includes(nf?.kind ?? "text") ? c.op : "is", value: "" }) }}>
              {fields.map((x) => <option key={x.key} value={x.key}>{t(x.label)}</option>)}
            </select>
            <select aria-label={t("Condition")} className={fieldClass} value={c.op} onChange={(e) => set(i, { op: e.target.value as Cond["op"] })}>
              {ops.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
            </select>
            {op?.noValue ? <span /> : f?.kind === "bool" ? (
              <select aria-label={t("Value")} className={fieldClass} value={c.value ?? ""} onChange={(e) => set(i, { value: e.target.value })}>
                <option value="">—</option><option value="true">{t("Yes")}</option><option value="false">{t("No")}</option>
              </select>
            ) : (
              <>
                <input aria-label={t("Value")} className={fieldClass} list={`${id}-${i}`} value={c.value ?? ""} placeholder={c.op === "last" || c.op === "next" ? t("Days") : f?.kind === "date" ? t("2026-01-31 or today") : ""} inputMode={c.op === "last" || c.op === "next" || f?.kind === "number" ? "decimal" : undefined} onChange={(e) => set(i, { value: e.target.value })} />
                {seen.length > 0 && <datalist id={`${id}-${i}`}>{seen.map((v) => <option key={v} value={v} />)}</datalist>}
              </>
            )}
            <IconButton label="Remove" icon={TrashIcon} onClick={() => onChange(value.filter((_, j) => j !== i))} />
          </div>
        )
      })}
      <div><Button type="button" onClick={() => onChange([...value, { field: fields[0]?.key ?? "", op: "is", value: "" }])}><PlusIcon className="size-4" aria-hidden />{t(add)}</Button></div>
      {value.length > 0 && <p className="text-xs text-fg3">{t("All conditions must hold. Separate several values with commas.")}</p>}
    </div>
  )
}

const nextLetter = (ms: Measure[]) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").find((l) => !ms.some((m) => m.id === l)) ?? "Z"

function Measures({ q, set, fields, rows, combo }: { q: Query; set: (q: Partial<Query>) => void; fields: Field[]; rows: Row[]; combo: boolean }) {
  const put = (i: number, patch: Partial<Measure>) => set({ measures: q.measures.map((m, j) => (i === j ? { ...m, ...patch } : m)) })
  const numeric = fields.filter((f) => f.kind === "number")
  return (
    <div className="flex flex-col gap-3">
      {q.measures.map((m, i) => {
        const fn = FNS.find((x) => x.value === m.fn)
        let formulaError = ""
        if (m.formula) {
          // Only to find mistakes: each letter stands for 1 here.
          try { evaluate(m.formula, Object.fromEntries(q.measures.slice(0, i).map((x) => [x.id, 1]))) } catch (e) { formulaError = (e as Error).message }
        }
        return (
          <fieldset key={m.id} className="rounded-box border border-line p-3">
            <legend className="flex items-center gap-2 px-1 text-[13px]"><span className="flex size-5 items-center justify-center rounded bg-accent-soft font-medium text-accent">{m.id}</span>{m.formula ? t("Formula") : t("Measure")}</legend>
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              {m.formula !== undefined ? (
                <div className="col-span-full"><Input label="Formula" value={m.formula} onChange={(e) => put(i, { formula: e.target.value })} placeholder="A / B * 100" hint={formulaError || "Letters stand for the measures above. + - * / % ^, parentheses, round(x, 2), abs, min, max, sqrt, floor, ceil."} /></div>
              ) : (
                <>
                  <Select label="Function" value={m.fn} onChange={(e) => put(i, { fn: e.target.value as Measure["fn"], field: FNS.find((x) => x.value === e.target.value)?.numeric ? m.field ?? numeric[0]?.key : m.fn === "distinct" ? m.field : undefined })} options={FNS.filter((x) => !x.numeric || numeric.length).map((x) => ({ value: x.value, label: x.label }))} />
                  {(fn?.numeric || m.fn === "distinct") && <Select label="Of" value={m.field ?? ""} onChange={(e) => put(i, { field: e.target.value })} options={fieldOptions(fn?.numeric ? numeric : fields)} />}
                </>
              )}
              <Input label="Name" value={m.label ?? ""} onChange={(e) => put(i, { label: e.target.value })} placeholder={t("Automatic")} />
              {combo && <Select label="Drawn as" value={m.as ?? (i ? "line" : "column")} onChange={(e) => put(i, { as: e.target.value as Measure["as"] })} options={[{ value: "column", label: "Columns" }, { value: "line", label: "Line" }]} />}
              <label className="flex flex-col gap-1 text-[13px] text-fg2">{t("Colour")}
                <span className="flex items-center gap-2"><input type="color" className="h-9 w-12 cursor-pointer rounded-control border border-line2 bg-raised" value={m.color?.startsWith("#") ? m.color : "#e38b4f"} onChange={(e) => put(i, { color: e.target.value })} />{m.color && <Button type="button" variant="ghost" onClick={() => put(i, { color: undefined })}>{t("Automatic")}</Button>}</span>
              </label>
            </div>
            {m.formula === undefined && (
              <details className="mt-3" open={!!m.where?.length}>
                <summary className="cursor-pointer text-[13px] text-fg2">{t("Only count rows where…")}{m.where?.length ? ` (${m.where.length})` : ""}</summary>
                <div className="mt-2"><Conditions value={m.where ?? []} onChange={(where) => put(i, { where })} fields={fields} rows={rows} add="Add a condition" /></div>
              </details>
            )}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <Check label="Only used by formulas" checked={!!m.hidden} onChange={(e) => put(i, { hidden: e.target.checked })} />
              {q.measures.length > 1 && <Button type="button" variant="ghost" onClick={() => set({ measures: q.measures.filter((_, j) => j !== i) })}><TrashIcon className="size-4" aria-hidden />{t("Remove")}</Button>}
            </div>
          </fieldset>
        )
      })}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => set({ measures: [...q.measures, { id: nextLetter(q.measures), fn: "count" }] })}><PlusIcon className="size-4" aria-hidden />{t("Add a measure")}</Button>
        {q.measures.length > 0 && <Button type="button" onClick={() => set({ measures: [...q.measures, { id: nextLetter(q.measures), fn: "count", formula: q.measures.length > 1 ? `${q.measures[0].id} / ${q.measures[1].id} * 100` : `${q.measures[0].id} * 1` }] })}><PlusIcon className="size-4" aria-hidden />{t("Add a formula")}</Button>}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-[13px] font-medium text-fg2">{t(title)}</h3>
      {children}
    </section>
  )
}

/** What the chart reads: the source, filters, groups and measures. */
export function DataForm({ card, onChange, datasets, rows, pageRange }: { card: ChartCard; onChange: (c: ChartCard) => void; datasets: Dataset[]; rows: Row[]; pageRange?: boolean }) {
  const q = card.query, type = card.look.type
  const ds = datasets.find((d) => d.id === q.dataset)
  const fields = ds?.fields ?? []
  const set = (patch: Partial<Query>) => onChange({ ...card, query: { ...q, ...patch } })
  const group = fields.find((f) => f.key === q.group)
  const rowwise = ROWWISE.includes(type)
  const single = SINGLE.includes(type)
  const noSplit = single || ["pie", "doughnut", "half", "treemap", "funnel", "numbers", "waterfall", "progress"].includes(type)
  return (
    <div className="flex flex-col gap-4">
      <Section title="Source">
        <Select label="Rows from" value={q.dataset} onChange={(e) => { const next = datasets.find((d) => d.id === e.target.value); if (next) onChange(retype({ ...freshChart(next), look: card.look }, type, next)) }} options={datasets.map((d) => ({ value: d.id, label: d.label }))} hint={ds?.hint} />
        {ds?.timed && <Select label="Period" value={q.range ?? (pageRange ? "" : "24h")} onChange={(e) => set({ range: e.target.value })} options={[...(pageRange ? [{ value: "", label: "The page's period" }] : []), ...RANGES.map(([value, label]) => ({ value, label }))]} />}
      </Section>
      <Section title="Filters">
        <Conditions value={q.where ?? []} onChange={(where) => set({ where })} fields={fields} rows={rows} />
      </Section>
      {type === "scatter" && (
        <Section title="Axes">
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <Select label="Across (X)" value={q.x ?? ""} onChange={(e) => set({ x: e.target.value })} options={fieldOptions(fields, ["number", "date"])} />
            <Select label="Up (Y)" value={q.y ?? ""} onChange={(e) => set({ y: e.target.value })} options={fieldOptions(fields, ["number"])} />
            <Select label="Point size" value={q.size ?? ""} onChange={(e) => set({ size: e.target.value || undefined })} options={fieldOptions(fields, ["number"], "Same size")} />
            <Select label="Colour by" value={q.split ?? ""} onChange={(e) => set({ split: e.target.value || undefined })} options={fieldOptions(fields, ["text", "bool", "tags"], "One colour")} />
          </div>
        </Section>
      )}
      {type === "list" && (
        <Section title="Columns">
          <fieldset className="grid max-h-52 grid-cols-2 overflow-auto rounded-control border border-line p-2 max-sm:grid-cols-1">
            <legend className="sr-only">{t("Columns")}</legend>
            {fields.map((f) => <Check key={f.key} label={t(f.label)} checked={!!q.columns?.includes(f.key)} onChange={(e) => set({ columns: e.target.checked ? [...(q.columns ?? []), f.key] : (q.columns ?? []).filter((k) => k !== f.key) })} />)}
          </fieldset>
          <div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
            <Select label="Sorted by" value={q.order ?? ""} onChange={(e) => set({ order: e.target.value || undefined })} options={fieldOptions(fields, undefined, "As they come")} />
            <Select label="Order" value={q.desc ? "desc" : "asc"} onChange={(e) => set({ desc: e.target.value === "desc" })} options={[{ value: "asc", label: "Smallest first" }, { value: "desc", label: "Largest first" }]} />
            <Input label="Rows" type="number" min={1} max={500} value={q.limit ?? 10} onChange={(e) => set({ limit: Number(e.target.value) || 10 })} />
          </div>
        </Section>
      )}
      {!rowwise && (
        <Section title="Categories">
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            {(!single || type === "number") && (
              <Select label={type === "number" ? "Trend over" : "Group by"} value={q.group ?? ""} onChange={(e) => set({ group: e.target.value || undefined, bucket: undefined, bins: undefined })}
                options={fieldOptions(fields, type === "number" ? ["date"] : type === "histogram" ? ["number"] : undefined, type === "histogram" ? undefined : type === "number" ? "No trend" : "Nothing: one total")} />
            )}
            {group?.kind === "date" && <Select label="By" value={q.bucket ?? "auto"} onChange={(e) => set({ bucket: e.target.value as Query["bucket"] })} options={BUCKETS} />}
            {group?.kind === "number" && (type === "histogram" || q.bins) ? <Input label="Ranges" type="number" min={2} max={50} value={q.bins ?? 10} onChange={(e) => set({ bins: Math.max(2, Math.min(50, Number(e.target.value) || 10)) })} /> : null}
            {group?.kind === "number" && type !== "histogram" && <Check label="Make ranges of it" checked={!!q.bins} onChange={(e) => set({ bins: e.target.checked ? 10 : undefined })} />}
            {!noSplit && <Select label="One series per" value={q.split ?? ""} onChange={(e) => set({ split: e.target.value || undefined })} options={fieldOptions(fields, ["text", "bool", "tags"], "Nothing")} />}
          </div>
        </Section>
      )}
      {!rowwise && (
        <Section title="Measures">
          {type === "progress" && <p className="text-xs text-fg3">{t("Measure B, when there is one, is the maximum of each bar, such as the size of a subnet.")}</p>}
          {type === "gauge" && <p className="text-xs text-fg3">{t("Measure B, when there is one, is the maximum of the gauge. Otherwise set it under Look.")}</p>}
          <Measures q={q} set={set} fields={fields} rows={rows} combo={type === "combo"} />
        </Section>
      )}
      {!rowwise && !single && (
        <Section title="Order">
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <Select label="Sort" value={q.sort ?? "auto"} onChange={(e) => set({ sort: e.target.value as Query["sort"] })} options={[{ value: "auto", label: "Automatic" }, { value: "desc", label: "Largest first" }, { value: "asc", label: "Smallest first" }, { value: "label", label: "By name" }]} />
            <Select label="Show as" value={q.showAs ?? "value"} onChange={(e) => set({ showAs: e.target.value as Query["showAs"] })} options={[{ value: "value", label: "Values" }, { value: "share", label: "Share of the total" }, { value: "cumulative", label: "Running total" }, { value: "change", label: "Change from the previous" }]} />
            <Input label="Keep the first" type="number" min={0} max={500} value={q.limit ?? ""} placeholder={t("All")} onChange={(e) => set({ limit: Number(e.target.value) || undefined })} />
            {!!q.limit && <Check label="Gather the rest as Other" checked={!!q.other} onChange={(e) => set({ other: e.target.checked })} />}
          </div>
        </Section>
      )}
    </div>
  )
}

const num = (v: string) => (v.trim() === "" || Number.isNaN(Number(v)) ? undefined : Number(v))

/** How the chart looks: stacking, legend, labels, colours, number format, axes and thresholds. */
export function LookForm({ card, onChange }: { card: ChartCard; onChange: (c: ChartCard) => void }) {
  const l = card.look, type = l.type
  const set = (patch: Partial<Look>) => onChange({ ...card, look: { ...l, ...patch } })
  const cartesian = ["column", "bar", "line", "area", "step", "combo", "histogram", "waterfall"].includes(type)
  const lines = ["line", "area", "step", "combo"].includes(type)
  const sized = cartesian || ["pie", "doughnut", "half", "treemap", "radar", "scatter"].includes(type)
  const thresholds = ["number", "numbers", "gauge", "progress", "table", "column", "bar"].includes(type)
  return (
    <div className="flex flex-col gap-4">
      <Section title="Layout">
        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          {["column", "bar", "area"].includes(type) && <Select label="Stacking" value={l.stack ?? "none"} onChange={(e) => set({ stack: e.target.value as Look["stack"] })} options={[{ value: "none", label: "Side by side" }, { value: "stacked", label: "Stacked" }, { value: "percent", label: "Stacked to 100 %" }]} />}
          {type !== "number" && type !== "gauge" && type !== "list" && type !== "table" && <Select label="Legend" value={l.legend ?? "auto"} onChange={(e) => set({ legend: e.target.value as Look["legend"] })} options={[{ value: "auto", label: "Automatic" }, { value: "bottom", label: "Below" }, { value: "right", label: "On the right" }, { value: "none", label: "Hidden" }]} />}
          {(cartesian || ["pie", "doughnut", "half", "treemap"].includes(type)) && <Select label="Labels" value={l.labels ?? (["pie"].includes(type) ? "share" : "none")} onChange={(e) => set({ labels: e.target.value as Look["labels"] })} options={[{ value: "none", label: "None" }, { value: "value", label: "Values" }, { value: "share", label: "Shares" }]} />}
          {sized && <Select label="Height" value={l.height ?? "m"} onChange={(e) => set({ height: e.target.value as Look["height"] })} options={[{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }]} />}
          {lines && <Check label="Smooth curves" checked={!!l.smooth} onChange={(e) => set({ smooth: e.target.checked })} />}
          {lines && <Check label="Show points" checked={!!l.markers} onChange={(e) => set({ markers: e.target.checked })} />}
          {(cartesian || type === "scatter") && <Check label="Grid lines" checked={l.grid !== false} onChange={(e) => set({ grid: e.target.checked })} />}
        </div>
      </Section>
      {type !== "list" && (
        <Section title="Colours">
          <div className="grid grid-cols-5 gap-2 max-sm:grid-cols-3" role="radiogroup" aria-label={t("Colours")}>
            {(["nyx", "status", "warm", "cool", "mono"] as const).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={(l.palette ?? "nyx") === p} onClick={() => set({ palette: p })} className={`flex flex-col items-center gap-1.5 rounded-box border px-2 py-2 text-xs ${(l.palette ?? "nyx") === p ? "border-accent bg-accent-soft text-accent" : "border-line2 text-fg2 hover:border-fg3"}`}>
                <span className="flex gap-0.5">{swatches(p).map((c) => <span key={c} className="size-3 rounded-sm" style={{ background: c }} />)}</span>
                {t({ nyx: "Nyx", status: "By state", warm: "Warm", cool: "Cool", mono: "One colour" }[p])}
              </button>
            ))}
          </div>
          {l.palette === "status" && <p className="text-xs text-fg3">{t("Words such as running, failed or in service take the colour of their state.")}</p>}
        </Section>
      )}
      <Section title="Numbers">
        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          <Select label="Format" value={l.format ?? "auto"} onChange={(e) => set({ format: e.target.value as Look["format"] })} options={[{ value: "auto", label: "From the field" }, { value: "number", label: "Number" }, { value: "compact", label: "Short (1.2k)" }, { value: "pct", label: "Percentage" }, { value: "bytes", label: "Bytes" }, { value: "bps", label: "Bytes per second" }, { value: "temp", label: "Temperature" }, { value: "duration", label: "Duration in seconds" }]} />
          <Input label="Decimals" type="number" min={0} max={6} value={l.decimals ?? ""} placeholder={t("Automatic")} onChange={(e) => set({ decimals: num(e.target.value) })} />
          <Input label="Before the number" value={l.prefix ?? ""} placeholder="$" onChange={(e) => set({ prefix: e.target.value || undefined })} />
          <Input label="After the number" value={l.suffix ?? ""} placeholder=" €" onChange={(e) => set({ suffix: e.target.value || undefined })} />
        </div>
      </Section>
      {(cartesian || ["scatter", "radar", "gauge", "progress"].includes(type)) && (
        <Section title="Scale">
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            {(cartesian || type === "scatter") && <Input label="Minimum" type="number" value={l.min ?? ""} placeholder={t("Automatic")} onChange={(e) => set({ min: num(e.target.value) })} />}
            <Input label="Maximum" type="number" value={l.max ?? ""} placeholder={t("Automatic")} onChange={(e) => set({ max: num(e.target.value) })} />
          </div>
          {cartesian && type !== "waterfall" && (
            <div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
              <Select label="Reference line" value={l.ref ?? "none"} onChange={(e) => set({ ref: e.target.value as Look["ref"] })} options={[{ value: "none", label: "None" }, { value: "avg", label: "Average" }, { value: "value", label: "A value" }]} />
              {l.ref === "value" && <Input label="At" type="number" value={l.refValue ?? ""} onChange={(e) => set({ refValue: num(e.target.value) })} />}
              {l.ref && l.ref !== "none" && <Input label="Its label" value={l.refLabel ?? ""} placeholder={t("Target")} onChange={(e) => set({ refLabel: e.target.value || undefined })} />}
            </div>
          )}
        </Section>
      )}
      {thresholds && (
        <Section title="Thresholds">
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <Input label="Warning from" type="number" value={l.warn ?? ""} onChange={(e) => set({ warn: num(e.target.value) })} />
            <Input label="Critical from" type="number" value={l.crit ?? ""} onChange={(e) => set({ crit: num(e.target.value) })} />
          </div>
          <Check label="Lower is worse" hint="For what should stay high, such as the life left of a disk." checked={!!l.lowBad} onChange={(e) => set({ lowBad: e.target.checked })} />
          <p className="text-xs text-fg3">{t(type === "gauge" || type === "progress" ? "In percent of the maximum." : "On the value shown. Columns and bars use them with a single series.")}</p>
        </Section>
      )}
    </div>
  )
}

/** Types in groups, as a spreadsheet's chart menu shows them. */
export function TypePicker({ value, onChange, extra }: { value: string; onChange: (type: string) => void; extra?: { type: string; label: string; icon: ReactNode }[] }) {
  const groups = [...new Set(TYPES.map((x) => x.group))]
  const tile = (type: string, label: string, icon: ReactNode) => (
    <label key={type} className={`flex h-[74px] cursor-pointer flex-col items-center justify-center gap-1 rounded-box border px-1 text-center text-xs leading-tight has-focus-visible:outline-2 has-focus-visible:outline-accent ${value === type ? "border-accent bg-accent-soft text-accent" : "border-line2 bg-raised text-fg2 hover:border-fg3 hover:text-fg"}`}>
      <input type="radio" className="sr-only" name="card-type" checked={value === type} onChange={() => onChange(type)} />
      {icon}{t(label)}
    </label>
  )
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <fieldset key={g}>
          <legend className="mb-2 text-[13px] font-medium text-fg2">{t(g)}</legend>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2">{TYPES.filter((x) => x.group === g).map((x) => tile(x.type, x.label, <TypeIcon type={x.type} />))}</div>
        </fieldset>
      ))}
      {extra && extra.length > 0 && (
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium text-fg2">{t("Other cards")}</legend>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2">{extra.map((x) => tile(x.type, x.label, x.icon))}</div>
        </fieldset>
      )}
    </div>
  )
}

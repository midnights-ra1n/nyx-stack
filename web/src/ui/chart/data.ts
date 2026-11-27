// What a chart computes from rows, apart from how it is drawn: filters, groups, series,
// the functions of each measure and the formulas between them. Pure, so it is tested.
import { lang, t } from "../i18n"
import { fmt } from "../lib"

export type Row = Record<string, unknown>
export type FieldKind = "text" | "number" | "date" | "bool" | "tags"
export type Format = "auto" | "number" | "compact" | "bytes" | "bps" | "pct" | "temp" | "duration"
export interface Field { key: string; label: string; kind: FieldKind; format?: Format }

/** Rows a dashboard can chart, as each app offers them. */
export interface Dataset {
  id: string
  label: string
  hint?: string
  fields: Field[]
  load: (range: string) => Promise<Row[]>
  /** The rows cover a time range, picked on the card or the page. */
  timed?: boolean
  /** The field that names a row: points and lists show it. */
  name?: string
  /** The page a row opens. */
  link?: (r: Row) => string | undefined
}

export type Op = "is" | "not" | "has" | "lacks" | "gt" | "gte" | "lt" | "lte" | "empty" | "set" | "last" | "next" | "past" | "future"
export interface Cond { field: string; op: Op; value?: string }
export type Fn = "count" | "distinct" | "sum" | "avg" | "min" | "max" | "median" | "last"
export interface Measure {
  /** A letter, which formulas use. */
  id: string
  fn: Fn
  field?: string
  label?: string
  /** Rows this measure counts, on top of the chart's filters: Excel's COUNTIF and SUMIF. */
  where?: Cond[]
  /** Computed from the other measures, such as `A / B * 100`. */
  formula?: string
  as?: "column" | "line"
  color?: string
  /** Only feeds formulas. */
  hidden?: boolean
}
export type Bucket = "auto" | "minute" | "5min" | "15min" | "hour" | "day" | "week" | "month" | "quarter" | "year" | "weekday" | "monthOfYear"
export interface Query {
  dataset: string
  /** Empty: the page's range. */
  range?: string
  where?: Cond[]
  group?: string
  bucket?: Bucket
  /** Turns a number into this many ranges: a histogram. */
  bins?: number
  split?: string
  measures: Measure[]
  sort?: "auto" | "label" | "desc" | "asc"
  limit?: number
  other?: boolean
  showAs?: "value" | "share" | "cumulative" | "change"
  x?: string
  y?: string
  size?: string
  columns?: string[]
  order?: string
  desc?: boolean
}

export interface Series { key: string; name: string; values: (number | null)[]; measure: Measure; split?: string }
export interface Result { cats: string[]; labels: string[]; series: Series[]; dated: boolean }
export interface Point { x: number; y: number; size: number | null; name: string; split: string }

export const FNS: { value: Fn; label: string; numeric: boolean }[] = [
  { value: "count", label: "Count", numeric: false },
  { value: "distinct", label: "Count distinct", numeric: false },
  { value: "sum", label: "Sum", numeric: true },
  { value: "avg", label: "Average", numeric: true },
  { value: "min", label: "Minimum", numeric: true },
  { value: "max", label: "Maximum", numeric: true },
  { value: "median", label: "Median", numeric: true },
  { value: "last", label: "Last value", numeric: true },
]

export const OPS: { value: Op; label: string; kinds: FieldKind[]; noValue?: boolean }[] = [
  { value: "is", label: "is", kinds: ["text", "tags", "bool", "number"] },
  { value: "not", label: "is not", kinds: ["text", "tags", "bool", "number"] },
  { value: "has", label: "contains", kinds: ["text", "tags"] },
  { value: "lacks", label: "does not contain", kinds: ["text", "tags"] },
  { value: "gt", label: ">", kinds: ["number", "date"] },
  { value: "gte", label: "≥", kinds: ["number", "date"] },
  { value: "lt", label: "<", kinds: ["number", "date"] },
  { value: "lte", label: "≤", kinds: ["number", "date"] },
  { value: "last", label: "in the last … days", kinds: ["date"] },
  { value: "next", label: "in the next … days", kinds: ["date"] },
  { value: "past", label: "is past", kinds: ["date"], noValue: true },
  { value: "future", label: "is to come", kinds: ["date"], noValue: true },
  { value: "empty", label: "is empty", kinds: ["text", "tags", "number", "date"], noValue: true },
  { value: "set", label: "is set", kinds: ["text", "tags", "number", "date"], noValue: true },
]

export const BUCKETS: { value: Bucket; label: string }[] = [
  { value: "auto", label: "Automatic" }, { value: "minute", label: "Minute" }, { value: "5min", label: "5 minutes" },
  { value: "15min", label: "15 minutes" }, { value: "hour", label: "Hour" }, { value: "day", label: "Day" },
  { value: "week", label: "Week" }, { value: "month", label: "Month" }, { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" }, { value: "weekday", label: "Day of the week" }, { value: "monthOfYear", label: "Month of the year" },
]

const isEmpty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && !v.length)

/** Milliseconds from a PocketBase date, an ISO date or Unix seconds. */
export function dateOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : null
  if (typeof v !== "string" || !v.trim()) return null
  const ms = Date.parse(/^\d{4}-\d\d-\d\d \d/.test(v) ? v.replace(" ", "T") : v)
  return Number.isNaN(ms) ? null : ms
}

export function numOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "boolean") return v ? 1 : 0
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v.replace(",", ".")); return Number.isFinite(n) ? n : null }
  return null
}

export const tagsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []

const textOf = (v: unknown) => (v == null ? "" : typeof v === "boolean" ? String(v) : String(v))
const kindOf = (fields: Field[], key?: string): FieldKind => fields.find((f) => f.key === key)?.kind ?? "text"

/** Several values are separated by commas: `status is In service, Spare`. */
const wanted = (value = "") => value.split(",").map((s) => s.trim().toLowerCase()).filter((s, i, all) => s || all.length === 1)

export function matches(r: Row, c: Cond, fields: Field[], now = Date.now()): boolean {
  const v = r[c.field], kind = kindOf(fields, c.field), want = (c.value ?? "").trim()
  if (c.op === "empty") return isEmpty(v)
  if (c.op === "set") return !isEmpty(v)
  if (kind === "date" && ["gt", "gte", "lt", "lte", "last", "next", "past", "future"].includes(c.op)) {
    const d = dateOf(v)
    if (d == null) return false
    const days = (Number(want) || 0) * 86400000
    if (c.op === "last") return d >= now - days && d <= now
    if (c.op === "next") return d >= now && d <= now + days
    if (c.op === "past") return d < now
    if (c.op === "future") return d >= now
    const w = want.toLowerCase() === "today" ? new Date(now).setHours(0, 0, 0, 0) : dateOf(want)
    return w != null && compare(d, w, c.op)
  }
  if (c.op === "gt" || c.op === "gte" || c.op === "lt" || c.op === "lte") {
    const a = numOf(v), b = numOf(want)
    return a != null && b != null && compare(a, b, c.op)
  }
  const texts = (kind === "tags" ? tagsOf(v) : [textOf(v)]).map((s) => s.toLowerCase())
  const ws = wanted(want)
  if (c.op === "is") return texts.some((s) => ws.includes(s))
  if (c.op === "not") return !texts.some((s) => ws.includes(s))
  if (c.op === "has") return texts.some((s) => ws.some((w) => s.includes(w)))
  if (c.op === "lacks") return !texts.some((s) => ws.some((w) => s.includes(w)))
  return true
}

function compare(a: number, b: number, op: Op) {
  return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b
}

export function aggregate(fn: Fn, rows: Row[], field?: string): number | null {
  if (fn === "count") return rows.length
  if (fn === "distinct") return new Set(rows.map((r) => textOf(field ? r[field] : r.id)).filter(Boolean)).size
  const nums = rows.map((r) => numOf(field ? r[field] : null)).filter((n): n is number => n != null)
  if (fn === "sum") return nums.reduce((a, b) => a + b, 0)
  if (!nums.length) return null
  if (fn === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length
  if (fn === "min") return Math.min(...nums)
  if (fn === "max") return Math.max(...nums)
  if (fn === "last") return nums[nums.length - 1]
  const s = [...nums].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Formulas: + - * / % ^, parentheses, measure letters and a few functions.
const FUNCS: Record<string, (...a: number[]) => number> = {
  round: (x, n = 0) => Math.round(x * 10 ** n) / 10 ** n, abs: Math.abs, sqrt: Math.sqrt,
  floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max,
}

/** The value of `expr`, `null` when a measure it uses has none. Throws on a mistake in `expr`. */
export function evaluate(expr: string, vars: Record<string, number | null>): number | null {
  const tokens = expr.match(/\d+(?:\.\d+)?|[A-Za-z_]\w*|[-+*/%^(),]|\S/g) ?? []
  let i = 0
  const peek = () => tokens[i]
  const eat = (want?: string) => {
    const tok = tokens[i++]
    if (want && tok !== want) throw new Error(t("Expected {want} in the formula", { want }))
    if (tok === undefined) throw new Error(t("The formula ends too early"))
    return tok
  }
  const nul = (f: (...a: number[]) => number) => (...a: (number | null)[]) => (a.some((x) => x == null) ? null : f(...(a as number[])))
  const expr0 = (): number | null => {
    let v = term()
    while (peek() === "+" || peek() === "-") { const op = eat(); const r = term(); v = nul((a, b) => (op === "+" ? a + b : a - b))(v, r) }
    return v
  }
  const term = (): number | null => {
    let v = power()
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = eat(); const r = power()
      v = v == null || r == null ? null : op === "*" ? v * r : r === 0 ? null : op === "/" ? v / r : v % r
    }
    return v
  }
  const power = (): number | null => { const b = unary(); if (peek() !== "^") return b; eat(); return nul(Math.pow)(b, power()) }
  const unary = (): number | null => { if (peek() === "-") { eat(); const v = unary(); return v == null ? null : -v } return primary() }
  const primary = (): number | null => {
    const tok = eat()
    if (tok === "(") { const v = expr0(); eat(")"); return v }
    if (/^\d/.test(tok)) return Number(tok)
    if (/^[A-Za-z_]/.test(tok)) {
      const name = tok.toLowerCase()
      if (peek() === "(" && FUNCS[name]) {
        eat("(")
        const args: (number | null)[] = []
        if (peek() !== ")") { args.push(expr0()); while (peek() === ",") { eat(); args.push(expr0()) } }
        eat(")")
        return nul(FUNCS[name])(...args)
      }
      if (!(tok.toUpperCase() in vars)) throw new Error(t("Unknown measure {name}", { name: tok }))
      return vars[tok.toUpperCase()]
    }
    throw new Error(t("Unexpected {tok} in the formula", { tok }))
  }
  if (!tokens.length) throw new Error(t("The formula is empty"))
  const v = expr0()
  if (i < tokens.length) throw new Error(t("Unexpected {tok} in the formula", { tok: tokens[i] }))
  return v != null && Number.isFinite(v) ? v : null
}

// Time buckets. Keys sort in time order; their start makes labels and fills gaps.
const pad = (n: number) => String(n).padStart(2, "0")
const STEP: [Bucket, number][] = [["minute", 6e4], ["5min", 3e5], ["15min", 9e5], ["hour", 36e5], ["day", 864e5], ["week", 6048e5], ["month", 2.6e9], ["quarter", 7.9e9], ["year", 3.2e10]]

/** The finest bucket that keeps a span under about 120 points. */
export const autoBucket = (span: number): Bucket => STEP.find(([, ms]) => span / ms <= 120)?.[0] ?? "year"

export function bucketKey(ms: number, b: Bucket): string {
  const d = new Date(ms)
  const Y = d.getFullYear(), M = d.getMonth() + 1, D = d.getDate(), h = d.getHours(), m = d.getMinutes()
  const day = `${Y}-${pad(M)}-${pad(D)}`
  switch (b) {
    case "minute": return `${day} ${pad(h)}:${pad(m)}`
    case "5min": return `${day} ${pad(h)}:${pad(m - (m % 5))}`
    case "15min": return `${day} ${pad(h)}:${pad(m - (m % 15))}`
    case "hour": return `${day} ${pad(h)}:00`
    case "week": { const w = new Date(Y, M - 1, D - ((d.getDay() + 6) % 7)); return `${w.getFullYear()}-${pad(w.getMonth() + 1)}-${pad(w.getDate())}` }
    case "month": return `${Y}-${pad(M)}`
    case "quarter": return `${Y}-Q${Math.floor((M - 1) / 3) + 1}`
    case "year": return `${Y}`
    case "weekday": return String((d.getDay() + 6) % 7)
    case "monthOfYear": return pad(M)
    default: return day
  }
}

function bucketStart(key: string, b: Bucket): Date {
  if (b === "quarter") { const [y, q] = key.split("-Q"); return new Date(Number(y), (Number(q) - 1) * 3, 1) }
  const [y, mo = "1", rest = "1"] = key.split("-")
  const [dd, hm = "00:00"] = rest.split(" ")
  const [h, m] = hm.split(":")
  return new Date(Number(y), Number(mo) - 1, Number(dd), Number(h), Number(m))
}

function nextBucket(d: Date, b: Bucket): Date {
  const n = new Date(d)
  if (b === "minute") n.setMinutes(n.getMinutes() + 1)
  else if (b === "5min") n.setMinutes(n.getMinutes() + 5)
  else if (b === "15min") n.setMinutes(n.getMinutes() + 15)
  else if (b === "hour") n.setHours(n.getHours() + 1)
  else if (b === "day") n.setDate(n.getDate() + 1)
  else if (b === "week") n.setDate(n.getDate() + 7)
  else if (b === "month") n.setMonth(n.getMonth() + 1)
  else if (b === "quarter") n.setMonth(n.getMonth() + 3)
  else n.setFullYear(n.getFullYear() + 1)
  return n
}

/** Every bucket from the first key to the last, so that a line does not skip quiet periods. */
export function fillBuckets(keys: string[], b: Bucket, max = 1000): string[] {
  if (b === "weekday") return ["0", "1", "2", "3", "4", "5", "6"]
  if (b === "monthOfYear") return Array.from({ length: 12 }, (_, i) => pad(i + 1))
  if (keys.length < 2) return keys
  const out: string[] = []
  const last = keys[keys.length - 1]
  for (let d = bucketStart(keys[0], b); out.length < max; d = nextBucket(d, b)) {
    const k = bucketKey(d.getTime(), b)
    out.push(k)
    if (k >= last) break
  }
  return out.length >= max ? keys : out
}

export function bucketLabel(key: string, b: Bucket, longSpan = false): string {
  if (b === "weekday") return new Date(2024, 0, 1 + Number(key)).toLocaleDateString(lang, { weekday: "short" })
  if (b === "monthOfYear") return new Date(2024, Number(key) - 1, 1).toLocaleDateString(lang, { month: "short" })
  const d = bucketStart(key, b)
  if (b === "year") return key
  if (b === "quarter") return `${lang === "fr" ? "T" : "Q"}${key.split("-Q")[1]} ${key.slice(0, 4)}`
  if (b === "month") return d.toLocaleDateString(lang, { month: "short", year: "numeric" })
  if (b === "day" || b === "week") return d.toLocaleDateString(lang, { day: "numeric", month: "short", ...(longSpan ? { year: "2-digit" } : {}) })
  const time = d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })
  return longSpan ? `${d.toLocaleDateString(lang, { day: "numeric", month: "short" })} ${time}` : time
}

const compactNum = (n: number) => n.toLocaleString(lang, { maximumFractionDigits: Math.abs(n) < 10 ? 2 : Math.abs(n) < 1000 ? 1 : 0 })

/** A number as its format reads it; `n` writes the bare number. */
export const formatNum = (v: number, f: Format = "number", n: (v: number) => string = compactNum) =>
  f === "bytes" ? fmt.bytes(v) : f === "bps" ? fmt.bps(v) : f === "pct" ? `${n(v)} %` : f === "temp" ? `${n(v)} °C`
  : f === "duration" ? fmt.uptime(v) : f === "compact" ? v.toLocaleString(lang, { notation: "compact", maximumFractionDigits: 1 }) : n(v)

/** The categories a row falls in for a field. Tags put a row in each of its tags. */
function keysOf(r: Row, field: string, kind: FieldKind, bucket: Bucket, bins?: { lo: number; width: number; n: number }): string[] {
  const v = r[field]
  if (kind === "tags") { const tags = tagsOf(v); return tags.length ? tags : [""] }
  if (kind === "date") { const d = dateOf(v); return [d == null ? "" : bucketKey(d, bucket)] }
  if (kind === "number" && bins) {
    const n = numOf(v)
    if (n == null) return [""]
    return [pad(Math.min(bins.n - 1, Math.floor((n - bins.lo) / bins.width)))]
  }
  if (kind === "bool") return [v === true || v === "true" ? "true" : v === false || v === "false" ? "false" : ""]
  return [textOf(v).trim()]
}

const measureName = (m: Measure, fields: Field[]) => {
  if (m.label) return m.label
  if (m.formula) return m.formula
  const fn = FNS.find((f) => f.value === m.fn)!
  const field = fields.find((f) => f.key === m.field)
  return fn.numeric && field ? t("{fn} of {field}", { fn: t(fn.label), field: t(field.label).toLowerCase() }) : t(fn.label)
}

export const OTHER = "\u0000other"

/** Groups, splits and measures `rows` into series of values, one per category. */
export function compute(q: Query, rows: Row[], fields: Field[], now = Date.now()): Result {
  const kept = rows.filter((r) => (q.where ?? []).every((c) => matches(r, c, fields, now)))
  const gKind = q.group ? kindOf(fields, q.group) : "text"
  const formatOf = (key?: string) => fields.find((f) => f.key === key)?.format
  const dated = !!q.group && gKind === "date"
  let bucket: Bucket = q.bucket ?? "auto"
  let span = 0
  if (dated) {
    const ds = kept.map((r) => dateOf(r[q.group!])).filter((d): d is number => d != null)
    span = ds.length ? Math.max(...ds) - Math.min(...ds) : 0
    if (bucket === "auto") bucket = autoBucket(span)
  }
  let bins: { lo: number; width: number; n: number } | undefined
  if (q.group && gKind === "number" && q.bins) {
    const ns = kept.map((r) => numOf(r[q.group!])).filter((n): n is number => n != null)
    const lo = ns.length ? Math.min(...ns) : 0, hi = ns.length ? Math.max(...ns) : 1
    bins = { lo, width: (hi - lo) / q.bins || 1, n: q.bins }
  }
  const sKind = q.split ? kindOf(fields, q.split) : "text"

  // Rows of each category, and of each split inside it.
  const cells = new Map<string, Map<string, Row[]>>()
  const splitRows = new Map<string, number>()
  for (const r of kept) {
    const cats = q.group ? keysOf(r, q.group, gKind, bucket, bins) : [""]
    const splits = q.split ? keysOf(r, q.split, sKind, "year") : [""]
    for (const c of cats) {
      const byS = cells.get(c) ?? new Map<string, Row[]>()
      cells.set(c, byS)
      for (const s of splits) { byS.set(s, [...(byS.get(s) ?? []), r]); splitRows.set(s, (splitRows.get(s) ?? 0) + 1) }
    }
  }
  if (!q.group && !cells.size) cells.set("", new Map([["", []]]))

  // At most 12 series: the splits with the most rows, the rest folded together.
  let splits = [...splitRows.keys()].sort((a, b) => splitRows.get(b)! - splitRows.get(a)!)
  if (!q.split) splits = [""]
  if (splits.length > 12) {
    const rest = new Set(splits.slice(11))
    for (const byS of cells.values()) {
      const folded = [...byS].filter(([s]) => rest.has(s)).flatMap(([, rs]) => rs)
      for (const s of rest) byS.delete(s)
      if (folded.length) byS.set(OTHER, folded)
    }
    splits = [...splits.slice(0, 11), OTHER]
  }

  const visible = q.measures.filter((m) => !m.hidden)
  const valuesFor = (cellRows: (s: string) => Row[]) => {
    const out = new Map<string, Map<string, number | null>>()
    for (const s of splits) {
      const vars: Record<string, number | null> = {}
      for (const m of q.measures) {
        if (m.formula) {
          try { vars[m.id] = evaluate(m.formula, vars) } catch { vars[m.id] = null }
        } else {
          const rs = cellRows(s).filter((r) => (m.where ?? []).every((c) => matches(r, c, fields, now)))
          vars[m.id] = aggregate(m.fn, rs, m.field)
        }
      }
      out.set(s, new Map(Object.entries(vars)))
    }
    return out
  }

  let cats = [...cells.keys()]
  // A timeline has no place for rows without a date.
  if (dated) cats = fillBuckets(cats.filter(Boolean).sort(), bucket)
  const table = new Map(cats.map((c) => [c, valuesFor((s) => cells.get(c)?.get(s) ?? [])]))
  const total = (c: string) => splits.reduce((sum, s) => sum + (table.get(c)!.get(s)!.get(visible[0]?.id ?? "")! ?? 0), 0)

  const natural = dated || !!bins || gKind === "bool" || (gKind === "number" && !bins)
  const sort = q.sort && q.sort !== "auto" ? q.sort : natural ? "natural" : "desc"
  // "(empty)" comes last when categories follow their own order.
  const blankLast = (f: (a: string, b: string) => number) => (a: string, b: string) => (a === "" ? 1 : b === "" ? -1 : f(a, b))
  if (sort === "natural" && !dated) cats.sort(blankLast((a, b) => (gKind === "number" && !bins ? numOf(a)! - numOf(b)! : a.localeCompare(b))))
  if (sort === "label") cats.sort(blankLast((a, b) => a.localeCompare(b, lang, { numeric: true })))
  if (sort === "desc" || sort === "asc") cats.sort((a, b) => (sort === "desc" ? total(b) - total(a) : total(a) - total(b)))

  if (q.limit && q.limit > 0 && cats.length > q.limit) {
    const rest = cats.slice(q.limit)
    cats = cats.slice(0, q.limit)
    if (q.other) {
      table.set(OTHER, valuesFor((s) => rest.flatMap((c) => cells.get(c)?.get(s) ?? [])))
      cats.push(OTHER)
    }
  }

  const longSpan = span > 2 * 864e5
  const label = (key: string, kind: FieldKind, b: Bucket, format?: Format) => {
    if (key === OTHER) return t("Other")
    if (key === "") return t("(empty)")
    if (kind === "date") return bucketLabel(key, b, longSpan)
    if (kind === "bool") return t(key === "true" ? "Yes" : "No")
    // A key is the value as written: 0.00861963722 for a CPU of 0.01 %.
    if (kind === "number" && numOf(key) != null) return formatNum(numOf(key)!, format)
    return key
  }
  const gFormat = formatOf(q.group)
  const labels = cats.map((c) => (bins && c && c !== OTHER
    ? `${formatNum(bins.lo + Number(c) * bins.width, gFormat)} – ${formatNum(bins.lo + (Number(c) + 1) * bins.width, gFormat)}`
    : !q.group && c === "" ? t("All") : label(c, gKind, bucket, gFormat)))

  const series: Series[] = []
  for (const s of splits) for (const m of visible) {
    let values = cats.map((c) => table.get(c)!.get(s)!.get(m.id) ?? null)
    if (q.showAs === "share") { const sum = values.reduce<number>((a, v) => a + (v ?? 0), 0); values = values.map((v) => (v == null || !sum ? null : (v / sum) * 100)) }
    if (q.showAs === "cumulative") { let run = 0; values = values.map((v) => (run += v ?? 0)) }
    if (q.showAs === "change") values = values.map((v, i) => (i && v != null && values[i - 1] != null ? v - values[i - 1]! : null))
    const sName = q.split ? label(s, sKind, "year", formatOf(q.split)) : ""
    const name = !q.split ? measureName(m, fields) : visible.length > 1 ? `${sName} · ${measureName(m, fields)}` : sName
    series.push({ key: `${s}|${m.id}`, name, values, measure: m, split: q.split ? s : undefined })
  }
  return { cats, labels, series, dated }
}

/** One point per row, for a scatter chart. */
export function points(q: Query, rows: Row[], fields: Field[], nameField?: string, now = Date.now()): Point[] {
  const val = (r: Row, key?: string) => (!key ? null : kindOf(fields, key) === "date" ? dateOf(r[key]) : numOf(r[key]))
  return rows
    .filter((r) => (q.where ?? []).every((c) => matches(r, c, fields, now)))
    .map((r) => ({ x: val(r, q.x), y: val(r, q.y), size: val(r, q.size), name: textOf(nameField ? r[nameField] : r.id), split: q.split ? keysOf(r, q.split, kindOf(fields, q.split), "year")[0] : "" }))
    .filter((p): p is Point => p.x != null && p.y != null)
}

/** The rows themselves, for a list. */
export function records(q: Query, rows: Row[], fields: Field[], now = Date.now()): Row[] {
  const kept = rows.filter((r) => (q.where ?? []).every((c) => matches(r, c, fields, now)))
  if (q.order) {
    const kind = kindOf(fields, q.order)
    const key = (r: Row) => (kind === "date" ? dateOf(r[q.order!]) : kind === "number" ? numOf(r[q.order!]) : null)
    kept.sort((a, b) => {
      const x = key(a), y = key(b)
      const c = kind === "date" || kind === "number" ? (x ?? Infinity) - (y ?? Infinity) : textOf(a[q.order!]).localeCompare(textOf(b[q.order!]), lang, { numeric: true })
      return q.desc ? -c : c
    })
  }
  return kept.slice(0, q.limit || 10)
}

/** A row as one line of a CSV file. */
export function toCsv(head: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  return [head, ...rows].map((r) => r.map(cell).join(",")).join("\n")
}

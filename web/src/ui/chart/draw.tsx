// Charts drawn in SVG from what `data.ts` computes. No library: nothing leaves the page.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Empty, Table, Td } from "../components"
import { lang, t } from "../i18n"
import { fmt, levelOf, type Level } from "../lib"
import { navigate } from "../shell"
import { compute, dateOf, formatNum, numOf, OTHER, points, records, tagsOf, toCsv, type Field, type Format, type Point, type Query, type Result, type Row } from "./data"

export type ChartType =
  | "column" | "bar" | "line" | "area" | "step" | "combo" | "histogram" | "waterfall"
  | "pie" | "doughnut" | "half" | "treemap" | "funnel" | "radar" | "scatter"
  | "number" | "numbers" | "gauge" | "progress" | "table" | "list"

export interface Look {
  type: ChartType
  stack?: "none" | "stacked" | "percent"
  legend?: "auto" | "none" | "bottom" | "right"
  labels?: "none" | "value" | "share"
  palette?: "nyx" | "status" | "warm" | "cool" | "mono"
  format?: Format
  decimals?: number
  prefix?: string
  suffix?: string
  min?: number
  max?: number
  grid?: boolean
  smooth?: boolean
  markers?: boolean
  ref?: "none" | "avg" | "value"
  refValue?: number
  refLabel?: string
  /** Thresholds on the value shown; on the share of the maximum for gauges and progress bars. */
  warn?: number
  crit?: number
  /** Lower values are the bad ones, as with disk life left. */
  lowBad?: boolean
  height?: "s" | "m" | "l"
}
export interface ChartCard { query: Query; look: Look }

/** Types that read rows one by one, not grouped. */
export const ROWWISE: ChartType[] = ["scatter", "list"]
/** Types that show one figure, so they take no categories. */
export const SINGLE: ChartType[] = ["number", "gauge"]

const HEIGHT = { s: 160, m: 240, l: 360 }
const SERIES = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((s) => `var(--color-${s})`)
const PALETTES: Record<string, string[]> = {
  nyx: SERIES,
  warm: ["#e38b4f", "#f2cf6d", "#fb909e", "#ffb0cf", "#e0a98f", "#f6b26b", "#c9734a", "#f7d9a8"],
  cool: ["#87d7f7", "#c3bafe", "#91e3ae", "#7fa7f5", "#8fe0c8", "#a5b4fc", "#67c6d9", "#b6e3f9"],
  mono: [100, 82, 66, 52, 40, 30, 22, 16].map((p) => `color-mix(in srgb, var(--color-accent) ${p}%, var(--color-surface))`),
}

const WORDS: [Level, string[]][] = [
  ["ok", ["ok", "up", "running", "active", "online", "done", "in service", "healthy", "success", "passed", "operational", "yes"]],
  ["warn", ["warn", "warning", "maintenance", "doing", "degraded", "in progress", "activating", "reloading", "restarting", "paused"]],
  ["crit", ["crit", "critical", "failed", "down", "error", "broken", "dead", "faulty", "lost"]],
  ["info", ["info", "todo", "planned", "new", "queued", "ordered", "created", "pending"]],
  ["off", ["off", "stopped", "inactive", "exited", "retired", "spare", "cancelled", "disabled", "unknown", "no", "(empty)", "other"]],
]
/** Status words take the colour of their state; anything else a series colour. */
export function statusColor(label: string, i: number) {
  const l = label.toLowerCase()
  const hit = WORDS.find(([, ws]) => ws.includes(l))
  return hit ? `var(--color-${hit[0]})` : SERIES[i % SERIES.length]
}
const paletteOf = (look: Look) => PALETTES[look.palette ?? "nyx"] ?? SERIES
/** The first colours of a palette, to pick it by sight. */
export const swatches = (p: string) => (p === "status" ? ["ok", "warn", "crit", "info"].map((l) => `var(--color-${l})`) : (PALETTES[p] ?? SERIES).slice(0, 4))
const colorAt = (look: Look, i: number, label = "") => (look.palette === "status" ? statusColor(label, i) : paletteOf(look)[i % 8])

const levelColor = (look: Look, v: number | null, fallback: string) => {
  if (v == null || (look.warn == null && look.crit == null)) return fallback
  const warn = look.warn ?? Infinity, crit = look.crit ?? Infinity
  const l: Level = look.lowBad ? (v <= (look.crit ?? -Infinity) ? "crit" : v <= (look.warn ?? -Infinity) ? "warn" : "ok") : levelOf(v, warn, crit)
  return `var(--color-${l})`
}

/** How values read: the card's format, else the field's. */
export function formatter(look: Look, field?: Field, share = false): (v: number | null | undefined) => string {
  const f: Format = share ? "pct" : look.format && look.format !== "auto" ? look.format : field?.format ?? "number"
  const n = (v: number) => v.toLocaleString(lang, look.decimals == null
    ? { maximumFractionDigits: Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0 }
    : { minimumFractionDigits: look.decimals, maximumFractionDigits: look.decimals })
  return (v) => (v == null || !Number.isFinite(v) ? "—" : `${look.prefix ?? ""}${formatNum(v, f, n)}${look.suffix ?? ""}`)
}

/** Round steps covering `lo`–`hi`. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (hi <= lo) hi = lo + 1
  const raw = (hi - lo) / Math.max(1, count), mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const out: number[] = []
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.5 && out.length < 50; v += step) out.push(Number(v.toPrecision(12)))
  return out
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)
const TEXT = { fontSize: 11, fill: "var(--color-fg3)" } as const

interface TipLine { color: string; name: string; value: string }
function Tip({ x, y, width, title, lines }: { x: number; y: number; width: number; title: string; lines: TipLine[] }) {
  const flip = x > width * 0.6
  return (
    <div role="status" className="pointer-events-none absolute z-10 min-w-32 rounded-box border border-line2 bg-raised px-3 py-2 text-[13px] whitespace-nowrap" style={{ top: Math.max(0, y), ...(flip ? { right: width - x + 10 } : { left: x + 10 }) }}>
      <div className="mb-1 text-xs text-fg3">{title}</div>
      {lines.map((l, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: l.color }} />
          <span className="mr-auto pr-3 text-fg2">{l.name}</span>
          <span className="font-medium">{l.value}</span>
        </div>
      ))}
    </div>
  )
}

function Legend({ items, hidden, toggle, vertical }: { items: { key: string; name: string; color: string; extra?: string }[]; hidden: Set<string>; toggle?: (k: string) => void; vertical?: boolean }) {
  return (
    <ul className={`flex gap-x-4 gap-y-1 text-[13px] ${vertical ? "flex-col" : "flex-wrap"}`}>
      {items.map((i) => (
        <li key={i.key}>
          <button type="button" disabled={!toggle} aria-pressed={toggle ? !hidden.has(i.key) : undefined} onClick={() => toggle?.(i.key)} className={`flex max-w-56 items-center gap-2 text-left ${hidden.has(i.key) ? "text-fg3 line-through" : "text-fg2"} ${toggle ? "hover:text-fg" : "cursor-default"}`}>
            <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: i.color, opacity: hidden.has(i.key) ? 0.3 : 1 }} />
            <span className="truncate">{i.name}</span>{i.extra && <span className="text-fg3">{i.extra}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

function useHidden() {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const toggle = (k: string) => setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); return n })
  return [hidden, toggle] as const
}

const measureField = (q: Query, fields: Field[], i = 0) => {
  const m = q.measures.filter((x) => !x.hidden)[i]
  return m && !m.formula && m.fn !== "count" && m.fn !== "distinct" ? fields.find((f) => f.key === m.field) : undefined
}

// Columns, bars, lines, areas and their mixes, on two axes.
function Cartesian({ r, look, q, fields }: { r: Result; look: Look; q: Query; fields: Field[] }) {
  const [ref, width] = useWidth()
  const [hidden, toggle] = useHidden()
  const [hover, setHover] = useState<number>()
  const type = look.type
  const horizontal = type === "bar"
  const percent = look.stack === "percent"
  const stacked = look.stack === "stacked" || percent
  const show = formatter(look, measureField(q, fields), percent || q.showAs === "share")
  const n = r.cats.length
  const series = r.series.map((s, i) => ({ ...s, color: s.measure.color || colorAt(look, i, s.name), draw: type === "combo" ? s.measure.as ?? (i ? "line" : "column") : type === "line" || type === "step" ? "line" : type === "area" ? "area" : "column" }))
  const shown = series.filter((s) => !hidden.has(s.key))
  const single = shown.length === 1 && (type === "column" || type === "bar" || type === "histogram")
  const waterfall = type === "waterfall"

  // Values as drawn: shares when stacked to 100 %, and where each piece starts.
  const totals = Array.from({ length: n }, (_, c) => shown.filter((s) => s.draw !== "line").reduce((a, s) => a + Math.max(0, s.values[c] ?? 0), 0))
  const val = (s: (typeof series)[number], c: number) => { const v = s.values[c]; return v == null ? null : percent && s.draw !== "line" ? (totals[c] ? (v / totals[c]) * 100 : 0) : v }
  const base = new Map<string, number[]>()
  const pos = Array(n).fill(0), neg = Array(n).fill(0)
  for (const s of shown) {
    if (s.draw === "line" || !stacked) continue
    base.set(s.key, Array.from({ length: n }, (_, c) => { const v = val(s, c) ?? 0; const b = v >= 0 ? pos[c] : neg[c]; if (v >= 0) pos[c] += v; else neg[c] += v; return b }))
  }
  // A waterfall adds each step to the running total and ends on the total.
  const wf = waterfall && shown[0] ? (() => { let run = 0; return shown[0].values.map((v) => { const from = run; run += v ?? 0; return [from, run] as [number, number] }) })() : []
  const labels = waterfall ? [...r.labels, t("Total")] : r.labels
  const count = labels.length

  const all: number[] = [0]
  if (waterfall) all.push(...wf.flat())
  else for (const s of shown) for (let c = 0; c < n; c++) { const v = val(s, c); if (v == null) continue; const b = base.get(s.key)?.[c] ?? 0; all.push(v + b, b) }
  const refV = look.ref === "value" ? look.refValue ?? null : look.ref === "avg" && shown[0] ? (() => { const vs = shown[0].values.filter((v): v is number => v != null); return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null })() : null
  if (refV != null) all.push(refV)
  let lo = Math.min(...all), hi = Math.max(...all)
  if (percent) { lo = Math.min(lo, 0); hi = 100 }
  if (look.min != null) lo = look.min
  if (look.max != null) hi = look.max
  const ticks = niceTicks(lo, hi, horizontal ? Math.max(2, Math.floor(width / 110)) : 4)
  const d0 = look.min ?? ticks[0], d1 = look.max ?? ticks[ticks.length - 1]

  const tickText = ticks.map((v) => show(v))
  const H = horizontal ? Math.max(HEIGHT[look.height ?? "m"], count * 26 + 28) : HEIGHT[look.height ?? "m"]
  const catChars = horizontal ? Math.min(22, Math.max(4, ...labels.map((l) => l.length))) : 0
  const left = horizontal ? catChars * 6.4 + 12 : Math.max(...tickText.map((s) => s.length)) * 6.2 + 10
  const right = 12, top = 10, bottom = horizontal ? 22 : 24
  const pw = Math.max(10, width - left - right), ph = H - top - bottom
  const band = (horizontal ? ph : pw) / Math.max(1, count)
  const scale = (v: number) => ((v - d0) / (d1 - d0 || 1)) * (horizontal ? pw : ph)
  const vx = (v: number) => (horizontal ? left + scale(v) : 0)
  const vy = (v: number) => top + ph - scale(v)
  const zero = Math.min(Math.max(0, d0), d1)
  const mid = (c: number) => (horizontal ? top : left) + band * c + band / 2

  const cols = shown.filter((s) => s.draw === "column")
  const colSlots = stacked || waterfall ? 1 : Math.max(1, cols.length)
  const groupW = band * (count > 40 ? 0.9 : 0.72)
  const slotW = groupW / colSlots

  const rect = (c: number, slot: number, from: number, to: number) => {
    const a = Math.min(from, to), b = Math.max(from, to)
    if (horizontal) return { x: vx(a), y: top + band * c + (band - groupW) / 2 + slot * slotW, width: Math.max(0, vx(b) - vx(a)), height: Math.max(1, slotW - 1) }
    return { x: left + band * c + (band - groupW) / 2 + slot * slotW, y: vy(b), width: Math.max(1, slotW - 1), height: Math.max(0, vy(a) - vy(b)) }
  }
  /** Runs of points without a gap, as [category, x, y]. */
  const runs = (s: (typeof series)[number], lift: boolean) => {
    const out: [number, number, number][][] = [[]]
    for (let c = 0; c < n; c++) {
      const v = val(s, c)
      if (v == null) { if (out[out.length - 1].length) out.push([]); continue }
      out[out.length - 1].push([c, mid(c), vy(v + (lift ? base.get(s.key)?.[c] ?? 0 : 0))])
    }
    return out.filter((p) => p.length)
  }
  const trace = (p: [number, number, number][]) => {
    if (type === "step") return p.map(([, x, y], i) => (i ? `H${x.toFixed(1)}V${y.toFixed(1)}` : `M${(x - band / 2).toFixed(1)} ${y.toFixed(1)}H${x.toFixed(1)}`)).join("") + `H${(p[p.length - 1][1] + band / 2).toFixed(1)}`
    if (!look.smooth || p.length < 3) return p.map(([, x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("")
    return p.map(([, x, y], i) => {
      if (!i) return `M${x} ${y}`
      const p0 = p[Math.max(0, i - 2)], p1 = p[i - 1], p3 = p[Math.min(p.length - 1, i + 1)]
      return `C${p1[1] + (x - p0[1]) / 6} ${p1[2] + (y - p0[2]) / 6} ${x - (p3[1] - p1[1]) / 6} ${y - (p3[2] - p1[2]) / 6} ${x} ${y}`
    }).join("")
  }
  /** The area under a run, down to zero or to the series stacked below. */
  const fill = (s: (typeof series)[number], p: [number, number, number][]) => {
    const step = type === "step" ? band / 2 : 0
    const back = [...p].reverse().map(([c, x], i) => {
      const y = vy(stacked ? base.get(s.key)?.[c] ?? zero : zero)
      return `L${(x + (i ? 0 : step)).toFixed(1)} ${y.toFixed(1)}`
    }).join("")
    return `${trace(p)}${back}L${(p[0][1] - step).toFixed(1)} ${vy(stacked ? base.get(s.key)?.[p[0][0]] ?? zero : zero).toFixed(1)}Z`
  }
  const pick = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const at = horizontal ? e.clientY - box.top : e.clientX - box.left
    setHover(Math.max(0, Math.min(count - 1, Math.floor(at / band))))
  }
  const key = (e: React.KeyboardEvent) => {
    const by = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0
    if (!by) return
    e.preventDefault()
    setHover((h) => Math.max(0, Math.min(count - 1, (h ?? -1) + by)))
  }
  // Bars stack their labels down the side, 14 px each; columns lay them across.
  const every = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(horizontal ? ph / 14 : pw / (Math.min(14, Math.max(...labels.map((l) => l.length))) * 6.4 + 10)))))
  const showLabels = look.labels && look.labels !== "none" && count <= 40
  const legend = look.legend !== "none" && (series.length > 1 || look.legend === "bottom" || look.legend === "right")

  const tip = hover == null ? null : {
    title: labels[hover],
    lines: waterfall
      ? [{ color: colorAt(look, 0), name: shown[0]?.name ?? "", value: hover < n ? show(shown[0]?.values[hover] ?? null) : show(wf[n - 1]?.[1] ?? 0) }]
      : shown.map((s) => ({ color: s.color, name: s.name, value: percent && s.draw !== "line" ? `${show(val(s, hover))} · ${formatter(look, measureField(q, fields))(s.values[hover])}` : show(s.values[hover]) })),
  }
  return (
    <div className={legend && look.legend === "right" ? "grid grid-cols-[minmax(0,1fr)_auto] gap-4" : ""}>
      <div ref={ref} className="relative min-w-0" style={{ height: H }} tabIndex={0} onKeyDown={key} onBlur={() => setHover(undefined)} role="group" aria-label={t("Chart values. Use the arrow keys to move in time.")}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={series.map((s) => s.name).join(", ")}>
            {ticks.map((v, i) => horizontal
              ? <g key={i}>{look.grid !== false && <line x1={vx(v)} x2={vx(v)} y1={top} y2={top + ph} stroke="var(--color-line)" />}<text x={vx(v)} y={H - 6} textAnchor="middle" {...TEXT}>{tickText[i]}</text></g>
              : <g key={i}>{look.grid !== false && <line x1={left} x2={left + pw} y1={vy(v)} y2={vy(v)} stroke="var(--color-line)" />}<text x={left - 6} y={vy(v) + 4} textAnchor="end" {...TEXT}>{tickText[i]}</text></g>)}
            {hover != null && (horizontal
              ? <rect x={left} y={top + band * hover} width={pw} height={band} fill="var(--color-fg)" opacity="0.05" />
              : <rect x={left + band * hover} y={top} width={band} height={ph} fill="var(--color-fg)" opacity="0.05" />)}
            {d0 < 0 && (horizontal ? <line x1={vx(0)} x2={vx(0)} y1={top} y2={top + ph} stroke="var(--color-line2)" /> : <line x1={left} x2={left + pw} y1={vy(0)} y2={vy(0)} stroke="var(--color-line2)" />)}
            {waterfall && wf.map(([from, to], c) => {
              const up = to >= from
              return <rect key={c} {...rect(c, 0, from, to)} rx="2" fill={up ? "var(--color-ok)" : "var(--color-crit)"} opacity="0.85" />
            })}
            {waterfall && n > 0 && <rect {...rect(n, 0, 0, wf[n - 1][1])} rx="2" fill={colorAt(look, 0)} />}
            {!waterfall && shown.filter((s) => s.draw === "area").map((s) => runs(s, stacked).map((p, i) => <path key={`${s.key}${i}`} d={fill(s, p)} fill={s.color} fillOpacity={stacked ? 0.55 : 0.16} />))}
            {!waterfall && cols.map((s, slot) => s.values.map((_, c) => {
              const v = val(s, c)
              if (v == null) return null
              const b = base.get(s.key)?.[c] ?? zero
              return <rect key={`${s.key}${c}`} {...rect(c, stacked ? 0 : slot, b, b + v)} rx={stacked ? 0 : 2} fill={single ? levelColor(look, s.values[c], look.palette === "status" ? statusColor(r.labels[c], c) : s.color) : s.color} />
            }))}
            {!waterfall && shown.filter((s) => s.draw !== "column").map((s) => (
              <g key={s.key}>
                {runs(s, s.draw === "area" && stacked).map((p, i) => <path key={i} d={trace(p)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" />)}
                {(look.markers || (n <= 24 && s.draw === "line")) && s.values.map((_, c) => { const v = val(s, c); return v == null ? null : <circle key={c} cx={mid(c)} cy={vy(v + (s.draw === "area" && stacked ? base.get(s.key)?.[c] ?? 0 : 0))} r="3" fill="var(--color-surface)" stroke={s.color} strokeWidth="2" /> })}
              </g>
            ))}
            {showLabels && !waterfall && shown.map((s) => s.values.map((_, c) => {
              const v = val(s, c)
              if (v == null || (stacked && s.draw !== "line" && Math.abs(scale(v) - scale(0)) < 14)) return null
              const end = v + (base.get(s.key)?.[c] ?? 0)
              const text = look.labels === "share" && !percent ? `${fmt.num(totals[c] ? (v / totals[c]) * 100 : 0, 0)} %` : show(v)
              if (horizontal) return <text key={`${s.key}${c}`} x={vx(end) + (stacked ? -4 : 4)} y={rect(c, stacked ? 0 : cols.indexOf(s), 0, 1).y + Math.max(1, slotW - 1) / 2 + 4} textAnchor={stacked ? "end" : "start"} fontSize="11" fill={stacked ? "var(--color-accent-ink)" : "var(--color-fg2)"}>{text}</text>
              const slot = s.draw === "column" && !stacked ? cols.indexOf(s) : -1
              const x = slot >= 0 ? rect(c, slot, 0, 1).x + Math.max(1, slotW - 1) / 2 : mid(c)
              return <text key={`${s.key}${c}`} x={x} y={vy(end) + (stacked && s.draw !== "line" ? 12 : -5)} textAnchor="middle" fontSize="11" fill={stacked && s.draw !== "line" ? "var(--color-accent-ink)" : "var(--color-fg2)"}>{text}</text>
            }))}
            {refV != null && (horizontal
              ? <g><line x1={vx(refV)} x2={vx(refV)} y1={top} y2={top + ph} stroke="var(--color-fg2)" strokeDasharray="4 4" /><text x={vx(refV) + 4} y={top + 10} {...TEXT}>{look.refLabel || (look.ref === "avg" ? t("Average") : show(refV))}</text></g>
              : <g><line x1={left} x2={left + pw} y1={vy(refV)} y2={vy(refV)} stroke="var(--color-fg2)" strokeDasharray="4 4" /><text x={left + pw} y={vy(refV) - 4} textAnchor="end" {...TEXT}>{look.refLabel || (look.ref === "avg" ? `${t("Average")} ${show(refV)}` : show(refV))}</text></g>)}
            {labels.map((l, c) => (c % every ? null : horizontal
              ? <text key={c} x={left - 6} y={mid(c) + 4} textAnchor="end" {...TEXT}><title>{l}</title>{clip(l, catChars)}</text>
              : <text key={c} x={mid(c)} y={H - 8} textAnchor="middle" {...TEXT}><title>{l}</title>{clip(l, 14)}</text>))}
            <rect x={left} y={top} width={pw} height={ph} fill="transparent" onPointerMove={pick} onPointerDown={pick} onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(undefined) }} />
          </svg>
        )}
        {tip && hover != null && <Tip x={horizontal ? left + pw / 2 : mid(hover)} y={horizontal ? mid(hover) : top} width={width} title={tip.title} lines={tip.lines} />}
      </div>
      {legend && <div className={look.legend === "right" ? "pt-2" : "mt-3"}><Legend vertical={look.legend === "right"} items={series.map((s) => ({ key: s.key, name: s.name, color: s.color }))} hidden={hidden} toggle={series.length > 1 ? toggle : undefined} /></div>}
    </div>
  )
}

// Pies, doughnuts and half doughnuts: the first series, one slice per category.
function Pie({ r, look, q, fields }: { r: Result; look: Look; q: Query; fields: Field[] }) {
  const [ref, width] = useWidth()
  const [hidden, toggle] = useHidden()
  const [hover, setHover] = useState<number>()
  const s = r.series[0]
  const show = formatter(look, measureField(q, fields))
  if (!s) return <Empty>{t("Nothing to show.")}</Empty>
  const slices = r.cats.map((c, i) => ({ key: c, name: r.labels[i], v: Math.max(0, s.values[i] ?? 0), color: colorAt(look, i, r.labels[i]) }))
  const shown = slices.filter((x) => !hidden.has(x.key) && x.v > 0)
  const total = shown.reduce((a, x) => a + x.v, 0)
  const half = look.type === "half"
  const hole = look.type === "doughnut" || half ? 0.6 : 0
  const side = look.legend === "right" || (look.legend !== "bottom" && look.legend !== "none" && width > 460)
  const H = HEIGHT[look.height ?? "m"]
  const size = Math.min(side ? width * 0.55 : width, half ? H * 2 - 20 : H)
  const R = size / 2 - 6, cx = size / 2, cy = half ? size / 2 : size / 2
  let at = half ? Math.PI : -Math.PI / 2
  const sweep = half ? Math.PI : Math.PI * 2
  const arcs = shown.map((x) => {
    const a0 = at, a1 = at + (x.v / (total || 1)) * sweep
    at = a1
    return { ...x, a0, a1 }
  })
  const pt = (a: number, rr: number) => [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]
  const path = (a0: number, a1: number, out: number) => {
    const large = a1 - a0 > Math.PI ? 1 : 0
    const r0 = R * hole
    if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4
    const [x0, y0] = pt(a0, out), [x1, y1] = pt(a1, out)
    if (!r0) return `M${cx} ${cy}L${x0} ${y0}A${out} ${out} 0 ${large} 1 ${x1} ${y1}Z`
    const [x2, y2] = pt(a1, r0), [x3, y3] = pt(a0, r0)
    return `M${x0} ${y0}A${out} ${out} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${large} 0 ${x3} ${y3}Z`
  }
  const h = hover != null ? arcs[hover] : undefined
  return (
    <div ref={ref} className={side ? "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-5" : "flex flex-col items-center gap-3"}>
      {width > 0 && (
        <div className="relative" style={{ width: size, height: half ? size / 2 + 6 : size }}>
          <svg width={size} height={half ? size / 2 + 6 : size} role="img" aria-label={slices.map((x) => `${x.name} ${show(x.v)}`).join(", ")}>
            {arcs.map((a, i) => (
              <path key={a.key} d={path(a.a0, a.a1, hover === i ? R + 4 : R)} fill={a.color} stroke="var(--color-surface)" strokeWidth="1.5" onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(undefined)} />
            ))}
            {look.labels !== "none" && !hole && arcs.map((a) => {
              if (a.a1 - a.a0 < 0.3) return null
              const [x, y] = pt((a.a0 + a.a1) / 2, R * 0.65)
              return <text key={a.key} x={x} y={y + 4} textAnchor="middle" fontSize="12" fill="var(--color-accent-ink)" fontWeight="500">{look.labels === "value" ? show(a.v) : `${fmt.num((a.v / total) * 100, 0)} %`}</text>
            })}
          </svg>
          {hole > 0 && (
            <div className="pointer-events-none absolute inset-x-0 text-center" style={half ? { bottom: 8 } : { top: "50%", transform: "translateY(-50%)" }}>
              <div className="text-xl font-medium">{show(h ? h.v : total)}</div>
              <div className="mx-auto max-w-28 truncate text-xs text-fg3">{h ? h.name : t("Total")}</div>
            </div>
          )}
          {h && !hole && <Tip x={cx} y={cy} width={size} title={h.name} lines={[{ color: h.color, name: `${fmt.num((h.v / (total || 1)) * 100, 1)} %`, value: show(h.v) }]} />}
        </div>
      )}
      {look.legend !== "none" && <Legend vertical={side} items={slices.map((x) => ({ key: x.key, name: x.name, color: x.color, extra: hidden.has(x.key) || !total ? "" : `${show(x.v)} · ${fmt.num((x.v / total) * 100, 0)} %` }))} hidden={hidden} toggle={toggle} />}
    </div>
  )
}

/** Squarified treemap: rows of tiles kept close to squares. */
export function squarify(values: number[], w: number, h: number): { x: number; y: number; w: number; h: number }[] {
  const total = values.reduce((a, b) => a + b, 0) || 1
  const items = values.map((v, i) => ({ i, a: (v / total) * w * h })).sort((a, b) => b.a - a.a)
  const out: { x: number; y: number; w: number; h: number }[] = Array(values.length)
  let x = 0, y = 0, W = w, H = h
  const worst = (row: number[], side: number) => { const s = row.reduce((a, b) => a + b, 0); return Math.max(...row.map((a) => Math.max((side * side * a) / (s * s), (s * s) / (side * side * a)))) }
  let row: typeof items = []
  const lay = () => {
    const s = row.reduce((a, b) => a + b.a, 0)
    if (W >= H) { const cw = s / H; let yy = y; for (const it of row) { const hh = it.a / cw; out[it.i] = { x, y: yy, w: cw, h: hh }; yy += hh } x += cw; W -= cw }
    else { const rh = s / W; let xx = x; for (const it of row) { const ww = it.a / rh; out[it.i] = { x: xx, y, w: ww, h: rh }; xx += ww } y += rh; H -= rh }
    row = []
  }
  for (const it of items) {
    const side = Math.min(W, H)
    if (row.length && worst([...row.map((r) => r.a), it.a], side) > worst(row.map((r) => r.a), side)) lay()
    row.push(it)
  }
  if (row.length) lay()
  return out
}

function Treemap({ r, look, q, fields }: { r: Result; look: Look; q: Query; fields: Field[] }) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number>()
  const show = formatter(look, measureField(q, fields))
  const s = r.series[0]
  const H = HEIGHT[look.height ?? "m"]
  const vals = (s?.values ?? []).map((v) => Math.max(0, v ?? 0))
  const tiles = width > 0 ? squarify(vals, width, H) : []
  const total = vals.reduce((a, b) => a + b, 0)
  return (
    <div ref={ref} className="relative" style={{ height: H }}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={r.labels.map((l, i) => `${l} ${show(vals[i])}`).join(", ")}>
          {tiles.map((b, i) => b && vals[i] > 0 && (
            <g key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(undefined)}>
              <rect x={b.x + 1} y={b.y + 1} width={Math.max(0, b.w - 2)} height={Math.max(0, b.h - 2)} rx="4" fill={colorAt(look, i, r.labels[i])} opacity={hover === i ? 1 : 0.88} />
              {b.w > 48 && b.h > 30 && <text x={b.x + 8} y={b.y + 18} fontSize="12" fontWeight="500" fill="var(--color-accent-ink)">{clip(r.labels[i], Math.floor(b.w / 7))}</text>}
              {b.w > 48 && b.h > 46 && <text x={b.x + 8} y={b.y + 34} fontSize="11" fill="var(--color-accent-ink)">{look.labels === "share" ? `${fmt.num((vals[i] / (total || 1)) * 100, 0)} %` : show(vals[i])}</text>}
            </g>
          ))}
        </svg>
      )}
      {hover != null && tiles[hover] && <Tip x={tiles[hover].x + tiles[hover].w / 2} y={tiles[hover].y} width={width} title={r.labels[hover]} lines={[{ color: colorAt(look, hover, r.labels[hover]), name: `${fmt.num((vals[hover] / (total || 1)) * 100, 1)} %`, value: show(vals[hover]) }]} />}
    </div>
  )
}

function Funnel({ r, look, q, fields }: { r: Result; look: Look; q: Query; fields: Field[] }) {
  const show = formatter(look, measureField(q, fields))
  const vals = (r.series[0]?.values ?? []).map((v) => Math.max(0, v ?? 0))
  const top = Math.max(1, ...vals)
  return (
    <ul className="flex flex-col gap-1.5">
      {vals.map((v, i) => (
        <li key={r.cats[i]} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 text-[13px]">
          <span className="truncate text-fg2" title={r.labels[i]}>{r.labels[i]}</span>
          <span className="flex h-7 justify-center"><span className="h-full rounded-sm" style={{ width: `${Math.max(1, (v / top) * 100)}%`, background: colorAt(look, i, r.labels[i]) }} /></span>
          <span className="w-28 text-right tabular-nums"><span className="font-medium">{show(v)}</span>{i > 0 && vals[0] > 0 && <span className="ml-1 text-fg3">{fmt.num((v / vals[0]) * 100, 0)} %</span>}</span>
        </li>
      ))}
    </ul>
  )
}

function Radar({ r, look, q, fields }: { r: Result; look: Look; q: Query; fields: Field[] }) {
  const [ref, width] = useWidth()
  const [hidden, toggle] = useHidden()
  const show = formatter(look, measureField(q, fields))
  const n = r.cats.length
  if (n < 3) return <Empty>{t("A radar needs at least three categories.")}</Empty>
  const series = r.series.map((s, i) => ({ ...s, color: s.measure.color || colorAt(look, i, s.name) }))
  const top = look.max ?? niceTicks(0, Math.max(1, ...series.filter((s) => !hidden.has(s.key)).flatMap((s) => s.values.map((v) => v ?? 0))), 4).pop()!
  const H = HEIGHT[look.height ?? "m"] + 40
  const R = Math.min(width / 2 - 70, H / 2 - 22), cx = width / 2, cy = H / 2
  const at = (c: number, f: number) => { const a = -Math.PI / 2 + (c / n) * Math.PI * 2; return [cx + Math.cos(a) * R * f, cy + Math.sin(a) * R * f] }
  return (
    <div>
      <div ref={ref} style={{ height: H }}>
        {width > 0 && R > 20 && (
          <svg width={width} height={H} role="img" aria-label={series.map((s) => s.name).join(", ")}>
            {[0.25, 0.5, 0.75, 1].map((f) => <polygon key={f} points={r.cats.map((_, c) => at(c, f).join(",")).join(" ")} fill="none" stroke="var(--color-line)" />)}
            {r.cats.map((_, c) => { const [x, y] = at(c, 1); const [lx, ly] = at(c, 1.12); return <g key={c}><line x1={cx} y1={cy} x2={x} y2={y} stroke="var(--color-line)" /><text x={lx} y={ly + 4} textAnchor={Math.abs(lx - cx) < 4 ? "middle" : lx > cx ? "start" : "end"} {...TEXT}><title>{r.labels[c]}</title>{clip(r.labels[c], 14)}</text></g> })}
            <text x={cx + 4} y={cy - R + 12} {...TEXT}>{show(top)}</text>
            {series.filter((s) => !hidden.has(s.key)).map((s) => (
              <polygon key={s.key} points={s.values.map((v, c) => at(c, Math.min(1, (v ?? 0) / (top || 1))).join(",")).join(" ")} fill={s.color} fillOpacity="0.18" stroke={s.color} strokeWidth="2" />
            ))}
          </svg>
        )}
      </div>
      {series.length > 1 && look.legend !== "none" && <div className="mt-2"><Legend items={series.map((s) => ({ key: s.key, name: s.name, color: s.color }))} hidden={hidden} toggle={toggle} /></div>}
    </div>
  )
}

function Scatter({ pts, look, q, fields }: { pts: Point[]; look: Look; q: Query; fields: Field[] }) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number>()
  if (!pts.length) return <Empty>{t("Nothing to show.")}</Empty>
  const fx = fields.find((f) => f.key === q.x), fy = fields.find((f) => f.key === q.y)
  const xDate = fx?.kind === "date"
  const showX = xDate ? (v: number | null | undefined) => (v == null ? "—" : new Date(v).toLocaleDateString(lang, { day: "numeric", month: "short", year: "2-digit" })) : formatter({ ...look, prefix: "", suffix: "", format: "auto" }, fx)
  const showY = formatter(look, fy)
  const splits = [...new Set(pts.map((p) => p.split))]
  const H = HEIGHT[look.height ?? "m"]
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y), ss = pts.map((p) => p.size ?? 0)
  const xt = xDate ? [Math.min(...xs), Math.max(...xs)] : niceTicks(Math.min(...xs), Math.max(...xs), 4)
  const yt = niceTicks(look.min ?? Math.min(0, ...ys), look.max ?? Math.max(...ys), 4)
  const left = Math.max(...yt.map((v) => showY(v).length)) * 6.2 + 10, top = 10, bottom = 24, right = 14
  const pw = Math.max(10, width - left - right), ph = H - top - bottom
  const sx = (v: number) => left + ((v - xt[0]) / (xt[xt.length - 1] - xt[0] || 1)) * pw
  const sy = (v: number) => top + ph - ((v - yt[0]) / (yt[yt.length - 1] - yt[0] || 1)) * ph
  const smax = Math.max(1, ...ss)
  const rad = (p: Point) => (q.size ? 3 + Math.sqrt(Math.max(0, p.size ?? 0) / smax) * 12 : 4)
  const color = (p: Point) => colorAt(look, splits.indexOf(p.split), p.split)
  const near = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect(), mx = e.clientX - box.left + left, my = e.clientY - box.top + top
    let best = -1, dist = 900
    pts.forEach((p, i) => { const d = (sx(p.x) - mx) ** 2 + (sy(p.y) - my) ** 2; if (d < dist) { dist = d; best = i } })
    setHover(best < 0 ? undefined : best)
  }
  const h = hover != null ? pts[hover] : undefined
  return (
    <div>
      <div ref={ref} className="relative" style={{ height: H }}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={t("Scatter of {n} points", { n: pts.length })}>
            {yt.map((v, i) => <g key={i}>{look.grid !== false && <line x1={left} x2={left + pw} y1={sy(v)} y2={sy(v)} stroke="var(--color-line)" />}<text x={left - 6} y={sy(v) + 4} textAnchor="end" {...TEXT}>{showY(v)}</text></g>)}
            {xt.map((v, i) => <text key={i} x={sx(v)} y={H - 8} textAnchor={xDate ? (i ? "end" : "start") : "middle"} {...TEXT}>{showX(v)}</text>)}
            {pts.map((p, i) => <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={rad(p)} fill={color(p)} fillOpacity={q.size ? 0.5 : 0.85} stroke={hover === i ? "var(--color-fg)" : "none"} />)}
            <rect x={left} y={top} width={pw} height={ph} fill="transparent" onPointerMove={near} onPointerDown={near} onPointerLeave={() => setHover(undefined)} />
          </svg>
        )}
        {h && <Tip x={sx(h.x)} y={sy(h.y)} width={width} title={h.name} lines={[
          { color: color(h), name: t(fx?.label ?? "X"), value: showX(h.x) },
          { color: color(h), name: t(fy?.label ?? "Y"), value: showY(h.y) },
          ...(q.size ? [{ color: color(h), name: t(fields.find((f) => f.key === q.size)?.label ?? ""), value: formatter({ type: "scatter" }, fields.find((f) => f.key === q.size))(h.size) }] : []),
        ]} />}
      </div>
      {splits.length > 1 && look.legend !== "none" && <div className="mt-2"><Legend items={splits.map((s, i) => ({ key: s || "-", name: s || t("(empty)"), color: colorAt(look, i, s) }))} hidden={new Set()} /></div>}
    </div>
  )
}

function Spark({ values, color }: { values: (number | null)[]; color: string }) {
  const vs = values.map((v) => v ?? 0)
  if (vs.length < 2) return null
  const lo = Math.min(...vs), hi = Math.max(...vs)
  const d = vs.map((v, i) => `${i ? "L" : "M"}${((i / (vs.length - 1)) * 100).toFixed(1)} ${(28 - ((v - lo) / (hi - lo || 1)) * 26).toFixed(1)}`).join("")
  return <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="mt-2 h-8 w-full" aria-hidden><path d={`${d}L100 30L0 30Z`} fill={color} fillOpacity="0.15" /><path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>
}

/** A big figure: the total, or the latest period with its change when grouped by date. */
function BigNumber({ r, look, q, fields }: { r: Result; look: Look; q: Query; fields: Field[] }) {
  const show = formatter(look, measureField(q, fields), q.showAs === "share")
  const s = r.series[0]
  if (!s) return <Empty>{t("Nothing to show.")}</Empty>
  const vs = s.values
  const last = r.dated ? [...vs].reverse().find((v) => v != null) ?? null : vs[0]
  const prev = r.dated ? vs[vs.length - 2] ?? null : null
  const change = r.dated && prev != null && last != null && prev !== 0 ? ((last - prev) / Math.abs(prev)) * 100 : null
  const color = levelColor(look, last, "var(--color-fg)")
  return (
    <div>
      <div className="text-[40px] leading-tight font-medium tabular-nums" style={{ color }}>{show(last)}</div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-[13px] text-fg3">
        <span>{s.name}{r.dated && ` · ${r.labels[vs.lastIndexOf(last)] ?? ""}`}</span>
        {change != null && <span className={change >= 0 !== !!look.lowBad ? "text-ok" : "text-crit"}>{change >= 0 ? "▲" : "▼"} {fmt.num(Math.abs(change), 0)} % {t("vs the period before")}</span>}
      </div>
      {r.dated && <Spark values={vs} color={look.warn != null || look.crit != null ? color : colorAt(look, 0)} />}
    </div>
  )
}

function Numbers({ r, look, q, fields }: { r: Result; look: Look; q: Query; fields: Field[] }) {
  const show = formatter(look, measureField(q, fields), q.showAs === "share")
  const s = r.series[0]
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
      {r.cats.map((c, i) => (
        <li key={c} className="rounded-box border border-line px-3 py-2">
          <div className="text-2xl font-medium tabular-nums" style={{ color: levelColor(look, s?.values[i] ?? null, look.palette === "status" ? statusColor(r.labels[i], i) : "var(--color-fg)") }}>{show(s?.values[i])}</div>
          <div className="truncate text-xs text-fg3" title={r.labels[i]}>{r.labels[i]}</div>
        </li>
      ))}
    </ul>
  )
}

function GaugeCard({ r, look, q, fields }: { r: Result; look: Look; q: Query; fields: Field[] }) {
  const show = formatter(look, measureField(q, fields))
  const v = r.series[0]?.values[0] ?? 0
  const max = look.max ?? r.series[1]?.values[0] ?? 100
  const pct = Math.max(0, Math.min(100, (v / (max || 1)) * 100))
  const color = levelColor(look, pct, colorAt(look, 0))
  const R = 54, len = Math.PI * R, arc = `M ${70 - R} 70 A ${R} ${R} 0 0 1 ${70 + R} 70`
  return (
    <figure className="flex flex-col items-center">
      <div className="relative">
        <svg viewBox="0 0 140 84" className="w-44" role="img" aria-label={`${r.series[0]?.name ?? ""} ${show(v)}`}>
          <path d={arc} fill="none" stroke="var(--color-line)" strokeWidth="10" strokeLinecap="round" />
          {pct > 0 && <path d={arc} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(pct / 100) * len} ${len}`} />}
          <text x="14" y="82" fontSize="8" fill="var(--color-fg3)" textAnchor="middle">{show(0)}</text>
          <text x="126" y="82" fontSize="8" fill="var(--color-fg3)" textAnchor="middle">{show(max)}</text>
        </svg>
        <div className="absolute inset-x-0 top-[40px] text-center text-[24px] leading-8 font-medium tabular-nums">{show(v)}</div>
      </div>
      <figcaption className="mt-1 text-[13px] text-fg2">{r.series[0]?.name} · {fmt.num(pct, 0)} %</figcaption>
    </figure>
  )
}

/** Each category against its maximum: measure B when there is one, else the largest value. */
function ProgressList({ r, look, q, fields }: { r: Result; look: Look; q: Query; fields: Field[] }) {
  const show = formatter(look, measureField(q, fields))
  const [a, b] = r.series
  const top = look.max ?? Math.max(1, ...(a?.values ?? []).map((v) => v ?? 0))
  return (
    <ul className="flex flex-col gap-2.5">
      {r.cats.map((c, i) => {
        const v = a?.values[i] ?? 0, max = b ? b.values[i] ?? 0 : top
        const pct = max ? Math.max(0, Math.min(100, (v / max) * 100)) : 0
        return (
          <li key={c} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-[13px]">
            <span className="truncate text-fg2" title={r.labels[i]}>{r.labels[i]}</span>
            <span className="h-2.5 overflow-hidden rounded-full bg-raised"><span className="block h-full rounded-full" style={{ width: `${pct}%`, background: levelColor(look, pct, look.palette === "status" ? statusColor(r.labels[i], i) : colorAt(look, 0)) }} /></span>
            <span className="text-right whitespace-nowrap tabular-nums"><span className="font-medium">{show(v)}</span>{b && <span className="text-fg3"> / {show(max)}</span>}<span className="ml-2 text-fg3">{fmt.num(pct, 0)} %</span></span>
          </li>
        )
      })}
    </ul>
  )
}

/** Categories down, series across, with totals where adding makes sense. */
export function PivotTable({ r, look, q, fields }: { r: Result; look: Look; q: Query; fields: Field[] }) {
  const show = formatter(look, measureField(q, fields), q.showAs === "share")
  const additive = r.series.every((s) => !s.measure.formula && ["count", "sum"].includes(s.measure.fn)) && q.showAs !== "cumulative"
  const rowTotal = (i: number) => r.series.reduce((a, s) => a + (s.values[i] ?? 0), 0)
  return (
    <Table head={[q.group ? t(fields.find((f) => f.key === q.group)?.label ?? "") : "", ...r.series.map((s) => s.name), ...(additive && r.series.length > 1 ? [t("Total")] : [])]}>
      {r.cats.map((c, i) => (
        <tr key={c}>
          <Td className="font-medium">{r.labels[i]}</Td>
          {r.series.map((s) => <Td key={s.key} className="text-right tabular-nums" style={{ color: levelColor(look, s.values[i], "") || undefined }}>{show(s.values[i])}</Td>)}
          {additive && r.series.length > 1 && <Td className="text-right font-medium tabular-nums">{show(rowTotal(i))}</Td>}
        </tr>
      ))}
      {additive && r.cats.length > 1 && (
        <tr className="border-t border-line2">
          <Td className="font-medium">{t("Total")}</Td>
          {r.series.map((s) => <Td key={s.key} className="text-right font-medium tabular-nums">{show(s.values.reduce<number>((a, v) => a + (v ?? 0), 0))}</Td>)}
          {r.series.length > 1 && <Td className="text-right font-medium tabular-nums">{show(r.cats.reduce((a, _, i) => a + rowTotal(i), 0))}</Td>}
        </tr>
      )}
    </Table>
  )
}

/** A field's value as a cell reads it. */
export function cellText(v: unknown, f: Field | undefined): string {
  if (v == null || v === "") return "—"
  if (f?.kind === "date") { const d = dateOf(v); return d == null ? "—" : new Date(d).toLocaleDateString(lang) }
  if (f?.kind === "bool") return t(v === true || v === "true" ? "Yes" : "No")
  if (f?.kind === "tags") return tagsOf(v).join(", ") || "—"
  if (f?.kind === "number") return formatter({ type: "list" }, f)(numOf(v))
  return String(v)
}

function List({ rows, q, fields, nameField, link }: { rows: Row[]; q: Query; fields: Field[]; nameField?: string; link?: (r: Row) => string | undefined }) {
  const cols = (q.columns?.length ? q.columns : [nameField ?? fields[0]?.key, ...fields.filter((f) => f.key !== nameField).slice(0, 2).map((f) => f.key)]).map((k) => fields.find((f) => f.key === k)).filter((f): f is Field => !!f)
  if (!rows.length) return <Empty>{t("Nothing to show.")}</Empty>
  return (
    <Table head={cols.map((f) => t(f.label))}>
      {rows.map((r, i) => {
        const to = link?.(r)
        return (
          <tr key={String(r.id ?? i)} className={to ? "cursor-pointer hover:bg-raised" : ""} onClick={to ? () => navigate(to) : undefined}>
            {cols.map((f, j) => <Td key={f.key} className={j ? "text-fg2" : "font-medium"} mono={f.key === "ip" || f.key === "address"}>{cellText(r[f.key], f)}</Td>)}
          </tr>
        )
      })}
    </Table>
  )
}

/** What a card computes, once, for the chart and for its data table. */
export function prepare(card: ChartCard, rows: Row[], fields: Field[], nameField?: string): { result?: Result; pts?: Point[]; list?: Row[] } {
  const { query: q, look } = card
  if (look.type === "scatter") return { pts: points(q, rows, fields, nameField) }
  if (look.type === "list") return { list: records(q, rows, fields) }
  const single = SINGLE.includes(look.type) && !(look.type === "number" && q.group && fields.find((f) => f.key === q.group)?.kind === "date")
  const query = { ...q, ...(single ? { group: undefined, split: undefined } : {}), ...(look.type === "histogram" ? { bins: q.bins || 10 } : {}), ...(look.type === "number" || look.type === "gauge" ? { split: undefined } : {}) }
  return { result: compute(query, rows, fields) }
}

export function ChartBody({ card, rows, fields, nameField, link }: { card: ChartCard; rows: Row[]; fields: Field[]; nameField?: string; link?: (r: Row) => string | undefined }) {
  const { query: q, look } = card
  const { result: r, pts, list } = prepare(card, rows, fields, nameField)
  if (pts) return <Scatter pts={pts} look={look} q={q} fields={fields} />
  if (list) return <List rows={list} q={q} fields={fields} nameField={nameField} link={link} />
  if (!r || (!r.cats.length && !SINGLE.includes(look.type))) return <Empty>{t("Nothing to show.")}</Empty>
  const props = { r, look, q, fields }
  const body: Record<ChartType, () => ReactNode> = {
    column: () => <Cartesian {...props} />, bar: () => <Cartesian {...props} />, line: () => <Cartesian {...props} />,
    area: () => <Cartesian {...props} />, step: () => <Cartesian {...props} />, combo: () => <Cartesian {...props} />,
    histogram: () => <Cartesian {...props} />, waterfall: () => <Cartesian {...props} />,
    pie: () => <Pie {...props} />, doughnut: () => <Pie {...props} />, half: () => <Pie {...props} />,
    treemap: () => <Treemap {...props} />, funnel: () => <Funnel {...props} />, radar: () => <Radar {...props} />,
    number: () => <BigNumber {...props} />, numbers: () => <Numbers {...props} />, gauge: () => <GaugeCard {...props} />,
    progress: () => <ProgressList {...props} />, table: () => <PivotTable {...props} />, scatter: () => null, list: () => null,
  }
  return <>{body[look.type]()}</>
}

/** The numbers behind a card, as a table anyone can read, and as CSV. */
export function chartData(card: ChartCard, rows: Row[], fields: Field[], nameField?: string): { head: string[]; rows: (string | number | null)[][] } {
  const { result: r, pts, list } = prepare(card, rows, fields, nameField)
  if (pts) {
    const label = (k?: string) => t(fields.find((f) => f.key === k)?.label ?? "")
    return { head: [t("Name"), label(card.query.x), label(card.query.y), ...(card.query.size ? [label(card.query.size)] : [])], rows: pts.map((p) => [p.name, p.x, p.y, ...(card.query.size ? [p.size] : [])]) }
  }
  if (list) {
    const cols = (card.query.columns?.length ? card.query.columns : [nameField ?? fields[0]?.key]).map((k) => fields.find((f) => f.key === k)).filter((f): f is Field => !!f)
    return { head: cols.map((f) => t(f.label)), rows: list.map((row) => cols.map((f) => cellText(row[f.key], f))) }
  }
  if (!r) return { head: [], rows: [] }
  return { head: [card.query.group ? t(fields.find((f) => f.key === card.query.group)?.label ?? "") : "", ...r.series.map((s) => s.name)], rows: r.cats.map((c, i) => [c === OTHER ? t("Other") : r.labels[i], ...r.series.map((s) => (s.values[i] == null ? null : Number(s.values[i]!.toFixed(4))))]) }
}

export function DataTable({ head, rows }: { head: string[]; rows: (string | number | null)[][] }) {
  return rows.length ? (
    <div className="max-h-96 overflow-auto">
      <Table head={head}>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <Td key={j} className={j ? "text-right tabular-nums" : "font-medium"}>{v == null ? "—" : typeof v === "number" ? v.toLocaleString(lang) : v}</Td>)}</tr>)}</Table>
    </div>
  ) : <Empty>{t("Nothing to show.")}</Empty>
}

export function downloadCsv(name: string, data: { head: string[]; rows: (string | number | null)[][] }) {
  const url = URL.createObjectURL(new Blob([`﻿${toCsv(data.head, data.rows)}`], { type: "text/csv;charset=utf-8" }))
  const a = document.createElement("a")
  a.href = url
  a.download = `${name.replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || "chart"}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

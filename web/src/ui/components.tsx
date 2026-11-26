import {
  ArrowDownIcon, ArrowUpIcon, CheckCircleIcon, ChevronDownIcon, ChevronUpDownIcon, ClockIcon, EllipsisVerticalIcon, ExclamationTriangleIcon,
  InformationCircleIcon, MagnifyingGlassIcon, MinusCircleIcon, XCircleIcon, XMarkIcon,
} from "@heroicons/react/24/outline"
import { Children, cloneElement, type ComponentType, isValidElement, type ReactElement, type ReactNode, type SVGProps, useEffect, useId, useRef, useState } from "react"
import { t, t as tr, tx, lang } from "./i18n"
import { fmt, type Level, levelBg, levelOf, levelSoft, levelText, samplesAt } from "./lib"

export type Icon = ComponentType<SVGProps<SVGSVGElement>>

const stateMeta: Record<Level, { icon: Icon; label: string }> = {
  ok: { icon: CheckCircleIcon, label: "Operational" },
  warn: { icon: ExclamationTriangleIcon, label: "Warning" },
  crit: { icon: XCircleIcon, label: "Critical" },
  info: { icon: InformationCircleIcon, label: "Information" },
  off: { icon: MinusCircleIcon, label: "Offline" },
}

/** One state, three signals: colour, icon shape and a word. */
export function Status({ level, label, cell }: { level: Level; label?: string; cell?: boolean }) {
  const { icon: I, label: word } = stateMeta[level]
  return (
    <span className={`inline-flex items-center gap-2 font-medium whitespace-nowrap ${levelText[level]} ${cell ? "" : `rounded-md px-2 py-0.5 text-xs ${levelSoft[level]}`}`}>
      <I className="size-4" aria-hidden />
      {tx(label ?? word)}
    </span>
  )
}

export function Button({ variant = "secondary", className = "", children, ...p }: { variant?: "primary" | "secondary" | "ghost" | "danger" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const look = {
    primary: "bg-accent text-accent-ink hover:bg-accent-hover",
    secondary: "bg-surface text-fg border border-line2 hover:bg-raised hover:border-fg3",
    ghost: "text-accent hover:text-accent-hover",
    danger: "text-crit border border-crit hover:bg-crit-soft",
  }[variant]
  return <button type="button" {...p} className={`inline-flex h-9 max-sm:h-11 items-center justify-center gap-2 rounded-control px-4 font-medium whitespace-nowrap transition-colors disabled:opacity-50 ${look} ${className}`}>{Children.map(children, tx)}</button>
}

export function IconButton({ label, icon: I, className = "", ...p }: { label: string; icon: Icon } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" aria-label={t(label)} title={t(label)} {...p} className={`inline-flex size-9 max-sm:size-11 items-center justify-center rounded-control text-fg2 hover:text-fg disabled:opacity-30 ${className}`}>
      <I className="size-5" aria-hidden />
    </button>
  )
}

export interface PanelAction { label: string; onClick: () => void }

/** Title left, three-dot menu right, body at the height of its content. */
/** Grey lines where content is on its way, so that nothing claims to be empty and the page does not jump when it comes. */
export function Skeleton({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div role="status" aria-label={t("Loading…")} className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => <div key={i} className="h-8 animate-pulse rounded-control bg-raised" style={{ width: `${100 - (i % 3) * 15}%` }} />)}
    </div>
  )
}

/** A page whose record is on its way: its title and two panels, in grey. */
export function PageSkeleton() {
  return (
    <div role="status" aria-label={t("Loading…")} className="flex flex-col gap-4">
      <div className="h-8 w-64 animate-pulse rounded-control bg-raised" />
      <div className="h-4 w-96 max-w-full animate-pulse rounded-control bg-raised" />
      <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1">
        {[0, 1].map((i) => <div key={i} className="h-64 animate-pulse rounded-panel border border-line bg-surface" />)}
      </div>
    </div>
  )
}

/** `help` explains the panel behind an ⓘ in its header; `footer` is for what changes, such as a state.
 *  `loading` shows grey lines until the data comes. */
export function Panel({ title, badge, actions, children, footer, help, flush, edit, loading }: { title: string; badge?: ReactNode; actions?: PanelAction[]; children: ReactNode; footer?: ReactNode; help?: string; flush?: boolean; edit?: ReactNode; loading?: boolean }) {
  const [open, setOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  return (
    <section className={`rounded-panel border bg-surface ${edit ? "border-dashed border-line2" : "border-line"}`} aria-label={t(title)}>
      <header className="flex h-11 items-center gap-1 border-b border-line pl-4 pr-2">
        <h2 className="mr-auto text-[14px] leading-5 font-medium">{t(title)}</h2>
        {badge && <span className="mr-2">{badge}</span>}
        {help && <IconButton label="About this panel" icon={InformationCircleIcon} aria-expanded={helpOpen} className={helpOpen ? "text-accent" : ""} onClick={() => setHelpOpen(!helpOpen)} />}
        {actions?.length ? (
          <div className="relative">
            <IconButton label={t("{title} menu", { title: t(title) })} icon={EllipsisVerticalIcon} aria-expanded={open} onClick={() => setOpen(!open)} />
            {open && (
              <div className="absolute right-0 top-11 z-20 min-w-44 rounded-panel border border-line2 bg-surface p-2" role="menu">
                {actions.map((a) => (
                  <button key={a.label} role="menuitem" className="block h-9 max-sm:h-11 w-full rounded-control px-3 text-left text-fg2 hover:bg-raised hover:text-fg" onClick={() => { setOpen(false); a.onClick() }}>{t(a.label)}</button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </header>
      {help && helpOpen && <p className="border-b border-line bg-raised/40 px-4 py-2 text-[13px] text-fg2">{tx(help)}</p>}
      {edit && <div className="flex justify-end border-b border-line px-2">{edit}</div>}
      {/* Flush panels put tables against the header line; anything else first gets the room it needs, unless marked data-flush. */}
      <div className={flush ? "[&>:first-child:not(:has(table)):not([data-flush])]:pt-4" : "p-4"}>{loading ? <Skeleton className={flush ? "px-4 pb-4" : ""} /> : children}</div>
      {footer && <footer className="border-t border-line px-4 py-2.5 text-[13px] text-fg3">{tx(footer)}</footer>}
    </section>
  )
}

export function Stat({ label, value, sub, level }: { label: string; value: ReactNode; sub?: ReactNode; level?: Level }) {
  return (
    <div>
      <div className="text-xs text-fg3">{t(label)}</div>
      <div className={`mt-1 text-2xl font-medium ${level ? levelText[level] : ""}`}>{value}</div>
      {sub && <div className="text-xs text-fg3">{tx(sub)}</div>}
    </div>
  )
}

/** 180° arc coloured by the threshold reached. */
export function Gauge({ label, value, warn = 75, crit = 90 }: { label: string; value: number; warn?: number; crit?: number }) {
  const R = 54, len = Math.PI * R, v = Math.min(100, Math.max(0, value))
  const arc = `M ${70 - R} 70 A ${R} ${R} 0 0 1 ${70 + R} 70`
  return (
    <figure className="flex flex-col items-center">
      <div className="relative">
        <svg viewBox="0 0 140 84" className="w-36" role="img" aria-label={`${t(label)} ${v.toFixed(0)} %`}>
          <path d={arc} fill="none" stroke="var(--color-line)" strokeWidth="9" strokeLinecap="round" />
          {v > 0 && <path d={arc} fill="none" stroke={`var(--color-${levelOf(v, warn, crit)})`} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(v / 100) * len} ${len}`} />}
          <text x="11" y="82" fontSize="9" fill="var(--color-fg3)" textAnchor="middle">0</text>
          <text x="127" y="82" fontSize="9" fill="var(--color-fg3)" textAnchor="middle">100</text>
        </svg>
        <div className="absolute inset-x-0 top-[38px] text-center text-[26px] leading-8 font-medium">{v.toFixed(0)} %</div>
      </div>
      <figcaption className="mt-1 text-[13px] text-fg2">{t(label)}</figcaption>
    </figure>
  )
}

/** Horizontal fill, coloured by thresholds. */
export function Meter({ pct, warn = 75, crit = 90 }: { pct: number; warn?: number; crit?: number }) {
  return <div className="h-1.5 overflow-hidden rounded-full bg-raised"><div className={`h-full rounded-full ${levelBg[levelOf(pct, warn, crit)]}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></div>
}

/** Fills with the work done. Unlike a Meter, a full bar is good news. */
export function Progress({ pct, label, thin }: { pct: number; label: string; thin?: boolean }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className={`overflow-hidden rounded-full bg-raised ${thin ? "h-2" : "h-5"}`}>
      <div className="h-full rounded-full bg-ok transition-[width] duration-500" style={{ width: `${pct}%` }} />
    </div>
  )
}

export function BarGauge({ rows, warn = 75, crit = 90 }: { rows: { label: string; pct: number }[]; warn?: number; crit?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {rows.map((r) => {
        const l = levelOf(r.pct, warn, crit)
        return (
          <div key={r.label} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_auto] items-center gap-3 text-[13px]">
            <span className="truncate text-fg2" title={r.label}>{r.label}</span>
            <Meter pct={r.pct} warn={warn} crit={crit} />
            <span className={`w-28 text-right font-medium whitespace-nowrap ${levelText[l]}`}>{r.pct.toFixed(0)} % · {stateMeta[l].label === "Operational" ? "OK" : t(stateMeta[l].label)}</span>
          </div>
        )
      })}
    </div>
  )
}

export interface Series { name: string; color: string; values: { t: number; v: number }[]; unit?: string }

/**
 * Hairline and readout over a plot. Snaps to the nearest sample and lists every series
 * there, so the pointer never has to land on a line. The arrow keys do the same.
 */
export function ChartHover({ series, top, unit, colors, format }: { series: { name: string; values: { t: number; v: number }[] }[]; top: number; unit: string; colors: string[]; format?: (v: number) => string }) {
  const [t, setT] = useState<number>()
  const times = [...new Set(series.flatMap((s) => s.values.map((p) => p.t)))].sort((a, b) => a - b)
  const t0 = times[0], t1 = times[times.length - 1]
  const share = (at: number) => ((at - t0) / (t1 - t0 || 1)) * 100
  const follow = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const at = t0 + ((e.clientX - box.left) / box.width) * (t1 - t0)
    setT(times.reduce((a, b) => (Math.abs(b - at) < Math.abs(a - at) ? b : a)))
  }
  const step = (e: React.KeyboardEvent) => {
    const by = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0
    if (!by) return
    e.preventDefault()
    setT(times[Math.max(0, Math.min(times.length - 1, (t == null ? times.length : times.indexOf(t)) + by))])
  }
  const label = (at: number) => new Date(at * 1000).toLocaleString(lang, { ...(t1 - t0 > 86400 ? { day: "numeric", month: "short" } : {}), hour: "2-digit", minute: "2-digit" })
  const flip = t != null && share(t) > 55
  return (
    <div tabIndex={0} role="group" aria-label={tr("Chart values. Use the arrow keys to move in time.")} className="absolute inset-0 touch-pan-y" onPointerMove={follow} onPointerDown={follow} onPointerLeave={(e) => { if (e.pointerType === "mouse") setT(undefined) }} onBlur={() => setT(undefined)} onKeyDown={step}>
      {t != null && (
        <>
          <div className="pointer-events-none absolute inset-y-0 w-px bg-fg3" style={{ left: `${share(t)}%` }} />
          {samplesAt(series, t).map(({ series: s, point }, i) => <span key={s.name} className="pointer-events-none absolute size-2 -translate-1/2 rounded-full border border-surface" style={{ left: `${share(t)}%`, top: `${100 - (Math.min(point.v, top) / top) * 100}%`, background: colors[i] }} />)}
          <div role="status" className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-box border border-line2 bg-raised px-3 py-2 text-[13px] whitespace-nowrap" style={flip ? { right: `calc(${100 - share(t)}% + 8px)` } : { left: `calc(${share(t)}% + 8px)` }}>
            <div className="mb-1 text-xs text-fg3">{label(t)}</div>
            {samplesAt(series, t).map(({ series: s, point }, i) => (
              <div key={s.name} className="flex items-center gap-2">
                <span className="inline-block h-0.5 w-3" style={{ background: colors[i] }} />
                <span className="mr-auto pr-3 text-fg2">{s.name}</span>
                <span className="font-medium">{format ? format(point.v) : `${fmt.num(point.v, point.v < 10 ? 1 : 0)}${unit}`}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Time series with a legend table: mean, max, last. `max` defaults to 100 for
 * percentages; pass `format` for other units, and `fill={false}` for bare lines.
 */
export function TimeSeries({ series, max = 100, unit = " %", format, fill = true, compact }: { series: Series[]; max?: number; unit?: string; format?: (v: number) => string; fill?: boolean; compact?: boolean }) {
  const W = 600, H = 180
  const show = format ?? ((v: number) => `${v.toFixed(0)}${unit}`)
  const all = series.flatMap((s) => s.values)
  const drawn = series.filter((s) => s.values.length)
  if (all.length < 2) return <Empty>{t("Not enough data yet.")}</Empty>
  const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t))
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W, y = (v: number) => H - (Math.min(v, max) / max) * H
  const clock = (t: number) => t1 - t0 > 2 * 86400 ? new Date(t * 1000).toLocaleDateString(lang, { day: "numeric", month: "short" }) : new Date(t * 1000).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })
  return (
    <div>
      <div className={`grid gap-2 ${format ? "grid-cols-[64px_1fr]" : "grid-cols-[32px_1fr]"}`}>
        <div className="flex h-44 flex-col justify-between text-right text-xs text-fg3" aria-hidden><span>{format ? format(max) : max}</span><span>{format ? format(max / 2) : max / 2}</span><span>0</span></div>
        <div className="relative h-44">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-44 w-full" role="img" aria-label={t("Chart of {names}", { names: series.map((s) => s.name).join(", ") })}>
            {[0, 0.5, 1].map((f) => <line key={f} x1="0" x2={W} y1={f * H} y2={f * H} stroke="var(--color-line)" vectorEffect="non-scaling-stroke" />)}
            {series.map((s) => {
              const line = s.values.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ")
              const last = s.values[s.values.length - 1], first = s.values[0]
              return (
                <g key={s.name}>
                  {fill && <path d={`${line} L${x(last.t)} ${H} L${x(first.t)} ${H} Z`} fill={s.color} fillOpacity="0.14" />}
                  <path d={line} fill="none" stroke={s.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                </g>
              )
            })}
          </svg>
          <ChartHover series={drawn} top={max} unit={unit} format={format} colors={drawn.map((s) => s.color)} />
        </div>
      </div>
      <div className={`mt-2 flex justify-between text-xs text-fg3 ${format ? "ml-[72px]" : "ml-10"}`}><span>{clock(t0)}</span><span>{clock((t0 + t1) / 2)}</span><span>{t("Now")}</span></div>
      {!compact && <table className="mt-3 w-full border-t border-line text-[13px]">
        <thead className="text-xs text-fg3"><tr><th className="py-2 text-left font-normal">{t("Series")}</th><th className="text-right font-normal">{t("Mean")}</th><th className="text-right font-normal">{t("Max")}</th><th className="text-right font-normal">{t("Last")}</th></tr></thead>
        <tbody>
          {series.map((s) => {
            const vs = s.values.map((p) => p.v)
            return (
              <tr key={s.name}>
                <td className="py-1"><span className="mr-2 inline-block h-0.5 w-3 align-middle" style={{ background: s.color }} />{s.name}</td>
                <td className="text-right text-fg2">{vs.length ? show(vs.reduce((a, b) => a + b, 0) / vs.length) : "—"}</td>
                <td className="text-right text-fg2">{vs.length ? show(Math.max(...vs)) : "—"}</td>
                <td className="text-right font-medium">{vs.length ? show(vs[vs.length - 1]) : "—"}</td>
              </tr>
            )
          })}
        </tbody>
      </table>}
    </div>
  )
}

/** Below 640 px the CSS turns rows into touch lists, using `data-label` for headers. */
export function Table({ head: raw, children, sort, onSort }: { head: ReactNode[]; children: ReactNode; sort?: { col: number; desc: boolean }; onSort?: (col: number) => void }) {
  const head = raw.map(tx)
  const rows = Children.map(children, (row) => {
    if (!isValidElement(row)) return row
    const r = row as ReactElement<{ children?: ReactNode }>
    return cloneElement(r, {}, Children.toArray(r.props.children).map((cell, i) => (isValidElement(cell) ? cloneElement(cell as ReactElement<any>, { "data-label": head[i] }) : cell)))
  })
  return (
    <div className="rt-box overflow-x-auto max-sm:overflow-visible">
      <table className="rt w-full text-left">
        <thead className="border-b border-line text-xs text-fg3"><tr>{head.map((h, i) => {
          const active = sort?.col === i
          const Arrow = sort?.desc ? ArrowDownIcon : ArrowUpIcon
          return (
            <th key={i} scope="col" aria-sort={active ? (sort.desc ? "descending" : "ascending") : undefined} className="h-9 px-3 font-normal first:pl-4 whitespace-nowrap">
              {onSort && h ? <button type="button" className={`inline-flex h-8 items-center gap-1 font-medium hover:text-fg ${active ? "text-fg" : ""}`} onClick={() => onSort(i)}>{h}{active && <Arrow className="size-3" aria-hidden />}</button> : h}
            </th>
          )
        })}</tr></thead>
        <tbody className="divide-y divide-line">{rows}</tbody>
      </table>
    </div>
  )
}

export const Td = ({ children, className = "", mono, ...p }: { children?: ReactNode; className?: string; mono?: boolean } & React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td {...p} className={`h-9 px-3 first:pl-4 ${mono ? "font-mono text-[13px] text-fg2" : ""} ${className}`}>{children}</td>
)

export const StateCell = ({ level, label, ...p }: { level: Level; label?: string } & React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td {...p} className="h-9 px-3"><Status cell level={level} label={label} /></td>
)

export const Empty = ({ children }: { children: ReactNode }) => <p className="py-2 text-fg3">{tx(children)}</p>
export const Mono = ({ children, className = "" }: { children: ReactNode; className?: string }) => <span className={`font-mono text-[13px] ${className}`}>{children}</span>
export const ErrorNote = ({ children }: { children: ReactNode }) => (children ? <p role="alert" className="text-crit">{tx(children)}</p> : null)

// 16 px on phones: iOS zooms the page into any smaller input.
const fieldBase = "max-sm:text-base w-full border border-line2 bg-raised px-4 text-fg placeholder:text-fg3 hover:border-fg3"
const fieldClass = `field h-9 max-sm:h-11 rounded-control ${fieldBase}`

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[13px] text-fg2">{t(label)}</label>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-fg3">{tx(hint)}</p>}
    </div>
  )
}

/** A search field for a toolbar: the magnifier says what it is, so no label shows above it. */
export function SearchInput({ label = "Search", className = "w-64 max-sm:w-full", placeholder, ...p }: { label?: string; className?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={`relative ${className}`}>
      <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg3" aria-hidden />
      <input type="search" aria-label={t(label)} placeholder={t(placeholder ?? "Search…")} {...p} className="h-9 max-sm:h-11 w-full rounded-control border border-line2 bg-surface pl-9 pr-3 placeholder:text-fg3 hover:border-fg3" />
    </div>
  )
}

export function Input({ label, hint, ...p }: { label: string; hint?: ReactNode } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <Field label={label} hint={hint}>{(id) => <input id={id} {...p} className={fieldClass} />}</Field>
}

export function TextArea({ label, hint, ...p }: { label: string; hint?: ReactNode } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <Field label={label} hint={hint}>{(id) => <textarea id={id} rows={6} {...p} className={`${fieldBase} rounded-box py-2 font-mono text-[13px]`} />}</Field>
}

export function Select({ label, options, hint, ...p }: { label: string; hint?: ReactNode; options: (string | { value: string; label: string })[] } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <select id={id} {...p} className={fieldClass}>
          {options.map((o) => { const { value, label } = typeof o === "string" ? { value: o, label: o } : o; return <option key={value} value={value}>{t(label)}</option> })}
        </select>
      )}
    </Field>
  )
}

/** A string label is translated; pass an element for a name that must show as typed. */
export function Check({ label, hint, ...p }: { label: ReactNode; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <label className="flex min-h-9 max-sm:min-h-11 items-center gap-3 text-fg2"><input type="checkbox" className="switch shrink-0" {...p} /><span>{tx(label)}{hint && <span className="block text-xs text-fg3">{t(hint)}</span>}</span></label>
}

/** The guide's variable control: label on raised, value on surface. A `raw` option, such as a tag, shows as typed. */
export function Variable({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string; raw?: boolean }[] }) {
  const id = useId()
  return (
    <div className="flex h-9 max-sm:h-11 items-stretch overflow-hidden rounded-control border border-line2">
      <label htmlFor={id} className="flex items-center bg-raised pl-4 pr-3 text-fg2">{t(label)}</label>
      <div className="relative flex items-center bg-surface">
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-full appearance-none bg-transparent pl-3 pr-8 text-fg">
          {options.map((o) => <option key={o.value} value={o.value} className="bg-surface">{o.raw ? o.label : t(o.label)}</option>)}
        </select>
        <ChevronUpDownIcon className="pointer-events-none absolute right-2 size-4 text-fg2" aria-hidden />
      </div>
    </div>
  )
}

export function RangeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId()
  return (
    <div className="relative flex h-9 max-sm:h-11 items-center rounded-control border border-line2 bg-surface">
      <ClockIcon className="pointer-events-none absolute left-3 size-5 text-fg2" aria-hidden />
      <label htmlFor={id} className="sr-only">{t("Period")}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-full appearance-none bg-transparent pl-10 pr-9 text-fg">
        {[["1h", "Last hour"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["90d", "Last 90 days"], ["180d", "Last 180 days"], ["365d", "Last year"]].map(([v, l]) => <option key={v} value={v} className="bg-surface">{t(l)}</option>)}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-3 size-4 text-fg2" aria-hidden />
    </div>
  )
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return (
    <dialog ref={ref} onClose={onClose} aria-label={t(title)} className={`m-auto max-h-[calc(100dvh-40px)] w-[calc(100vw-40px)] overflow-y-auto ${wide ? "max-w-5xl" : "max-w-xl"} rounded-panel border border-line2 bg-surface text-fg backdrop:bg-black/60`}>
      <header className="flex h-11 items-center justify-between border-b border-line pl-4 pr-2">
        <h2 className="text-[15px] font-medium">{t(title)}</h2>
        <IconButton label="Close" icon={XMarkIcon} onClick={() => ref.current?.close()} />
      </header>
      <div className="flex flex-col gap-4 p-5">{children}</div>
    </dialog>
  )
}

interface Asked { message: string; action: string; danger?: boolean; info?: boolean; done: (ok: boolean) => void }
let showAsk: ((a: Asked) => void) | null = null

/** Styled stand-in for window.confirm; resolves true when confirmed. */
export const ask = (message: string, opts: { action?: string; danger?: boolean } = {}) =>
  new Promise<boolean>((done) => (showAsk ? showAsk({ message: t(message), action: t(opts.action ?? "Confirm"), danger: opts.danger, done }) : done(window.confirm(t(message)))))

/** Styled stand-in for window.alert. */
export const tell = (message: string) =>
  new Promise<void>((done) => (showAsk ? showAsk({ message: t(message), action: "OK", info: true, done: () => done() }) : (window.alert(t(message)), done())))

/** Hosts the dialogs opened by ask() and tell(); mounted once next to the app. */
export function Dialogs() {
  const [a, setA] = useState<Asked | null>(null)
  const ref = useRef<HTMLDialogElement>(null)
  const answer = useRef(false)
  useEffect(() => { showAsk = setA; return () => { showAsk = null } }, [])
  useEffect(() => { if (a) { answer.current = false; ref.current?.showModal() } }, [a])
  if (!a) return null
  const close = (ok: boolean) => { answer.current = ok; ref.current?.close() }
  const Mark = a.danger ? ExclamationTriangleIcon : InformationCircleIcon
  return (
    <dialog ref={ref} onClose={() => { a.done(answer.current); setA(null) }} aria-label={t(a.info ? "Notice" : "Confirm")} className="m-auto w-[calc(100vw-40px)] max-w-md rounded-panel border border-line2 bg-surface text-fg backdrop:bg-black/60">
      <div className="flex gap-3 p-5">
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${a.danger ? "bg-crit-soft text-crit" : "bg-accent-soft text-accent"}`}><Mark className="size-5" aria-hidden /></span>
        <p className="pt-1.5 whitespace-pre-wrap text-fg2">{a.message}</p>
      </div>
      <div className="flex justify-end gap-3 border-t border-line px-5 py-3">
        {!a.info && <Button autoFocus={a.danger} onClick={() => close(false)}>{t("Cancel")}</Button>}
        <Button autoFocus={!a.danger} variant={a.danger ? "danger" : "primary"} onClick={() => close(true)}>{a.action}</Button>
      </div>
    </dialog>
  )
}

export function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <pre className="overflow-x-auto rounded-box border border-line2 bg-bg p-3 font-mono text-[13px] whitespace-pre-wrap break-all text-fg2">{text}</pre>
      <div><Button onClick={async () => { await navigator.clipboard.writeText(text); setDone(true) }}>{t(done ? "Copied" : "Copy")}</Button></div>
    </div>
  )
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className="inline-flex flex-wrap gap-0.5 rounded-control border border-line2 bg-bg p-0.5">
      {tabs.map((tab) => (
        <button key={tab.id} type="button" role="tab" aria-selected={tab.id === value} onClick={() => onChange(tab.id)} className={`h-8 max-sm:h-10 rounded-[8px] px-3 ${tab.id === value ? "bg-raised text-fg" : "text-fg2 hover:text-fg"}`}>{t(tab.label)}</button>
      ))}
    </div>
  )
}


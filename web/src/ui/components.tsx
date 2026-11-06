import {
  CheckCircleIcon, ChevronDownIcon, ChevronUpDownIcon, ClockIcon, EllipsisVerticalIcon, ExclamationTriangleIcon,
  InformationCircleIcon, MinusCircleIcon, XCircleIcon, XMarkIcon,
} from "@heroicons/react/24/outline"
import { Children, cloneElement, type ComponentType, isValidElement, type ReactElement, type ReactNode, type SVGProps, useEffect, useId, useRef, useState } from "react"
import { type Level, levelBg, levelOf, levelSoft, levelText } from "./lib"

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
    <span className={`inline-flex items-center gap-2 font-medium whitespace-nowrap ${levelText[level]} ${cell ? "" : `rounded-full px-3 py-1 text-[13px] ${levelSoft[level]}`}`}>
      <I className="size-4" aria-hidden />
      {label ?? word}
    </span>
  )
}

export function Button({ variant = "secondary", className = "", ...p }: { variant?: "primary" | "secondary" | "ghost" | "danger" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const look = {
    primary: "bg-accent text-accent-ink hover:bg-accent-hover",
    secondary: "bg-raised text-fg border border-line2 hover:border-fg3",
    ghost: "text-accent hover:text-accent-hover",
    danger: "text-crit border border-crit hover:bg-crit-soft",
  }[variant]
  return <button type="button" {...p} className={`inline-flex h-9 max-sm:h-11 items-center justify-center gap-2 rounded-control px-4 font-medium whitespace-nowrap transition-colors disabled:opacity-50 ${look} ${className}`} />
}

export function IconButton({ label, icon: I, className = "", ...p }: { label: string; icon: Icon } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" aria-label={label} title={label} {...p} className={`inline-flex size-9 max-sm:size-11 items-center justify-center rounded-control text-fg2 hover:text-fg disabled:opacity-30 ${className}`}>
      <I className="size-5" aria-hidden />
    </button>
  )
}

export interface PanelAction { label: string; onClick: () => void }

/** Title left, three-dot menu right, body at the height of its content. */
export function Panel({ title, badge, actions, children, footer, flush, edit }: { title: string; badge?: ReactNode; actions?: PanelAction[]; children: ReactNode; footer?: ReactNode; flush?: boolean; edit?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <section className={`rounded-panel border bg-surface ${edit ? "border-dashed border-line2" : "border-line"}`} aria-label={title}>
      <header className="flex h-11 items-center justify-between gap-3 pl-4 pr-2">
        <h2 className="text-[15px] leading-[22px] font-medium">{title}</h2>
        {badge && <span className="mr-3">{badge}</span>}
        {actions?.length ? (
          <div className="relative">
            <IconButton label={`${title} menu`} icon={EllipsisVerticalIcon} aria-expanded={open} onClick={() => setOpen(!open)} />
            {open && (
              <div className="absolute right-0 top-11 z-20 min-w-44 rounded-panel border border-line2 bg-surface p-2" role="menu">
                {actions.map((a) => (
                  <button key={a.label} role="menuitem" className="block h-9 max-sm:h-11 w-full rounded-control px-3 text-left text-fg2 hover:bg-raised hover:text-fg" onClick={() => { setOpen(false); a.onClick() }}>{a.label}</button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </header>
      {edit && <div className="flex justify-end border-b border-line px-2">{edit}</div>}
      <div className={flush ? "" : "px-4 pb-4"}>{children}</div>
      {footer && <footer className="border-t border-line px-4 py-2.5 text-[13px] text-fg3">{footer}</footer>}
    </section>
  )
}

export function Stat({ label, value, sub, level }: { label: string; value: ReactNode; sub?: ReactNode; level?: Level }) {
  return (
    <div>
      <div className="text-[13px] text-fg2">{label}</div>
      <div className={`mt-1 text-[26px] leading-[32px] font-medium ${level ? levelText[level] : ""}`}>{value}</div>
      {sub && <div className="text-xs text-fg3">{sub}</div>}
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
        <svg viewBox="0 0 140 84" className="w-36" role="img" aria-label={`${label} ${v.toFixed(0)} percent`}>
          <path d={arc} fill="none" stroke="var(--color-line)" strokeWidth="9" strokeLinecap="round" />
          {v > 0 && <path d={arc} fill="none" stroke={`var(--color-${levelOf(v, warn, crit)})`} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(v / 100) * len} ${len}`} />}
          <text x="11" y="82" fontSize="9" fill="var(--color-fg3)" textAnchor="middle">0</text>
          <text x="127" y="82" fontSize="9" fill="var(--color-fg3)" textAnchor="middle">100</text>
        </svg>
        <div className="absolute inset-x-0 top-[38px] text-center text-[26px] leading-8 font-medium">{v.toFixed(0)} %</div>
      </div>
      <figcaption className="mt-1 text-[13px] text-fg2">{label}</figcaption>
    </figure>
  )
}

/** Horizontal fill, coloured by thresholds. */
export function Meter({ pct, warn = 75, crit = 90 }: { pct: number; warn?: number; crit?: number }) {
  return <div className="h-3 overflow-hidden rounded-full bg-raised"><div className={`h-full rounded-full ${levelBg[levelOf(pct, warn, crit)]}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></div>
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
            <span className={`w-28 text-right font-medium whitespace-nowrap ${levelText[l]}`}>{r.pct.toFixed(0)} % · {stateMeta[l].label === "Operational" ? "OK" : stateMeta[l].label}</span>
          </div>
        )
      })}
    </div>
  )
}

export interface Series { name: string; color: string; values: { t: number; v: number }[]; unit?: string }

/** Time series with a legend table: mean, max, last. At most one per screen. */
export function TimeSeries({ series, max = 100, unit = " %" }: { series: Series[]; max?: number; unit?: string }) {
  const W = 600, H = 180
  const all = series.flatMap((s) => s.values)
  if (all.length < 2) return <Empty>Not enough data yet.</Empty>
  const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t))
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W, y = (v: number) => H - (Math.min(v, max) / max) * H
  const clock = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return (
    <div>
      <div className="grid grid-cols-[32px_1fr] gap-2">
        <div className="flex h-44 flex-col justify-between text-right text-xs text-fg3" aria-hidden><span>{max}</span><span>{max / 2}</span><span>0</span></div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-44 w-full" role="img" aria-label={`Chart of ${series.map((s) => s.name).join(" and ")}`}>
          {[0, 0.5, 1].map((f) => <line key={f} x1="0" x2={W} y1={f * H} y2={f * H} stroke="var(--color-line)" vectorEffect="non-scaling-stroke" />)}
          {series.map((s) => {
            const line = s.values.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ")
            const last = s.values[s.values.length - 1], first = s.values[0]
            return (
              <g key={s.name}>
                <path d={`${line} L${x(last.t)} ${H} L${x(first.t)} ${H} Z`} fill={s.color} fillOpacity="0.14" />
                <path d={line} fill="none" stroke={s.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              </g>
            )
          })}
        </svg>
      </div>
      <div className="mt-2 ml-10 flex justify-between text-xs text-fg3"><span>{clock(t0)}</span><span>{clock((t0 + t1) / 2)}</span><span>Now</span></div>
      <table className="mt-3 w-full border-t border-line text-[13px]">
        <thead className="text-xs text-fg3"><tr><th className="py-2 text-left font-normal">Series</th><th className="text-right font-normal">Mean</th><th className="text-right font-normal">Max</th><th className="text-right font-normal">Last</th></tr></thead>
        <tbody>
          {series.map((s) => {
            const vs = s.values.map((p) => p.v)
            return (
              <tr key={s.name}>
                <td className="py-1"><span className="mr-2 inline-block h-0.5 w-3 align-middle" style={{ background: s.color }} />{s.name}</td>
                <td className="text-right text-fg2">{(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(0)}{unit}</td>
                <td className="text-right text-fg2">{Math.max(...vs).toFixed(0)}{unit}</td>
                <td className="text-right font-medium">{vs[vs.length - 1].toFixed(0)}{unit}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Below 640 px the CSS turns rows into touch lists, using `data-label` for headers. */
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  const rows = Children.map(children, (row) => {
    if (!isValidElement(row)) return row
    const r = row as ReactElement<{ children?: ReactNode }>
    return cloneElement(r, {}, Children.toArray(r.props.children).map((cell, i) => (isValidElement(cell) ? cloneElement(cell as ReactElement<any>, { "data-label": head[i] }) : cell)))
  })
  return (
    <div className="overflow-x-auto max-sm:overflow-visible">
      <table className="rt w-full text-left">
        <thead className="bg-raised text-xs text-fg2"><tr>{head.map((h, i) => <th key={i} scope="col" className="h-8 px-3 font-medium first:pl-4 whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{rows}</tbody>
      </table>
    </div>
  )
}

export const Td = ({ children, className = "", mono, ...p }: { children?: ReactNode; className?: string; mono?: boolean } & React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td {...p} className={`h-9 px-3 first:pl-4 ${mono ? "font-mono text-[13px] text-fg2" : ""} ${className}`}>{children}</td>
)

/** Fully tinted state cell, as in the guide's tables. */
export const StateCell = ({ level, label, ...p }: { level: Level; label?: string } & React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td {...p} className={`h-9 px-3 ${levelSoft[level]}`}><Status cell level={level} label={label} /></td>
)

export const Empty = ({ children }: { children: ReactNode }) => <p className="py-2 text-fg3">{children}</p>
export const Mono = ({ children, className = "" }: { children: ReactNode; className?: string }) => <span className={`font-mono text-[13px] ${className}`}>{children}</span>
export const ErrorNote = ({ children }: { children: ReactNode }) => (children ? <p role="alert" className="text-crit">{children}</p> : null)

// 16 px on phones: iOS zooms the page into any smaller input.
const fieldBase = "max-sm:text-base w-full border border-line2 bg-raised px-4 text-fg placeholder:text-fg3 hover:border-fg3"
const fieldClass = `field h-9 max-sm:h-11 rounded-control ${fieldBase}`

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[13px] text-fg2">{label}</label>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-fg3">{hint}</p>}
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
          {options.map((o) => { const { value, label } = typeof o === "string" ? { value: o, label: o } : o; return <option key={value} value={value}>{label}</option> })}
        </select>
      )}
    </Field>
  )
}

export function Check({ label, ...p }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <label className="flex min-h-9 max-sm:min-h-11 items-center gap-3 text-fg2"><input type="checkbox" className="switch" {...p} />{label}</label>
}

/** The guide's variable control: label on raised, value on surface. */
export function Variable({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const id = useId()
  return (
    <div className="flex h-9 max-sm:h-11 items-stretch overflow-hidden rounded-control border border-line2">
      <label htmlFor={id} className="flex items-center bg-raised pl-4 pr-3 text-fg2">{label}</label>
      <div className="relative flex items-center bg-surface">
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-full appearance-none bg-transparent pl-3 pr-8 text-fg">
          {options.map((o) => <option key={o.value} value={o.value} className="bg-surface">{o.label}</option>)}
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
      <label htmlFor={id} className="sr-only">Period</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-full appearance-none bg-transparent pl-10 pr-9 text-fg">
        {[["1h", "Last hour"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["90d", "Last 90 days"], ["180d", "Last 180 days"], ["365d", "Last year"]].map(([v, l]) => <option key={v} value={v} className="bg-surface">{l}</option>)}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-3 size-4 text-fg2" aria-hidden />
    </div>
  )
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return (
    <dialog ref={ref} onClose={onClose} aria-label={title} className={`m-auto max-h-[calc(100dvh-40px)] w-[calc(100vw-40px)] overflow-y-auto ${wide ? "max-w-5xl" : "max-w-xl"} rounded-panel border border-line2 bg-surface text-fg backdrop:bg-black/60`}>
      <header className="flex h-11 items-center justify-between border-b border-line pl-4 pr-2">
        <h2 className="text-[15px] font-medium">{title}</h2>
        <IconButton label="Close" icon={XMarkIcon} onClick={() => ref.current?.close()} />
      </header>
      <div className="flex flex-col gap-4 p-5">{children}</div>
    </dialog>
  )
}

export function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <pre className="overflow-x-auto rounded-box border border-line2 bg-bg p-3 font-mono text-[13px] whitespace-pre-wrap break-all text-fg2">{text}</pre>
      <div><Button onClick={async () => { await navigator.clipboard.writeText(text); setDone(true) }}>{done ? "Copied" : "Copy"}</Button></div>
    </div>
  )
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className="flex flex-wrap gap-2">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)} className={`h-9 max-sm:h-11 rounded-control px-4 ${t.id === value ? "bg-accent-soft text-accent" : "text-fg2 hover:bg-raised hover:text-fg"}`}>{t.label}</button>
      ))}
    </div>
  )
}


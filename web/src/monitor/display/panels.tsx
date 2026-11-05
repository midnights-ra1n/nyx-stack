import { ExclamationTriangleIcon } from "@heroicons/react/24/outline"
import { useEffect, useRef, useState } from "react"
import { BarGauge, Empty, Status } from "../../ui/components"
import { fmt, type Level, levelBg, levelSoft, levelText } from "../../ui/lib"
import { nextScroll, uptimeBar } from "./model"

const OVERALL: Record<string, string> = {
  ok: "All systems operational", warn: "Degraded performance", crit: "Service disruption", off: "No services selected",
}
const COLORS = ["var(--color-s1)", "var(--color-s2)", "var(--color-s3)", "var(--color-s4)", "var(--color-ok)", "var(--color-warn)"]
const dayName = (generated: number, back: number) => new Date((generated - back * 86400) * 1000).toLocaleDateString()

function Overall({ state }: { state: Level }) {
  return (
    <div className={`fit flex h-full items-center justify-center ${levelSoft[state]}`}>
      <div className={`flex items-center gap-3 px-4 font-medium ${levelText[state]}`} style={{ fontSize: "clamp(16px, min(45cqh, 4.5cqw), 72px)" }}>
        <span className={`size-[0.6em] shrink-0 rounded-full ${levelBg[state]}`} aria-hidden />
        {OVERALL[state]}
      </div>
    </div>
  )
}

function UptimeBars({ days, uptime, generated }: { days: (number | null)[]; uptime: number | null; generated: number }) {
  return (
    <div className="mt-1">
      <div className="flex h-5 gap-px" role="img" aria-label={uptime == null ? "No uptime data yet" : `${uptime} percent uptime over 30 days`}>
        {days.map((d, i) => <span key={i} className={`min-w-0 flex-1 rounded-[1px] ${uptimeBar(d)}`} title={`${dayName(generated, days.length - 1 - i)}: ${d == null ? "no data" : `${d} %`}`} />)}
      </div>
      <div className="mt-1 flex justify-between text-xs text-fg3"><span>30 days ago</span><span>{uptime == null ? "No data yet" : `${uptime} % uptime`}</span><span>Today</span></div>
    </div>
  )
}

function Services({ rows, generated }: { rows: any[]; generated: number }) {
  if (!rows?.length) return <Empty>No services selected.</Empty>
  return (
    <ul className="flex flex-col divide-y divide-line">
      {rows.map((r, i) => (
        <li key={i} className="py-2.5">
          <div className="flex items-center justify-between gap-3"><span className="truncate font-medium">{r.label}</span><Status cell level={r.state} /></div>
          {r.days && <UptimeBars days={r.days} uptime={r.uptime} generated={generated} />}
        </li>
      ))}
    </ul>
  )
}

function Tiles({ rows }: { rows: any[] }) {
  if (!rows?.length) return <Empty>Nothing selected.</Empty>
  return (
    <ul className="grid min-h-full auto-rows-fr grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
      {rows.map((r, i) => (
        <li key={i} className={`flex min-h-16 flex-col justify-center rounded-control px-3 py-2 ${levelSoft[r.state as Level]}`}>
          <span className="truncate font-medium" title={r.label}>{r.label}</span>
          <Status cell level={r.state} />
        </li>
      ))}
    </ul>
  )
}

function Spark({ values, level }: { values: number[]; level: Level }) {
  if (values.length < 2) return null
  const max = Math.max(...values, 1), W = 100, H = 30
  const line = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * W).toFixed(2)} ${(H - (v / max) * H * 0.9).toFixed(2)}`).join(" ")
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 w-full" aria-hidden>
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill={`var(--color-${level})`} fillOpacity="0.14" />
      <path d={line} fill="none" stroke={`var(--color-${level})`} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function BigNumber({ data }: { data: any }) {
  if (data == null) return <div className="flex h-full items-center justify-center text-fg3">No data</div>
  const value = Number.isInteger(data.value) ? data.value : Number(data.value).toFixed(data.value >= 100 ? 0 : 1)
  return (
    <div className="fit relative flex h-full items-center justify-center">
      <div className={`relative z-10 font-medium whitespace-nowrap ${levelText[data.level as Level]}`} style={{ fontSize: "clamp(22px, min(52cqh, 24cqw), 160px)", lineHeight: 1 }}>
        {value}<span className="ml-1 text-[0.45em] text-fg2">{data.unit}</span>
      </div>
      <Spark values={data.spark ?? []} level={data.level} />
    </div>
  )
}

const fixed = (rows: any[]) => rows.map((r) => ({ label: r.label, pct: r.value }))

/** All text lives in the SVG, so the gauge grows with its panel and reads from across a room. */
function ScalingGauge({ label, value, unit, level }: { label: string; value: number; unit: string; level: Level }) {
  const R = 54, len = Math.PI * R, share = unit === "%" ? Math.min(100, Math.max(0, value)) / 100 : 1
  const arc = `M ${70 - R} 66 A ${R} ${R} 0 0 1 ${70 + R} 66`
  return (
    <svg viewBox="0 0 140 90" className="h-full min-h-0 w-full min-w-0" role="img" aria-label={`${label} ${value.toFixed(0)} ${unit}`}>
      <path d={arc} fill="none" stroke="var(--color-line2)" strokeWidth="9" strokeLinecap="round" />
      {share > 0 && <path d={arc} fill="none" stroke={`var(--color-${level})`} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${share * len} ${len}`} />}
      <text x="70" y="62" textAnchor="middle" fontSize="24" fontWeight="500" fill="var(--color-fg)">{value.toFixed(0)}<tspan fontSize="11" fill="var(--color-fg2)"> {unit}</tspan></text>
      <text x="70" y="84" textAnchor="middle" fontSize="10" fill="var(--color-fg2)">{label}</text>
    </svg>
  )
}

function Gauges({ rows }: { rows: any[] }) {
  if (!rows?.length) return <Empty>No data.</Empty>
  return <div className="grid h-full auto-cols-fr grid-flow-col items-center gap-2 max-sm:grid-flow-row max-sm:grid-cols-2">{rows.map((r, i) => <ScalingGauge key={i} {...r} />)}</div>
}

function Chart({ data }: { data: any }) {
  const series = (data?.series ?? []).filter((s: any) => s.values.length > 1)
  const all = series.flatMap((s: any) => s.values)
  if (!all.length) return <div className="flex h-full items-center justify-center text-fg3">Not enough data yet</div>
  const W = 600, H = 200
  const t0 = Math.min(...all.map((p: any) => p.t)), t1 = Math.max(...all.map((p: any) => p.t))
  const top = data.unit === "%" ? 100 : Math.max(...all.map((p: any) => p.v)) * 1.15 || 1
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W
  const y = (v: number) => H - (Math.min(v, top) / top) * H
  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      <div className="grid min-h-0 flex-1 grid-cols-[auto_1fr] gap-2">
        <div className="flex flex-col justify-between text-right text-xs text-fg3" aria-hidden><span>{top.toFixed(0)}</span><span>0</span></div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full min-h-0 w-full" role="img" aria-label={`Chart of ${series.map((s: any) => s.name).join(", ")}`}>
          {[0, 0.5, 1].map((f) => <line key={f} x1="0" x2={W} y1={f * H} y2={f * H} stroke="var(--color-line)" vectorEffect="non-scaling-stroke" />)}
          {series.map((s: any, i: number) => (
            <path key={s.name} d={s.values.map((p: any, n: number) => `${n ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ")} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      </div>
      <ul className="flex max-h-10 flex-wrap gap-x-4 overflow-hidden text-xs text-fg2">
        {series.map((s: any, i: number) => <li key={s.name} className="whitespace-nowrap"><span className="mr-1.5 inline-block h-0.5 w-3 align-middle" style={{ background: COLORS[i % COLORS.length] }} />{s.name} <span className="font-medium text-fg">{s.values[s.values.length - 1].v.toFixed(data.unit === "%" ? 0 : 1)} {data.unit}</span></li>)}
      </ul>
    </div>
  )
}

function Alerts({ rows }: { rows: any[] | null }) {
  if (!rows?.length) return <div className="flex h-full items-center justify-center text-ok">No open alerts</div>
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((a, i) => (
        <li key={i} className={`flex gap-2 rounded-control px-3 py-2 ${levelSoft[a.severity as Level] ?? levelSoft.warn}`}>
          <ExclamationTriangleIcon className={`mt-0.5 size-4 shrink-0 ${levelText[a.severity as Level] ?? levelText.warn}`} aria-hidden />
          <span className="min-w-0"><span className="block">{a.message}</span><span className="text-xs text-fg3">Since {fmt.date(a.since)}</span></span>
        </li>
      ))}
    </ul>
  )
}

function Clock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id) }, [])
  return (
    <div className="fit flex h-full flex-col items-center justify-center">
      <div className="font-medium" style={{ fontSize: "clamp(20px, min(48cqh, 20cqw), 120px)", lineHeight: 1.1 }}>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
      <div className="text-fg2" style={{ fontSize: "clamp(12px, 14cqh, 32px)" }}>{now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</div>
    </div>
  )
}

function Body({ p, overall, generated }: { p: any; overall: Level; generated: number }) {
  switch (p.type) {
    case "overall": return <Overall state={overall} />
    case "services": return <Services rows={p.data} generated={generated} />
    case "tiles": return <Tiles rows={p.data} />
    case "stat": return <BigNumber data={p.data} />
    case "gauge": return <Gauges rows={p.data} />
    case "bars": return p.data?.length ? <BarGauge rows={fixed(p.data)} /> : <Empty>No data.</Empty>
    case "timeseries": return <Chart data={p.data} />
    case "alerts": return <Alerts rows={p.data} />
    case "text": return <p className="whitespace-pre-wrap">{p.text}</p>
    case "clock": return <Clock />
    default: return null
  }
}

const EDGE_TO_EDGE = ["overall"]
const PAGE_MS = 8000

/** Nobody can scroll a wall, so what does not fit comes up one page at a time. A jump, not a slide: moving text is hard to read from across a room. */
function useWallPaging(on: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const [label, setLabel] = useState("")
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => {
      const el = ref.current
      if (!el) return
      if (el.scrollHeight <= el.clientHeight + 1) { el.scrollTop = 0; setLabel(""); return }
      const box = el.getBoundingClientRect()
      const cut = [...(el.firstElementChild?.children ?? [])].find((c) => c.getBoundingClientRect().bottom > box.bottom + 1)
      // Rectangles are in zoomed pixels, scrollTop is not.
      const offset = cut ? (cut.getBoundingClientRect().top - box.top) * (el.clientHeight / box.height) : 0
      el.scrollTop = nextScroll(el.scrollTop, el.clientHeight, el.scrollHeight, offset)
      setLabel(`Page ${Math.round(el.scrollTop / el.clientHeight) + 1} of ${Math.ceil(el.scrollHeight / el.clientHeight)}`)
    }, PAGE_MS)
    return () => clearInterval(id)
  }, [on])
  return { ref, label }
}

/** A compact frame, like a Grafana panel, that fills its grid cell. */
export function DashPanel({ p, overall, generated, paged }: { p: any; overall: Level; generated: number; paged?: boolean }) {
  const { ref, label } = useWallPaging(!!paged)
  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-panel border border-line bg-surface" aria-label={p.title || p.type}>
      {p.title && <h2 className="flex h-8 shrink-0 items-center truncate px-3 text-[13px] font-medium text-fg2">{p.title}</h2>}
      <div ref={ref} className={`min-h-0 flex-1 ${paged ? "overflow-hidden" : "overflow-auto"} ${EDGE_TO_EDGE.includes(p.type) ? "" : p.title ? "px-3 pb-2" : "p-2"}`}><Body p={p} overall={overall} generated={generated} /></div>
      {label && <span className="absolute right-3 top-1.5 rounded-control bg-raised px-2 text-xs text-fg2">{label}</span>}
    </section>
  )
}

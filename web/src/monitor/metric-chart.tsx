// Charts of host metrics over time, built from groups you make and metrics you add by hand.
// The Charts page and the dashboards' "Metrics over time" cards share them.
import { CheckIcon, PlusIcon, PresentationChartLineIcon } from "@heroicons/react/24/outline"
import { type ReactNode, useState } from "react"
import { Button, Empty, ErrorNote, Select, Skeleton, TimeSeries } from "../ui/components"
import type { Query } from "../ui/chart/data"
import type { ChartCard } from "../ui/chart/draw"
import { RANGES } from "../ui/chart/editor"
import { t } from "../ui/i18n"
import { useApi } from "../ui/lib"
import { allTags, hasTag } from "../ui/tags"
import type { Card, CardKind } from "../ui/widgets"
import { GroupsModal } from "./groups"
import { axis, combine, METRIC_KEYS, METRICS, type Metric, type Point, pointsOf, slotFor } from "./metrics"

/** Every host, as a group nobody has to make. */
export const ALL = "*"

export interface MetricChart {
  /** Groups are tags on hosts, made in the Groups window; `ALL` is every host. */
  groups: string[]
  metrics: Metric[]
  /** Each group as its average, its highest value, or one line per host. */
  combine: "avg" | "max" | "each"
  look?: "line" | "area"
  /** A period of its own; else the page's. */
  range?: string
}

/** What a chart holds, with the defaults of a new one. */
export const settle = (c: Partial<MetricChart>): MetricChart => ({ groups: c.groups ?? [ALL], metrics: c.metrics ?? ["cpu"], combine: c.combine ?? "avg", look: c.look, range: c.range })

const COLORS = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `var(--color-s${i})`)
/** Measures that share an axis are drawn together; each other unit gets a chart of its own. */
const UNIT: Record<Metric, string> = { cpu: "pct", mem: "pct", disk: "pct", temp: "temp", rx: "net", tx: "net" }
// shortcut: the server sends at most 24 hosts per request; a chart over more hosts reads the first 24.
const MAX_HOSTS = 24
const COMBINE = [{ value: "avg", label: "Average of each group" }, { value: "max", label: "Highest of each group" }, { value: "each", label: "One line per host" }]
const LOOKS = [{ value: "line", label: "Lines" }, { value: "area", label: "Areas" }]

export const groupName = (g: string) => (g === ALL ? t("All hosts") : g)
export const membersOf = (g: string, hosts: any[]) => hosts.filter((h) => h.installed && (g === ALL || hasTag(h, g)))

export interface Line { name: string; metric: Metric; values: Point[] }

/**
 * The lines of a chart, named by what tells them apart: the group or host when there
 * are several, the metric when several share an axis. Lines without a point, such as
 * the temperature of VMs, are left out and named in `empty`.
 */
export function chartLines(c: MetricChart, hosts: any[], series: Record<string, any[] | undefined>): { lines: Line[]; empty: string[] } {
  const lines: Line[] = [], empty: string[] = []
  const add = (who: string, m: Metric, values: Point[], named: boolean) => {
    const several = c.metrics.filter((x) => UNIT[x] === UNIT[m]).length > 1
    const metric = t(METRICS[m].label)
    if (!values.length) return empty.push(`${who} · ${metric}`)
    lines.push({ name: [named || !several ? who : "", several ? metric : ""].filter(Boolean).join(" · "), metric: m, values })
  }
  for (const m of c.metrics) {
    if (c.combine === "each") {
      const seen = new Set<string>()
      for (const h of c.groups.flatMap((g) => membersOf(g, hosts))) if (!seen.has(h.id)) { seen.add(h.id); add(h.name, m, pointsOf(series[h.id], m), true) }
    } else {
      for (const g of c.groups) {
        const of = membersOf(g, hosts).map((h) => pointsOf(series[h.id], m)).filter((l) => l.length)
        add(groupName(g), m, of.length ? combine(of, c.combine, slotFor(of)) : [], c.groups.length > 1)
      }
    }
  }
  return { lines, empty }
}

export function MetricChartView({ chart, range }: { chart: Partial<MetricChart>; range: string }) {
  const c = settle(chart)
  const hosts = useApi<any[]>("/api/hosts")
  const list = hosts.data ?? []
  const ids = [...new Set(c.groups.flatMap((g) => membersOf(g, list).map((h) => h.id)))].slice(0, MAX_HOSTS)
  const series = useApi<Record<string, any[]>>(ids.length ? `/api/series?range=${c.range || range}&hosts=${ids.join(",")}` : null)
  if (!c.groups.length || !c.metrics.length) return <Empty>{t("Pick at least one group and one metric.")}</Empty>
  if (hosts.error || series.error) return <ErrorNote>{hosts.error || series.error}</ErrorNote>
  if (!hosts.data) return <Skeleton />
  if (!ids.length) return <Empty>{t("These groups have no host yet.")}</Empty>
  if (!series.data) return <Skeleton />
  const { lines, empty } = chartLines(c, list, series.data)
  const units = [...new Set(c.metrics.map((m) => UNIT[m]))].filter((u) => lines.some((l) => UNIT[l.metric] === u))
  return (
    <div className="flex flex-col gap-5">
      {!lines.length && <Empty>{t("Not enough data yet.")}</Empty>}
      {units.map((u) => {
        const own = lines.filter((l) => UNIT[l.metric] === u)
        const a = axis(own[0].metric, own.flatMap((l) => l.values.map((p) => p.v)))
        return (
          <section key={u} aria-label={c.metrics.filter((m) => UNIT[m] === u).map((m) => t(METRICS[m].label)).join(", ")}>
            {units.length > 1 && <h4 className="mb-2 text-[13px] font-medium text-fg2">{c.metrics.filter((m) => UNIT[m] === u).map((m) => t(METRICS[m].label)).join(", ")}</h4>}
            <TimeSeries series={own.map((l) => ({ name: l.name, values: l.values, color: COLORS[lines.indexOf(l) % COLORS.length] }))} max={a.max} unit={a.unit} format={a.format} fill={c.look === "area"} />
          </section>
        )
      })}
      {empty.length > 0 && <p className="text-xs text-fg3">{t("No data for {names}.", { names: empty.join(", ") })}</p>}
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={`inline-flex h-9 items-center gap-1.5 rounded-control border px-3 text-[13px] max-sm:h-11 ${on ? "border-accent bg-accent-soft text-fg" : "border-line2 text-fg2 hover:border-accent hover:text-fg"}`}>
      {on && <CheckIcon className="size-4 text-accent" aria-hidden />}{children}
    </button>
  )
}

const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x])

/** Groups and metrics as buttons to switch on, then how to fold a group and how to draw it. */
export function MetricForm({ chart, set, pageRange = true }: { chart: Partial<MetricChart>; set: (patch: Partial<MetricChart>) => void; pageRange?: boolean }) {
  const c = settle(chart)
  const hosts = useApi<any[]>("/api/hosts", { poll: false })
  const [grouping, setGrouping] = useState(false)
  const list = hosts.data ?? []
  return (
    <div className="col-span-full flex flex-col gap-4">
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-medium text-fg2">{t("Groups")}</legend>
        <div className="flex flex-wrap gap-2">
          {[ALL, ...allTags(list)].map((g) => <Chip key={g} on={c.groups.includes(g)} onClick={() => set({ groups: toggle(c.groups, g) })}>{groupName(g)}<span className="text-fg3">{membersOf(g, list).length}</span></Chip>)}
          <Button type="button" onClick={() => setGrouping(true)}><PlusIcon className="size-4" aria-hidden />{t("New group")}</Button>
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-medium text-fg2">{t("Metrics")}</legend>
        <div className="flex flex-wrap gap-2">
          {METRIC_KEYS.map((m) => <Chip key={m} on={c.metrics.includes(m)} onClick={() => set({ metrics: toggle(c.metrics, m) })}>{t(METRICS[m].label)}</Chip>)}
        </div>
        <p className="mt-1.5 text-xs text-fg3">{t("Metrics of different units get a chart each, one under the other.")}</p>
      </fieldset>
      <p className="rounded-control bg-raised px-3 py-2 text-xs text-fg2">{t("Advanced: for filters, formulas, other functions or another kind of chart, pick a chart type under Type. This chart opens in the full editor as it is.")}</p>
      <div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
        <Select label="Combine" value={c.combine} onChange={(e) => set({ combine: e.target.value as MetricChart["combine"] })} options={COMBINE} />
        <Select label="Look" value={c.look ?? "line"} onChange={(e) => set({ look: e.target.value as MetricChart["look"] })} options={LOOKS} />
        <Select label="Period" value={c.range ?? ""} onChange={(e) => set({ range: e.target.value || undefined })} options={[{ value: "", label: pageRange ? "The page's period" : "Last 24 hours" }, ...RANGES.map(([value, label]) => ({ value, label }))]} />
      </div>
      {grouping && <GroupsModal hosts={list} onClose={() => setGrouping(false)} onSaved={hosts.reload} />}
    </div>
  )
}

/** What a chart card of host metrics or fleet load keeps when it turns simple: its metrics, how it folds hosts, its look and period. Filters are dropped. */
export function fromChart(c: Card): Partial<MetricChart> {
  const q: Query | undefined = c.chart?.query
  if (!q || (q.dataset !== "metrics" && q.dataset !== "fleet")) return {}
  const metrics = [...new Set(q.measures.map((m) => m.field))].filter((f): f is Metric => !!f && f in METRICS)
  return {
    groups: [ALL], metrics: metrics.length ? metrics : ["cpu"], combine: q.split === "host" ? "each" : q.measures[0]?.fn === "max" ? "max" : "avg",
    look: c.chart.look.type === "area" ? "area" : "line", range: q.range || undefined,
  }
}

/**
 * The same chart for the full editor, on the rows of host metrics: the groups as a filter on
 * tags, one series per host or per tag, a measure per metric. From there anything goes.
 */
export function toChart(card: Card): ChartCard {
  const c = settle(card as Partial<MetricChart>)
  const groups = c.groups.filter((g) => g !== ALL)
  const all = groups.length < c.groups.length
  return {
    query: {
      dataset: "metrics", group: "t", range: c.range,
      where: all ? [] : [{ field: "tags", op: "is", value: groups.join(", ") }],
      split: c.combine === "each" ? "host" : !all && groups.length > 1 ? "tags" : undefined,
      measures: c.metrics.map((m, i) => ({ id: String.fromCharCode(65 + i), fn: c.combine === "max" ? "max" : "avg", field: m })),
    },
    look: { type: c.look === "area" ? "area" : "line", legend: "auto", palette: "nyx" },
  }
}

export const METRIC_KIND: CardKind = {
  label: "Metrics over time", icon: PresentationChartLineIcon, hint: "Simple: CPU, memory, disk, temperature or network of your groups of hosts, over the period. Pick a chart type instead for the full editor.",
  body: (c, ctx) => <MetricChartView chart={c as Partial<MetricChart>} range={ctx?.range ?? "24h"} />,
  form: (c, set) => <MetricForm chart={c as Partial<MetricChart>} set={set} />,
  check: (c) => { const s = settle(c as Partial<MetricChart>); return !s.groups.length ? "Pick at least one group." : !s.metrics.length ? "Add at least one metric." : undefined },
  from: fromChart,
  toChart,
}

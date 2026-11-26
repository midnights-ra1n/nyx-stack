import { PencilSquareIcon, PlusIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Button, Check, Empty, ErrorNote, IconButton, Input, Modal, Panel, RangeSelect, Select, TimeSeries, Variable, ask } from "../ui/components"
import { t } from "../ui/i18n"
import { api, useApi, useStored } from "../ui/lib"
import { PageHeader } from "../ui/shell"
import { allTags, hasTag, tagOptions } from "../ui/tags"
import { axis, combine, METRIC_KEYS, METRICS, type Metric, pointsOf, slotFor } from "./metrics"

/** Which hosts a chart draws: all, one tag, a fixed list, or whatever a variable of the page holds. */
export type Source = "all" | "tag" | "hosts" | "$host" | "$tag"
export interface ChartCfg {
  id: string
  title: string
  metric: Metric
  source: Source
  tag?: string
  hosts?: string[]
  /** One line per host, or the hosts folded into their average or highest value. */
  show: "each" | "avg" | "max"
  look: "area" | "line" | "bars"
  wide?: boolean
}
export interface Vars { host: string; tag: string; range: string }

const COLORS = ["var(--color-s1)", "var(--color-s2)", "var(--color-s3)", "var(--color-s4)"]
/** At most this many hosts per chart; the server sends no more. */
const MAX_HOSTS = 24

const SOURCES = [
  { value: "all", label: "All hosts" },
  { value: "$host", label: "The Host variable" },
  { value: "$tag", label: "The Tag variable" },
  { value: "tag", label: "A tag" },
  { value: "hosts", label: "Hosts I choose" },
]
const SHOWS = [{ value: "each", label: "One line per host" }, { value: "avg", label: "Their average" }, { value: "max", label: "The highest of them" }]
const LOOKS = [{ value: "area", label: "Areas" }, { value: "line", label: "Lines" }, { value: "bars", label: "Bars, latest value" }]

export const STARTER: ChartCfg[] = [
  { id: "cpu", title: t("CPU of $tag"), metric: "cpu", source: "$tag", show: "each", look: "line" },
  { id: "mem", title: t("Memory of $tag"), metric: "mem", source: "$tag", show: "each", look: "line" },
  { id: "net", title: t("Network in of $host"), metric: "rx", source: "$host", show: "each", look: "area" },
  { id: "temp", title: t("Hottest host"), metric: "temp", source: "all", show: "max", look: "area" },
]

/** The hosts a chart takes, once the variables of the page are filled in. */
export function chartHosts(c: ChartCfg, hosts: any[], v: Vars): any[] {
  const pick = c.source === "all" ? hosts
    : c.source === "$host" ? hosts.filter((h) => !v.host || h.id === v.host)
    : c.source === "$tag" ? hosts.filter((h) => hasTag(h, v.tag))
    : c.source === "tag" ? hosts.filter((h) => hasTag(h, c.tag ?? ""))
    : hosts.filter((h) => c.hosts?.includes(h.id))
  return pick.slice(0, MAX_HOSTS)
}

/** `$host` and `$tag` in a title read as what the variables hold. */
export function chartTitle(c: ChartCfg, hosts: any[], v: Vars) {
  const host = hosts.find((h) => h.id === v.host)?.name ?? t("all hosts")
  return (c.title || t(METRICS[c.metric].label)).replace(/\$host/g, host).replace(/\$tag/g, v.tag || t("all hosts"))
}

function Bars({ rows, format }: { rows: { name: string; v: number; color: string }[]; format: (v: number) => string; }) {
  const top = Math.max(...rows.map((r) => r.v), 1)
  return (
    <ul className="flex flex-col gap-2">
      {[...rows].sort((a, b) => b.v - a.v).map((r) => (
        <li key={r.name} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-[13px]">
          <span className="truncate">{r.name}</span>
          <span className="h-2.5 rounded-full bg-raised"><span className="block h-full rounded-full" style={{ width: `${(r.v / top) * 100}%`, background: r.color }} /></span>
          <span className="w-20 text-right tabular-nums text-fg2">{format(r.v)}</span>
        </li>
      ))}
    </ul>
  )
}

/** One chart drawn from its settings: shared by the page and the preview of the editor. */
export function ChartView({ c, hosts, vars }: { c: ChartCfg; hosts: any[]; vars: Vars }) {
  const picked = chartHosts(c, hosts, vars)
  const { data, error } = useApi<Record<string, any[]>>(picked.length ? `/api/series?range=${vars.range}&hosts=${picked.map((h) => h.id).join(",")}` : null)
  if (!picked.length) return <Empty>{t("No host matches.")}</Empty>
  if (error) return <ErrorNote>{error}</ErrorNote>
  if (!data) return <p className="text-fg3">{t("Loading…")}</p>
  const lines = picked.map((h) => ({ name: h.name, values: pointsOf(data[h.id], c.metric) })).filter((l) => l.values.length)
  const series = c.show === "each" || lines.length < 2
    ? lines.map((l, i) => ({ ...l, color: COLORS[i % COLORS.length] }))
    : [{ name: t(c.show === "max" ? "Highest" : "Average"), color: COLORS[0], values: combine(lines.map((l) => l.values), c.show, slotFor(lines.map((l) => l.values))) }]
  const a = axis(c.metric, series.flatMap((s) => s.values.map((p) => p.v)))
  const show = a.format ?? ((v: number) => `${v.toFixed(0)} %`)
  if (c.look === "bars") {
    if (!series.length) return <Empty>{t("Not enough data yet.")}</Empty>
    return <Bars format={show} rows={series.map((s) => ({ name: s.name, color: s.color, v: s.values[s.values.length - 1].v }))} />
  }
  return <TimeSeries series={series} max={a.max} unit={a.unit} format={a.format} fill={c.look === "area"} />
}

function ChartForm({ chart, hosts, vars, onSave, onClose }: { chart: ChartCfg; hosts: any[]; vars: Vars; onSave: (c: ChartCfg) => void; onClose: () => void }) {
  const [c, setC] = useState(chart)
  const set = (o: Partial<ChartCfg>) => setC({ ...c, ...o })
  const tags = allTags(hosts)
  return (
    <Modal title={chart.title ? t("Edit {name}", { name: chart.title }) : t("New chart")} onClose={onClose} wide>
      <form className="grid grid-cols-[minmax(0,20rem)_1fr] gap-6 max-md:grid-cols-1" onSubmit={(e) => { e.preventDefault(); onSave(c) }}>
        <div className="flex flex-col gap-4">
          <Input label="Title" value={c.title} onChange={(e) => set({ title: e.target.value })} placeholder={t(METRICS[c.metric].label)} hint="$host and $tag are replaced by what the variables at the top hold." />
          <Select label="Measure" value={c.metric} onChange={(e) => set({ metric: e.target.value as Metric })} options={METRIC_KEYS.map((k) => ({ value: k, label: METRICS[k].label }))} />
          <Select label="Hosts" value={c.source} onChange={(e) => set({ source: e.target.value as Source })} options={SOURCES} />
          {c.source === "tag" && (tags.length ? <Select label="Tag" value={c.tag ?? ""} onChange={(e) => set({ tag: e.target.value })} options={["", ...tags]} /> : <p className="text-[13px] text-fg3">{t("No host has a tag yet. Add some on a host's page.")}</p>)}
          {c.source === "hosts" && (
            <fieldset className="flex max-h-48 flex-col overflow-auto rounded-control border border-line p-2">
              <legend className="px-1 text-[13px] text-fg2">{t("Hosts")}</legend>
              {hosts.map((h) => <Check key={h.id} label={h.name} checked={!!c.hosts?.includes(h.id)} onChange={(e) => set({ hosts: e.target.checked ? [...(c.hosts ?? []), h.id] : (c.hosts ?? []).filter((x) => x !== h.id) })} />)}
            </fieldset>
          )}
          <Select label="Show" value={c.show} onChange={(e) => set({ show: e.target.value as ChartCfg["show"] })} options={SHOWS} />
          <Select label="Look" value={c.look} onChange={(e) => set({ look: e.target.value as ChartCfg["look"] })} options={LOOKS} />
          <Check label="Full width" checked={!!c.wide} onChange={(e) => set({ wide: e.target.checked })} />
          <div className="flex gap-3"><Button variant="primary" type="submit">{t("Save")}</Button><Button onClick={onClose}>{t("Cancel")}</Button></div>
        </div>
        <section aria-label={t("Preview")} className="min-w-0 rounded-panel border border-line p-4">
          <h3 className="mb-3 font-medium">{chartTitle(c, hosts, vars)}</h3>
          <ChartView c={c} hosts={hosts} vars={vars} />
        </section>
      </form>
    </Modal>
  )
}

/** Charts anyone can build: a measure, some hosts, and how to draw them. Saved on the monitor, so every browser sees the same. */
export function Charts() {
  const hosts = useApi<any[]>("/api/hosts", { poll: false })
  const saved = useApi<{ charts?: ChartCfg[] } | null>("/api/settings/charts", { poll: false })
  const [vars, setVars] = useStored<Vars>("nyx.charts.vars", { host: "", tag: "", range: "24h" })
  const [editing, setEditing] = useState<ChartCfg | null>(null)
  const [error, setError] = useState("")
  const list = hosts.data ?? []
  const charts = saved.data?.charts ?? STARTER
  const tags = allTags(list)
  const save = async (next: ChartCfg[]) => {
    try { await api("/api/settings/charts", { method: "PUT", body: { charts: next } }); setError(""); saved.reload() } catch (e) { setError((e as Error).message) }
  }
  const put = (c: ChartCfg) => { save(charts.some((x) => x.id === c.id) ? charts.map((x) => (x.id === c.id ? c : x)) : [...charts, c]); setEditing(null) }
  const move = (i: number, by: number) => { const next = [...charts]; [next[i], next[i + by]] = [next[i + by], next[i]]; save(next) }
  const fresh = (): ChartCfg => ({ id: Math.random().toString(36).slice(2, 10), title: "", metric: "cpu", source: "all", show: "each", look: "line" })
  return (
    <>
      <PageHeader title={t("Charts")} subtitle="Pick a measure and some hosts. The variables below change every chart that uses them." onRefresh={() => { hosts.reload(); saved.reload() }}
        variables={<>
          <Variable label="Host" value={vars.host} onChange={(host) => setVars({ ...vars, host })} options={[{ value: "", label: "All" }, ...list.map((h) => ({ value: h.id, label: h.name }))]} />
          <Variable label="Tag" value={vars.tag} onChange={(tag) => setVars({ ...vars, tag })} options={tagOptions(tags)} />
          <RangeSelect value={vars.range} onChange={(range) => setVars({ ...vars, range })} />
        </>}
        actions={<Button variant="primary" onClick={() => setEditing(fresh())}><PlusIcon className="size-5" aria-hidden />{t("Add chart")}</Button>} />
      <ErrorNote>{error || hosts.error || saved.error}</ErrorNote>
      {editing && <ChartForm chart={editing} hosts={list} vars={vars} onSave={put} onClose={() => setEditing(null)} />}
      {charts.length === 0 ? <Empty>{t("No chart yet. Add one, or bring back the examples.")}</Empty> : (
        <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1">
          {charts.map((c, i) => (
            <div key={c.id} className={c.wide ? "col-span-full" : ""}>
              <Panel title={chartTitle(c, list, vars)} badge={<IconButton label="Edit" icon={PencilSquareIcon} onClick={() => setEditing(c)} />} actions={[
                { label: "Edit", onClick: () => setEditing(c) },
                { label: "Duplicate", onClick: () => setEditing({ ...c, id: fresh().id, title: `${c.title} (2)` }) },
                ...(i > 0 ? [{ label: "Move up", onClick: () => move(i, -1) }] : []),
                ...(i < charts.length - 1 ? [{ label: "Move down", onClick: () => move(i, 1) }] : []),
                { label: "Delete", onClick: async () => { if (await ask(t("Delete {name}?", { name: chartTitle(c, list, vars) }), { action: "Delete", danger: true })) save(charts.filter((x) => x.id !== c.id)) } },
              ]}>
                {list.length ? <ChartView c={c} hosts={list} vars={vars} /> : <Empty>{t("No hosts yet. Add one to get an install command.")}</Empty>}
              </Panel>
            </div>
          ))}
        </div>
      )}
      {saved.data?.charts && <div className="mt-4"><Button onClick={async () => { if (await ask(t("Replace your charts with the examples?"), { action: "Replace", danger: true })) save(STARTER) }}>{t("Bring back the examples")}</Button></div>}
    </>
  )
}

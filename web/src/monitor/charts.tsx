import { PencilSquareIcon, PlusIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Button, Empty, ErrorNote, IconButton, Panel, RangeSelect, ask } from "../ui/components"
import { CardEditor, ChartView } from "../ui/dashboard"
import { t } from "../ui/i18n"
import { api, useApi, useStored } from "../ui/lib"
import { PageHeader } from "../ui/shell"
import type { Card } from "../ui/widgets"
import { DATASETS } from "./datasets"
import { ALL, groupName, METRIC_KIND } from "./metric-chart"

/** The Charts page takes the simple metric charts and every chart of the full editor. */
const KINDS = { metrics: METRIC_KIND }
const newId = () => Math.random().toString(36).slice(2, 10)

export const STARTER: Card[] = [
  { id: "cpu", type: "metrics", title: t("CPU per host"), groups: [ALL], metrics: ["cpu"], combine: "each" },
  { id: "mem", type: "metrics", title: t("Memory per host"), groups: [ALL], metrics: ["mem"], combine: "each" },
  { id: "load", type: "metrics", title: t("Fleet load"), groups: [ALL], metrics: ["cpu", "mem"], combine: "avg", look: "area" },
  { id: "temp", type: "metrics", title: t("Hottest host"), groups: [ALL], metrics: ["temp"], combine: "max", look: "area" },
]

/**
 * A chart saved by an older version: one metric over all hosts, a tag or the page's variables,
 * or groups and metrics without a type. A tag becomes that group; anything else, every host.
 */
export function upgradeChart(c: any): Card {
  if (c.type) return c
  if (Array.isArray(c.metrics)) return { ...c, type: "metrics" }
  const group = c.source === "tag" && c.tag ? c.tag : ALL
  return {
    id: c.id, wide: c.wide, type: "metrics", groups: [group], metrics: [c.metric ?? "cpu"], combine: c.show ?? "each", look: c.look === "area" ? "area" : "line",
    title: String(c.title ?? "").replace(/\$(host|tag)/g, groupName(group)),
  }
}

/** Charts anyone builds, simply from groups and metrics or in the full editor. Saved on the monitor, so every browser sees the same. */
export function Charts() {
  const saved = useApi<{ charts?: any[] } | null>("/api/settings/charts", { poll: false })
  const [range, setRange] = useStored("nyx.charts.range", "24h")
  const [editing, setEditing] = useState<{ card: Card; isNew: boolean } | null>(null)
  const [error, setError] = useState("")
  const charts = (saved.data?.charts ?? STARTER).map(upgradeChart)
  const save = async (next: Card[]) => {
    try { await api("/api/settings/charts", { method: "PUT", body: { charts: next } }); setError(""); saved.reload() } catch (e) { setError((e as Error).message) }
  }
  const put = async (c: Card) => { await save(charts.some((x) => x.id === c.id) ? charts.map((x) => (x.id === c.id ? c : x)) : [...charts, c]); setEditing(null) }
  const remove = async (c: Card) => { if (await ask(t("Delete {name}?", { name: c.title }), { action: "Delete", danger: true })) { await save(charts.filter((x) => x.id !== c.id)); setEditing(null) } }
  const move = (i: number, by: number) => { const next = [...charts]; [next[i], next[i + by]] = [next[i + by], next[i]]; save(next) }
  return (
    <>
      <PageHeader title={t("Charts")} subtitle="Pick groups of hosts and add the metrics to draw, or pick a chart type for the full editor. A click on a series in a legend keeps only that one." onRefresh={saved.reload}
        variables={<RangeSelect value={range} onChange={setRange} />}
        actions={<Button variant="primary" onClick={() => setEditing({ card: { id: newId(), type: "metrics", title: "", groups: [ALL], metrics: ["cpu"], combine: "avg" }, isNew: true })}><PlusIcon className="size-5" aria-hidden />{t("Add chart")}</Button>} />
      <ErrorNote>{error || saved.error}</ErrorNote>
      {editing && <CardEditor card={editing.card} isNew={editing.isNew} datasets={DATASETS} kinds={KINDS} range={range} onSave={put} onRemove={() => remove(editing.card)} onClose={() => setEditing(null)} />}
      {charts.length === 0 ? <Empty>{t("No chart yet. Add one, or bring back the examples.")}</Empty> : (
        <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1">
          {charts.map((c, i) => (
            <div key={c.id} className={c.wide ? "col-span-full" : ""}>
              <Panel title={c.title} badge={<IconButton label="Edit" icon={PencilSquareIcon} onClick={() => setEditing({ card: c, isNew: false })} />} actions={[
                { label: "Edit", onClick: () => setEditing({ card: c, isNew: false }) },
                { label: "Duplicate", onClick: () => setEditing({ card: { ...c, id: newId(), title: `${c.title} (2)` }, isNew: true }) },
                { label: c.wide ? "Half width" : "Full width", onClick: () => save(charts.map((x) => (x.id === c.id ? { ...x, wide: !c.wide } : x))) },
                ...(i > 0 ? [{ label: "Move up", onClick: () => move(i, -1) }] : []),
                ...(i < charts.length - 1 ? [{ label: "Move down", onClick: () => move(i, 1) }] : []),
                { label: "Delete", onClick: () => remove(c) },
              ]}>
                {c.type === "chart" ? <ChartView chart={c.chart} datasets={DATASETS} range={range} /> : KINDS.metrics.body(c, { range })}
              </Panel>
            </div>
          ))}
        </div>
      )}
      {saved.data?.charts && <div className="mt-4"><Button onClick={async () => { if (await ask(t("Replace your charts with the examples?"), { action: "Replace", danger: true })) save(STARTER) }}>{t("Bring back the examples")}</Button></div>}
    </>
  )
}

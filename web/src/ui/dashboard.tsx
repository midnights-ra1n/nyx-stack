// A dashboard of tabs. The first tab holds the page's own panels; every tab takes cards:
// charts built from the app's datasets, and the app's other kinds of cards.
import { ArrowPathIcon, BellAlertIcon, ChartBarIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ClipboardDocumentCheckIcon, CpuChipIcon, CubeIcon, GlobeAltIcon, PencilIcon, PlusIcon, ServerStackIcon, ShieldCheckIcon, Squares2X2Icon, TrashIcon } from "@heroicons/react/24/outline"
import { useState, type ReactNode } from "react"
import { Board, type BoardPanel, CustomizeButton, type Layout, reveal } from "./board"
import { Button, Empty, ErrorNote, Input, Modal, Panel, Skeleton, Tabs, ask } from "./components"
import { t } from "./i18n"
import { api, useApi, useStored } from "./lib"
import { PageHeader } from "./shell"
import type { Dataset, Measure, Query } from "./chart/data"
import { ChartBody, chartData, DataTable, downloadCsv, type ChartCard, type ChartType, type Look } from "./chart/draw"
import { DataForm, freshChart, LookForm, retype, TYPES, TypePicker, useRows } from "./chart/editor"
import type { Card, CardKind } from "./widgets"

export interface DashTab { id: string; name: string; icon?: string }
interface Saved { tabs?: DashTab[]; widgets?: Card[] }

/** A ready-made tab: its name, what it is for, and the cards it starts with. */
export interface TabPreset { name: string; hint: string; icon: string; cards: Omit<Card, "id" | "tab">[] }

/** A chart card for a preset. It counts rows unless measures say otherwise. */
export const chartCard = (title: string, type: ChartType, query: Omit<Query, "measures"> & { measures?: Measure[] }, look: Partial<Look> = {}): Omit<Card, "id" | "tab"> =>
  ({ type: "chart", title, chart: { query: { where: [], measures: [{ id: "A", fn: "count" }], ...query }, look: { legend: "auto", palette: "nyx", ...look, type } } })

const TAB_ICONS: Record<string, typeof ChartBarIcon> = {
  grid: Squares2X2Icon, chart: ChartBarIcon, server: ServerStackIcon, cpu: CpuChipIcon, shield: ShieldCheckIcon, globe: GlobeAltIcon,
  cube: CubeIcon, bell: BellAlertIcon, updates: ArrowPathIcon, work: ClipboardDocumentCheckIcon,
}
const EMPTY_TAB = { name: "Empty tab", hint: "Start from nothing and add your own cards.", icon: "chart" }

const MAIN = "main"
const newId = () => Math.random().toString(36).slice(2, 10)
const deal = (ids: string[], n: number) => Array.from({ length: n }, (_, c) => ids.filter((_, i) => i % n === c))

/** A chart card with its rows. */
export function ChartView({ chart, datasets, range, asData }: { chart: ChartCard; datasets: Dataset[]; range: string; asData?: boolean }) {
  const ds = datasets.find((d) => d.id === chart.query.dataset)
  const { data, error } = useRows(ds, chart.query.range || range)
  if (!ds) return <Empty>{t("This card reads rows that no longer exist. Edit it to pick others.")}</Empty>
  if (error) return <ErrorNote>{error}</ErrorNote>
  if (!data) return <Skeleton />
  return asData ? <DataTable {...chartData(chart, data, ds.fields, ds.name)} /> : <ChartBody card={chart} rows={data} fields={ds.fields} nameField={ds.name} link={ds.link} />
}

const typeLabel = (c: Card, kinds: Record<string, CardKind>) =>
  c.type === "chart" ? TYPES.find((x) => x.type === c.chart?.look.type)?.label ?? "Chart" : kinds[c.type]?.label ?? c.type

/** A title that says what a chart shows, for cards left untitled. */
function autoTitle(c: Card, datasets: Dataset[], kinds: Record<string, CardKind>) {
  if (c.type !== "chart" || !c.chart) return t(kinds[c.type]?.label ?? "Card")
  const ds = datasets.find((d) => d.id === c.chart!.query.dataset)
  const by = ds?.fields.find((f) => f.key === c.chart!.query.group)
  return by ? t("{data} by {field}", { data: t(ds!.label), field: t(by.label).toLowerCase() }) : t(ds?.label ?? "Chart")
}

export function CardEditor({ card, isNew, datasets, kinds, range, onSave, onRemove, onClose }: { card: Card; isNew: boolean; datasets: Dataset[]; kinds: Record<string, CardKind>; range?: string; onSave: (c: Card) => Promise<void>; onRemove: () => void; onClose: () => void }) {
  const [c, setC] = useState(card)
  const [step, setStep] = useState(isNew ? "type" : c.type === "chart" ? "data" : "content")
  const [error, setError] = useState("")
  const chart = c.type === "chart" ? c.chart! : undefined
  const ds = chart && datasets.find((d) => d.id === chart.query.dataset)
  const rows = useRows(ds, chart?.query.range || range || "24h").data ?? []
  const kind = kinds[c.type]
  const pick = (type: string) => {
    if (kinds[type]) return setC({ ...c, ...kinds[type].from?.(c), type, chart: undefined })
    // A card of another kind opens in the full editor with what it already shows, when it can.
    const base = chart ?? kind?.toChart?.(c) ?? freshChart(datasets[0])
    setC({ ...c, type: "chart", chart: retype(base, type as ChartCard["look"]["type"], datasets.find((d) => d.id === base.query.dataset)) })
  }
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const problem = kind?.check?.(c) ?? (chart?.look.type === "scatter" && (!chart.query.x || !chart.query.y) ? "Pick the two axes." : undefined)
    if (problem) return setError(problem)
    try { await onSave({ ...c, title: c.title.trim() || autoTitle(c, datasets, kinds) }) } catch (err) { setError((err as Error).message) }
  }
  const steps = [{ id: "type", label: "Type" }, ...(chart ? [{ id: "data", label: "Data" }, { id: "look", label: "Look" }] : kind?.form ? [{ id: "content", label: "Content" }] : [])]
  return (
    <Modal title={isNew ? "Add a card" : t("Edit {name}", { name: card.title })} onClose={onClose} wide>
      <form onSubmit={save} className="grid grid-cols-[minmax(0,26rem)_minmax(0,1fr)] gap-6 max-lg:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          <Input label="Title" value={c.title} placeholder={autoTitle(c, datasets, kinds)} onChange={(e) => setC({ ...c, title: e.target.value })} />
          <Tabs tabs={steps} value={steps.some((s) => s.id === step) ? step : "type"} onChange={setStep} />
          {step === "type" && <TypePicker value={chart ? chart.look.type : c.type} onChange={pick} extra={Object.entries(kinds).map(([type, k]) => ({ type, label: k.label, icon: <k.icon className="size-6" aria-hidden /> }))} />}
          {step === "type" && kind && <p className="text-xs text-fg3">{t(kind.hint)}</p>}
          {step === "data" && chart && <DataForm card={chart} onChange={(chart) => setC({ ...c, chart })} datasets={datasets} rows={rows} pageRange={!!range} />}
          {step === "look" && chart && <LookForm card={chart} onChange={(chart) => setC({ ...c, chart })} />}
          {step === "content" && kind?.form && <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">{kind.form(c, (p) => setC({ ...c, ...p }))}</div>}
          <ErrorNote>{error}</ErrorNote>
          <div className="flex flex-wrap gap-3 border-t border-line pt-4">
            <Button variant="primary" type="submit"><CheckIcon className="size-5" aria-hidden />{t(isNew ? "Add the card" : "Save")}</Button>
            <Button type="button" onClick={onClose}>{t("Cancel")}</Button>
            {!isNew && <Button type="button" variant="danger" className="ml-auto" onClick={onRemove}><TrashIcon className="size-4" aria-hidden />{t("Remove")}</Button>}
          </div>
        </div>
        <section aria-label={t("Preview")} className="min-w-0 self-start lg:sticky lg:top-0">
          <p className="mb-2 text-[13px] text-fg3">{t("Preview")}</p>
          <Panel title={c.title || autoTitle(c, datasets, kinds)} flush={kind?.flush}>
            {chart ? <ChartView chart={chart} datasets={datasets} range={range ?? "24h"} /> : kind ? kind.body(c, { range: range ?? "24h" }) : null}
          </Panel>
        </section>
      </form>
    </Modal>
  )
}

/** The tab bar: pick, add, rename, move and delete tabs. */
function TabBar({ tabs, current, onPick, onChange, onAdd, presets, mainName, counts }: { tabs: DashTab[]; current: string; onPick: (id: string) => void; onChange: (tabs: DashTab[], removed?: string) => void; onAdd: (p?: TabPreset) => string; presets: TabPreset[]; mainName: string; counts: Record<string, number> }) {
  const [renaming, setRenaming] = useState<string>()
  const [name, setName] = useState("")
  const [menu, setMenu] = useState<"tab" | "add">()
  const i = tabs.findIndex((x) => x.id === current)
  const tab = tabs[i]
  const rename = (id: string, value: string) => { setRenaming(undefined); if (value.trim()) onChange(tabs.map((x) => (x.id === id ? { ...x, name: value.trim() } : x))) }
  const move = (by: number) => { const next = [...tabs]; [next[i], next[i + by]] = [next[i + by], next[i]]; onChange(next); setMenu(undefined) }
  const add = (p?: TabPreset) => { setMenu(undefined); const id = onAdd(p); if (!p) { setName(t("New tab")); setRenaming(id) } }
  const remove = async () => {
    setMenu(undefined)
    const n = counts[current] ?? 0
    if (await ask(n ? t("Delete the tab {name} and its {n} cards?", { name: tab.name, n }) : t("Delete the tab {name}?", { name: tab.name }), { action: "Delete", danger: true })) { onChange(tabs.filter((x) => x.id !== current), current); onPick(MAIN) }
  }
  const item = "flex h-9 max-sm:h-11 w-full items-center gap-2 rounded-control px-3 text-left text-fg2 hover:bg-raised hover:text-fg"
  return (
    <div className="mb-5 flex flex-wrap items-end gap-x-2 border-b border-line">
      <div role="tablist" aria-label={t("Dashboard tabs")} className="-mb-px flex flex-wrap">
        {[{ id: MAIN, name: mainName, icon: "grid" }, ...tabs].map((x) => {
          const on = x.id === current
          const Icon = TAB_ICONS[x.icon ?? ""] ?? ChartBarIcon
          return (
            <div key={x.id} className={`relative flex items-center border-b-2 transition-colors ${on ? "border-accent text-fg" : "border-transparent text-fg2 hover:border-line2 hover:text-fg"}`}>
              {renaming === x.id ? (
                <input autoFocus onFocus={(e) => e.target.select()} aria-label={t("Tab name")} className="my-1 h-8 w-44 rounded-[8px] border border-accent bg-raised px-3 text-fg" value={name} maxLength={40}
                  onChange={(e) => setName(e.target.value)} onBlur={() => rename(x.id, name)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); rename(x.id, name) } if (e.key === "Escape") setRenaming(undefined) }} />
              ) : (
                <button type="button" role="tab" aria-selected={on} onClick={() => { onPick(x.id); setMenu(undefined) }} onDoubleClick={() => { if (x.id !== MAIN) { setName(x.name); setRenaming(x.id) } }}
                  className="flex h-10 max-sm:h-11 items-center gap-2 px-3 whitespace-nowrap">
                  <Icon className={`size-4 ${on ? "text-accent" : "text-fg3"}`} aria-hidden />
                  <span className={on ? "font-medium" : ""}>{x.name}</span>
                  {x.id !== MAIN && counts[x.id] ? <span className="min-w-5 rounded-full bg-raised px-1.5 text-center text-[11px] leading-5 text-fg3 tabular-nums">{counts[x.id]}</span> : null}
                </button>
              )}
              {on && x.id !== MAIN && renaming !== x.id && (
                <button type="button" aria-label={t("{title} menu", { title: x.name })} aria-haspopup="menu" aria-expanded={menu === "tab"} onClick={() => setMenu(menu === "tab" ? undefined : "tab")}
                  className="-ml-1.5 mr-1 grid size-7 max-sm:size-11 place-items-center rounded-[6px] text-fg3 hover:bg-raised hover:text-fg">
                  <ChevronDownIcon className="size-3.5" aria-hidden />
                </button>
              )}
              {on && menu === "tab" && tab && (
                <div role="menu" className="absolute left-0 top-full z-20 mt-1 min-w-48 rounded-panel border border-line2 bg-surface p-2">
                  {[
                    { label: "Rename", icon: PencilIcon, on: () => { setMenu(undefined); setName(tab.name); setRenaming(tab.id) } },
                    ...(i > 0 ? [{ label: "Move left", icon: ChevronLeftIcon, on: () => move(-1) }] : []),
                    ...(i < tabs.length - 1 ? [{ label: "Move right", icon: ChevronRightIcon, on: () => move(1) }] : []),
                    { label: "Delete the tab", icon: TrashIcon, on: remove },
                  ].map((a) => <button key={a.label} role="menuitem" type="button" onClick={a.on} className={item}><a.icon className="size-4" aria-hidden />{t(a.label)}</button>)}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="relative mb-1">
        <button type="button" aria-haspopup="menu" aria-expanded={menu === "add"} onClick={() => setMenu(menu === "add" ? undefined : "add")}
          className="flex h-8 max-sm:h-11 items-center gap-1.5 rounded-control px-2.5 text-[13px] text-fg3 hover:bg-raised hover:text-fg">
          <PlusIcon className="size-4" aria-hidden />{t("Add a tab")}
        </button>
        {menu === "add" && (
          <div role="menu" className="absolute left-0 top-full z-20 mt-1 w-[22rem] max-w-[calc(100vw-32px)] rounded-panel border border-line2 bg-surface p-2">
            {[EMPTY_TAB, ...presets].map((p, n) => {
              const Icon = TAB_ICONS[p.icon] ?? ChartBarIcon
              const cards = n ? (p as TabPreset).cards.length : 0
              return (
                <button key={p.name} role="menuitem" type="button" onClick={() => add(n ? (p as TabPreset) : undefined)}
                  className={`flex w-full items-start gap-3 rounded-control px-3 py-2 text-left hover:bg-raised ${n === 1 ? "mt-1 border-t border-line pt-3" : ""}`}>
                  <Icon className="mt-0.5 size-5 shrink-0 text-fg3" aria-hidden />
                  <span className="min-w-0">
                    <span className="flex items-baseline gap-2 text-fg">{t(p.name)}{cards ? <span className="text-xs text-fg3">{t("{n} cards", { n: cards })}</span> : null}</span>
                    <span className="block text-xs leading-4 text-fg3">{t(p.hint)}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export interface DashboardProps {
  /** Names the layouts kept in this browser. */
  id: string
  /** Where tabs and cards are saved, as `{ tabs, widgets }`. */
  setting: string
  header: { title: string; subtitle?: ReactNode; crumbs?: { label: ReactNode; to?: string }[]; onRefresh?: () => void; variables?: ReactNode; actions?: ReactNode }
  /** The page's own panels, on the first tab. */
  builtins: BoardPanel[]
  desktop: Layout
  phone: Layout
  datasets: Dataset[]
  kinds: Record<string, CardKind>
  /** The page's period, which charts of timed rows follow unless they set their own. */
  range?: string
  /** Ready-made tabs offered when adding one. */
  presets?: TabPreset[]
}

export function Dashboard({ id, setting, header, builtins, desktop, phone, datasets, kinds, range, presets = [] }: DashboardProps) {
  const saved = useApi<Saved | null>(setting, { poll: false })
  const tabs = saved.data?.tabs ?? []
  const cards = saved.data?.widgets ?? []
  const [stored, setTab] = useStored(`nyx.tab.${id}`, MAIN)
  const tab = tabs.some((x) => x.id === stored) ? stored : MAIN
  const [editing, setEditing] = useState<{ card: Card; isNew: boolean }>()
  const [asData, setAsData] = useState<string[]>([])
  const [version, setVersion] = useState(0)
  const [error, setError] = useState("")

  const put = async (next: Saved) => {
    try { await api(setting, { method: "PUT", body: { ...saved.data, ...next } }); setError(""); await saved.reload() } catch (e) { setError((e as Error).message); throw e }
  }
  const boardOf = (tabId: string) => (tabId === MAIN ? id : `${id}.${tabId}`)
  const on = (tabId: string) => cards.filter((c) => (c.tab ?? MAIN) === tabId)
  const layouts = (tabId: string) => {
    if (tabId === MAIN) return { desktop, phone }
    const ids = on(tabId).map((c) => `w:${c.id}`)
    return { desktop: { cols: deal(ids, 2), hidden: [] }, phone: { cols: [ids], hidden: [] } }
  }
  const save = async (c: Card) => {
    const exists = cards.some((x) => x.id === c.id)
    await put({ widgets: exists ? cards.map((x) => (x.id === c.id ? c : x)) : [...cards, c] })
    if (!exists) { reveal(boardOf(c.tab ?? MAIN), `w:${c.id}`, layouts(c.tab ?? MAIN)); setVersion((v) => v + 1) }
    setEditing(undefined)
  }
  const remove = async (c: Card) => {
    if (!await ask(t("Remove {name}?", { name: c.title }), { action: "Remove", danger: true })) return
    await put({ widgets: cards.filter((x) => x.id !== c.id) }).catch(() => {})
    setEditing(undefined)
  }
  const moveTo = async (c: Card, to: string) => {
    if (!await put({ widgets: cards.map((x) => (x.id === c.id ? { ...x, tab: to === MAIN ? undefined : to } : x)) }).then(() => true, () => false)) return
    reveal(boardOf(to), `w:${c.id}`, layouts(to))
    setVersion((v) => v + 1)
  }
  const csv = async (c: Card) => {
    const ds = datasets.find((d) => d.id === c.chart?.query.dataset)
    if (!ds || !c.chart) return
    try { downloadCsv(c.title, chartData(c.chart, await ds.load(c.chart.query.range || range || "24h"), ds.fields, ds.name)) } catch (e) { setError((e as Error).message) }
  }
  const counts = Object.fromEntries(tabs.map((x) => [x.id, on(x.id).length]))
  // A preset's names are saved in the language of the person adding it, like a tab named by hand.
  const addTab = (p?: TabPreset) => {
    const tabId = newId()
    put({
      tabs: [...tabs, { id: tabId, name: t(p?.name ?? "New tab"), icon: p?.icon }],
      ...(p ? { widgets: [...cards, ...p.cards.map((c) => ({ ...c, id: newId(), tab: tabId, title: t(c.title) }) as Card)] } : {}),
    }).catch(() => {})
    setTab(tabId)
    return tabId
  }

  const panelOf = (c: Card): BoardPanel => {
    const kind = kinds[c.type]
    const data = asData.includes(c.id)
    const flush = kind?.flush || data || ["table", "list"].includes(c.chart?.look.type ?? "")
    return {
      id: `w:${c.id}`, title: c.title, render: (edit) => (
        <Panel title={c.title} edit={edit} flush={flush} actions={[
          { label: "Edit", onClick: () => setEditing({ card: c, isNew: false }) },
          { label: "Duplicate", onClick: () => setEditing({ card: { ...c, id: newId(), title: t("{name} (copy)", { name: c.title }) }, isNew: true }) },
          ...(c.type === "chart" ? [
            { label: data ? "Show the chart" : "Show the data", onClick: () => setAsData(data ? asData.filter((x) => x !== c.id) : [...asData, c.id]) },
            { label: "Download as CSV", onClick: () => csv(c) },
          ] : []),
          ...[{ id: MAIN, name: t(header.title) }, ...tabs].filter((x) => x.id !== (c.tab ?? MAIN)).map((x) => ({ label: t("Move to {tab}", { tab: x.name }), onClick: () => moveTo(c, x.id) })),
          { label: "Remove", onClick: () => remove(c) },
        ]}>
          {c.type === "chart" && c.chart
            ? <ChartView chart={c.chart} datasets={datasets} range={range ?? "24h"} asData={data} />
            : kind ? kind.body(c, { range: range ?? "24h" }) : <Empty>{t("Unknown widget.")}</Empty>}
        </Panel>
      ),
    }
  }

  const here = on(tab)
  const panels = tab === MAIN ? [...builtins, ...here.map(panelOf)] : here.map(panelOf)
  const fresh = (): Card => (datasets.length ? { id: newId(), type: "chart", title: "", tab: tab === MAIN ? undefined : tab, chart: freshChart(datasets[0]) } : { id: newId(), type: "note", title: "", tab: tab === MAIN ? undefined : tab })
  return (
    <>
      <PageHeader {...header} actions={<>
        {header.actions}
        <CustomizeButton />
        <Button variant="primary" onClick={() => setEditing({ card: fresh(), isNew: true })}><PlusIcon className="size-5" aria-hidden />{t("Add a card")}</Button>
      </>} />
      <TabBar tabs={tabs} current={tab} onPick={setTab} onAdd={addTab} presets={presets} mainName={t(header.title)} counts={counts} onChange={(next, removed) => put({ tabs: next, ...(removed ? { widgets: cards.filter((c) => c.tab !== removed) } : {}) }).catch(() => {})} />
      <ErrorNote>{error || saved.error}</ErrorNote>
      {editing && <CardEditor key={editing.card.id} card={editing.card} isNew={editing.isNew} datasets={datasets} kinds={kinds} range={range} onSave={save} onRemove={() => remove(editing.card)} onClose={() => setEditing(undefined)} />}
      {(saved.data !== undefined || saved.error) && (tab !== MAIN && !here.length
        ? <div className="rounded-panel border border-dashed border-line2 px-6 py-12 text-center">
            <p className="text-fg2">{t("This tab is empty. Add charts, figures, tables or notes to it.")}</p>
            <Button variant="primary" className="mt-4" onClick={() => setEditing({ card: fresh(), isNew: true })}><PlusIcon className="size-5" aria-hidden />{t("Add a card")}</Button>
          </div>
        : <Board key={`${tab}:${version}`} id={boardOf(tab)} panels={panels} {...layouts(tab)} />)}
    </>
  )
}

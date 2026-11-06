import { ArrowTopRightOnSquareIcon, Cog6ToothIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useEffect, useRef, useState } from "react"
import { Button, Check, Copy, Empty, ErrorNote, IconButton, Input, Modal, Panel, Select, Status, Table, Tabs, Td, TextArea } from "../../ui/components"
import { api, useApi, useMedia } from "../../ui/lib"
import { Link, navigate, PageHeader, Section } from "../../ui/shell"
import { addPanel, type Box, type Item, type PageConfig, PANEL_TYPES, type PanelCfg, place, slugify, template, themeVars } from "./model"
import { DashPanel } from "./panels"
import { Grid } from "./viewer"

const MAX_LOGO = 256 * 1024
const pageUrl = (p: any) => `${location.origin}/${p.kind}/${p.slug}${p.kind === "wall" ? `#key=${p.access_key}` : ""}`
const KINDS = [{ value: "status", label: "Public status page" }, { value: "wall", label: "Wall display" }]

const HOST_METRICS = [["cpu", "CPU"], ["mem", "Memory"], ["swap", "Swap"], ["disk", "Fullest disk"], ["temp", "Temperature"], ["rx", "Network in"], ["tx", "Network out"]]
const PROBE_METRICS = [["latency", "Latency"], ["cert_days", "Certificate days left"]]
const COUNTS = [["online", "Number online"], ["down", "Number down"], ["containers", "Running containers"], ["availability", "Availability, 30 days"], ["alerts", "Open alerts"]]
const SERIES = [["cpu", "CPU"], ["mem", "Memory"], ["disk", "Disk"], ["temp", "Temperature"], ["rx", "Network in"], ["tx", "Network out"], ["latency", "Probe latency"]]

function NewPage({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ name: "", kind: "status", slug: "" })
  const [error, setError] = useState("")
  const slug = f.slug || slugify(f.name)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const page = await api("/api/pages", { body: { name: f.name, kind: f.kind, slug, config: template(f.kind as any, f.name) } })
      navigate(`/pages/${page.id}`)
    } catch (err) { setError((err as Error).message) }
  }
  return (
    <Modal title="New page" onClose={onDone}>
      <form className="flex flex-col gap-4" onSubmit={save}>
        <Input label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Select label="Type" value={f.kind} options={KINDS} onChange={(e) => setF({ ...f, kind: e.target.value })} />
        <Input label="Address" required value={slug} className="font-mono" onChange={(e) => setF({ ...f, slug: e.target.value })} hint={`${location.origin}/${f.kind}/${slug}`} />
        <p className="text-fg2">{f.kind === "wall" ? "Fills the screen without scrolling. Opens with a private link, no sign-in needed." : "Anyone with the address can read it once published. It shows only what you pick."}</p>
        <ErrorNote>{error}</ErrorNote>
        <div><Button variant="primary" type="submit">Create</Button></div>
      </form>
    </Modal>
  )
}

export function PagesList() {
  const { data, reload, error } = useApi<any[]>("/api/pages", { poll: false })
  const [adding, setAdding] = useState(false)
  const remove = async (p: any) => { if (confirm(`Delete ${p.name}? Its address stops working.`)) { await api(`/api/pages/${p.id}`, { method: "DELETE" }); reload() } }
  return (
    <>
      <PageHeader title="Status pages" subtitle="Public status pages and wall displays." actions={<Button variant="primary" onClick={() => setAdding(true)}><PlusIcon className="size-5" aria-hidden />New page</Button>} />
      <Section>
        <Panel title={`${data?.length ?? 0} pages`} flush>
          <ErrorNote>{error}</ErrorNote>
          {data?.length === 0 ? <div className="px-4 pb-4"><Empty>No pages yet.</Empty></div> : (
            <Table head={["Name", "Type", "Address", "State", ""]}>
              {data?.map((p) => (
                <tr key={p.id}>
                  <Td className="font-medium"><Link className="text-accent" to={`/pages/${p.id}`}>{p.name}</Link></Td>
                  <Td className="text-fg2">{p.kind === "wall" ? "Wall display" : "Status page"}</Td>
                  <Td mono>/{p.kind}/{p.slug}</Td>
                  <Td>{p.published ? <Status cell level="ok" label="Published" /> : <Status cell level="off" label="Draft" />}</Td>
                  <Td className="w-24 whitespace-nowrap text-right">
                    {p.published && <a href={pageUrl(p)} target="_blank" rel="noreferrer" aria-label={`Open ${p.name}`} className="inline-flex size-10 items-center justify-center text-fg2 hover:text-fg"><ArrowTopRightOnSquareIcon className="size-5" aria-hidden /></a>}
                    <IconButton label="Delete" icon={TrashIcon} onClick={() => remove(p)} />
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </Section>
      {adding && <NewPage onDone={() => setAdding(false)} />}
    </>
  )
}

function ItemPicker({ items, onChange, hint }: { items: Item[]; onChange: (i: Item[]) => void; hint: string }) {
  const hosts = useApi<any[]>("/api/hosts", { poll: false }).data ?? []
  const probes = useApi<any[]>("/api/probes", { poll: false }).data ?? []
  const all: { kind: Item["kind"]; id: string; name: string }[] = [...hosts.map((h) => ({ kind: "host" as const, id: h.id, name: h.name })), ...probes.map((p) => ({ kind: "probe" as const, id: p.id, name: p.name }))]
  return (
    <fieldset className="col-span-full flex flex-col gap-1">
      <legend className="mb-1 text-[13px] text-fg2">Shows</legend>
      <p className="mb-1 text-xs text-fg3">{hint}</p>
      {all.length === 0 && <Empty>No hosts or probes yet.</Empty>}
      <ul className="flex max-h-64 flex-col gap-1 overflow-auto">
        {all.map((a) => {
          const on = items.find((i) => i.id === a.id)
          return (
            <li key={a.id} className="grid min-h-9 max-sm:min-h-11 grid-cols-2 items-center gap-3 max-sm:grid-cols-1">
              <Check label={`${a.name} (${a.kind})`} checked={!!on} onChange={(e) => onChange(e.target.checked ? [...items, { kind: a.kind, id: a.id, label: "" }] : items.filter((i) => i.id !== a.id))} />
              {on && <input aria-label={`Public name for ${a.name}`} placeholder="Name shown here" value={on.label} className="h-10 rounded-control border border-line2 bg-bg px-3" onChange={(e) => onChange(items.map((i) => (i.id === a.id ? { ...i, label: e.target.value } : i)))} />}
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}

function metricOptions(p: PanelCfg, wall: boolean, probes: any[]) {
  if (p.type === "timeseries") return SERIES
  const readings = p.items.filter((i) => i.kind === "probe").flatMap((i) => (probes.find((x) => x.id === i.id)?.readings ?? []).map((r: any) => [`reading:${r.label}`, r.label]))
  const single = [...HOST_METRICS, ...PROBE_METRICS, ...readings, ["uptime", "Uptime, 30 days"]]
  return p.type === "stat" ? [...COUNTS.filter(([k]) => wall || k !== "alerts"), ...single] : single
}

function PanelForm({ panel, wall, onSave, onClose }: { panel: PanelCfg; wall: boolean; onSave: (p: PanelCfg) => void; onClose: () => void }) {
  const [p, setP] = useState(panel)
  const probes = useApi<any[]>("/api/probes", { poll: false }).data ?? []
  const set = (over: Partial<PanelCfg>) => setP({ ...p, ...over })
  const num = (k: keyof Box, label: string) => <Input label={label} type="number" min={0} value={p[k]} onChange={(e) => set({ [k]: Number(e.target.value) })} />
  const usesItems = !["overall", "text", "clock", "alerts"].includes(p.type)
  const usesMetric = ["stat", "gauge", "bars", "timeseries"].includes(p.type)
  return (
    <Modal title={PANEL_TYPES.find((t) => t.type === p.type)?.label ?? "Panel"} onClose={onClose} wide>
      <form className="grid grid-cols-2 gap-4 max-sm:grid-cols-1" onSubmit={(e) => { e.preventDefault(); onSave(p) }}>
        <Input label="Title" value={p.title} onChange={(e) => set({ title: e.target.value })} hint="Leave empty for no title bar." />
        {usesMetric && <Select label="Metric" value={p.metric} onChange={(e) => set({ metric: e.target.value })} options={metricOptions(p, wall, probes).map(([value, label]) => ({ value, label }))} />}
        {p.type === "services" && <Check label="Show 30 days of uptime" checked={p.uptime} onChange={(e) => set({ uptime: e.target.checked })} />}
        {p.type === "text" && <div className="col-span-full"><TextArea label="Text" rows={5} value={p.text} onChange={(e) => set({ text: e.target.value })} /></div>}
        {usesItems && <ItemPicker items={p.items} onChange={(items) => set({ items })} hint={wall ? "Leave everything unticked to show all hosts and probes." : "Only what you tick is public. Give it another name to hide the real one."} />}
        <div className="col-span-full grid grid-cols-4 gap-3">{num("x", "Column")}{num("y", "Row")}{num("w", "Width")}{num("h", "Height")}</div>
        <div className="col-span-full"><Button variant="primary" type="submit">Apply</Button></div>
      </form>
    </Modal>
  )
}

/** Drag a panel to move it, drag its corner to resize. Snaps to the grid. */
function EditGrid({ page, panels, onChange, onEdit }: { page: any; panels: PanelCfg[]; onChange: (p: PanelCfg[]) => void; onEdit: (p: PanelCfg) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; resize: boolean; px: number; py: number; start: PanelCfg[] } | null>(null)
  const start = (e: React.PointerEvent, id: string, resize: boolean) => {
    e.stopPropagation()
    drag.current = { id, resize, px: e.clientX, py: e.clientY, start: panels }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const cell = (box.current!.clientWidth + 8) / 24
    const [dx, dy] = [(e.clientX - d.px) / cell, (e.clientY - d.py) / 44]
    const p = d.start.find((x) => x.id === d.id)!
    onChange(place(d.start, d.id, d.resize ? { x: p.x, y: p.y, w: p.w + dx, h: p.h + dy } : { x: p.x + dx, y: p.y + dy, w: p.w, h: p.h }))
  }
  const end = () => { drag.current = null }
  const phone = useMedia("(max-width: 639px)")
  const data = Object.fromEntries((page?.panels ?? []).map((p: any) => [p.id, p]))
  return (
    <div ref={box}>
      <Grid page={{ panels }} render={(p: PanelCfg) => (
        <div className="relative h-full">
          <DashPanel p={{ ...p, ...data[p.id], title: p.title }} overall={page?.overall ?? "off"} generated={page?.generated ?? 0} />
          <div className={`absolute inset-0 rounded-panel border border-dashed border-line2 hover:border-accent ${phone ? "pointer-events-none" : "cursor-move touch-none"}`} onPointerDown={(e) => start(e, p.id, false)} onPointerMove={move} onPointerUp={end} />
          <div className="absolute right-1 top-0 flex">
            <IconButton label={`Edit ${p.title || p.type}`} icon={Cog6ToothIcon} onClick={() => onEdit(p)} />
            <IconButton label={`Remove ${p.title || p.type}`} icon={TrashIcon} onClick={() => onChange(panels.filter((x) => x.id !== p.id))} />
          </div>
          {!phone && <div aria-hidden className="absolute bottom-0 right-0 size-6 cursor-se-resize touch-none border-b-2 border-r-2 border-accent" onPointerDown={(e) => start(e, p.id, true)} onPointerMove={move} onPointerUp={end} />}
        </div>
      )} />
    </div>
  )
}

function Appearance({ c, set }: { c: PageConfig; set: (o: Partial<PageConfig>) => void }) {
  const [error, setError] = useState("")
  const upload = (file?: File) => {
    if (!file) return
    if (file.size > MAX_LOGO) return setError("The logo must be under 256 KB.")
    const r = new FileReader()
    r.onload = () => { setError(""); set({ logo: String(r.result) }) }
    r.readAsDataURL(file)
  }
  return (
    <Panel title="Appearance">
      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
        <Input label="Title" value={c.title} onChange={(e) => set({ title: e.target.value })} />
        <Input label="Description" value={c.description} onChange={(e) => set({ description: e.target.value })} />
        <Select label="Theme" value={c.preset} onChange={(e) => set({ preset: e.target.value })} options={[{ value: "nyx", label: "Nyx dark" }, { value: "graphite", label: "Graphite" }, { value: "light", label: "Light" }]} />
        <div className="flex items-end gap-3">
          <Input label="Accent colour" type="color" value={c.accent || "#e38b4f"} onChange={(e) => set({ accent: e.target.value })} className="w-20" />
          {c.accent && <Button variant="ghost" onClick={() => set({ accent: "" })}>Use theme colour</Button>}
        </div>
        <Input label="Refresh every (seconds)" type="number" min={5} max={3600} value={c.refresh_s} onChange={(e) => set({ refresh_s: Number(e.target.value) })} />
        <Input label="Zoom on large screens" type="number" min={0.5} max={4} step={0.25} value={c.zoom} onChange={(e) => set({ zoom: Number(e.target.value) })} hint="Set 2 for a 4K wall display." />
        <div className="flex items-end gap-3">
          <Input label="Logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => upload(e.target.files?.[0])} hint="Stored in the page, so visitors never call a third party." />
          {c.logo && <><img src={c.logo} alt="Current logo" className="h-10" /><Button variant="ghost" onClick={() => set({ logo: "" })}>Remove</Button></>}
        </div>
        <Select label="Notice style" value={c.notice_level} onChange={(e) => set({ notice_level: e.target.value })} options={[{ value: "", label: "Information" }, { value: "warn", label: "Warning" }, { value: "crit", label: "Critical" }]} />
        <div className="col-span-full"><TextArea label="Notice" rows={2} value={c.notice} onChange={(e) => set({ notice: e.target.value })} hint="Shown at the top, for maintenance or an ongoing incident." /></div>
        <div className="col-span-full"><Input label="Footer" value={c.footer} onChange={(e) => set({ footer: e.target.value })} /></div>
        <ErrorNote>{error}</ErrorNote>
      </div>
    </Panel>
  )
}

function Sharing({ page, onChange, c, set }: { page: any; onChange: (p: any) => void; c: PageConfig; set: (o: Partial<PageConfig>) => void }) {
  const [slug, setSlug] = useState(page.slug)
  const [error, setError] = useState("")
  const patch = async (body: any) => {
    try { onChange(await api(`/api/pages/${page.id}`, { method: "PATCH", body })); setError("") } catch (e) { setError((e as Error).message) }
  }
  const rotate = async () => { if (confirm("Replace the link? Screens using the old one stop updating.")) onChange(await api(`/api/pages/${page.id}/key`, { method: "POST" })) }
  return (
    <Panel title="Sharing">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1"><div className="text-[13px] text-fg2">{page.kind === "wall" ? "Private link" : "Public address"}</div><Copy text={pageUrl(page)} /></div>
        <p className="text-fg2">{page.kind === "wall" ? "Open this link on the display. It needs no account, so treat it as a password." : "Anyone with this address can read the page while it is published."}</p>
        <div className="flex items-end gap-3">
          <div className="flex-1"><Input label="Address" className="font-mono" value={slug} onChange={(e) => setSlug(e.target.value)} /></div>
          <Button onClick={() => patch({ slug })} disabled={slug === page.slug}>Change</Button>
        </div>
        {page.kind === "wall" && <div><Button onClick={rotate}>Replace the private link</Button></div>}
        {page.kind === "status" && <div className="flex flex-col gap-1">
          <Check label="Let other sites show this page in a frame" checked={!!c.embed} onChange={(e) => set({ embed: e.target.checked })} />
          {c.embed && <Copy text={`<iframe src="${pageUrl(page)}" title="${c.title || page.name}" style="width:100%;height:600px;border:0"></iframe>`} />}
        </div>}
        <ErrorNote>{error}</ErrorNote>
      </div>
    </Panel>
  )
}

const TABS = [{ id: "layout", label: "Layout" }, { id: "appearance", label: "Appearance" }, { id: "sharing", label: "Sharing" }]

export function PageEditor({ id }: { id: string }) {
  const { data: pages, error: loadError } = useApi<any[]>("/api/pages", { poll: false })
  const [page, setPage] = useState<any>()
  const [cfg, setCfg] = useState<PageConfig>()
  const [dirty, setDirty] = useState(false)
  const [tab, setTab] = useState("layout")
  const [editing, setEditing] = useState<PanelCfg>()
  const [preview, setPreview] = useState<any>()
  const [note, setNote] = useState("")

  useEffect(() => {
    const p = pages?.find((x) => x.id === id)
    if (p && !page) { setPage(p); setCfg(p.config) }
  }, [pages, id, page])

  useEffect(() => {
    if (!cfg || !page) return
    const run = () => api("/api/pages/preview", { body: { kind: page.kind, config: cfg } }).then(setPreview, (e) => setNote(e.message))
    const first = setTimeout(run, 300)
    const id = setInterval(() => { if (!document.hidden) run() }, 15000)
    return () => { clearTimeout(first); clearInterval(id) }
  }, [cfg, page])

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    addEventListener("beforeunload", warn)
    return () => removeEventListener("beforeunload", warn)
  }, [dirty])

  if (!page || !cfg) return pages && !pages.find((x) => x.id === id) ? <p className="text-fg2">Page not found.</p> : <ErrorNote>{loadError}</ErrorNote>
  const set = (over: Partial<PageConfig>) => { setCfg({ ...cfg, ...over }); setDirty(true); setNote("") }
  const save = async () => {
    try { setPage(await api(`/api/pages/${id}`, { method: "PATCH", body: { config: cfg } })); setDirty(false); setNote("Saved.") } catch (e) { setNote((e as Error).message) }
  }
  const publish = async (published: boolean) => {
    try { setPage(await api(`/api/pages/${id}`, { method: "PATCH", body: { config: cfg, published } })); setDirty(false); setNote(published ? "Published." : "Back to draft.") } catch (e) { setNote((e as Error).message) }
  }
  return (
    <>
      <PageHeader title={page.name} crumbs={[{ label: "Status pages", to: "/pages" }, { label: page.name }]} subtitle={note || (dirty ? "Unsaved changes." : page.published ? "Published." : "Draft: not visible yet.")}
        variables={<Tabs tabs={TABS} value={tab} onChange={setTab} />}
        actions={<>
          {page.published && <a href={pageUrl(page)} target="_blank" rel="noreferrer"><Button><ArrowTopRightOnSquareIcon className="size-5" aria-hidden />Open</Button></a>}
          <Button onClick={() => publish(!page.published)}>{page.published ? "Unpublish" : "Publish"}</Button>
          <Button variant="primary" onClick={save} disabled={!dirty}>Save</Button>
        </>} />
      <Section>
        {tab === "appearance" && <Appearance c={cfg} set={set} />}
        {tab === "sharing" && <Sharing page={page} onChange={setPage} c={cfg} set={set} />}
        {tab === "layout" && <>
          <Select label="Add a panel" value="" onChange={(e) => e.target.value && set({ panels: addPanel(cfg.panels, e.target.value as any) })} options={[{ value: "", label: "Choose a type…" }, ...PANEL_TYPES.filter((t) => page.kind === "wall" || t.type !== "alerts").map((t) => ({ value: t.type, label: t.label }))]} />
          <div className="rounded-panel bg-bg p-2" style={themeVars(cfg.preset, cfg.accent)}>
            {cfg.panels.length ? <EditGrid page={preview} panels={cfg.panels} onChange={(panels) => set({ panels })} onEdit={setEditing} /> : <Empty>Add a panel to start.</Empty>}
          </div>
          {page.kind === "wall" && <p className="text-[13px] text-fg3">On the screen, rows stretch to fill the height exactly. A panel with more than it can hold shows it one page at a time.</p>}
        </>}
      </Section>
      {editing && <PanelForm panel={editing} wall={page.kind === "wall"} onClose={() => setEditing(undefined)} onSave={(p) => { set({ panels: place(cfg.panels.map((x) => (x.id === p.id ? p : x)), p.id, p) }); setEditing(undefined) }} />}
    </>
  )
}

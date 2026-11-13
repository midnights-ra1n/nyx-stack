import { BoltIcon, CodeBracketSquareIcon, ClockIcon, DocumentTextIcon, GlobeAltIcon, HeartIcon, LinkIcon, PlusIcon, WindowIcon } from "@heroicons/react/24/outline"
import { useEffect, useState } from "react"
import { Board, CustomizeButton, reveal } from "../ui/board"
import { BarGauge, Button, Empty, ErrorNote, type Icon, Input, Meter, Panel, Stat, Status, Table, Td, TextArea } from "../ui/components"
import { Editor, EditorGroup } from "../ui/crud"
import { api, fmt, type Level, useApi } from "../ui/lib"
import { Link, navigate, PageHeader } from "../ui/shell"
import { PipelineList } from "../ui/pipelines"
import { TempoTiles } from "../ui/tempo"

export const deployLevel = (s: string): Level => (s === "ok" ? "ok" : s === "failed" ? "crit" : s === "running" ? "info" : "off")

export interface Widget { id: string; type: string; title: string; text?: string; links?: string; url?: string; height?: number; tz?: string }

export const WIDGETS: Record<string, { label: string; icon: Icon; hint: string }> = {
  tempo: { label: "EDF Tempo", icon: BoltIcon, hint: "Today, tomorrow and the days left. Read from the linked monitor, where the RTE keys are set." },
  pipelines: { label: "Pipelines", icon: CodeBracketSquareIcon, hint: "State of the latest CI/CD run of each repository. Read from the linked monitor, where the pipelines are set." },
  monitoring: { label: "Monitoring", icon: HeartIcon, hint: "Hosts online, open alerts and average load, from the linked monitor." },
  note: { label: "Note", icon: DocumentTextIcon, hint: "Free text: a procedure, a reminder, a phone number." },
  links: { label: "Links", icon: LinkIcon, hint: "Bookmarks to your services." },
  clock: { label: "Clock", icon: ClockIcon, hint: "Time and date, in any time zone." },
  embed: { label: "Web page", icon: WindowIcon, hint: "Shows a page of your own, such as a Grafana panel. Your browser loads it directly." },
}

const safeUrl = (u: string) => /^https?:\/\//i.test(u.trim())

/** `Label | https://url` per line. Lines without an http(s) address are dropped. */
export function parseLinks(text = "") {
  return text.split("\n").map((l) => {
    const i = l.lastIndexOf("|")
    const [label, url] = i < 0 ? [l, l] : [l.slice(0, i), l.slice(i + 1)]
    return { label: label.trim(), url: url.trim() }
  }).filter((l) => safeUrl(l.url))
}

function Clock({ tz }: { tz?: string }) {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 10_000); return () => clearInterval(t) }, [])
  const opts = (o: Intl.DateTimeFormatOptions) => { try { return now.toLocaleString(undefined, { ...o, timeZone: tz || undefined }) } catch { return now.toLocaleString(undefined, o) } }
  return (
    <div className="py-2 text-center">
      <div className="text-[44px] leading-none font-medium tabular-nums">{opts({ hour: "2-digit", minute: "2-digit" })}</div>
      <div className="mt-2 text-fg2">{opts({ weekday: "long", day: "numeric", month: "long" })}{tz && <span className="text-fg3"> · {tz}</span>}</div>
    </div>
  )
}

function FromMonitor({ what, children }: { what: string; children: (data: any) => React.ReactNode }) {
  const { data, error } = useApi(`/api/monitor/${what}`)
  if (error) return <ErrorNote>{error}</ErrorNote>
  if (data === undefined) return <Empty>Loading…</Empty>
  if (data === null) return <Empty>Link a monitor in <Link to="/settings" className="text-accent">Settings</Link> to fill this panel.</Empty>
  return <>{children(data)}</>
}

function WidgetBody({ w }: { w: Widget }) {
  if (w.type === "tempo") return <FromMonitor what="tempo">{(t) => (t.configured === false ? <Empty>Add your RTE API keys in the monitor's settings.</Empty> : <TempoTiles tempo={t} className="auto-rows-[96px]" />)}</FromMonitor>
  if (w.type === "pipelines") return <FromMonitor what="pipelines">{(rows) => <PipelineList rows={rows} />}</FromMonitor>
  if (w.type === "monitoring") return (
    <FromMonitor what="overview">{(o) => (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Hosts online" value={`${o.hosts_online} / ${o.hosts_total}`} level={o.hosts_online === o.hosts_total ? "ok" : "warn"} />
          <Stat label="Open alerts" value={o.alerts} level={o.alerts_crit ? "crit" : o.alerts ? "warn" : "ok"} />
          <Stat label="Containers" value={`${o.containers_running} / ${o.containers_total}`} />
        </div>
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 text-[13px]">
          <span className="text-fg2">CPU</span><Meter pct={o.cpu} /><span>{fmt.pct(o.cpu)}</span>
          <span className="text-fg2">Memory</span><Meter pct={o.mem} /><span>{fmt.pct(o.mem)}</span>
        </div>
      </div>
    )}</FromMonitor>
  )
  if (w.type === "note") return w.text ? <p className="whitespace-pre-wrap text-fg2">{w.text}</p> : <Empty>Empty note.</Empty>
  if (w.type === "links") {
    const links = parseLinks(w.links)
    return links.length ? (
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        {links.map((l) => <li key={l.url + l.label}><a href={l.url} target="_blank" rel="noreferrer noopener" className="flex h-10 items-center gap-2 truncate rounded-control border border-line px-3 hover:border-line2 hover:text-accent"><GlobeAltIcon className="size-4 shrink-0 text-fg3" aria-hidden /><span className="truncate">{l.label || l.url}</span></a></li>)}
      </ul>
    ) : <Empty>No links yet.</Empty>
  }
  if (w.type === "clock") return <Clock tz={w.tz} />
  if (w.type === "embed") return w.url && safeUrl(w.url)
    ? <iframe title={w.title} src={w.url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerPolicy="no-referrer" loading="lazy" className="w-full rounded-control border border-line bg-bg" style={{ height: w.height || 320 }} />
    : <Empty>Set an http(s) address.</Empty>
  return <Empty>Unknown widget.</Empty>
}

function WidgetForm({ widget, onSave, onRemove, onCancel }: { widget: Widget | null; onSave: (w: Widget) => Promise<void>; onRemove: () => void; onCancel: () => void }) {
  const [w, setW] = useState<Widget>(widget ?? { id: "", type: "note", title: "" })
  const [error, setError] = useState("")
  const set = (patch: Partial<Widget>) => setW({ ...w, ...patch })
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (w.type === "embed" && !safeUrl(w.url ?? "")) return setError("The address must start with http:// or https://.")
    try { await onSave({ ...w, title: w.title.trim() || WIDGETS[w.type].label }) } catch (err) { setError((err as Error).message) }
  }
  return (
    <Editor title={widget ? `Edit ${widget.title}` : "Add widget"} onCancel={onCancel} onSubmit={submit} error={error}
      footer={widget && <Button type="button" variant="danger" onClick={onRemove}>Remove widget</Button>}>
      {!widget && (
        <EditorGroup title="Kind">
          <fieldset className="col-span-full">
            <legend className="sr-only">Kind</legend>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
              {Object.entries(WIDGETS).map(([type, m]) => (
                <label key={type} className={`flex h-20 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-box border text-[13px] has-focus-visible:outline-2 has-focus-visible:outline-accent ${w.type === type ? "border-accent bg-accent-soft text-accent" : "border-line2 bg-raised text-fg2 hover:border-fg3"}`}>
                  <input type="radio" className="sr-only" name="widget-type" checked={w.type === type} onChange={() => set({ type })} />
                  <m.icon className="size-6" aria-hidden />{m.label}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-fg3">{WIDGETS[w.type].hint}</p>
          </fieldset>
        </EditorGroup>
      )}
      <EditorGroup title="Content">
        <div className="col-span-full"><Input label="Title" placeholder={WIDGETS[w.type].label} value={w.title} onChange={(e) => set({ title: e.target.value })} /></div>
        {w.type === "note" && <div className="col-span-full"><TextArea label="Text" rows={5} value={w.text ?? ""} onChange={(e) => set({ text: e.target.value })} /></div>}
        {w.type === "links" && <div className="col-span-full"><TextArea label="Links" rows={5} placeholder={"Proxmox | https://pve.lan:8006\nNextcloud | https://cloud.lan"} value={w.links ?? ""} onChange={(e) => set({ links: e.target.value })} hint="One per line: a label, a bar, then an http(s) address." /></div>}
        {w.type === "clock" && <Input label="Time zone" placeholder="Europe/Paris" value={w.tz ?? ""} onChange={(e) => set({ tz: e.target.value })} hint="Empty: the time zone of this browser." />}
        {w.type === "embed" && <>
          <Input label="Address" required placeholder="https://grafana.lan/d-solo/…" value={w.url ?? ""} onChange={(e) => set({ url: e.target.value })} hint="The page must allow being framed." />
          <Input label="Height (px)" type="number" min={120} max={1200} value={w.height ?? 320} onChange={(e) => set({ height: Number(e.target.value) })} />
        </>}
      </EditorGroup>
    </Editor>
  )
}

const DESKTOP = { cols: [["summary", "categories", "subnets", "deployments"], ["conflicts", "tasks", "warranty"]], hidden: [] }
const PHONE = { cols: [["summary", "conflicts", "tasks", "subnets"]], hidden: ["deployments", "warranty", "categories"] }

export function Overview() {
  const { data, reload } = useApi("/api/overview")
  const dash = useApi<{ widgets?: Widget[] }>("/api/settings/dashboard", { poll: false })
  const widgets = dash.data?.widgets ?? []
  const [editing, setEditing] = useState<Widget | null | undefined>()
  const [version, setVersion] = useState(0)
  const saveAll = async (list: Widget[]) => { await api("/api/settings/dashboard", { method: "PUT", body: { widgets: list } }); await dash.reload() }
  const save = async (w: Widget) => {
    if (w.id) await saveAll(widgets.map((x) => (x.id === w.id ? w : x)))
    else {
      const id = crypto.randomUUID().slice(0, 8)
      await saveAll([...widgets, { ...w, id }])
      reveal("manager", `w:${id}`, { desktop: DESKTOP, phone: PHONE })
      setVersion(version + 1)
    }
    setEditing(undefined)
  }
  const remove = async () => {
    if (!editing || !confirm(`Remove ${editing.title}?`)) return
    await saveAll(widgets.filter((x) => x.id !== editing.id))
    setEditing(undefined)
  }
  const stat = (label: string, value: any, to: string, level?: Level) => <Link to={to} className="-m-2 rounded-box p-2 hover:bg-raised"><Stat label={label} value={value ?? "—"} level={level} /></Link>
  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
      <Panel title="Summary" edit={edit}>
        <div className="grid grid-cols-4 gap-4 max-sm:grid-cols-2">
          {stat("Hardware", data?.hardware, "/hardware")}
          {stat("Virtual assets", data?.virtual, "/virtual")}
          {stat("IP addresses", data?.addresses, "/ipam")}
          {stat("Subnets", data?.subnets.length, "/ipam")}
          {stat("Node.js sites", data?.sites, "/sites")}
          {stat("Open tasks", data?.open_tasks, "/tasks")}
          {stat("Deploying", data?.running_deploys, "/deployments", data?.running_deploys ? "info" : undefined)}
          {stat("Conflicts", data?.conflicts.length, "/ipam", data?.conflicts.length ? "warn" : "ok")}
        </div>
      </Panel>
    ) },
    { id: "categories", title: "Hardware by category", render: (edit: any) => (
      <Panel title="Hardware by category" edit={edit} actions={[{ label: "Open hardware", onClick: () => navigate("/hardware") }]}>
        {data?.categories.length ? (
          <ul className="flex flex-col gap-2">
            {data.categories.map((c: any) => (
              <li key={c.name} className="grid grid-cols-[120px_1fr_auto] items-center gap-3">
                <span className="truncate">{c.name}</span>
                <div className="h-2 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-accent" style={{ width: `${(c.total * 100) / Math.max(...data.categories.map((x: any) => x.total))}%` }} /></div>
                <span className="text-[13px] whitespace-nowrap text-fg2">{c.total}{c.in_service < c.total && <span className="text-fg3"> · {c.total - c.in_service} out</span>}</span>
              </li>
            ))}
          </ul>
        ) : <Empty>No hardware yet.</Empty>}
      </Panel>
    ) },
    { id: "conflicts", title: "Addressing conflicts", render: (edit: any) => (
      <Panel title="Addressing conflicts" edit={edit} actions={[{ label: "Open IPAM", onClick: () => navigate("/ipam") }]}>
        {data?.conflicts.length ? <ul className="flex flex-col gap-2">{data.conflicts.map((c: any) => <li key={c.message} className="flex items-baseline gap-3"><Status level={c.severity} /><span>{c.message}</span></li>)}</ul> : <Empty>No conflicts.</Empty>}
      </Panel>
    ) },
    { id: "subnets", title: "Subnet usage", render: (edit: any) => (
      <Panel title="Subnet usage" edit={edit}>
        {data?.subnets.length ? <BarGauge rows={[...data.subnets].sort((a: any, b: any) => b.pct - a.pct).slice(0, 10).map((s: any) => ({ label: `${s.name} ${s.cidr}`, pct: s.pct }))} /> : <Empty>No subnets yet.</Empty>}
      </Panel>
    ) },
    { id: "tasks", title: "Due within 7 days", render: (edit: any) => (
      <Panel title="Due within 7 days" edit={edit}>
        {data?.tasks.length ? <ul className="flex flex-col gap-2">{data.tasks.map((t: any) => <li key={t.id} className="flex justify-between gap-3"><span>{t.title}</span><span className="whitespace-nowrap text-fg2">{fmt.date(t.due)}</span></li>)}</ul> : <Empty>Nothing due.</Empty>}
      </Panel>
    ) },
    { id: "deployments", title: "Recent deployments", render: (edit: any) => (
      <Panel title="Recent deployments" edit={edit} flush>
        {data?.deployments.length ? (
          <Table head={["Name", "Version", "State"]}>
            {data.deployments.map((d: any) => <tr key={d.id}><Td className="font-medium">{d.name}</Td><Td mono>{d.version || "—"}</Td><Td><Status level={deployLevel(d.status)} label={d.status || "planned"} /></Td></tr>)}
          </Table>
        ) : <div className="px-4 pb-4"><Empty>No deployments yet.</Empty></div>}
      </Panel>
    ) },
    { id: "warranty", title: "Warranty ending", render: (edit: any) => (
      <Panel title="Warranty ending" edit={edit}>
        {data?.warranty.length ? <ul className="flex flex-col gap-2">{data.warranty.map((h: any) => <li key={h.id} className="flex justify-between gap-3"><span>{h.name}</span><span className="text-fg2">{fmt.date(h.warranty_until)}</span></li>)}</ul> : <Empty>No warranty ending soon.</Empty>}
      </Panel>
    ) },
    ...widgets.map((w) => ({ id: `w:${w.id}`, title: w.title, render: (edit: any) => (
      <Panel title={w.title} edit={edit} flush={w.type === "embed"} actions={[{ label: "Edit widget", onClick: () => setEditing(w) }]}>
        <div className={w.type === "embed" ? "px-4 pb-4" : ""}><WidgetBody w={w} /></div>
      </Panel>
    ) })),
  ]
  return (
    <>
      <PageHeader title="Overview" onRefresh={reload} actions={<>
        <CustomizeButton />
        <Button variant="primary" disabled={editing === null} onClick={() => setEditing(null)}><PlusIcon className="size-5" aria-hidden />Add widget</Button>
      </>} />
      {editing !== undefined && <WidgetForm key={editing?.id ?? "new"} widget={editing} onSave={save} onRemove={remove} onCancel={() => setEditing(undefined)} />}
      {(dash.data || dash.error) && <Board key={version} id="manager" panels={panels} desktop={DESKTOP} phone={PHONE} />}
    </>
  )
}

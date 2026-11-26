import { ArrowPathIcon, PlayIcon, StopIcon } from "@heroicons/react/24/outline"
import { useEffect, useState } from "react"
import { Button, Empty, ErrorNote, Input, Mono, Panel, Stat, StateCell, Status, Table, Tabs, Td, Variable, ask, SearchInput, PageSkeleton } from "../ui/components"
import { t, lang } from "../ui/i18n"
import { fmt, type Level, sortRows, useApi } from "../ui/lib"
import { Link, navigate, PageHeader } from "../ui/shell"
import { allTags, hasTag, tagOptions } from "../ui/tags"
import { onHost } from "./pages"

export interface Service {
  name: string; description: string; active: string; sub: string; enabled: string
  since: number; pid: number; mem: number; cpu_pct: number; restarts: number
  kind: string; result: string; path: string
  host?: string; host_id?: string
}

/** Red when it failed, amber while it changes state or waits to restart, green when running, grey when stopped. */
export function serviceLevel(s: Pick<Service, "active" | "sub">): Level {
  if (s.active === "failed") return "crit"
  if (s.sub === "auto-restart" || ["activating", "deactivating", "reloading"].includes(s.active)) return "warn"
  if (s.active === "active") return s.sub === "running" ? "ok" : "info"
  return "off"
}

/** What a person would say: "Running", "Done" for a one-shot that exited fine, "Stopped"… */
export function serviceWord(s: Pick<Service, "active" | "sub">) {
  if (s.active === "failed") return "Failed"
  if (s.sub === "auto-restart") return "Restarting"
  if (s.active === "activating") return "Starting"
  if (s.active === "deactivating") return "Stopping"
  if (s.active === "reloading") return "Reloading"
  if (s.active === "active") return s.sub === "running" ? "Running" : s.sub === "exited" ? "Done" : s.sub
  return "Stopped"
}

/** How long it has been in its state, as "3 d 4 h". */
export const sinceFor = (since: number, now = Date.now() / 1000) => (since > 0 ? fmt.uptime(Math.max(0, now - since)) : "—")

const SHOWS = [{ value: "", label: "All" }, { value: "running", label: "Running" }, { value: "failed", label: "Failed" }, { value: "stopped", label: "Stopped" }, { value: "enabled-stopped", label: "Enabled but not running" }]

/** Search and state together. "Enabled but not running" finds what should start at boot and did not. */
export function filterServices(rows: Service[], q: string, show: string) {
  const n = q.trim().toLowerCase()
  return rows.filter((s) =>
    (!n || [s.name, s.description, s.host].some((v) => String(v ?? "").toLowerCase().includes(n))) &&
    (!show || (show === "running" ? s.sub === "running" : show === "failed" ? s.active === "failed"
      : show === "stopped" ? s.active === "inactive" : s.enabled === "enabled" && s.active !== "active")))
}

const RANK: Record<Level, number> = { crit: 0, warn: 1, ok: 2, info: 3, off: 4 }
const servicePath = (hostId: string, name: string) => `/hosts/${hostId}/services/${encodeURIComponent(name)}`

/** Failed ones first, then by name; or by a column picked in the header. */
/** `compact`, for a half-width panel: the state as an icon, and no "At boot" column. */
export function ServiceTable({ rows, hostId, withHost, compact }: { rows: Service[]; hostId?: string; withHost?: boolean; compact?: boolean }) {
  const [q, setQ] = useState("")
  const [show, setShow] = useState("")
  const [order, setOrder] = useState<{ col: number; desc: boolean }>({ col: -1, desc: false })
  const keys: ((s: Service) => any)[] = [(s) => RANK[serviceLevel(s)], (s) => s.name, ...(withHost ? [(s: Service) => s.host] : []), (s) => -s.since, (s) => s.mem, (s) => s.cpu_pct, (s) => s.restarts, (s) => s.enabled]
  const found = filterServices(rows, q, show)
  const list = order.col >= 0 ? sortRows(found, keys[order.col], order.desc) : [...found].sort((a, b) => RANK[serviceLevel(a)] - RANK[serviceLevel(b)] || a.name.localeCompare(b.name))
  const open = (s: Service) => navigate(servicePath(s.host_id ?? hostId!, s.name))
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 px-4 pb-3">
        <SearchInput className="min-w-40 max-w-64 flex-1 max-sm:max-w-none" placeholder="Name or description" value={q} onChange={(e) => setQ(e.target.value)} />
        <Variable label="Show" value={show} onChange={setShow} options={SHOWS} />
        <span className="ml-auto text-[13px] text-fg2">{t("{n} of {total}", { n: list.length, total: rows.length })}</span>
      </div>
      {list.length === 0 ? <div className="px-4 pb-4"><Empty>{t("Nothing matches.")}</Empty></div> : (
        <Table head={["State", "Service", ...(withHost ? ["Host"] : []), "For", "Memory", "CPU", "Restarts", ...(compact ? [] : ["At boot"])]} sort={order} onSort={(col) => setOrder({ col, desc: order.col === col && !order.desc })}>
          {list.map((s) => (
            <tr key={`${s.host_id ?? ""}${s.name}`} className="cursor-pointer hover:bg-raised" onClick={(e) => { if (!(e.target as HTMLElement).closest("a, button")) open(s) }}>
              {compact
                ? <Td title={t(serviceWord(s))}><Status cell level={serviceLevel(s)} label="" /><span className="sr-only">{t(serviceWord(s))}</span></Td>
                : <StateCell level={serviceLevel(s)} label={serviceWord(s)} />}
              <Td className={compact ? "max-w-48" : "max-w-md"}>
                <span className="flex min-w-0 flex-col">
                  <Link to={servicePath(s.host_id ?? hostId!, s.name)} className="truncate font-medium hover:text-accent">{s.name}</Link>
                  {s.description && s.description !== `${s.name}.service` && <span className="truncate text-xs text-fg3">{s.description}</span>}
                </span>
              </Td>
              {withHost && <Td><Link to={`/hosts/${s.host_id}`} className="text-fg2 hover:text-accent">{s.host}</Link></Td>}
              <Td className="whitespace-nowrap text-fg2">{sinceFor(s.since)}</Td>
              <Td className="whitespace-nowrap text-fg2 tabular-nums">{s.mem ? fmt.bytes(s.mem) : "—"}</Td>
              <Td className="whitespace-nowrap text-fg2 tabular-nums">{s.sub === "running" ? fmt.pct(s.cpu_pct) : "—"}</Td>
              <Td className={s.restarts ? "text-warn" : "text-fg3"}>{s.restarts || "—"}</Td>
              {!compact && <Td className="text-fg2">{s.enabled ? t(s.enabled) : "—"}</Td>}
            </tr>
          ))}
        </Table>
      )}
    </>
  )
}

/** Counts of one host's or the fleet's services, as numbers to click into the table. */
function Counts({ rows }: { rows: Service[] }) {
  const failed = rows.filter((s) => s.active === "failed").length
  const lazy = rows.filter((s) => s.enabled === "enabled" && s.active !== "active" && s.active !== "failed").length
  return (
    <div className="grid grid-cols-4 gap-4 max-sm:grid-cols-2">
      <Stat label="Running" value={rows.filter((s) => s.sub === "running").length} level="ok" />
      <Stat label="Failed" value={failed} level={failed ? "crit" : "ok"} />
      <Stat label="Enabled but not running" value={lazy} level={lazy ? "warn" : undefined} />
      <Stat label="Loaded" value={rows.length} />
    </div>
  )
}

/** The services panel of a host's page. */
export function HostServices({ host, edit }: { host: any; edit?: any }) {
  const rows: Service[] = host.services ?? []
  return (
    <Panel title={t("Services")} flush edit={edit} help="systemd services, read every minute. Click one for its details, logs and unit file.">
      {rows.length === 0 ? <div className="px-4 pb-4"><Empty>{t("No services reported yet. Up-to-date agents list them from systemd.")}</Empty></div> : <>
        <div className="px-4 pb-4"><Counts rows={rows} /></div>
        <ServiceTable rows={rows} hostId={host.id} compact />
      </>}
    </Panel>
  )
}

/** Every service of every host. */
export function ServicesPage() {
  const { data, error, reload } = useApi<Service[]>("/api/services")
  const hosts = useApi<any[]>("/api/hosts", { poll: false }).data ?? []
  const [host, setHost] = useState(() => new URLSearchParams(location.search).get("host") ?? "")
  const [tag, setTag] = useState("")
  const rows = (data ?? []).filter((s) => (!host || s.host_id === host) && (!tag || hasTag(hosts.find((h) => h.id === s.host_id) ?? {}, tag)))
  const reporting = new Set((data ?? []).map((s) => s.host_id)).size
  return (
    <>
      <PageHeader title={t("Services")} subtitle={t("systemd services of {n} hosts, failed ones first.", { n: reporting })} onRefresh={reload}
        variables={<>
          <Variable label="Host" value={host} onChange={setHost} options={[{ value: "", label: "All" }, ...hosts.filter((h) => h.services_total).map((h) => ({ value: h.id, label: h.name }))]} />
          {allTags(hosts).length > 0 && <Variable label="Tag" value={tag} onChange={setTag} options={tagOptions(allTags(hosts))} />}
        </>} />
      <ErrorNote>{error}</ErrorNote>
      <div className="mb-4"><Panel title={t("Summary")}><Counts rows={rows} /></Panel></div>
      <Panel title={t("Services")} flush loading={!data}>
        {data && !data.length ? <div className="px-4 pb-4"><Empty>{t("No services reported yet. Up-to-date agents list them from systemd.")}</Empty></div> : <ServiceTable rows={rows} withHost={!host} hostId={host} />}
      </Panel>
    </>
  )
}

const VIEWS = [{ id: "logs", label: "Logs" }, { id: "status", label: "Status" }, { id: "cat", label: "Unit file" }]

/** What the agent says about one service, read when the tab opens: logs, `systemctl status` or the unit file. */
function AgentText({ hostId, name, op, nonce }: { hostId: string; name: string; op: string; nonce: number }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(true)
  useEffect(() => {
    let live = true
    setBusy(true)
    onHost(hostId, { action: "service", op, name }).then((r) => live && setText(r.output.trim() || t("Nothing.")), (e) => live && setText((e as Error).message)).finally(() => live && setBusy(false))
    return () => { live = false }
  }, [hostId, name, op, nonce])
  return <pre aria-busy={busy} aria-live="polite" className="max-h-[32rem] min-h-40 overflow-auto rounded-box bg-bg p-3 font-mono text-[13px] whitespace-pre-wrap">{busy ? t("Waiting for the agent…") : text}</pre>
}

export function ServiceDetail({ hostId, name }: { hostId: string; name: string }) {
  const { data: h, error, reload } = useApi(`/api/hosts/${hostId}`)
  const [view, setView] = useState("logs")
  const [nonce, setNonce] = useState(0)
  const [note, setNote] = useState("")
  if (error) return <p role="alert" className="text-crit">{error}</p>
  if (!h) return <PageSkeleton />
  const s: Service | undefined = h.services?.find((x: Service) => x.name === name)
  const crumbs = [{ label: "Hosts", to: "/hosts" }, { label: h.name, to: `/hosts/${hostId}` }, { label: "Services", to: `/services?host=${hostId}` }, { label: name }]
  if (!s) return <><PageHeader title={name} crumbs={crumbs} /><Empty>{t("This service is not loaded on {host} any more.", { host: h.name })}</Empty></>
  const control = async (op: string) => {
    if (op !== "start" && !await ask(t(op === "stop" ? "Stop {name} on {host}? What depends on it stops working." : "Restart {name} on {host}?", { name, host: h.name }), { action: op === "stop" ? "Stop" : "Restart", danger: op === "stop" })) return
    setNote(t("Sent, waiting for the agent…"))
    try { const r = await onHost(hostId, { action: "service", op, name }); setNote(r.ok ? t("{op} done.", { op: t(op === "start" ? "Start" : op === "stop" ? "Stop" : "Restart") }) : r.output); setNonce(nonce + 1); reload() } catch (e) { setNote((e as Error).message) }
  }
  const row = (label: string, value: React.ReactNode) => <><dt className="text-fg2">{t(label)}</dt><dd className="min-w-0 truncate">{value || "—"}</dd></>
  return (
    <>
      <PageHeader title={name} crumbs={crumbs} subtitle={s.description} onRefresh={() => { reload(); setNonce(nonce + 1) }}
        actions={<>
          <Status level={serviceLevel(s)} label={serviceWord(s)} />
          {s.active !== "active" && <Button variant="primary" onClick={() => control("start")}><PlayIcon className="size-5" aria-hidden />{t("Start")}</Button>}
          <Button onClick={() => control("restart")}><ArrowPathIcon className="size-5" aria-hidden />{t("Restart")}</Button>
          {s.active === "active" && name !== "nyx-agent" && <Button variant="danger" onClick={() => control("stop")}><StopIcon className="size-5" aria-hidden />{t("Stop")}</Button>}
        </>} />
      {note && <p role="status" className="mb-4 rounded-panel bg-raised px-4 py-2.5 text-fg2">{note}</p>}
      <div className="mb-4 grid grid-cols-4 gap-4 max-md:grid-cols-2">
        <Panel title={t("State")}><Stat label={serviceWord(s)} value={sinceFor(s.since)} sub={s.since ? t("since {date}", { date: new Date(s.since * 1000).toLocaleString(lang) }) : undefined} level={serviceLevel(s)} /></Panel>
        <Panel title={t("Memory")}><Stat label="In use" value={s.mem ? fmt.bytes(s.mem) : "—"} /></Panel>
        <Panel title={t("CPU")}><Stat label="Share of one core" value={s.sub === "running" ? fmt.pct(s.cpu_pct) : "—"} /></Panel>
        <Panel title={t("Restarts")}><Stat label="Since it was loaded" value={s.restarts} level={s.restarts ? "warn" : undefined} /></Panel>
      </div>
      <div className="grid grid-cols-[minmax(0,20rem)_1fr] gap-4 max-lg:grid-cols-1">
        <Panel title={t("Details")}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
            {row("Host", <Link to={`/hosts/${hostId}`} className="text-accent">{h.name}</Link>)}
            {row("State", `${s.active} (${s.sub})`)}
            {row("Last result", s.result && <span className={s.result === "success" ? "" : "text-crit"}>{s.result}</span>)}
            {row("At boot", s.enabled && t(s.enabled))}
            {row("Type", s.kind)}
            {row("Main PID", s.pid > 0 ? <Mono>{s.pid}</Mono> : "")}
            {row("Unit file", s.path && <span title={s.path}><Mono>{s.path}</Mono></span>)}
          </dl>
        </Panel>
        <Panel title={t("From the agent")} help="Read on demand: the answer comes with the host's next report, within a few seconds while this page is open.">
          <div className="mb-3 flex flex-wrap items-center gap-3"><Tabs tabs={VIEWS} value={view} onChange={setView} /><Button className="ml-auto" onClick={() => setNonce(nonce + 1)}><ArrowPathIcon className="size-5" aria-hidden />{t("Read again")}</Button></div>
          <AgentText hostId={hostId} name={name} op={view} nonce={nonce} />
        </Panel>
      </div>
    </>
  )
}

import { SignalIcon } from "@heroicons/react/24/outline"
import { useEffect, useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { Button, Empty, Mono, Panel, Stat, Status, Table, Td, Variable } from "../ui/components"
import { api, type Level, useApi } from "../ui/lib"
import { Link, navigate, PageHeader } from "../ui/shell"

export interface LogRow { t?: number; level: Level; service: string; message: string; host?: string; count: number }

const LEVELS: Record<string, string> = { crit: "Error", warn: "Warning", info: "Info" }
const LIVE_LINES = 1000
const LIVE_POLL_MS = 2000

/** Reads `<epoch> <<priority>> <service>: <message>`, or the plain journal line of an older agent. */
export function parseLog(line: string, host?: string): LogRow {
  const [, t, priority, service, message] = line.match(/^(\d+) <(\d)> (.*?): (.*)$/) ?? []
  if (t) return { t: +t, level: +priority <= 3 ? "crit" : +priority === 4 ? "warn" : "info", service, message, host, count: 1 }
  const [, iso, old, text] = line.match(/^(\S+) \S+ ([^\s:[]+)(?:\[\d+\])?: (.*)$/) ?? []
  const time = iso ? Date.parse(iso.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) : NaN
  if (!isNaN(time)) return { t: time / 1000, level: "warn", service: old, message: text, host, count: 1 }
  return { level: "warn", service: "", message: line, host, count: 1 }
}

/** Newest first, with repeats of a message folded into its latest occurrence. */
export function logRows(lines: { line: string; host?: string }[]): LogRow[] {
  const rows = new Map<string, LogRow>()
  for (const r of lines.map((l) => parseLog(l.line, l.host)).sort((a, b) => (b.t ?? 0) - (a.t ?? 0))) {
    const key = `${r.host}|${r.service}|${r.message}`
    const seen = rows.get(key)
    if (seen) seen.count++
    else rows.set(key, r)
  }
  return [...rows.values()]
}

/** Follows the logs of a host. Only runs while the tab is visible, so that the agent stops when nobody looks. */
export function useLiveLogs(id: string | null) {
  const [state, setState] = useState({ lines: [] as string[], connected: false })
  useEffect(() => {
    setState({ lines: [], connected: false })
    if (!id) return
    let after = 0, stopped = false, timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (!document.hidden) {
        try {
          const r = await api(`/api/hosts/${id}/logs/live?after=${after}`)
          if (stopped) return
          after = r.seq
          setState((s) => ({ connected: r.connected, lines: [...s.lines, ...r.lines].slice(-LIVE_LINES) }))
        } catch { setState((s) => ({ ...s, connected: false })) }
      }
      if (!stopped) timer = setTimeout(tick, LIVE_POLL_MS)
    }
    tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, [id])
  return state
}

function when(t?: number) {
  if (!t) return "—"
  const d = new Date(t * 1000)
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: "2-digit", month: "2-digit" })} ${time}`
}

export function LogTable({ rows, hosts }: { rows: LogRow[]; hosts?: boolean }) {
  const message = (r: LogRow) => <>{r.message}{r.count > 1 && <span className="ml-2 rounded-full bg-raised px-2 py-0.5 font-sans text-xs text-fg2">× {r.count}</span>}</>
  const key = (r: LogRow) => `${r.host}${r.service}${r.message}`
  return (
    <>
      <div className="max-sm:hidden">
        <Table head={["Time", "Level", ...(hosts ? ["Host"] : []), "Service", "Message"]}>
          {rows.map((r) => (
            <tr key={key(r)}>
              <Td mono className="whitespace-nowrap text-fg3">{when(r.t)}</Td>
              <Td><Status level={r.level} label={LEVELS[r.level]} /></Td>
              {hosts && <Td className="font-medium whitespace-nowrap">{r.host}</Td>}
              <Td className="text-fg2 whitespace-nowrap">{r.service || "—"}</Td>
              <Td className="w-full font-mono text-[13px] [overflow-wrap:anywhere]">{message(r)}</Td>
            </tr>
          ))}
        </Table>
      </div>
      <ul className="divide-y divide-line border-t border-line sm:hidden">
        {rows.map((r) => (
          <li key={key(r)} className="px-4 py-3">
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate text-fg2">{hosts && <span className="font-medium text-fg">{r.host} · </span>}{r.service}</span>
              <Status cell level={r.level} label={LEVELS[r.level]} />
            </div>
            <p className="mt-1 font-mono text-[13px] [overflow-wrap:anywhere]">{message(r)}</p>
            <p className="mt-1 text-xs text-fg3">{when(r.t)}</p>
          </li>
        ))}
      </ul>
    </>
  )
}

/** Lines per value of `key`, biggest first. */
function tally(rows: LogRow[], key: (r: LogRow) => string) {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(key(r), (counts.get(key(r)) ?? 0) + r.count)
  return [...counts].sort((a, b) => b[1] - a[1])
}

function LiveButton({ live, onClick, disabled }: { live: boolean; onClick: () => void; disabled?: boolean }) {
  return <Button variant={live ? "primary" : undefined} aria-pressed={live} disabled={disabled} onClick={onClick}><SignalIcon className="size-5" aria-hidden />{live ? "Stop live" : "Go live"}</Button>
}

const liveNote = (connected: boolean) => (connected
  ? "Live: everything from info up, nothing is stored. Stops when you leave."
  : "Waiting for the agent. It starts at its next report, within 15 seconds. An older agent has to be updated first.")

/** The logs block of a host page. */
export function HostLogs({ id, lines, edit }: { id: string; lines: string[]; edit: any }) {
  const [live, setLive] = useState(false)
  const tail = useLiveLogs(live ? id : null)
  const rows = logRows((live ? tail.lines : lines ?? []).map((line) => ({ line })))
  return (
    <Panel title="Logs" flush edit={edit} footer={live ? liveNote(tail.connected) : "Warnings and errors from journald, kept in memory."}>
      <div className="flex justify-end px-4 pb-4"><LiveButton live={live} onClick={() => setLive(!live)} /></div>
      {rows.length ? <div className="max-h-96 overflow-y-auto"><LogTable rows={rows} /></div> : <div className="px-4 pb-4"><Empty>{live ? "No new lines yet." : "No warnings."}</Empty></div>}
    </Panel>
  )
}

/** Latest errors across the fleet, for the overview. */
export function RecentLogs({ edit }: { edit: any }) {
  const { data } = useApi<any[]>("/api/logs?host=&q=")
  const rows = logRows(data ?? []).slice(0, 6)
  return (
    <Panel title="Recent logs" flush edit={edit} actions={[{ label: "All logs", onClick: () => navigate("/logs") }]}>
      {rows.length ? <LogTable rows={rows} hosts /> : <div className="px-4 pb-4"><Empty>No warnings.</Empty></div>}
    </Panel>
  )
}

export function Logs() {
  const hosts = useApi<any[]>("/api/hosts", { poll: false })
  const [host, setHost] = useState("")
  const [q, setQ] = useState("")
  const [needle, setNeedle] = useState("")
  const [level, setLevel] = useState("")
  const [service, setService] = useState("")
  const [liveOn, setLive] = useState(false)
  useEffect(() => { const id = setTimeout(() => setNeedle(q), 300); return () => clearTimeout(id) }, [q])
  const live = liveOn && !!host
  const tail = useLiveLogs(live ? host : null)
  const saved = useApi<any[]>(`/api/logs?host=${host}&q=${encodeURIComponent(needle)}`, { poll: !live })
  const name = hosts.data?.find((h) => h.id === host)?.name
  const all = logRows(live ? tail.lines.map((line) => ({ line, host: name })) : saved.data ?? [])
  const n = needle.toLowerCase()
  const inView = all.filter((r) => !live || `${r.service} ${r.message}`.toLowerCase().includes(n))
  const rows = inView.filter((r) => (!level || r.level === level) && (!service || r.service === service))
  const sum = (l: string) => inView.filter((r) => r.level === l).reduce((s, r) => s + r.count, 0)
  const services = tally(inView, (r) => r.service).filter(([s]) => s)
  const noisy = tally(inView, (r) => r.host ?? "")

  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
      <Panel title="Summary" edit={edit}>
        <div className="grid grid-cols-4 gap-4 max-sm:grid-cols-2">
          <Stat label="Errors" value={sum("crit")} level={sum("crit") ? "crit" : "ok"} />
          <Stat label="Warnings" value={sum("warn")} level={sum("warn") ? "warn" : "ok"} />
          <Stat label="Services" value={services.length} />
          <Stat label="Hosts" value={noisy.length} />
        </div>
      </Panel>
    ) },
    { id: "services", title: "Noisiest services", render: (edit: any) => (
      <Panel title="Noisiest services" edit={edit}>
        {services.length ? (
          <div className="flex flex-wrap gap-2">
            {services.slice(0, 12).map(([s, count]) => <Button key={s} variant={service === s ? "primary" : undefined} aria-pressed={service === s} onClick={() => setService(service === s ? "" : s)}>{s} <span className="opacity-70">{count}</span></Button>)}
          </div>
        ) : <Empty>Nothing yet.</Empty>}
      </Panel>
    ) },
    { id: "hosts", title: "Noisiest hosts", render: (edit: any) => (
      <Panel title="Noisiest hosts" edit={edit}>
        {noisy.length ? <ul className="divide-y divide-line">{noisy.slice(0, 8).map(([h, count]) => <li key={h} className="flex justify-between py-2"><span>{h}</span><Mono className="text-fg2">{count}</Mono></li>)}</ul> : <Empty>Nothing yet.</Empty>}
      </Panel>
    ) },
    { id: "journal", title: "Journal", render: (edit: any) => (
      <Panel title="Journal" flush edit={edit} footer={live ? liveNote(tail.connected) : "Identical messages are folded, with the number of repeats."}>
        {rows.length ? <LogTable rows={rows} hosts={!host} /> : <div className="px-4 pb-4"><Empty>{live ? "No new lines yet." : "No matching lines."}</Empty></div>}
      </Panel>
    ) },
  ]

  return (
    <>
      <PageHeader title="Logs" subtitle={host ? <>{live ? "Everything" : "Warnings and errors"} from <Link to={`/hosts/${host}`}>{name}</Link></> : "Warnings and errors, the last 500 lines per host. Pick a host to follow it live."} onRefresh={saved.reload}
        actions={<><CustomizeButton /><LiveButton live={live} disabled={!host} onClick={() => setLive(!liveOn)} /></>}
        variables={<>
          <Variable label="Host" value={host} onChange={setHost} options={[{ value: "", label: "All" }, ...(hosts.data ?? []).map((h) => ({ value: h.id, label: h.name }))]} />
          <Variable label="Level" value={level} onChange={setLevel} options={[{ value: "", label: "All" }, { value: "crit", label: "Errors" }, { value: "warn", label: "Warnings" }, ...(live ? [{ value: "info", label: "Info" }] : [])]} />
          <label className="flex h-9 items-stretch overflow-hidden rounded-control border border-line2 max-sm:h-11 max-sm:w-full">
            <span className="flex items-center bg-raised pr-3 pl-4 text-fg2">Filter</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} className="w-56 min-w-0 flex-1 bg-surface px-3 text-fg outline-none" />
          </label>
        </>} />
      <Board id="logs" panels={panels}
        desktop={{ cols: [["summary", "services", "journal"]], hidden: ["hosts"] }}
        phone={{ cols: [["summary", "journal"]], hidden: ["services", "hosts"] }} />
    </>
  )
}

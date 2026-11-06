import { useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { BarGauge, Empty, ErrorNote, Gauge, Panel, RangeSelect, Stat, StateCell, Status, Table, Td, TimeSeries, Variable, Mono } from "../ui/components"
import { fmt, type Level, levelSoft, useApi } from "../ui/lib"
import { Link, navigate, PageHeader } from "../ui/shell"
import { DiskHealth } from "./disks"
import { RecentLogs } from "./logs"
import { TempoTiles } from "./tempo"

const sevLevel = (s: string): Level => (s === "crit" ? "crit" : s === "warn" ? "warn" : s === "info" ? "info" : "ok")
export const hostLevel = (s: string): Level => (s === "off" ? "off" : (s as Level))

function HostList({ hosts, th }: { hosts: any[]; th: any }) {
  return (
    <>
      <div className="max-sm:hidden">
        <Table head={["Host", "Address", "CPU", "Mem.", "State"]}>
          {hosts.map((h) => (
            <tr key={h.id} className="cursor-pointer hover:bg-raised" onClick={() => navigate(`/hosts/${h.id}`)}>
              <Td className="font-medium"><Link to={`/hosts/${h.id}`}>{h.name}</Link></Td>
              <Td mono>{h.ip || "—"}</Td>
              <Td className={h.cpu >= th.warn ? "text-warn" : "text-fg2"}>{fmt.pct(h.cpu)}</Td>
              <Td className={h.mem >= th.warn ? "text-warn" : "text-fg2"}>{fmt.pct(h.mem)}</Td>
              <StateCell level={hostLevel(h.status)} />
            </tr>
          ))}
        </Table>
      </div>
      <ul className="divide-y divide-line sm:hidden">
        {hosts.map((h) => (
          <li key={h.id}>
            <Link to={`/hosts/${h.id}`} className="grid h-[68px] grid-cols-[1fr_auto] items-stretch">
              <span className="flex flex-col justify-center px-4"><span className="font-medium">{h.name}</span><Mono className="text-fg2">{h.ip || "—"}</Mono></span>
              <span className={`flex flex-col items-end justify-center px-4 ${levelSoft[hostLevel(h.status)]}`}>
                <Status cell level={hostLevel(h.status)} />
                <span className="text-xs text-fg2">CPU {fmt.pct(h.cpu)} · Mem. {fmt.pct(h.mem)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}

/** Block of the overview. It fetches its own data, so that it costs nothing while hidden. */
function Probes({ edit }: { edit: any }) {
  const { data } = useApi<any[]>("/api/probes")
  return (
    <Panel title="Probes" edit={edit} actions={[{ label: "Network", onClick: () => navigate("/network") }]}>
      {data?.length ? <ul className="divide-y divide-line">{data.map((p) => <li key={p.id} className="flex items-center justify-between gap-3 py-2"><span className="min-w-0 truncate">{p.name}</span><Status cell level={p.up == null ? "off" : p.up ? "ok" : "crit"} label={p.up ? `${p.latency_ms.toFixed(0)} ms` : p.up == null ? "Pending" : "Down"} /></li>)}</ul> : <Empty>No probes yet.</Empty>}
    </Panel>
  )
}

function StoppedContainers({ edit }: { edit: any }) {
  const { data } = useApi<any[]>("/api/containers")
  const stopped = data?.filter((c) => c.state !== "running") ?? []
  return (
    <Panel title="Stopped containers" edit={edit} actions={[{ label: "All containers", onClick: () => navigate("/containers") }]}>
      {stopped.length ? <ul className="divide-y divide-line">{stopped.map((c) => <li key={c.host_id + c.name} className="flex justify-between gap-3 py-2"><Mono>{c.name}</Mono><span className="text-fg3">{c.host}</span></li>)}</ul> : <Empty>Everything is running.</Empty>}
    </Panel>
  )
}

export function Overview() {
  const [range, setRange] = useState("24h")
  const [host, setHost] = useState("")
  const over = useApi("/api/overview")
  const hosts = useApi<any[]>("/api/hosts")
  const series = useApi<any[]>(`/api/series?range=${range}&host=${host}`)
  const alerts = useApi("/api/c/alerts?filter=open%3Dtrue&sort=-created&perPage=5")
  const power = useApi("/api/integrations/power")
  const tempo = useApi("/api/integrations/tempo", { poll: false })
  const o = over.data
  const th = o?.thresholds ?? { warn: 75, crit: 90 }
  const reload = () => { over.reload(); hosts.reload(); series.reload(); alerts.reload() }
  const points = series.data ?? []
  const visible = (hosts.data ?? []).filter((h) => !host || h.id === host)
  const selected = host ? hosts.data?.find((h) => h.id === host) : undefined
  const cpu = selected ? selected.cpu ?? 0 : o?.cpu ?? 0
  const mem = selected ? selected.mem ?? 0 : o?.mem ?? 0
  const offline = o ? o.hosts_total - o.hosts_online : 0
  const stopped = o ? o.containers_total - o.containers_running : 0
  const pending = (hosts.data ?? []).filter((h) => h.updates > 0)

  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
      <Panel title="Summary" edit={edit}>
        <div className="grid grid-cols-2 gap-x-5 gap-y-5 [&>*:nth-child(even)]:border-l [&>*:nth-child(even)]:border-line [&>*:nth-child(even)]:pl-5">
          <Stat label="Hosts online" value={o ? `${o.hosts_online} / ${o.hosts_total}` : "—"} level={offline ? "warn" : "ok"} sub={`${offline} offline`} />
          <Stat label="Active alerts" value={o?.alerts ?? "—"} level={o?.alerts_crit ? "crit" : o?.alerts ? "warn" : "ok"} sub={`${o?.alerts_crit ?? 0} critical`} />
          <Stat label="Containers" value={o ? `${o.containers_running} / ${o.containers_total}` : "—"} level={stopped ? "warn" : "ok"} sub={`${stopped} stopped`} />
          <Stat label="Availability 7 d" value={o?.availability_7d == null ? "—" : `${o.availability_7d.toFixed(1)} %`} level={o?.availability_7d == null ? undefined : o.availability_7d >= 99 ? "ok" : "warn"} sub="across probes" />
        </div>
      </Panel>
    ) },
    { id: "usage", title: "Average usage", render: (edit: any) => (
      <Panel title="Average usage" edit={edit}>
        <div className="flex justify-around gap-4"><Gauge label="CPU" value={cpu} warn={th.warn} crit={th.crit} /><Gauge label="Memory" value={mem} warn={th.warn} crit={th.crit} /></div>
      </Panel>
    ) },
    { id: "load", title: "Load", render: (edit: any) => (
      <Panel title={`Load over ${range}`} edit={edit}>
        <TimeSeries series={[
          { name: "CPU", color: "var(--color-s1)", values: points.map((p) => ({ t: p.t, v: p.cpu })) },
          { name: "Memory", color: "var(--color-s2)", values: points.map((p) => ({ t: p.t, v: p.mem })) },
        ]} />
      </Panel>
    ) },
    { id: "alerts", title: "Recent alerts", render: (edit: any) => (
      <Panel title="Recent alerts" edit={edit} actions={[{ label: "All alerts", onClick: () => navigate("/alerts") }]}>
        {alerts.data?.items.length ? (
          <ul className="divide-y divide-line border-t border-line">
            {alerts.data.items.map((a: any) => (
              <li key={a.id} className="flex items-start gap-3 py-3">
                <Status cell level={sevLevel(a.severity)} label="" />
                <div><div>{a.message}</div><div className="text-xs text-fg3">{a.severity === "crit" ? "Critical" : "Warning"} · {fmt.ago(a.created)}</div></div>
              </li>
            ))}
          </ul>
        ) : <Empty>No open alerts.</Empty>}
      </Panel>
    ) },
    { id: "hosts", title: "Hosts", render: (edit: any) => (
      <Panel title="Hosts" edit={edit} flush actions={[{ label: "All hosts", onClick: () => navigate("/hosts") }]}><HostList hosts={visible} th={th} /></Panel>
    ) },
    { id: "storage", title: "Storage", render: (edit: any) => (
      <Panel title="Storage" edit={edit}>
        {o?.storage.length ? <BarGauge warn={th.warn} crit={th.crit} rows={o.storage.map((s: any) => ({ label: `${s.host} ${s.mount}`, pct: s.pct }))} /> : <Empty>No disks reported.</Empty>}
      </Panel>
    ) },
    { id: "power", title: "Power", render: (edit: any) => (
      <Panel title="Power" edit={edit}>
        <Stat label="Total draw" value={`${(power.data?.total ?? 0).toFixed(0)} W`} sub={`${power.data?.plugs.length ?? 0} plugs`} />
      </Panel>
    ) },
    { id: "tempo", title: "EDF Tempo", render: (edit: any) => <TempoPanel edit={edit} tempo={tempo.data} error={tempo.error} /> },
    { id: "disks", title: "Disk health", render: (edit: any) => <DiskHealth edit={edit} /> },
    { id: "logs", title: "Recent logs", render: (edit: any) => <RecentLogs edit={edit} /> },
    { id: "probes", title: "Probes", render: (edit: any) => <Probes edit={edit} /> },
    { id: "containers", title: "Stopped containers", render: (edit: any) => <StoppedContainers edit={edit} /> },
    { id: "updates", title: "Pending updates", render: (edit: any) => (
      <Panel title="Pending updates" edit={edit}>
        {pending.length ? <ul className="divide-y divide-line">{pending.map((h) => <li key={h.id} className="flex justify-between gap-3 py-2"><Link to={`/hosts/${h.id}`}>{h.name}</Link><span className="text-fg2">{h.updates}</span></li>)}</ul> : <Empty>Every host is up to date.</Empty>}
      </Panel>
    ) },
  ]

  return (
    <>
      <PageHeader
        title="Overview"
        crumbs={[{ label: "Dashboards" }, { label: "Homelab" }]}
        subtitle={`Updated at ${fmt.time(over.updated)}`}
        onRefresh={reload}
        actions={<><CustomizeButton /><RangeSelect value={range} onChange={setRange} /></>}
        variables={<Variable label="Host" value={host} onChange={setHost} options={[{ value: "", label: "All" }, ...(hosts.data ?? []).map((h) => ({ value: h.id, label: h.name }))]} />}
      />
      <Board
        id="overview"
        panels={panels}
        desktop={{ cols: [["summary", "load", "alerts"], ["usage", "hosts", "storage"]], hidden: ["power", "tempo", "disks", "logs", "probes", "containers", "updates"] }}
        phone={{ cols: [["summary", "usage", "alerts", "hosts"]], hidden: ["load", "storage", "power", "tempo", "disks", "logs", "probes", "containers", "updates"] }}
      />
    </>
  )
}

function TempoPanel({ tempo, error, edit }: { tempo: any; error?: string; edit: any }) {
  return (
    <Panel title="EDF Tempo" edit={edit}>
      {error ? <ErrorNote>{error}</ErrorNote> : !tempo ? <Empty>Loading…</Empty> : !tempo.configured ? <Empty>Add your RTE API keys in Settings.</Empty> : <TempoTiles tempo={tempo} className="auto-rows-[112px]" />}
    </Panel>
  )
}


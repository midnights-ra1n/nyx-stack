import { useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { BarGauge, Empty, Gauge, Panel, RangeSelect, Stat, StateCell, Status, Table, Td, TimeSeries, Variable, Mono } from "../ui/components"
import { fmt, type Level, levelSoft, useApi } from "../ui/lib"
import { Link, navigate, PageHeader } from "../ui/shell"

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
              <span className="flex flex-col justify-center px-5"><span className="font-medium">{h.name}</span><Mono className="text-fg2">{h.ip || "—"}</Mono></span>
              <span className={`flex flex-col items-end justify-center px-5 ${levelSoft[hostLevel(h.status)]}`}>
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
    { id: "tempo", title: "EDF Tempo", render: (edit: any) => <TempoPanel edit={edit} tempo={tempo.data} /> },
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
        desktop={{ cols: [["summary", "load", "alerts"], ["usage", "hosts", "storage"]], hidden: ["power", "tempo"] }}
        phone={{ cols: [["summary", "usage", "alerts", "hosts"]], hidden: ["load", "storage", "power", "tempo"] }}
      />
    </>
  )
}

const TEMPO: Record<string, { label: string; level: Level }> = { BLUE: { label: "Blue", level: "info" }, WHITE: { label: "White", level: "off" }, RED: { label: "Red", level: "crit" } }

function TempoPanel({ tempo, edit }: { tempo: any; edit: any }) {
  const day = (c?: string) => (c ? <Status level={TEMPO[c].level} label={TEMPO[c].label} /> : <span className="text-fg3">Not published</span>)
  return (
    <Panel title="EDF Tempo" edit={edit}>
      {!tempo?.configured ? <Empty>Add your RTE API keys in Settings.</Empty> : (
        <div className="flex flex-col gap-3">
          <div className="flex justify-between"><span className="text-fg2">Today</span>{day(tempo.today)}</div>
          <div className="flex justify-between"><span className="text-fg2">Tomorrow</span>{day(tempo.tomorrow)}</div>
          <div className="grid grid-cols-3 gap-3 border-t border-line pt-3">
            <Stat label="Blue left" value={tempo.remaining.blue} />
            <Stat label="White left" value={tempo.remaining.white} />
            <Stat label="Red left" value={tempo.remaining.red} />
          </div>
        </div>
      )}
    </Panel>
  )
}


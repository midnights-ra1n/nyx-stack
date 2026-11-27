import { RectangleGroupIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Button, Empty, ErrorNote, Gauge, Panel, RangeSelect, Stat, StateCell, Status, Table, Td, TimeSeries, Variable, Mono } from "../ui/components"
import { fmt, type Level, levelOf, levelSoft, levelText, useApi, useStored } from "../ui/lib"
import { Link, navigate } from "../ui/shell"
import { Dashboard } from "../ui/dashboard"
import { BASIC_KINDS } from "../ui/widgets"
import { DATASETS } from "./datasets"
import { PRESETS } from "./presets"
import { METRIC_KIND } from "./metric-chart"
import { DiskHealth } from "./disks"
import { HostIcon, hostType } from "./hosts"
import { averages, GroupsModal, inScope, scopeOptions } from "./groups"
import { combine, type Metric, pointsOf, slotFor } from "./metrics"
import { RecentLogs } from "./logs"
import { StoragePanel } from "./storage-tree"
import { PipelineList } from "../ui/pipelines"
import { TempoTiles } from "../ui/tempo"
import { NextDnsPanel } from "../ui/nextdns"
import { t, tn } from "../ui/i18n"

const KINDS = { metrics: METRIC_KIND, ...BASIC_KINDS }
const sevLevel = (s: string): Level => (s === "crit" ? "crit" : s === "warn" ? "warn" : s === "info" ? "info" : "ok")
export const hostLevel = (s: string): Level => (s === "off" ? "off" : (s as Level))

function HostList({ hosts, th }: { hosts: any[]; th: any }) {
  return (
    <>
      <div className="max-sm:hidden">
        <Table head={["Host", "Address", "CPU", "Mem.", "State"]}>
          {hosts.map((h) => (
            <tr key={h.id} className="cursor-pointer hover:bg-raised" onClick={() => navigate(`/hosts/${h.id}`)}>
              <Td className="font-medium"><span className="flex items-center gap-2"><HostIcon type={hostType(h, hosts)} /><Link to={`/hosts/${h.id}`}>{h.name}</Link></span></Td>
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
              <span className="flex flex-col justify-center px-4"><span className="flex items-center gap-2 font-medium"><HostIcon type={hostType(h, hosts)} />{h.name}</span><Mono className="text-fg2">{h.ip || "—"}</Mono></span>
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

/** One line per type of host and per group with its averages: which part of the homelab works hard, or runs hot. */
function ByGroup({ hosts, scope, onPick, th, edit }: { hosts: any[]; scope: string; onPick: (scope: string) => void; th: any; edit: any }) {
  const rows = scopeOptions(hosts, false).filter((o) => o.value).map((o) => ({ ...o, a: averages(hosts.filter((h) => inScope(h, o.value, hosts))) }))
  const cell = (v: number | null, warn: number, crit: number, unit = " %") => <Td className={v == null ? "text-fg3" : v >= warn ? levelText[levelOf(v, warn, crit)] : "text-fg2"}>{v == null ? "—" : `${v.toFixed(0)}${unit}`}</Td>
  return (
    <Panel title={t("By group")} edit={edit} flush help="Averages of the online hosts of each type and group. The temperature only counts hosts with a sensor, so physical ones.">
      {rows.length ? (
        <Table head={["Group", "Hosts", "CPU", "Mem.", "Temp."]}>
          {rows.map((r) => (
            <tr key={r.value} aria-selected={scope === r.value} className={`cursor-pointer hover:bg-raised ${scope === r.value ? "bg-accent-soft" : ""}`} onClick={() => onPick(scope === r.value ? "" : r.value)}>
              <Td className="font-medium"><span className="flex items-center gap-2">{r.group === "Types" && <HostIcon type={r.value.slice(5)} />}{r.raw ? r.label : t(r.label)}</span></Td>
              <Td className="text-fg2">{r.a.n}</Td>
              {cell(r.a.cpu, th.warn, th.crit)}
              {cell(r.a.mem, th.warn, th.crit)}
              {cell(r.a.temp, th.temp_warn ?? 80, th.temp_crit ?? 90, " °C")}
            </tr>
          ))}
        </Table>
      ) : <div className="px-4 pb-4"><Empty>{t("No host yet.")}</Empty></div>}
    </Panel>
  )
}

/** Block of the overview. It fetches its own data, so that it costs nothing while hidden. */
function Probes({ edit }: { edit: any }) {
  const { data } = useApi<any[]>("/api/probes")
  return (
    <Panel title={t("Probes")} edit={edit} actions={[{ label: "Network", onClick: () => navigate("/network") }]}>
      {data?.length ? <ul className="divide-y divide-line">{data.map((p) => <li key={p.id} className="flex items-center justify-between gap-3 py-2"><span className="min-w-0 truncate">{p.name}</span><Status cell level={p.up == null ? "off" : p.up ? "ok" : "crit"} label={p.up ? `${p.latency_ms.toFixed(0)} ms` : p.up == null ? "Pending" : "Down"} /></li>)}</ul> : <Empty>{t("No probes yet.")}</Empty>}
    </Panel>
  )
}

function PipelinesPanel({ edit }: { edit: any }) {
  const { data } = useApi<any[]>("/api/pipelines")
  return (
    <Panel title={t("Pipelines")} edit={edit} actions={[{ label: "Pipelines", onClick: () => navigate("/pipelines") }]}>
      <PipelineList rows={data ?? []} />
    </Panel>
  )
}

function StoppedContainers({ edit }: { edit: any }) {
  const { data } = useApi<any[]>("/api/containers")
  const stopped = data?.filter((c) => c.state !== "running") ?? []
  return (
    <Panel title={t("Stopped containers")} edit={edit} actions={[{ label: "All containers", onClick: () => navigate("/containers") }]}>
      {stopped.length ? <ul className="divide-y divide-line">{stopped.map((c) => <li key={c.host_id + c.name} className="flex justify-between gap-3 py-2"><Mono>{c.name}</Mono><span className="text-fg3">{c.host}</span></li>)}</ul> : <Empty>{t("Everything is running.")}</Empty>}
    </Panel>
  )
}

export function Overview() {
  const [range, setRange] = useState("24h")
  const [stored, setScope] = useStored("nyx.overview.scope", "")
  const [grouping, setGrouping] = useState(false)
  const over = useApi("/api/overview")
  const hosts = useApi<any[]>("/api/hosts")
  const all = hosts.data ?? []
  const scopes = scopeOptions(all)
  // A group or host deleted since reads as every host.
  const scope = scopes.some((o) => o.value === stored) ? stored : ""
  const visible = all.filter((h) => inScope(h, scope, all))
  // shortcut: a scope of more than 24 hosts charts the first 24 (the server's cap); fetch in pages if a homelab gets there.
  const ids = visible.slice(0, 24).map((h) => h.id)
  const series = useApi<any>(!scope ? `/api/series?range=${range}` : ids.length ? `/api/series?range=${range}&hosts=${ids.join(",")}` : null)
  const alerts = useApi("/api/c/alerts?filter=open%3Dtrue&sort=-created&perPage=5")
  const power = useApi("/api/integrations/power")
  const tempo = useApi("/api/integrations/tempo", { poll: false })
  const o = over.data
  const th = o?.thresholds ?? { warn: 75, crit: 90 }
  const reload = () => { over.reload(); hosts.reload(); series.reload(); alerts.reload() }
  // The whole fleet comes as one line from the server; a scope is the average of its hosts.
  const line = (m: Metric) => {
    if (!scope) return pointsOf(series.data, m)
    const lines = ids.map((id) => pointsOf(series.data?.[id], m)).filter((l) => l.length)
    return combine(lines, "avg", slotFor(lines))
  }
  const avg = averages(visible)
  const offline = o ? o.hosts_total - o.hosts_online : 0
  const stopped = o ? o.containers_total - o.containers_running : 0
  const pending = (hosts.data ?? []).filter((h) => h.updates > 0)

  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
      <Panel title={t("Summary")} edit={edit}>
        <div className="grid grid-cols-2 gap-x-5 gap-y-5 [&>*:nth-child(even)]:border-l [&>*:nth-child(even)]:border-line [&>*:nth-child(even)]:pl-5">
          <Stat label="Hosts online" value={o ? `${o.hosts_online} / ${o.hosts_total}` : "—"} level={offline ? "warn" : "ok"} sub={t("{n} offline", { n: offline })} />
          <Stat label="Active alerts" value={o?.alerts ?? "—"} level={o?.alerts_crit ? "crit" : o?.alerts ? "warn" : "ok"} sub={t("{n} critical", { n: o?.alerts_crit ?? 0 })} />
          <Stat label="Containers" value={o ? `${o.containers_running} / ${o.containers_total}` : "—"} level={stopped ? "warn" : "ok"} sub={t("{n} stopped", { n: stopped })} />
          <Stat label="Availability 7 d" value={o?.availability_7d == null ? "—" : `${fmt.num(o.availability_7d)} %`} level={o?.availability_7d == null ? undefined : o.availability_7d >= 99 ? "ok" : "warn"} sub="across probes" />
        </div>
      </Panel>
    ) },
    { id: "usage", title: "Average usage", render: (edit: any) => (
      <Panel title={t("Average usage")} edit={edit} footer={avg.n ? t("Across {n} online hosts", { n: avg.n }) + (avg.sensors ? ` · ${t("temperature from the {n} with a sensor", { n: avg.sensors })}` : "") : undefined}>
        <div className="flex flex-wrap justify-around gap-4">
          <Gauge label="CPU" value={avg.cpu ?? 0} warn={th.warn} crit={th.crit} />
          <Gauge label="Memory" value={avg.mem ?? 0} warn={th.warn} crit={th.crit} />
          {avg.temp != null && <Gauge label="Temperature" value={avg.temp} unit=" °C" warn={th.temp_warn ?? 80} crit={th.temp_crit ?? 90} />}
        </div>
      </Panel>
    ) },
    { id: "load", title: "Load", render: (edit: any) => (
      <Panel title={t("Load over {range}", { range })} edit={edit}>
        <TimeSeries series={[
          { name: "CPU", color: "var(--color-s1)", values: line("cpu") },
          { name: t("Memory"), color: "var(--color-s2)", values: line("mem") },
        ]} />
      </Panel>
    ) },
    { id: "alerts", title: "Recent alerts", render: (edit: any) => (
      <Panel title={t("Recent alerts")} edit={edit} loading={!alerts.data} actions={[{ label: "All alerts", onClick: () => navigate("/alerts") }]}>
        {alerts.data?.items.length ? (
          <ul className="divide-y divide-line border-t border-line">
            {alerts.data.items.map((a: any) => (
              <li key={a.id} className="flex items-start gap-3 py-3">
                <Status cell level={sevLevel(a.severity)} label="" />
                <div><div>{tn(a.message)}</div><div className="text-xs text-fg3">{t(a.severity === "crit" ? "Critical" : "Warning")} · {fmt.ago(a.created)}</div></div>
              </li>
            ))}
          </ul>
        ) : <Empty>{t("No open alerts.")}</Empty>}
      </Panel>
    ) },
    { id: "hosts", title: "Hosts", render: (edit: any) => (
      <Panel title={t("Hosts")} edit={edit} flush actions={[{ label: "All hosts", onClick: () => navigate("/hosts") }]}><HostList hosts={visible} th={th} /></Panel>
    ) },
    { id: "groups", title: "By group", render: (edit: any) => <ByGroup hosts={all} scope={scope} onPick={setScope} th={th} edit={edit} /> },
    { id: "storage", title: "Storage", render: (edit: any) => <StoragePanel edit={edit} hosts={visible} allHosts={hosts.data ?? []} storage={o?.storage ?? []} th={th} /> },
    { id: "power", title: "Power", render: (edit: any) => (
      <Panel title={t("Power")} edit={edit}>
        <Stat label="Total draw" value={`${(power.data?.total ?? 0).toFixed(0)} W`} sub={t("{n} plugs", { n: power.data?.plugs.length ?? 0 })} />
      </Panel>
    ) },
    { id: "tempo", title: "EDF Tempo", render: (edit: any) => <TempoPanel edit={edit} tempo={tempo.data} error={tempo.error} /> },
    { id: "nextdns", title: "NextDNS", render: (edit: any) => <NextDnsPanel edit={edit} /> },
    { id: "disks", title: "Disk health", render: (edit: any) => <DiskHealth edit={edit} /> },
    { id: "logs", title: "Recent logs", render: (edit: any) => <RecentLogs edit={edit} /> },
    { id: "probes", title: "Probes", render: (edit: any) => <Probes edit={edit} /> },
    { id: "pipelines", title: "Pipelines", render: (edit: any) => <PipelinesPanel edit={edit} /> },
    { id: "containers", title: "Stopped containers", render: (edit: any) => <StoppedContainers edit={edit} /> },
    { id: "updates", title: "Pending updates", render: (edit: any) => (
      <Panel title={t("Pending updates")} edit={edit}>
        {pending.length ? <ul className="divide-y divide-line">{pending.map((h) => <li key={h.id} className="flex justify-between gap-3 py-2"><Link to={`/hosts/${h.id}`}>{h.name}</Link><span className="text-fg2">{h.updates}</span></li>)}</ul> : <Empty>{t("Every host is up to date.")}</Empty>}
      </Panel>
    ) },
  ]

  return (
    <Dashboard id="overview" setting="/api/settings/monitor_dashboard" datasets={DATASETS} kinds={KINDS} range={range} presets={PRESETS}
      header={{
        title: "Overview",
        crumbs: [{ label: "Dashboards" }, { label: "Homelab" }],
        subtitle: t("Updated at {v0}", { v0: fmt.time(over.updated) }),
        onRefresh: reload,
        actions: <RangeSelect value={range} onChange={setRange} />,
        variables: <>
          <Variable label="Show" value={scope} onChange={setScope} options={scopes} />
          <Button onClick={() => setGrouping(true)}><RectangleGroupIcon className="size-5" aria-hidden />{t("Groups")}</Button>
          {grouping && <GroupsModal hosts={all} onClose={() => setGrouping(false)} onSaved={hosts.reload} />}
        </>,
      }}
      builtins={panels}
      desktop={{ cols: [["summary", "load", "alerts"], ["usage", "groups", "hosts", "storage"]], hidden: ["power", "tempo", "nextdns", "disks", "logs", "probes", "pipelines", "containers", "updates"] }}
      phone={{ cols: [["summary", "usage", "alerts", "hosts"]], hidden: ["load", "groups", "storage", "power", "tempo", "nextdns", "disks", "logs", "probes", "pipelines", "containers", "updates"] }}
    />
  )
}

function TempoPanel({ tempo, error, edit }: { tempo: any; error?: string; edit: any }) {
  return (
    <Panel title={t("EDF Tempo")} edit={edit}>
      {error ? <ErrorNote>{error}</ErrorNote> : !tempo ? <Empty>{t("Loading…")}</Empty> : !tempo.configured ? <Empty>{t("Add your RTE API keys in Settings.")}</Empty> : <TempoTiles tempo={tempo} className="auto-rows-[112px]" />}
    </Panel>
  )
}


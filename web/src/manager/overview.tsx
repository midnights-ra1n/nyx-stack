import { BoltIcon, ShieldCheckIcon, CodeBracketSquareIcon, HeartIcon } from "@heroicons/react/24/outline"
import { BarGauge, Empty, ErrorNote, Meter, Panel, Stat, Status, Table, Td, Skeleton } from "../ui/components"
import { Dashboard } from "../ui/dashboard"
import { fmt, type Level, useApi } from "../ui/lib"
import { Link, navigate } from "../ui/shell"
import { BASIC_KINDS, type CardKind } from "../ui/widgets"
import { DATASETS } from "./datasets"
import { PRESETS } from "./presets"
import { PipelineList } from "../ui/pipelines"
import { TempoTiles } from "../ui/tempo"
import { NextDns } from "../ui/nextdns"
import { ProgressSummary } from "./progress"
import { t, tn } from "../ui/i18n"

export const deployLevel = (s: string): Level => (s === "ok" ? "ok" : s === "failed" ? "crit" : s === "running" ? "info" : "off")

function FromMonitor({ what, children }: { what: string; children: (data: any) => React.ReactNode }) {
  const { data, error } = useApi(`/api/monitor/${what}`)
  if (error) return <ErrorNote>{error}</ErrorNote>
  if (data === undefined) return <Skeleton />
  if (data === null) return <Empty>{t("Link a monitor in")} <Link to="/settings" className="text-accent">{t("Settings")}</Link> {t("to fill this panel.")}</Empty>
  return <>{children(data)}</>
}

function Monitoring() {
  return (
    <FromMonitor what="overview">{(o) => (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Hosts online" value={`${o.hosts_online} / ${o.hosts_total}`} level={o.hosts_online === o.hosts_total ? "ok" : "warn"} />
          <Stat label="Open alerts" value={o.alerts} level={o.alerts_crit ? "crit" : o.alerts ? "warn" : "ok"} />
          <Stat label="Containers" value={`${o.containers_running} / ${o.containers_total}`} />
        </div>
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 text-[13px]">
          <span className="text-fg2">{t("CPU")}</span><Meter pct={o.cpu} /><span>{fmt.pct(o.cpu)}</span>
          <span className="text-fg2">{t("Memory")}</span><Meter pct={o.mem} /><span>{fmt.pct(o.mem)}</span>
        </div>
      </div>
    )}</FromMonitor>
  )
}

/** Cards of the manager, on top of charts and the cards both apps offer. */
const KINDS: Record<string, CardKind> = {
  ...BASIC_KINDS,
  tempo: { label: "EDF Tempo", icon: BoltIcon, hint: "Today, tomorrow and the days left. Read from the linked monitor, where the RTE keys are set.",
    body: () => <FromMonitor what="tempo">{(tempo) => (tempo.configured === false ? <Empty>{t("Add your RTE API keys in the monitor's settings.")}</Empty> : <TempoTiles tempo={tempo} className="auto-rows-[96px]" />)}</FromMonitor> },
  nextdns: { label: "NextDNS", icon: ShieldCheckIcon, hint: "Queries and blocked queries, with a period to pick. The API key is set in Settings.", body: () => <NextDns /> },
  pipelines: { label: "Pipelines", icon: CodeBracketSquareIcon, hint: "State of the latest CI/CD run of each repository. Read from the linked monitor, where the pipelines are set.",
    body: () => <FromMonitor what="pipelines">{(rows) => <PipelineList rows={rows} />}</FromMonitor> },
  monitoring: { label: "Monitoring", icon: HeartIcon, hint: "Hosts online, open alerts and average load, from the linked monitor.", body: () => <Monitoring /> },
}

const DESKTOP = { cols: [["summary", "categories", "subnets", "deployments"], ["progress", "conflicts", "tasks", "warranty"]], hidden: [] }
const PHONE = { cols: [["summary", "progress", "conflicts", "tasks", "subnets"]], hidden: ["deployments", "warranty", "categories"] }

export function Overview() {
  const { data, reload, updated } = useApi("/api/overview")
  const stat = (label: string, value: any, to: string, level?: Level) => <Link to={to} className="-m-2 rounded-box p-2 hover:bg-raised"><Stat label={label} value={value ?? "—"} level={level} /></Link>
  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
      <Panel title={t("Summary")} edit={edit}>
        <div className="grid grid-cols-4 gap-4 max-sm:grid-cols-2">
          {stat("Hardware", data?.hardware, "/hardware")}
          {stat("Virtual assets", data?.virtual, "/virtual")}
          {stat("IP addresses", data?.addresses, "/ipam")}
          {stat("Subnets", data?.subnets.length, "/ipam")}
          {stat("Open interventions", data?.open_interventions, "/interventions")}
          {stat("Open tasks", data?.open_tasks, "/work")}
          {stat("Deploying", data?.running_deploys, "/work", data?.running_deploys ? "info" : undefined)}
          {stat("Conflicts", data?.conflicts.length, "/ipam", data?.conflicts.length ? "warn" : "ok")}
        </div>
      </Panel>
    ) },
    { id: "progress", title: "Progress", render: (edit: any) => (
      <Panel title="Progress" edit={edit} actions={[{ label: "Open the work", onClick: () => navigate("/work") }]}><ProgressSummary /></Panel>
    ) },
    { id: "categories", title: "Hardware by category", render: (edit: any) => (
      <Panel title={t("Hardware by category")} edit={edit} loading={!data} actions={[{ label: "Open hardware", onClick: () => navigate("/hardware") }]}>
        {data?.categories.length ? (
          <ul className="flex flex-col gap-2">
            {data.categories.map((c: any) => (
              <li key={c.name} className="grid grid-cols-[120px_1fr_auto] items-center gap-3">
                <span className="truncate">{c.name}</span>
                <div className="h-2 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-accent" style={{ width: `${(c.total * 100) / Math.max(...data.categories.map((x: any) => x.total))}%` }} /></div>
                <span className="text-[13px] whitespace-nowrap text-fg2">{c.total}{c.in_service < c.total && <span className="text-fg3"> · {t("{n} out", { n: c.total - c.in_service })}</span>}</span>
              </li>
            ))}
          </ul>
        ) : <Empty>{t("No hardware yet.")}</Empty>}
      </Panel>
    ) },
    { id: "conflicts", title: "Addressing conflicts", render: (edit: any) => (
      <Panel title={t("Addressing conflicts")} edit={edit} loading={!data} actions={[{ label: "Open IPAM", onClick: () => navigate("/ipam") }]}>
        {data?.conflicts.length ? <ul className="flex flex-col gap-2">{data.conflicts.map((c: any) => <li key={c.message} className="flex items-baseline gap-3"><Status level={c.severity} /><span>{tn(c.message)}</span></li>)}</ul> : <Empty>{t("No conflicts.")}</Empty>}
      </Panel>
    ) },
    { id: "subnets", title: "Subnet usage", render: (edit: any) => (
      <Panel title={t("Subnet usage")} edit={edit} loading={!data}>
        {data?.subnets.length ? <BarGauge rows={[...data.subnets].sort((a: any, b: any) => b.pct - a.pct).slice(0, 10).map((s: any) => ({ label: `${s.name} ${s.cidr}`, pct: s.pct }))} /> : <Empty>{t("No subnets yet.")}</Empty>}
      </Panel>
    ) },
    { id: "tasks", title: "Due within 7 days", render: (edit: any) => (
      <Panel title={t("Due within 7 days")} edit={edit} loading={!data}>
        {data?.tasks.length ? <ul className="flex flex-col gap-2">{data.tasks.map((task: any) => <li key={task.id} className="flex justify-between gap-3"><span>{task.title}</span><span className="whitespace-nowrap text-fg2">{fmt.date(task.due)}</span></li>)}</ul> : <Empty>{t("Nothing due.")}</Empty>}
      </Panel>
    ) },
    { id: "deployments", title: "Recent deployments", render: (edit: any) => (
      <Panel title={t("Recent deployments")} edit={edit} loading={!data} flush>
        {data?.deployments.length ? (
          <Table head={["Name", "Version", "State"]}>
            {data.deployments.map((d: any) => <tr key={d.id}><Td className="font-medium">{d.name}</Td><Td mono>{d.version || "—"}</Td><Td><Status level={deployLevel(d.status)} label={d.status || "planned"} /></Td></tr>)}
          </Table>
        ) : <div className="px-4 pb-4"><Empty>{t("No deployments yet.")}</Empty></div>}
      </Panel>
    ) },
    { id: "warranty", title: "Warranty ending", render: (edit: any) => (
      <Panel title={t("Warranty ending")} edit={edit} loading={!data}>
        {data?.warranty.length ? <ul className="flex flex-col gap-2">{data.warranty.map((h: any) => <li key={h.id} className="flex justify-between gap-3"><span>{h.name}</span><span className="text-fg2">{fmt.date(h.warranty_until)}</span></li>)}</ul> : <Empty>{t("No warranty ending soon.")}</Empty>}
      </Panel>
    ) },
  ]
  return (
    <Dashboard id="manager" setting="/api/settings/dashboard" datasets={DATASETS} kinds={KINDS} presets={PRESETS}
      header={{ title: "Overview", crumbs: [{ label: "Dashboards" }, { label: "Homelab" }], subtitle: t("Updated at {v0}", { v0: fmt.time(updated) }), onRefresh: reload }}
      builtins={panels} desktop={DESKTOP} phone={PHONE} />
  )
}

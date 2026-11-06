import { Board, CustomizeButton } from "../ui/board"
import { BarGauge, Empty, Panel, Stat, Status, Table, Td } from "../ui/components"
import { fmt, type Level, useApi } from "../ui/lib"
import { navigate, PageHeader } from "../ui/shell"

export const deployLevel = (s: string): Level => (s === "ok" ? "ok" : s === "failed" ? "crit" : s === "running" ? "info" : "off")

export function Overview() {
  const { data, reload } = useApi("/api/overview")
  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
      <Panel title="Summary" edit={edit}>
        <div className="grid grid-cols-4 gap-4 max-sm:grid-cols-2">
          <Stat label="Hardware" value={data?.hardware ?? "—"} />
          <Stat label="Virtual assets" value={data?.virtual ?? "—"} />
          <Stat label="Sites" value={data?.sites ?? "—"} />
          <Stat label="Open tasks" value={data?.open_tasks ?? "—"} />
        </div>
      </Panel>
    ) },
    { id: "conflicts", title: "Addressing conflicts", render: (edit: any) => (
      <Panel title="Addressing conflicts" edit={edit} actions={[{ label: "Open IPAM", onClick: () => navigate("/ipam") }]}>
        {data?.conflicts.length ? <ul className="flex flex-col gap-2">{data.conflicts.map((c: any) => <li key={c.message} className="flex items-baseline gap-3"><Status level={c.severity} /><span>{c.message}</span></li>)}</ul> : <Empty>No conflicts.</Empty>}
      </Panel>
    ) },
    { id: "subnets", title: "Subnet usage", render: (edit: any) => (
      <Panel title="Subnet usage" edit={edit}>
        {data?.subnets.length ? <BarGauge rows={data.subnets.map((s: any) => ({ label: `${s.name} ${s.cidr}`, pct: s.pct }))} /> : <Empty>No subnets yet.</Empty>}
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
  ]
  return (
    <>
      <PageHeader title="Overview" onRefresh={reload} actions={<CustomizeButton />} />
      <Board id="manager" panels={panels}
        desktop={{ cols: [["summary", "subnets", "deployments"], ["conflicts", "tasks", "warranty"]], hidden: [] }}
        phone={{ cols: [["summary", "conflicts", "tasks", "subnets"]], hidden: ["deployments", "warranty"] }} />
    </>
  )
}

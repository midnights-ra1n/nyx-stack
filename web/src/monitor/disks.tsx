import { useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { BarGauge, Empty, Meter, Mono, Panel, Stat, StateCell, Status, Table, Td, Variable } from "../ui/components"
import { fmt, type Level, levelBg, levelOf, useApi } from "../ui/lib"
import { Link, navigate, PageHeader } from "../ui/shell"

const LIFE_WARN = 20, LIFE_CRIT = 10
const DEFAULT_TH = { warn: 75, crit: 90 }
const lifeLevel = (life: number): Level => (life <= LIFE_CRIT ? "crit" : life <= LIFE_WARN ? "warn" : "ok")
const powerOn = (h?: number | null) => (h == null ? "—" : h >= 8760 ? `${(h / 8760).toFixed(1)} years` : `${Math.round(h / 24)} days`)

/** Total space of file systems. The datasets of a ZFS pool share its free space, so that counts once. */
export function capacity(disks: { host_id?: string; fs?: string; device?: string; used: number; total: number }[]) {
  const pools = new Set<string>()
  let used = 0, free = 0
  for (const d of disks) {
    used += d.used
    const pool = d.fs === "zfs" ? `${d.host_id}/${d.device?.split("/")[0]}` : `${d.host_id}/${d.device}`
    if (!pools.has(pool)) { pools.add(pool); free += d.total - d.used }
  }
  return { used, free, total: used + free }
}

/** One row per file system, fullest first. */
export function FileSystems({ rows, th = DEFAULT_TH, hosts }: { rows: any[]; th?: { warn: number; crit: number }; hosts?: boolean }) {
  const sorted = [...rows].sort((a, b) => b.pct - a.pct)
  return (
    <Table head={[...(hosts ? ["Host"] : []), "Mount point", "Usage", "Free", "State"]}>
      {sorted.map((d) => (
        <tr key={(d.host_id ?? "") + d.mount}>
          {hosts && <Td className="font-medium whitespace-nowrap"><Link to={`/hosts/${d.host_id}`}>{d.host}</Link></Td>}
          <Td><Mono>{d.mount}</Mono><div className="text-xs text-fg3">{[d.fs, d.device].filter(Boolean).join(" · ")}</div></Td>
          <Td className="w-full min-w-48 py-2">
            <Meter pct={d.pct} warn={th.warn} crit={th.crit} />
            <div className="mt-1 text-xs text-fg2">{fmt.bytes(d.used)} of {fmt.bytes(d.total)} · {d.pct.toFixed(0)} %</div>
          </Td>
          <Td className="text-fg2 whitespace-nowrap">{fmt.bytes(d.total - d.used)}</Td>
          <StateCell level={d.online === false ? "off" : levelOf(d.pct, th.warn, th.crit)} />
        </tr>
      ))}
    </Table>
  )
}

function Fact({ label, value, level }: { label: string; value: React.ReactNode; level?: Level }) {
  return <div><dt className="text-xs text-fg3">{label}</dt><dd className={level === "warn" ? "text-warn" : level === "crit" ? "text-crit" : ""}>{value}</dd></div>
}

/** What smartctl knows about each physical disk, in plain words. */
export function DiskCards({ disks, hosts }: { disks: any[]; hosts?: boolean }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-4">
      {disks.map((d) => (
        <article key={(d.host_id ?? "") + d.device} className="flex flex-col gap-3 rounded-box bg-raised p-4">
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate font-medium" title={d.model}>{d.model}</h3>
              <p className="text-xs text-fg3">{hosts && <><Link to={`/hosts/${d.host_id}`}>{d.host}</Link> · </>}<Mono>{d.device}</Mono>{[d.kind, d.capacity && fmt.bytes(d.capacity)].filter(Boolean).map((x) => ` · ${x}`)}</p>
            </div>
            <Status level={d.health} label={d.health === "ok" ? "Healthy" : d.health === "warn" ? "Attention" : "Critical"} />
          </header>
          {d.reason && <p className="text-[13px] text-fg2">{d.reason}</p>}
          {d.life_left_pct != null && (
            <div>
              <div className="mb-1 flex justify-between text-xs text-fg2"><span>Life left</span><span>{d.life_left_pct} %</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-surface"><div className={`h-full rounded-full ${levelBg[lifeLevel(d.life_left_pct)]}`} style={{ width: `${d.life_left_pct}%` }} /></div>
            </div>
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Fact label="Temperature" value={fmt.temp(d.temp_c)} />
            <Fact label="Powered on" value={powerOn(d.power_on_hours)} />
            <Fact label="Bad sectors" value={d.bad_sectors ?? "—"} level={d.bad_sectors ? "warn" : undefined} />
            <Fact label="Power cycles" value={d.power_cycles ?? "—"} />
            {d.written_bytes != null && <Fact label="Written" value={fmt.bytes(d.written_bytes)} />}
            {d.serial && <Fact label="Serial" value={<Mono>{d.serial}</Mono>} />}
          </dl>
        </article>
      ))}
    </div>
  )
}

/** Disks and file systems that need a look, worst first, for the overview and the storage page. */
function needsAttention(disks: any[], smart: any[], th: { warn: number; crit: number }) {
  const full = disks.map((d) => ({ key: d.host_id + d.mount, level: levelOf(d.pct, th.warn, th.crit), to: `/hosts/${d.host_id}`, what: `${d.host} ${d.mount}`, why: `${d.pct.toFixed(0)} % full, ${fmt.bytes(d.total - d.used)} free` }))
  const worn = smart.map((d) => ({ key: d.host_id + d.device, level: d.health as Level, to: `/hosts/${d.host_id}`, what: `${d.host} ${d.device}`, why: d.reason }))
  return [...full, ...worn].filter((x) => x.level !== "ok").sort((a, b) => Number(b.level === "crit") - Number(a.level === "crit"))
}

function Attention({ disks, smart, th }: { disks: any[]; smart: any[]; th: { warn: number; crit: number } }) {
  const items = needsAttention(disks, smart, th)
  if (!items.length) return <Empty>All disks and file systems look fine.</Empty>
  return (
    <ul className="divide-y divide-line">
      {items.map((x) => <li key={x.key} className="flex items-center justify-between gap-3 py-2"><span className="min-w-0"><Link className="font-medium" to={x.to}>{x.what}</Link><span className="block text-xs text-fg3">{x.why}</span></span><Status level={x.level} /></li>)}
    </ul>
  )
}

/** Block of the overview: what storage needs a look. */
export function DiskHealth({ edit }: { edit: any }) {
  const { data } = useApi("/api/storage")
  return (
    <Panel title="Disk health" edit={edit} actions={[{ label: "Storage", onClick: () => navigate("/storage") }]}>
      <Attention disks={data?.disks ?? []} smart={data?.smart ?? []} th={data?.thresholds ?? DEFAULT_TH} />
    </Panel>
  )
}

export function Storage() {
  const { data, reload } = useApi("/api/storage")
  const hosts = useApi<any[]>("/api/hosts", { poll: false })
  const [host, setHost] = useState("")
  const th = data?.thresholds ?? DEFAULT_TH
  const mine = (d: any) => !host || d.host_id === host
  const disks = (data?.disks ?? []).filter(mine)
  const smart = (data?.smart ?? []).filter(mine)
  const { used, free, total } = capacity(disks)
  const unhealthy = smart.filter((d: any) => d.health !== "ok").length
  const hottest = Math.max(-Infinity, ...smart.map((d: any) => d.temp_c ?? -Infinity))
  const perHost = [...new Set<string>(disks.map((d: any) => d.host_id))].map((id) => {
    const rows = disks.filter((d: any) => d.host_id === id)
    const c = capacity(rows)
    return { label: rows[0].host, pct: c.total ? (c.used / c.total) * 100 : 0 }
  }).sort((a, b) => b.pct - a.pct)

  const panels = [
    { id: "capacity", title: "Capacity", render: (edit: any) => (
      <Panel title="Capacity" edit={edit}>
        <div className="grid grid-cols-4 gap-4 max-sm:grid-cols-2">
          <Stat label="Used" value={fmt.bytes(used)} sub={`of ${fmt.bytes(total)}`} />
          <Stat label="Free" value={fmt.bytes(free)} sub={`on ${disks.length} file systems`} />
          <Stat label="Physical disks" value={smart.length ? `${smart.length - unhealthy} / ${smart.length}` : "—"} level={!smart.length ? undefined : unhealthy ? "warn" : "ok"} sub="healthy" />
          <Stat label="Hottest disk" value={fmt.temp(isFinite(hottest) ? hottest : null)} />
        </div>
        {total > 0 && <div className="mt-5"><Meter pct={(used / total) * 100} warn={th.warn} crit={th.crit} /></div>}
      </Panel>
    ) },
    { id: "attention", title: "Needs attention", render: (edit: any) => <Panel title="Needs attention" edit={edit}><Attention disks={disks} smart={smart} th={th} /></Panel> },
    { id: "hosts", title: "Usage per host", render: (edit: any) => (
      <Panel title="Usage per host" edit={edit}>{perHost.length ? <BarGauge warn={th.warn} crit={th.crit} rows={perHost} /> : <Empty>No file system reported yet.</Empty>}</Panel>
    ) },
    { id: "files", title: "File systems", render: (edit: any) => (
      <Panel title="File systems" flush edit={edit}>
        {disks.length ? <FileSystems rows={disks} th={th} hosts={!host} /> : <div className="px-4 pb-4"><Empty>No file system reported yet.</Empty></div>}
      </Panel>
    ) },
    { id: "smart", title: "Physical disks", render: (edit: any) => (
      <Panel title="Physical disks" edit={edit} footer="Attention from 20 % life left or any bad sector, critical from 10 % or a failed self-assessment. Refreshed every 30 minutes.">
        {smart.length ? <DiskCards disks={smart} hosts={!host} /> : <Empty>SMART data comes from physical hosts.</Empty>}
      </Panel>
    ) },
  ]

  return (
    <>
      <PageHeader title="Storage" subtitle="Space on every file system and health of every physical disk" onRefresh={reload} actions={<CustomizeButton />}
        variables={<Variable label="Host" value={host} onChange={setHost} options={[{ value: "", label: "All" }, ...(hosts.data ?? []).map((h) => ({ value: h.id, label: h.name }))]} />} />
      <Board id="storage" panels={panels}
        desktop={{ cols: [["capacity", "attention", "files", "smart"]], hidden: ["hosts"] }}
        phone={{ cols: [["capacity", "attention", "smart", "files"]], hidden: ["hosts"] }} />
    </>
  )
}

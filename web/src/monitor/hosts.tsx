import { ArrowPathIcon, ChevronRightIcon, CommandLineIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useEffect, useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { Button, Check, Copy, Empty, ErrorNote, Gauge, Input, Modal, Mono, Panel, Progress, RangeSelect, Select, Stat, StateCell, Status, Table, Td, TimeSeries } from "../ui/components"
import { api, fmt, levelOf, useApi, useStored } from "../ui/lib"
import { Link, navigate, PageHeader } from "../ui/shell"
import { DiskCards, FileSystems } from "./disks"
import { HostLogs } from "./logs"
import { hostLevel } from "./overview"

const KINDS = [{ value: "vm", label: "VM" }, { value: "physical", label: "Physical server" }, { value: "proxmox", label: "Physical server (Proxmox)" }, { value: "vps", label: "VPS" }]
// The path keeps working where sudo does not search /usr/local/bin, as on RHEL.
const UNINSTALL = 'sudo "$(command -v nyx-agent)" uninstall'
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k

const UPDATE_POLL_MS = 5000
const OCI_LIMITS = "No CPU, memory, disk, network, updates or logs: an OCI image has no systemd to run the agent."

export interface TreeRow { host?: any; guest?: any; parent?: any; depth: number; hasChildren: boolean; key: string }

/** Flatten hosts into display order, nesting children and agent-less Proxmox guests. */
export function buildTree(hosts: any[], guestsOf: (h: any) => any[], collapsed: Set<string>): TreeRow[] {
  const ids = new Set(hosts.map((h) => h.id))
  const kids = (id: string) => hosts.filter((h) => h.parent === id)
  const out: TreeRow[] = []
  const walk = (h: any, depth: number) => {
    const children = kids(h.id)
    const guests = guestsOf(h).filter((g) => !children.some((c) => c.vmid === g.vmid || c.name === g.name))
    out.push({ host: h, depth, hasChildren: children.length + guests.length > 0, key: h.id })
    if (collapsed.has(h.id)) return
    children.forEach((c) => walk(c, depth + 1))
    guests.forEach((g) => out.push({ guest: g, parent: h, depth: depth + 1, hasChildren: false, key: `${h.id}-${g.vmid}` }))
  }
  hosts.filter((h) => !h.parent || !ids.has(h.parent)).forEach((h) => walk(h, 0))
  return out
}

export function consoleUrl(pve: string, h: any, guest?: any) {
  if (!pve) return ""
  const base = `${pve.replace(/\/$/, "")}/?novnc=1`
  if (guest) return `${base}&console=${guest.kind === "lxc" ? "lxc" : "kvm"}&vmid=${guest.vmid}&vmname=${encodeURIComponent(guest.name)}&node=${guest.node}`
  if (h.vmid) return `${base}&console=lxc&vmid=${h.vmid}&node=${h.pve_node}`
  return h.kind === "proxmox" ? `${base}&console=shell&node=${h.hostname}` : ""
}

/** Hosts of the latest updates, without those already dismissed on this device. */
export function updateRun(hosts: any[], seen: number) {
  const run = hosts.filter((h) => h.update && h.update.started > seen)
  const done = run.filter((h) => h.update.done).length
  const pct = run.length ? Math.round(run.reduce((n, h) => n + h.update.pct, 0) / run.length) : 0
  return { run, done, pct, last: Math.max(seen, ...run.map((h) => h.update.started)) }
}

/** The bar must move even with auto-refresh slowed down or off. */
function useUpdatePolling(running: boolean, reload: () => void) {
  useEffect(() => {
    if (!running) return
    const id = setInterval(reload, UPDATE_POLL_MS)
    return () => clearInterval(id)
  }, [running, reload])
}

function RunRow({ host: h }: { host: any }) {
  const u = h.update
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-3">
        <Link to={`/hosts/${h.id}`} className="truncate font-medium hover:text-accent">{h.name}</Link>
        {u.done ? <span /> : <Progress thin pct={u.pct} label={`Update of ${h.name}`} />}
        {u.done ? <Status cell level={u.error ? "crit" : "ok"} label={u.error ? "Failed" : "Updated"} /> : <span className="text-fg2">{u.pct} %</span>}
      </div>
      {u.error ? <p className="max-h-24 overflow-auto font-mono text-[13px] whitespace-pre-wrap text-crit">{u.error}</p> : !u.done && <p className="truncate text-[13px] text-fg3">{u.step ?? "Waiting for the agent"}</p>}
    </li>
  )
}

/** Outside the board: it only exists while there is something to follow or to do. */
function FleetUpdates({ hosts }: { hosts: any[] }) {
  const [seen, setSeen] = useStored("nyx.updates-seen", 0)
  const { run, done, pct, last } = updateRun(hosts, seen)
  const restart = hosts.filter((h) => h.reboot_required)
  if (!run.length && !restart.length) return null
  return (
    <div className="mb-4">
      <Panel title="Updates">
        <div className="flex flex-col gap-3">
          {run.length > 0 && <>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <span className="text-[26px] leading-8 font-medium">{pct} %</span>
              <span className="text-fg2">{done} of {run.length} hosts finished</span>
            </div>
            <Progress pct={pct} label="Progress of the update" />
            <ul className="divide-y divide-line">{run.map((h) => <RunRow key={h.id} host={h} />)}</ul>
          </>}
          {restart.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <Status level="warn" label={`${restart.length} to restart`} />
              {restart.map((h) => <Link key={h.id} to={`/hosts/${h.id}`} className="font-medium hover:text-accent">{h.name}</Link>)}
            </div>
          )}
          {run.length > 0 && done === run.length && <div><Button onClick={() => setSeen(last)}>Hide results</Button></div>}
        </div>
      </Panel>
    </div>
  )
}

/** The install command of a host, for the address the host can reach the monitor at. */
function InstallCommand({ id }: { id: string }) {
  const { data: status } = useApi("/api/auth/status", { poll: false })
  const [typed, setTyped] = useStored("nyx.agent-url", "")
  const [url, setUrl] = useState(typed)
  useEffect(() => { const t = setTimeout(() => setUrl(typed), 300); return () => clearTimeout(t) }, [typed])
  // Without NYX_PUBLIC_URL the server only knows localhost, which a remote host cannot reach.
  const fallback = status?.public_url?.includes("://localhost") ? location.origin : status?.public_url
  const address = url.trim() || fallback
  const { data, error } = useApi(address ? `/api/hosts/${id}/install?url=${encodeURIComponent(address)}` : null, { poll: false })
  return (
    <div className="flex flex-col gap-4">
      <Input label="Monitor URL" value={typed} placeholder={fallback} className="font-mono" onChange={(e) => setTyped(e.target.value)} hint="The address this host reaches the monitor at. Remembered on this device." />
      {error ? <ErrorNote>{error}</ErrorNote> : data && <>
        <p className="text-fg2">Run this as root on the host.</p>
        <Copy text={data.curl} />
        <p className="text-fg2">Or use these variables with the Ansible role.</p>
        <Copy text={Object.entries(data.ansible).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")} />
      </>}
    </div>
  )
}

function AddHost({ hosts, onDone }: { hosts: any[]; onDone: () => void }) {
  const [f, setF] = useState({ name: "", kind: "vm", parent: "", ct_autoinstall: false })
  const [res, setRes] = useState<any>()
  const [error, setError] = useState("")
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try { setRes(await api("/api/hosts", { body: f })) } catch (err) { setError((err as Error).message) }
  }
  if (res) return <Modal title="Install the agent" onClose={onDone}><InstallCommand id={res.id} /></Modal>
  return (
    <Modal title="Add host" onClose={onDone}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Input label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Select label="Deployment type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={KINDS} hint={f.kind === "physical" || f.kind === "proxmox" ? "SMART monitoring is included; smartmontools is installed if missing." : undefined} />
        <Select label="Runs on" value={f.parent} onChange={(e) => setF({ ...f, parent: e.target.value })} options={[{ value: "", label: "Nothing (top level)" }, ...hosts.map((h) => ({ value: h.id, label: h.name }))]} />
        {f.kind === "proxmox" && <Check label="Install the agent in containers, including new ones" checked={f.ct_autoinstall} onChange={(e) => setF({ ...f, ct_autoinstall: e.target.checked })} />}
        <ErrorNote>{error}</ErrorNote>
        <div><Button variant="primary" type="submit">Generate install command</Button></div>
      </form>
    </Modal>
  )
}

export function Hosts() {
  const hosts = useApi<any[]>("/api/hosts")
  const proxmox = useApi("/api/settings/proxmox", { poll: false })
  const [add, setAdd] = useState(false)
  const [collapsed, setCollapsed] = useState(new Set<string>())
  const [updateError, setUpdateError] = useState("")
  const list = hosts.data ?? []
  const updating = list.some((h) => h.update && !h.update.done)
  useUpdatePolling(updating, hosts.reload)
  const rows = buildTree(list, (h) => h.guests ?? [], collapsed)
  const toggle = (id: string) => { const s = new Set(collapsed); s.has(id) ? s.delete(id) : s.add(id); setCollapsed(s) }
  const online = list.filter((h) => h.status !== "off").length
  const updates = list.reduce((n, h) => n + (h.updates || 0), 0)
  const updateAll = async () => {
    if (!confirm(`Upgrade the packages of ${online} online hosts and bring their agents up to date? Services can restart while packages are replaced. Hosts are not rebooted.`)) return
    setUpdateError("")
    try { await api("/api/hosts/update-all", { method: "POST" }); hosts.reload() } catch (e) { setUpdateError((e as Error).message) }
  }
  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
      <Panel title="Summary" edit={edit}>
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Online" value={`${online} / ${list.length}`} level={online === list.length ? "ok" : "warn"} />
          <Stat label="Pending updates" value={updates} level={updates ? "warn" : "ok"} />
          <Stat label="Agent-less guests" value={rows.filter((r) => r.guest).length} />
        </div>
      </Panel>
    ) },
    { id: "fleet", title: "Fleet", render: (edit: any) => (
      <Panel title="Fleet" flush edit={edit}>
        {list.length === 0 ? <div className="px-4 pb-4"><Empty>No hosts yet. Add one to get an install command.</Empty></div> : (
          <Table head={["Host", "Type", "Address", "CPU", "Mem.", "Temp.", "Updates", "State"]}>
            {rows.map((r) => r.host ? (
              <tr key={r.key} className="hover:bg-raised">
                <Td className="font-medium">
                  <span className="flex items-center gap-1" style={{ paddingLeft: r.depth * 24 }}>
                    {r.hasChildren
                      ? <button aria-label="Toggle children" aria-expanded={!collapsed.has(r.host.id)} className="text-fg3" onClick={() => toggle(r.host.id)}><ChevronRightIcon className={`size-4 ${collapsed.has(r.host.id) ? "" : "rotate-90"}`} aria-hidden /></button>
                      : <span className="w-4" />}
                    <Link to={`/hosts/${r.host.id}`} className="hover:text-accent">{r.host.name}</Link>
                  </span>
                </Td>
                <Td className="text-fg2">{kindLabel(r.host.kind)}</Td>
                <Td mono>{r.host.ip || "—"}</Td>
                <Td className="text-fg2">{fmt.pct(r.host.cpu)}</Td>
                <Td className="text-fg2">{fmt.pct(r.host.mem)}</Td>
                <Td className="text-fg2">{fmt.temp(r.host.temp)}</Td>
                <Td className="text-fg2"><span className="flex items-center gap-2 whitespace-nowrap">{r.host.updates || "—"}{r.host.reboot_required && <Status cell level="warn" label="Restart" />}</span></Td>
                <StateCell level={hostLevel(r.host.status)} label={r.host.installed ? undefined : r.host.oci ? "OCI, no agent" : "Waiting for install"} />
              </tr>
            ) : (
              <tr key={r.key}>
                <Td className="text-fg2"><span style={{ paddingLeft: r.depth * 24 + 16 }}>{r.guest.name}</span></Td>
                <Td className="text-fg3">{r.guest.oci ? "OCI container" : r.guest.kind === "lxc" ? "Container" : "VM"} {r.guest.vmid}, no agent</Td>
                {r.guest.oci ? <Td colSpan={5} className="text-warn">{OCI_LIMITS}</Td> : <><Td /><Td /><Td /><Td /><Td /></>}
                <Td>{proxmox.data?.url && <a className="text-accent" target="_blank" rel="noreferrer" href={consoleUrl(proxmox.data.url, r.parent, r.guest)}>Console</a>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    ) },
  ]
  return (
    <>
      <PageHeader title="Hosts" subtitle={`${list.length} hosts`} onRefresh={hosts.reload} actions={<><CustomizeButton /><Button disabled={updating || !online} onClick={updateAll}><ArrowPathIcon className="size-5" aria-hidden />Update all</Button><Button variant="primary" onClick={() => setAdd(true)}><PlusIcon className="size-5" aria-hidden />Add host</Button></>} />
      <ErrorNote>{updateError}</ErrorNote>
      <FleetUpdates hosts={list} />
      <Board id="hosts" panels={panels} desktop={{ cols: [["fleet"]], hidden: ["summary"] }} phone={{ cols: [["fleet"]], hidden: ["summary"] }} />
      {add && <AddHost hosts={list} onDone={() => { setAdd(false); hosts.reload() }} />}
    </>
  )
}

export function HostDetail({ id }: { id: string }) {
  const [range, setRange] = useState("1h")
  const { data: h, reload, error } = useApi(`/api/hosts/${id}`)
  const series = useApi<any[]>(`/api/series?range=${range}&host=${id}`)
  const proxmox = useApi("/api/settings/proxmox", { poll: false })
  const [install, setInstall] = useState(false)
  const [note, setNote] = useState("")
  const [removing, setRemoving] = useState(false)
  const updating = !!h?.update && !h.update.done
  useUpdatePolling(updating, reload)
  if (error) return <p role="alert" className="text-crit">{error}</p>
  if (!h) return null

  const send = async (body: any, msg: string) => {
    try { await api(`/api/hosts/${id}/command`, { body }); setNote(`${msg} Queued, it reaches the agent with its next report.`); reload() } catch (e) { setNote((e as Error).message) }
  }
  const remove = async () => {
    await api(`/api/hosts/${id}`, { method: "DELETE" })
    navigate("/hosts")
  }
  const consoleLink = consoleUrl(proxmox.data?.url ?? "", h)
  const points = series.data ?? []
  const physical = h.kind === "physical" || h.kind === "proxmox"
  const panels = [
    { id: "usage", title: "Usage", render: (edit: any) => (
      <Panel title="Usage" edit={edit}>
        <div className="flex justify-around gap-4"><Gauge label="CPU" value={h.cpu ?? 0} /><Gauge label="Memory" value={h.mem ?? 0} /></div>
      </Panel>
    ) },
    { id: "history", title: "History", render: (edit: any) => (
      <Panel title="History" edit={edit}>
        <TimeSeries series={[{ name: "CPU", color: "var(--color-s1)", values: points.map((p) => ({ t: p.t, v: p.cpu })) }, { name: "Memory", color: "var(--color-s2)", values: points.map((p) => ({ t: p.t, v: p.mem })) }]} />
      </Panel>
    ) },
    { id: "details", title: "Details", render: (edit: any) => (
      <Panel title="Details" edit={edit}>
        <div className="grid grid-cols-3 gap-4 max-sm:grid-cols-2">
          <Stat label="Swap" value={fmt.pct(h.swap)} level={levelOf(h.swap)} />
          <Stat label="Temperature" value={fmt.temp(h.temp)} />
          <Stat label="Containers" value={`${h.containers_running}/${h.containers_total}`} />
          <Stat label="Down" value={<span className="text-xl">{fmt.bps(h.rx)}</span>} />
          <Stat label="Up" value={<span className="text-xl">{fmt.bps(h.tx)}</span>} />
          <Stat label="Agent" value={<span className="text-xl">{h.agent_version || "—"}</span>} />
        </div>
      </Panel>
    ) },
    { id: "logs", title: "Logs", render: (edit: any) => <HostLogs id={id} lines={h.logs} edit={edit} /> },
    { id: "disks", title: "File systems", render: (edit: any) => (
      <Panel title="File systems" flush edit={edit}>
        {h.disks?.length ? <FileSystems rows={h.disks.map((d: any) => ({ ...d, pct: (d.used / d.total) * 100 }))} /> : <div className="px-4 pb-4"><Empty>No data yet.</Empty></div>}
      </Panel>
    ) },
    { id: "smart", title: "Physical disks", absent: !physical, render: (edit: any) => (
      <Panel title="Physical disks" edit={edit} footer="Attention from 20 % life left or any bad sector, critical from 10 % or a failed self-assessment.">
        {h.smart?.length ? <DiskCards disks={h.smart} /> : <Empty>No SMART data yet.</Empty>}
      </Panel>
    ) },
    { id: "containers", title: "Containers", absent: !h.containers?.length, render: (edit: any) => (
      <Panel title="Containers" flush edit={edit}>
        <Table head={["Name", "Status", "State"]}>
          {h.containers?.map((c: any) => <tr key={c.name}><Td mono>{c.name}</Td><Td className="text-fg2">{c.status}</Td><StateCell level={c.state === "running" ? "ok" : "off"} label={c.state} /></tr>)}
        </Table>
      </Panel>
    ) },
    { id: "node", title: "Node.js", absent: !h.node, render: (edit: any) => (
      <Panel title="Node.js" edit={edit}>
        <p className="text-fg2">Node <Mono>{h.node?.version}</Mono></p>
        {h.node?.apps.map((a: any) => <p key={a.path} className="mt-2">{a.name} <Mono className="text-fg3">{a.path}</Mono></p>)}
      </Panel>
    ) },
    { id: "updates", title: "Updates", render: (edit: any) => (
      <Panel title="Updates" edit={edit}>
        {updating && (
          <div className="mb-4 flex flex-col gap-2">
            <Progress pct={h.update.pct} label={`Update of ${h.name}`} />
            <p role="status" className="truncate text-[13px] text-fg2">{h.update.pct} % · {h.update.step ?? "Waiting for the agent"}</p>
          </div>
        )}
        {h.reboot_required && <p className="mb-4"><Status level="warn" label="Restart needed" /></p>}
        {h.update_list?.length ? (
          <ul className="mb-4 max-h-60 overflow-auto">
            {h.update_list.map((u: any) => <li key={u.name} className="flex justify-between py-1"><Mono>{u.name}</Mono><span className={u.security ? "text-warn" : "text-fg3"}>{u.security ? "Security" : u.version}</span></li>)}
          </ul>
        ) : <p className="mb-4 text-fg3">No pending updates known.</p>}
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => send({ action: "check_updates" }, "Check requested.")}>Check now</Button>
          <Button variant="primary" disabled={updating} onClick={() => { if (confirm(`Upgrade all packages on ${h.name}?`)) send({ action: "update_system" }, "System update requested.") }}>Update system</Button>
          <Button disabled={updating} onClick={() => send({ action: "update_agent" }, "Agent update requested.")}>Update agent</Button>
        </div>
      </Panel>
    ) },
    { id: "agent", title: "Agent", render: (edit: any) => (
      <Panel title="Agent" edit={edit}>
        <div className="flex flex-col gap-4">
          <Select label="Deployment type" value={h.kind} onChange={(e) => send({ action: "set_kind", kind: e.target.value, ct_autoinstall: h.ct_autoinstall }, "Type change requested.")} options={KINDS} hint="Applied live, without reinstalling." />
          {h.kind === "proxmox" && <Check label="Install the agent in containers, including new ones" checked={h.ct_autoinstall} onChange={(e) => send({ action: "set_kind", kind: h.kind, ct_autoinstall: e.target.checked }, "Change requested.")} />}
          {note && <p className="text-[13px] text-fg2" role="status">{note}</p>}
          {h.results?.slice(-3).reverse().map((r: any) => <p key={r.id} className={`font-mono text-[13px] whitespace-pre-wrap ${r.ok ? "text-fg2" : "text-crit"}`}>{r.output}</p>)}
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => setInstall(!install)}>{install ? "Hide install command" : "Show install command"}</Button>
            <Button variant="danger" onClick={() => setRemoving(true)}><TrashIcon className="size-5" aria-hidden />Delete host</Button>
          </div>
          {install && <InstallCommand id={id} />}
        </div>
      </Panel>
    ) },
  ]
  return (
    <>
      <PageHeader
        title={h.name}
        crumbs={[{ label: "Hosts", to: "/hosts" }, { label: h.name }]}
        subtitle={<><Mono>{h.ip || "no address yet"}</Mono> · {kindLabel(h.kind)} · {h.os || "waiting for first report"} · up {fmt.uptime(h.uptime_s)}</>}
        onRefresh={reload}
        actions={<>
          <Status level={hostLevel(h.status)} />
          {consoleLink && <a href={consoleLink} target="_blank" rel="noreferrer"><Button><CommandLineIcon className="size-5" aria-hidden />Console</Button></a>}
          <CustomizeButton />
          <RangeSelect value={range} onChange={setRange} />
        </>}
      />
      {h.oci && <p role="note" className="mb-4 rounded-panel bg-warn-soft px-4 py-2.5 text-warn">{h.installed ? "This container runs an OCI image: logs, updates and Docker state stay empty when the image lacks journald, a package manager or Docker." : OCI_LIMITS}</p>}
      <Board id="host" panels={panels}
        desktop={{ cols: [["usage", "history", "details", "logs"], ["disks", "smart", "containers", "node", "updates", "agent"]], hidden: [] }}
        phone={{ cols: [["usage", "details", "disks", "smart", "containers", "logs", "history", "node", "updates", "agent"]], hidden: [] }} />
      {removing && (
        <Modal title={`Delete ${h.name}`} onClose={() => setRemoving(false)}>
          <div className="flex flex-col gap-4">
            <p className="text-fg2">Deleting the host only stops Nyx from accepting its agent. To remove the agent, its service and its configuration, run this on the host:</p>
            <Copy text={UNINSTALL} />
            <div className="flex justify-end gap-3">
              <Button onClick={() => setRemoving(false)}>Cancel</Button>
              <Button variant="danger" onClick={remove}>Delete host</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

import { ChevronRightIcon, CommandLineIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { BarGauge, Button, Check, Copy, Empty, ErrorNote, Gauge, Input, Modal, Mono, Panel, RangeSelect, Select, Stat, StateCell, Status, Table, Td, TimeSeries } from "../ui/components"
import { api, fmt, levelOf, type Level, useApi } from "../ui/lib"
import { Link, navigate, PageHeader, Section } from "../ui/shell"
import { hostLevel } from "./overview"

const KINDS = [{ value: "vm", label: "VM" }, { value: "physical", label: "Physical server" }, { value: "proxmox", label: "Physical server (Proxmox)" }, { value: "vps", label: "VPS" }]
// The path keeps working where sudo does not search /usr/local/bin, as on RHEL.
const UNINSTALL = 'sudo "$(command -v nyx-agent)" uninstall'
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k

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

function AddHost({ hosts, onDone }: { hosts: any[]; onDone: () => void }) {
  const [f, setF] = useState({ name: "", kind: "vm", parent: "", ct_autoinstall: false })
  const [res, setRes] = useState<any>()
  const [error, setError] = useState("")
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try { setRes(await api("/api/hosts", { body: f })) } catch (err) { setError((err as Error).message) }
  }
  if (res) {
    const a = res.ansible
    return (
      <Modal title="Install the agent" onClose={onDone}>
        <p className="text-fg2">Run this as root on the host.</p>
        <Copy text={res.curl} />
        <p className="text-fg2">Or use these variables with the Ansible role.</p>
        <Copy text={Object.entries(a).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")} />
      </Modal>
    )
  }
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
  const list = hosts.data ?? []
  const rows = buildTree(list, (h) => h.guests ?? [], collapsed)
  const toggle = (id: string) => { const s = new Set(collapsed); s.has(id) ? s.delete(id) : s.add(id); setCollapsed(s) }
  return (
    <>
      <PageHeader title="Hosts" subtitle={`${list.length} hosts`} onRefresh={hosts.reload} actions={<Button variant="primary" onClick={() => setAdd(true)}><PlusIcon className="size-5" aria-hidden />Add host</Button>} />
      <Panel title="Fleet" flush>
        {list.length === 0 ? <div className="px-5 pb-5"><Empty>No hosts yet. Add one to get an install command.</Empty></div> : (
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
                <Td className="text-fg2">{r.host.updates || "—"}</Td>
                <StateCell level={hostLevel(r.host.status)} label={r.host.installed ? undefined : "Waiting for install"} />
              </tr>
            ) : (
              <tr key={r.key}>
                <Td className="text-fg2"><span style={{ paddingLeft: r.depth * 24 + 20 }}>{r.guest.name}</span></Td>
                <Td className="text-fg3">{r.guest.kind === "lxc" ? "Container" : "VM"} {r.guest.vmid}, no agent</Td>
                <Td /><Td /><Td /><Td /><Td />
                <Td>{proxmox.data?.url && <a className="text-accent" target="_blank" rel="noreferrer" href={consoleUrl(proxmox.data.url, r.parent, r.guest)}>Console</a>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
      {add && <AddHost hosts={list} onDone={() => { setAdd(false); hosts.reload() }} />}
    </>
  )
}

const smartLevel: Record<string, Level> = { ok: "ok", warn: "warn", crit: "crit" }

export function HostDetail({ id }: { id: string }) {
  const [range, setRange] = useState("1h")
  const { data: h, reload, error } = useApi(`/api/hosts/${id}`)
  const series = useApi<any[]>(`/api/series?range=${range}&host=${id}`)
  const proxmox = useApi("/api/settings/proxmox", { poll: false })
  const [install, setInstall] = useState<any>()
  const [note, setNote] = useState("")
  const [removing, setRemoving] = useState(false)
  if (error) return <p role="alert" className="text-crit">{error}</p>
  if (!h) return null

  const send = async (body: any, msg: string) => {
    try { await api(`/api/hosts/${id}/command`, { body }); setNote(`${msg} Queued, it reaches the agent with its next report.`) } catch (e) { setNote((e as Error).message) }
  }
  const remove = async () => {
    await api(`/api/hosts/${id}`, { method: "DELETE" })
    navigate("/hosts")
  }
  const consoleLink = consoleUrl(proxmox.data?.url ?? "", h)
  const points = series.data ?? []
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
          <RangeSelect value={range} onChange={setRange} />
        </>}
      />
      <div className="grid grid-cols-2 items-start gap-5 max-lg:grid-cols-1">
        <Section>
          <Panel title="Usage">
            <div className="flex justify-around gap-4"><Gauge label="CPU" value={h.cpu ?? 0} /><Gauge label="Memory" value={h.mem ?? 0} /></div>
          </Panel>
          <Panel title="History">
            <TimeSeries series={[{ name: "CPU", color: "var(--color-s1)", values: points.map((p) => ({ t: p.t, v: p.cpu })) }, { name: "Memory", color: "var(--color-s2)", values: points.map((p) => ({ t: p.t, v: p.mem })) }]} />
          </Panel>
          <Panel title="Details">
            <div className="grid grid-cols-3 gap-5 max-sm:grid-cols-2">
              <Stat label="Swap" value={fmt.pct(h.swap)} level={levelOf(h.swap)} />
              <Stat label="Temperature" value={fmt.temp(h.temp)} />
              <Stat label="Containers" value={`${h.containers_running}/${h.containers_total}`} />
              <Stat label="Down" value={<span className="text-xl">{fmt.bps(h.rx)}</span>} />
              <Stat label="Up" value={<span className="text-xl">{fmt.bps(h.tx)}</span>} />
              <Stat label="Agent" value={<span className="text-xl">{h.agent_version || "—"}</span>} />
            </div>
          </Panel>
          <Panel title="Logs" footer="Warnings and errors from journald, kept in memory.">
            {h.logs?.length ? <pre className="max-h-80 overflow-auto font-mono text-[13px] whitespace-pre-wrap text-fg2">{[...h.logs].reverse().join("\n")}</pre> : <Empty>No warnings.</Empty>}
          </Panel>
        </Section>
        <Section>
          <Panel title="Disks">
            {h.disks?.length ? <BarGauge rows={h.disks.map((d: any) => ({ label: d.mount, pct: (d.used / d.total) * 100 }))} /> : <Empty>No data yet.</Empty>}
          </Panel>
          {(h.kind === "physical" || h.kind === "proxmox") && (
            <Panel title="SMART" flush footer="Attention from 20 % life left or any bad sector, critical from 10 % or a failed self-assessment.">
              {h.smart?.length ? (
                <Table head={["Disk", "Model", "Life left", "State"]}>
                  {h.smart.map((d: any) => (
                    <tr key={d.device}><Td mono>{d.device}</Td><Td className="text-fg2">{d.model}</Td><Td className="text-fg2">{d.life_left_pct == null ? "—" : `${d.life_left_pct} %`}</Td><StateCell level={smartLevel[d.health]} label={d.reason || undefined} /></tr>
                  ))}
                </Table>
              ) : <div className="px-5 pb-5"><Empty>No SMART data yet.</Empty></div>}
            </Panel>
          )}
          {h.containers?.length > 0 && (
            <Panel title="Containers" flush>
              <Table head={["Name", "Status", "State"]}>
                {h.containers.map((c: any) => <tr key={c.name}><Td mono>{c.name}</Td><Td className="text-fg2">{c.status}</Td><StateCell level={c.state === "running" ? "ok" : "off"} label={c.state} /></tr>)}
              </Table>
            </Panel>
          )}
          {h.node && (
            <Panel title="Node.js">
              <p className="text-fg2">Node <Mono>{h.node.version}</Mono></p>
              {h.node.apps.map((a: any) => <p key={a.path} className="mt-2">{a.name} <Mono className="text-fg3">{a.path}</Mono></p>)}
            </Panel>
          )}
          <Panel title="Updates">
            {h.update_list?.length ? (
              <ul className="mb-4 max-h-60 overflow-auto">
                {h.update_list.map((u: any) => <li key={u.name} className="flex justify-between py-1"><Mono>{u.name}</Mono><span className={u.security ? "text-warn" : "text-fg3"}>{u.security ? "Security" : u.version}</span></li>)}
              </ul>
            ) : <p className="mb-4 text-fg3">No pending updates known.</p>}
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => send({ action: "check_updates" }, "Check requested.")}>Check now</Button>
              <Button variant="primary" onClick={() => { if (confirm(`Upgrade all packages on ${h.name}?`)) send({ action: "update_system" }, "System update requested.") }}>Update system</Button>
              <Button onClick={() => send({ action: "update_agent" }, "Agent update requested.")}>Update agent</Button>
            </div>
          </Panel>
          <Panel title="Agent">
            <div className="flex flex-col gap-4">
              <Select label="Deployment type" value={h.kind} onChange={(e) => send({ action: "set_kind", kind: e.target.value, ct_autoinstall: h.ct_autoinstall }, "Type change requested.")} options={KINDS} hint="Applied live, without reinstalling." />
              {h.kind === "proxmox" && <Check label="Install the agent in containers, including new ones" checked={h.ct_autoinstall} onChange={(e) => send({ action: "set_kind", kind: h.kind, ct_autoinstall: e.target.checked }, "Change requested.")} />}
              {note && <p className="text-[13px] text-fg2" role="status">{note}</p>}
              {h.results?.slice(-3).reverse().map((r: any) => <p key={r.id} className={`font-mono text-[13px] whitespace-pre-wrap ${r.ok ? "text-fg2" : "text-crit"}`}>{r.output}</p>)}
              <div className="flex flex-wrap gap-3">
                <Button onClick={async () => setInstall(await api(`/api/hosts/${id}/install`))}>Show install command</Button>
                <Button variant="danger" onClick={() => setRemoving(true)}><TrashIcon className="size-5" aria-hidden />Delete host</Button>
              </div>
              {install && <Copy text={install.curl} />}
            </div>
          </Panel>
        </Section>
      </div>
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

import { ArrowPathIcon, BellIcon, BellSlashIcon, ChevronRightIcon, CloudIcon, CommandLineIcon, ComputerDesktopIcon, CubeIcon, CubeTransparentIcon, GlobeAltIcon, PlusIcon, ServerIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useEffect, useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { ProxmoxIcon } from "../ui/brand-icons"
import { Button, Check, Copy, Empty, ErrorNote, Gauge, type Icon, Input, Meter, Modal, Mono, Panel, Progress, RangeSelect, Select, Stat, StateCell, Status, Table, Td, TimeSeries, Variable, ask } from "../ui/components"
import { api, fmt, type Level, levelOf, levelSoft, useApi, useStored } from "../ui/lib"
import { Link, navigate, PageHeader } from "../ui/shell"
import { DiskCards, FileSystems } from "./disks"
import { FirewallPanel } from "./firewall"
import { ReposPanel } from "./repos"
import { HostLogs } from "./logs"
import { hostLevel } from "./overview"
import { VpnTable } from "./vpn"
import { t } from "../ui/i18n"

const KINDS = [{ value: "vm", label: "VM" }, { value: "lxc", label: "LXC container" }, { value: "physical", label: "Physical server" }, { value: "proxmox", label: "Physical server (Proxmox)" }, { value: "vps", label: "VPS" }]
const WATCH_CTS = "Manage LXC containers from this host"
const WATCH_CTS_HINT = "Every container gets the agent, installed from this host. OCI containers have no init: this host measures them. Unticking removes them from Nyx, with their history."
// The path keeps working where sudo does not search /usr/local/bin, as on RHEL.
const UNINSTALL = 'sudo "$(command -v nyx-agent)" uninstall'
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k

/** Older agents report containers as `vm`: their Proxmox parent or VMID tells them apart. */
export function hostType(h: any, hosts: any[]): string {
  const parent = hosts.find((p) => p.id === h.parent)
  const guest = parent?.guests?.find((g: any) => g.vmid === h.vmid || g.name === h.name)
  return h.kind === "lxc" || (h.kind === "vm" && (h.vmid > 0 || guest?.kind === "lxc")) ? "ct" : h.kind
}

/** A container watched by its Proxmox host, with no agent of its own to send commands to. */
export const noAgent = (h: any) => h.kind === "lxc" && !h.agent_version

export const HOST_TYPES: Record<string, { label: string; icon: Icon }> = {
  vm: { label: "VM", icon: ComputerDesktopIcon },
  ct: { label: "LXC container", icon: CubeIcon },
  oci: { label: "OCI container", icon: CubeTransparentIcon },
  physical: { label: "Physical server", icon: ServerIcon },
  proxmox: { label: "Physical server (Proxmox)", icon: ProxmoxIcon },
  vps: { label: "VPS", icon: CloudIcon },
}

export function HostIcon({ type }: { type: string }) {
  const { icon: I = ServerIcon, label = type } = HOST_TYPES[type] ?? {}
  return <span title={label} role="img" aria-label={label} className="inline-flex shrink-0 text-fg2"><I className="size-5" aria-hidden /></span>
}

const UPDATE_POLL_MS = 5000

export interface TreeRow { host?: any; guest?: any; parent?: any; depth: number; hasChildren: boolean; key: string }

/** Flatten hosts into display order, nesting children and agent-less Proxmox guests. */
export function buildTree(hosts: any[], guestsOf: (h: any) => any[], collapsed: Set<string>): TreeRow[] {
  const ids = new Set(hosts.map((h) => h.id))
  const kids = (id: string) => hosts.filter((h) => h.parent === id)
  const out: TreeRow[] = []
  const walk = (h: any, depth: number) => {
    const children = kids(h.id)
    // Across the whole fleet: a guest with its own agent can sit at the top level.
    const guests = guestsOf(h).filter((g) => !children.some((c) => c.vmid === g.vmid) && !hosts.some((c) => c.name === g.name || c.hostname === g.name))
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
  // Opened by Nyx, which signs in with the credentials of the settings and sends you on to Proxmox.
  const base = "/api/proxmox/console?"
  if (guest) return `${base}console=${guest.kind === "lxc" ? "lxc" : "kvm"}&vmid=${guest.vmid}&vmname=${encodeURIComponent(guest.name)}&node=${encodeURIComponent(guest.node)}`
  if (h.vmid) return `${base}console=lxc&vmid=${h.vmid}&node=${encodeURIComponent(h.pve_node)}`
  return h.kind === "proxmox" ? `${base}console=shell&node=${encodeURIComponent(h.hostname)}` : ""
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
        {u.done ? <span /> : <Progress thin pct={u.pct} label={t("Update of {name}", { name: h.name })} />}
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
      <Panel title={t("Updates")}>
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
          {run.length > 0 && done === run.length && <div><Button onClick={() => setSeen(last)}>{t("Hide results")}</Button></div>}
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
        <p className="text-fg2">{t("Run this as root on the host.")}</p>
        <Copy text={data.curl} />
        <p className="text-fg2">{t("Or use these variables with the Ansible role.")}</p>
        <Copy text={Object.entries(data.ansible).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")} />
      </>}
    </div>
  )
}

const STEP = "flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-medium"

/** Adding a host on a page of its own: describe it, then install the agent with the command it gets. */
export function AddHostPage() {
  const hosts = useApi<any[]>("/api/hosts", { poll: false })
  const [f, setF] = useState({ name: "", kind: "vm", parent: "", ct_autoinstall: false })
  const [res, setRes] = useState<any>()
  const [error, setError] = useState("")
  // Only a VM or a container runs on something, and only on one of your physical servers.
  const nested = f.kind === "vm" || f.kind === "lxc"
  const servers = (hosts.data ?? []).filter((h) => h.kind === "physical" || h.kind === "proxmox")
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    try { setRes(await api("/api/hosts", { body: { ...f, parent: nested ? f.parent : "" } })) } catch (err) { setError((err as Error).message) }
  }
  const step = (n: number, title: string, active: boolean) => (
    <span className="flex items-center gap-3"><span className={`${STEP} ${active ? "bg-accent text-accent-ink" : "bg-raised text-fg2"}`}>{n}</span>{title}</span>
  )
  return (
    <>
      <PageHeader title={t("Add host")} crumbs={[{ label: "Hosts", to: "/hosts" }, { label: "Add host" }]} />
      <div className="grid max-w-5xl items-start gap-4 lg:grid-cols-2">
        <Panel title={t("Describe the host")} badge={res && <Status level="ok" label="Created" />}>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <p className="flex flex-col gap-2 text-[13px] text-fg2">{step(1, "Name it and pick how it runs", !res)}</p>
            <Input label="Name" required autoFocus disabled={!!res} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <fieldset disabled={!!res}>
              <legend className="mb-1 text-[13px] text-fg2">{t("Deployment type")}</legend>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2">
                {KINDS.map((k) => {
                  const I = HOST_TYPES[k.value === "lxc" ? "ct" : k.value]?.icon ?? ServerIcon
                  return (
                    <label key={k.value} className={`flex h-20 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-box border px-2 text-center text-[13px] has-focus-visible:outline-2 has-focus-visible:outline-accent ${f.kind === k.value ? "border-accent bg-accent-soft text-accent" : "border-line2 bg-raised text-fg2 hover:border-fg3"}`}>
                      <input type="radio" className="sr-only" name="kind" checked={f.kind === k.value} onChange={() => setF({ ...f, kind: k.value })} />
                      <I className="size-6" aria-hidden />{k.label}
                    </label>
                  )
                })}
              </div>
              {(f.kind === "physical" || f.kind === "proxmox") && <p className="mt-2 text-xs text-fg3">{t("SMART monitoring is included; smartmontools is installed if missing.")}</p>}
            </fieldset>
            {nested && <Select label="Runs on" disabled={!!res} value={f.parent} onChange={(e) => setF({ ...f, parent: e.target.value })} options={[{ value: "", label: "Nothing (top level)" }, ...servers.map((h) => ({ value: h.id, label: `${h.name} (${h.kind === "proxmox" ? "Proxmox" : "physical"})` }))]} />}
            {f.kind === "proxmox" && <Check label={WATCH_CTS} hint={WATCH_CTS_HINT} disabled={!!res} checked={f.ct_autoinstall} onChange={(e) => setF({ ...f, ct_autoinstall: e.target.checked })} />}
            <ErrorNote>{error}</ErrorNote>
            {!res && <div className="flex gap-3"><Button variant="primary" type="submit">{t("Generate install command")}</Button><Button onClick={() => navigate("/hosts")}>{t("Cancel")}</Button></div>}
          </form>
        </Panel>
        <Panel title={t("Install the agent")}>
          <div className="flex flex-col gap-4">
            <p className="flex flex-col gap-2 text-[13px] text-fg2">{step(2, "Run the command on the host", !!res)}</p>
            {res ? <>
              <InstallCommand id={res.id} />
              <p className="text-[13px] text-fg3">{t("The host turns online with the agent's first report, usually within a minute.")}</p>
              <div className="flex flex-wrap gap-3">
                <Button variant="primary" onClick={() => navigate(`/hosts/${res.id}`)}>Open {f.name}</Button>
                <Button onClick={() => { setRes(undefined); setF({ ...f, name: "" }) }}><PlusIcon className="size-5" aria-hidden />{t("Add another")}</Button>
              </div>
            </> : <Empty>{t("The command appears here once the host is described.")}</Empty>}
          </div>
        </Panel>
      </div>
    </>
  )
}

const STATES = [{ value: "", label: "All" }, { value: "ok", label: "Healthy" }, { value: "problem", label: "Warning or critical" }, { value: "off", label: "Offline" }]

/** Search, type and state together. A guest without an agent only shows on the unfiltered tree. */
export function filterHosts(hosts: any[], q: string, type: string, state: string) {
  const n = q.trim().toLowerCase()
  return hosts.filter((h) =>
    (!n || [h.name, h.hostname, h.ip, h.os].some((v) => String(v ?? "").toLowerCase().includes(n))) &&
    (!type || hostType(h, hosts) === type) &&
    (!state || (state === "problem" ? h.status === "warn" || h.status === "crit" : h.status === state)))
}

/** A number with its bar, so a busy host stands out down the column. */
function Usage({ pct, warn, crit }: { pct?: number | null; warn?: number; crit?: number }) {
  if (pct == null) return <span className="text-fg3">—</span>
  return <span className="flex w-28 items-center gap-2"><span className="flex-1"><Meter pct={pct} warn={warn} crit={crit} /></span><span className="w-11 text-right text-[13px] tabular-nums text-fg2">{fmt.pct(pct)}</span></span>
}

export function Hosts() {
  const hosts = useApi<any[]>("/api/hosts")
  const proxmox = useApi("/api/settings/proxmox", { poll: false })
  const th = useApi("/api/settings/thresholds", { poll: false }).data ?? {}
  const [collapsed, setCollapsed] = useState(new Set<string>())
  const [updateError, setUpdateError] = useState("")
  const [bulkDns, setBulkDns] = useState(false)
  const [q, setQ] = useState("")
  const [type, setType] = useState("")
  const [state, setState] = useState("")
  const list = hosts.data ?? []
  const filtered = !!(q.trim() || type || state)
  const updating = list.some((h) => h.update && !h.update.done)
  useUpdatePolling(updating, hosts.reload)
  const rows = buildTree(filterHosts(list, q, type, state), (h) => (filtered ? [] : h.guests ?? []), collapsed)
  const toggle = (id: string) => { const s = new Set(collapsed); s.has(id) ? s.delete(id) : s.add(id); setCollapsed(s) }
  const online = list.filter((h) => h.status !== "off").length
  const problems = list.filter((h) => h.status === "warn" || h.status === "crit").length
  const updatable = list.filter((h) => h.status !== "off" && h.agent_version).length
  const updates = list.reduce((n, h) => n + (h.updates || 0), 0)
  const restart = list.filter((h) => h.reboot_required).length
  const types = [...new Set(list.map((h) => hostType(h, list)))]
  const updateAll = async () => {
    if (!await ask(t("Upgrade the packages of {updatable} online hosts and bring their agents up to date? Services can restart while packages are replaced. Hosts are not rebooted.", { updatable }), { action: "Update all" })) return
    setUpdateError("")
    try { await api("/api/hosts/update-all", { method: "POST" }); hosts.reload() } catch (e) { setUpdateError((e as Error).message) }
  }
  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
      <Panel title={t("Summary")} edit={edit}>
        <div className="grid grid-cols-4 gap-4 max-sm:grid-cols-2">
          <Stat label="Online" value={`${online} / ${list.length}`} level={online === list.length ? "ok" : "warn"} />
          <Stat label="Need attention" value={problems} level={problems ? "warn" : "ok"} />
          <Stat label="Pending updates" value={updates} level={updates ? "warn" : "ok"} sub={restart ? `${restart} to restart` : undefined} />
          <Stat label="Agent-less guests" value={list.reduce((n, h) => n + buildTree([h], (x) => x.guests ?? [], new Set()).filter((r) => r.guest).length, 0)} />
        </div>
      </Panel>
    ) },
    { id: "fleet", title: "Fleet", render: (edit: any) => (
      <Panel title={filtered ? `${t("Fleet")} · ${t("{n} of {total}", { n: rows.length, total: list.length })}` : "Fleet"} flush edit={edit}>
        {list.length > 0 && (
          <div className="flex flex-wrap items-end gap-3 px-4 pb-3">
            <div className="w-64 max-sm:w-full"><Input label="Search" type="search" placeholder={t("Name, address or OS")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <Variable label="Type" value={type} onChange={setType} options={[{ value: "", label: "All" }, ...types.map((t) => ({ value: t, label: HOST_TYPES[t]?.label ?? t }))]} />
            <Variable label="State" value={state} onChange={setState} options={STATES} />
          </div>
        )}
        {list.length === 0 ? <div className="px-4 pb-4"><Empty>{t("No hosts yet. Add one to get an install command.")}</Empty></div> : rows.length === 0 ? <div className="px-4 pb-4"><Empty>{t("No host matches.")}</Empty></div> : (
          <Table head={["Host", "Type", "Address", "CPU", "Memory", "Temp.", "Updates", "State"]}>
            {rows.map((r) => r.host ? (
              <tr key={r.key} className="cursor-pointer hover:bg-raised" onClick={(e) => { if (!(e.target as HTMLElement).closest("a, button")) navigate(`/hosts/${r.host.id}`) }}>
                <Td className="font-medium">
                  <span className="flex items-center gap-1" style={{ paddingLeft: r.depth * 24 }}>
                    {r.hasChildren
                      ? <button aria-label={t("Toggle children")} aria-expanded={!collapsed.has(r.host.id)} className="text-fg3" onClick={() => toggle(r.host.id)}><ChevronRightIcon className={`size-4 ${collapsed.has(r.host.id) ? "" : "rotate-90"}`} aria-hidden /></button>
                      : <span className="w-4" />}
                    <HostIcon type={hostType(r.host, list)} />
                    <span className="ml-1 flex min-w-0 flex-col">
                      <Link to={`/hosts/${r.host.id}`} className="truncate hover:text-accent">{r.host.name}</Link>
                      {r.host.os && <span className="truncate text-xs font-normal text-fg3">{r.host.os}</span>}
                    </span>
                    {r.host.muted && <BellSlashIcon className="size-4 shrink-0 text-fg3" aria-label={t("Excluded from alerts")} />}
                  </span>
                </Td>
                <Td className="text-fg2">{HOST_TYPES[hostType(r.host, list)]?.label ?? r.host.kind}</Td>
                <Td mono>{r.host.ip || "—"}</Td>
                <Td><Usage pct={r.host.status === "off" ? null : r.host.cpu} warn={th.warn} crit={th.crit} /></Td>
                <Td><Usage pct={r.host.status === "off" ? null : r.host.mem} warn={th.warn} crit={th.crit} /></Td>
                <Td className={r.host.temp >= (th.temp_crit ?? 90) ? "text-crit" : r.host.temp >= (th.temp_warn ?? 80) ? "text-warn" : "text-fg2"}>{fmt.temp(r.host.temp)}</Td>
                <Td className="text-fg2"><span className="flex items-center gap-2 whitespace-nowrap">{r.host.updates || "—"}{r.host.reboot_required && <Status cell level="warn" label="Restart" />}</span></Td>
                <StateCell level={hostLevel(r.host.status)} label={r.host.installed ? undefined : r.host.kind === "lxc" ? "Stopped" : "Waiting for install"} />
              </tr>
            ) : (
              <tr key={r.key}>
                <Td className="text-fg2"><span className="flex items-center gap-2 whitespace-nowrap" style={{ paddingLeft: r.depth * 24 + 20 }}><HostIcon type={r.guest.kind === "lxc" ? "ct" : "vm"} />{r.guest.name}</span></Td>
                <Td className="text-fg3">{r.guest.kind === "lxc" ? "LXC container" : "VM"} {r.guest.vmid}, no agent</Td>
                <Td /><Td /><Td /><Td /><Td />
                <Td>{proxmox.data?.url && <a className="text-accent" target="_blank" rel="noreferrer" href={consoleUrl(proxmox.data.url, r.parent, r.guest)}>{t("Console")}</a>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    ) },
  ]
  return (
    <>
      <PageHeader title={t("Hosts")} subtitle={`${list.length} hosts`} onRefresh={hosts.reload} actions={<><CustomizeButton /><Button disabled={!updatable} onClick={() => setBulkDns(true)}><GlobeAltIcon className="size-5" aria-hidden />{t("Change DNS")}</Button><Button disabled={updating || !updatable} onClick={updateAll}><ArrowPathIcon className="size-5" aria-hidden />{t("Update all")}</Button><Button variant="primary" onClick={() => navigate("/hosts/new")}><PlusIcon className="size-5" aria-hidden />{t("Add host")}</Button></>} />
      <ErrorNote>{updateError}</ErrorNote>
      <FleetUpdates hosts={list} />
      {bulkDns && <BulkDns hosts={list.filter((h) => h.status !== "off" && h.agent_version)} onClose={() => { setBulkDns(false); hosts.reload() }} />}
      <Board id="hosts" panels={panels} desktop={{ cols: [["summary", "fleet"]], hidden: [] }} phone={{ cols: [["summary", "fleet"]], hidden: [] }} />
    </>
  )
}

export type DnsRun = { host: string; name: string; id?: string; ok?: boolean; output: string }

/** Where each host of a bulk DNS change stands, from the results the agents sent back. */
export function dnsRunState(runs: DnsRun[], results: any[]): DnsRun[] {
  return runs.map((r) => {
    const res = r.id && r.ok === undefined ? results.find((x) => x.id === r.id) : undefined
    return res ? { ...r, ok: res.ok, output: res.output } : r
  })
}

/** Sends the same DNS servers to many agents at once and shows, live, which ones took them. */
function BulkDns({ hosts, onClose }: { hosts: any[]; onClose: () => void }) {
  const [picked, setPicked] = useState(() => new Set(hosts.map((h) => h.id)))
  const [dns, setDns] = useState("")
  const [runs, setRuns] = useState<DnsRun[]>([])
  const pending = runs.some((r) => r.id && r.ok === undefined)
  useEffect(() => {
    if (!pending) return
    const id = setInterval(async () => {
      try { const results = await api<any[]>("/api/results"); setRuns((rs) => dnsRunState(rs, results)) } catch { /* next tick */ }
    }, 2000)
    return () => clearInterval(id)
  }, [pending])
  const toggle = (id: string) => { const s = new Set(picked); s.has(id) ? s.delete(id) : s.add(id); setPicked(s) }
  const apply = async (e: React.FormEvent) => {
    e.preventDefault()
    const servers = dns.split(/[\s,]+/).filter(Boolean)
    const chosen = hosts.filter((h) => picked.has(h.id))
    setRuns(chosen.map((h) => ({ host: h.id, name: h.name, output: "Sending…" })))
    const sent = await Promise.all(chosen.map(async (h): Promise<DnsRun> => {
      try {
        const { id } = await api<{ id: string }>(`/api/hosts/${h.id}/command`, { method: "POST", body: { action: "set_dns", dns: servers } })
        return { host: h.id, name: h.name, id, output: "Waiting for the agent…" }
      } catch (err) { return { host: h.id, name: h.name, ok: false, output: (err as Error).message } }
    }))
    setRuns(sent)
  }
  const done = runs.filter((r) => r.ok !== undefined).length
  return (
    <Modal title={t("Change DNS servers")} onClose={onClose} wide>
      <form className="flex flex-col gap-4" onSubmit={apply}>
        <Input label="DNS servers" value={dns} onChange={(e) => setDns(e.target.value)} placeholder={t("The system's resolver")} hint="Used by the agents to reach the monitor, for example 1.1.1.1, 1.0.0.1. Each agent keeps them only if the monitor answers through them. Empty goes back to the system's." />
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[13px] text-fg2">Hosts · {picked.size} of {hosts.length}</legend>
          <div className="flex gap-3 text-[13px]">
            <button type="button" className="text-accent" onClick={() => setPicked(new Set(hosts.map((h) => h.id)))}>{t("All")}</button>
            <button type="button" className="text-accent" onClick={() => setPicked(new Set())}>{t("None")}</button>
          </div>
          <div className="grid max-h-56 grid-cols-2 overflow-y-auto max-sm:grid-cols-1">
            {hosts.map((h) => <Check key={h.id} label={h.name} hint={h.dns?.length ? h.dns.join(", ") : "System resolver"} checked={picked.has(h.id)} onChange={() => toggle(h.id)} />)}
          </div>
        </fieldset>
        <div><Button variant="primary" type="submit" disabled={!picked.size || pending}>Apply to {picked.size} hosts</Button></div>
      </form>
      {runs.length > 0 && (
        <div className="mt-4" role="status" aria-live="polite">
          <p className="mb-2 text-[13px] text-fg2">{done} of {runs.length} answered</p>
          <ul className="flex flex-col divide-y divide-line">
            {runs.map((r) => (
              <li key={r.host} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2">
                <span className="flex min-w-0 flex-col"><span className="truncate">{r.name}</span><span className={`font-mono text-xs ${r.ok === false ? "text-crit" : "text-fg3"}`}>{r.output}</span></span>
                <Status cell level={r.ok === undefined ? "info" : r.ok ? "ok" : "crit"} label={r.ok === undefined ? "Pending" : r.ok ? "Changed" : "Failed"} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}

/** State badge; when not green, a click lists what made it so. */
function IssuesBadge({ level, issues }: { level: Level; issues?: { level: Level; message: string }[] }) {
  const [open, setOpen] = useState(false)
  if ((level !== "warn" && level !== "crit") || !issues?.length) return <Status level={level} />
  return (
    <div className="relative" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false) }}>
      <button type="button" aria-expanded={open} aria-haspopup="true" className="rounded-full hover:brightness-125" onClick={() => setOpen(!open)}><Status level={level} label={`${level === "crit" ? "Critical" : "Warning"} · ${issues.length}`} /></button>
      {open && (
        <ul className="absolute right-0 top-10 z-20 flex w-72 flex-col gap-1 rounded-panel border border-line2 bg-surface p-2">
          {issues.map((i) => <li key={i.message} className={`flex items-start gap-2 rounded-control px-2 py-1.5 text-[13px] ${levelSoft[i.level]}`}><Status cell level={i.level} label="" /><span className="text-fg">{i.message}</span></li>)}
        </ul>
      )}
    </div>
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
    try { await api(`/api/hosts/${id}/command`, { body }); setNote(t("{msg} Queued, it reaches the agent with its next report.", { msg: t(msg) })); reload() } catch (e) { setNote((e as Error).message) }
  }
  const remove = async () => {
    await api(`/api/hosts/${id}`, { method: "DELETE" })
    navigate("/hosts")
  }
  const mute = async () => {
    if (!h.muted && !await ask(t("Keep {name} out of alerts and notifications? It stays measured, and its open alerts close without a notice.", { name: h.name }), { action: "Exclude" })) return
    try { await api(`/api/hosts/${id}`, { method: "PATCH", body: { muted: !h.muted } }); reload() } catch (e) { setNote((e as Error).message) }
  }
  const consoleLink = consoleUrl(proxmox.data?.url ?? "", h)
  const points = series.data ?? []
  const physical = h.kind === "physical" || h.kind === "proxmox"
  const watched = noAgent(h)
  const panels = [
    { id: "usage", title: "Usage", render: (edit: any) => (
      <Panel title={t("Usage")} edit={edit}>
        <div className="flex justify-around gap-4"><Gauge label="CPU" value={h.cpu ?? 0} /><Gauge label="Memory" value={h.mem ?? 0} /></div>
      </Panel>
    ) },
    { id: "history", title: "History", render: (edit: any) => (
      <Panel title={t("History")} edit={edit}>
        <TimeSeries series={[{ name: "CPU", color: "var(--color-s1)", values: points.map((p) => ({ t: p.t, v: p.cpu })) }, { name: "Memory", color: "var(--color-s2)", values: points.map((p) => ({ t: p.t, v: p.mem })) }]} />
      </Panel>
    ) },
    { id: "details", title: "Details", render: (edit: any) => (
      <Panel title={t("Details")} edit={edit}>
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
    { id: "logs", title: "Logs", absent: watched, render: (edit: any) => <HostLogs id={id} lines={h.logs} edit={edit} /> },
    { id: "disks", title: "File systems", render: (edit: any) => (
      <Panel title={t("File systems")} flush edit={edit}>
        {h.disks?.length ? <FileSystems rows={h.disks.map((d: any) => ({ ...d, pct: (d.used / d.total) * 100 }))} /> : <div className="px-4 pb-4"><Empty>{t("No data yet.")}</Empty></div>}
      </Panel>
    ) },
    { id: "smart", title: "Physical disks", absent: !physical, render: (edit: any) => (
      <Panel title={t("Physical disks")} edit={edit} footer="Attention from 20 % life left or any bad sector, critical from 10 % or a failed self-assessment.">
        {h.smart?.length ? <DiskCards disks={h.smart} /> : <Empty>{t("No SMART data yet.")}</Empty>}
      </Panel>
    ) },
    { id: "containers", title: "Containers", absent: !h.containers?.length, render: (edit: any) => (
      <Panel title={t("Containers")} flush edit={edit}>
        <Table head={["Name", "Status", "State"]}>
          {h.containers?.map((c: any) => <tr key={c.name}><Td mono>{c.name}</Td><Td className="text-fg2">{c.status}</Td><StateCell level={c.state === "running" ? "ok" : "off"} label={c.state} /></tr>)}
        </Table>
      </Panel>
    ) },
    { id: "vpn", title: "VPN links", absent: !h.vpn?.length, render: (edit: any) => (
      <Panel title={t("VPN links")} flush edit={edit}><VpnTable rows={h.vpn ?? []} /></Panel>
    ) },
    { id: "firewall", title: "Firewall", absent: watched || !h.firewall, render: (edit: any) => (
      <Panel title={t("Firewall")} flush edit={edit}><FirewallPanel id={id} fw={h.firewall} name={h.name} onSent={reload} /></Panel>
    ) },
    { id: "node", title: "Node.js", absent: !h.node?.version && !h.node?.apps.length, render: (edit: any) => (
      <Panel title={t("Node.js")} edit={edit}>
        {h.node?.version && <p className="text-fg2">{t("Node")} <Mono>{h.node.version}</Mono></p>}
        {h.node?.apps.map((a: any) => <p key={a.path} className="mt-2">{a.name} <Mono className="text-fg3">{a.path}</Mono>{a.manager && <span className="ml-2 text-fg3">{a.manager}</span>}</p>)}
      </Panel>
    ) },
    { id: "updates", title: "Updates", absent: watched, render: (edit: any) => (
      <Panel title={t("Updates")} edit={edit}>
        {updating && (
          <div className="mb-4 flex flex-col gap-2">
            <Progress pct={h.update.pct} label={t("Update of {name}", { name: h.name })} />
            <p role="status" className="truncate text-[13px] text-fg2">{h.update.pct} % · {h.update.step ?? "Waiting for the agent"}</p>
          </div>
        )}
        {h.reboot_required && <p className="mb-4"><Status level="warn" label="Restart needed" /></p>}
        {h.update_list?.length ? (
          <ul className="mb-4 max-h-60 overflow-auto">
            {h.update_list.map((u: any) => <li key={u.name} className="flex justify-between py-1"><Mono>{u.name}</Mono><span className={u.security ? "text-warn" : "text-fg3"}>{u.security ? t("Security") : u.version}</span></li>)}
          </ul>
        ) : <p className="mb-4 text-fg3">{t("No pending updates known.")}</p>}
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => send({ action: "check_updates" }, "Check requested.")}>{t("Check now")}</Button>
          <Button variant="primary" disabled={updating} onClick={async () => { if (await ask(t("Upgrade all packages on {name}?", { name: h.name }), { action: "Update" })) send({ action: "update_system" }, "System update requested.") }}>{t("Update system")}</Button>
          <Button disabled={updating} onClick={async () => { if (await ask(t("Remove packages nothing needs any more on {name}, old kernels included, and empty the package cache?", { name: h.name }), { action: "Clean up" })) send({ action: "clean_system" }, "Clean-up requested.") }}>{t("Clean up")}</Button>
          <Button disabled={updating} onClick={() => send({ action: "update_agent" }, "Agent update requested.")}>{t("Update agent")}</Button>
        </div>
      </Panel>
    ) },
    { id: "repos", title: "Package sources", absent: watched || !h.repos?.length, render: (edit: any) => (
      <Panel title={t("Package sources")} edit={edit}><ReposPanel key={h.repos.map((f: any) => f.path + f.content.length).join()} files={h.repos} send={send} /></Panel>
    ) },
    { id: "agent", title: "Agent", absent: watched, render: (edit: any) => (
      <Panel title={t("Agent")} edit={edit}>
        <div className="flex flex-col gap-4">
          <Select label="Deployment type" value={h.kind} onChange={(e) => send({ action: "set_kind", kind: e.target.value, ct_autoinstall: h.ct_autoinstall }, "Type change requested.")} options={KINDS} hint="Applied live, without reinstalling. The agent corrects VM, LXC and physical if the machine says otherwise." />
          {h.kind === "proxmox" && <Check label={WATCH_CTS} hint={WATCH_CTS_HINT} checked={h.ct_autoinstall} onChange={(e) => send({ action: "set_kind", kind: h.kind, ct_autoinstall: e.target.checked }, "Change requested.")} />}
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get("dns")); send({ action: "set_dns", dns: v.split(/[\s,]+/).filter(Boolean) }, "DNS change requested.") }}>
            <Input label="DNS servers" name="dns" key={h.dns?.join()} defaultValue={h.dns?.join(", ") ?? ""} placeholder={t("The system's resolver")} hint="Only used to reach the monitor, for example 1.1.1.1, 1.0.0.1 to bypass a local NextDNS. Kept only if the monitor answers through them. Empty to go back to the system's." />
            <div><Button type="submit">{t("Apply DNS")}</Button></div>
          </form>
          {note && <p className="text-[13px] text-fg2" role="status">{note}</p>}
          {h.results?.slice(-3).reverse().map((r: any) => <p key={r.id} className={`font-mono text-[13px] whitespace-pre-wrap ${r.ok ? "text-fg2" : "text-crit"}`}>{r.output}</p>)}
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => setInstall(!install)}>{install ? "Hide install command" : "Show install command"}</Button>
            <Button variant="danger" onClick={() => setRemoving(true)}><TrashIcon className="size-5" aria-hidden />{t("Delete host")}</Button>
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
          <IssuesBadge level={hostLevel(h.status)} issues={h.issues} />
          <Button aria-pressed={!!h.muted} onClick={mute}>{h.muted ? <><BellIcon className="size-5" aria-hidden />{t("Alert again")}</> : <><BellSlashIcon className="size-5" aria-hidden />{t("Exclude from alerts")}</>}</Button>
          {consoleLink && <a href={consoleLink} target="_blank" rel="noreferrer"><Button><CommandLineIcon className="size-5" aria-hidden />{t("Console")}</Button></a>}
          <CustomizeButton />
          <RangeSelect value={range} onChange={setRange} />
        </>}
      />
      {h.muted && <p role="note" className="mb-4 flex items-center gap-2 rounded-panel bg-raised px-4 py-2.5 text-fg2"><BellSlashIcon className="size-5 shrink-0" aria-hidden />{t("Excluded from alerts: nothing about this host opens an alert or sends a notification.")}</p>}
      {watched && <p role="note" className="mb-4 rounded-panel bg-raised px-4 py-2.5 text-fg2">{t("Measured by its Proxmox host, with no agent inside. Logs, updates and Docker state need an agent.")}</p>}
      {h.oci && !watched && <p role="note" className="mb-4 rounded-panel bg-warn-soft px-4 py-2.5 text-warn">{t("This container runs an OCI image: logs, updates and Docker state stay empty when the image lacks journald, a package manager or Docker.")}</p>}
      <Board id="host" panels={panels}
        desktop={{ cols: [["usage", "history", "details", "logs"], ["disks", "smart", "containers", "vpn", "firewall", "node", "updates", "agent"]], hidden: [] }}
        phone={{ cols: [["usage", "details", "disks", "smart", "containers", "vpn", "firewall", "logs", "history", "node", "updates", "agent"]], hidden: [] }} />
      {removing && (
        <Modal title={`Delete ${h.name}`} onClose={() => setRemoving(false)}>
          <div className="flex flex-col gap-4">
            <p className="text-fg2">{t("Deleting the host only stops Nyx from accepting its agent. To remove the agent, its service and its configuration, run this on the host:")}</p>
            {h.kind === "proxmox" && <p className="text-fg2">{t("Its LXC containers leave Nyx with it, and this command also removes any agent left inside the running ones. VMs stay as hosts of their own.")}</p>}
            <Copy text={UNINSTALL} />
            <div className="flex justify-end gap-3">
              <Button onClick={() => setRemoving(false)}>{t("Cancel")}</Button>
              <Button variant="danger" onClick={remove}>{t("Delete host")}</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

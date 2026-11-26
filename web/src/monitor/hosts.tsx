import { ArrowPathIcon, ArrowUpIcon, BellIcon, BellSlashIcon, ChevronRightIcon, ClockIcon, CloudIcon, CommandLineIcon, ComputerDesktopIcon, CpuChipIcon, QueueListIcon, CubeIcon, CubeTransparentIcon, ExclamationTriangleIcon, GlobeAltIcon, MagnifyingGlassIcon, PencilIcon, PlusIcon, ServerIcon, TrashIcon, XCircleIcon } from "@heroicons/react/24/outline"
import { Fragment, useEffect, useRef, useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { DistroIcon, distroName, distroOf, osName, ProxmoxIcon } from "../ui/brand-icons"
import { Button, Check, Copy, Empty, ErrorNote, Gauge, type Icon, Input, Meter, Modal, Mono, Panel, Progress, RangeSelect, Select, Stat, StateCell, Status, Table, Tabs, Td, TimeSeries, Variable, ask, tell, Skeleton, PageSkeleton } from "../ui/components"
import { api, fmt, type Level, levelBg, levelOf, levelSoft, levelText, useApi, useStored } from "../ui/lib"
import { Link, navigate, PageHeader } from "../ui/shell"
import { DiskCards, FileSystems } from "./disks"
import { FirewallPanel } from "./firewall"
import { ReposPanel } from "./repos"
import { HostLogs } from "./logs"
import { hostLevel } from "./overview"
import { VpnTable } from "./vpn"
import { HostServices } from "./services"
import { t, tn } from "../ui/i18n"
import { allTags, hasTag, splitTags, Tag, TagInput, TagList, tagOptions } from "../ui/tags"
import { axis, pointsOf } from "./metrics"

const KINDS = [{ value: "vm", label: "VM" }, { value: "lxc", label: "LXC container" }, { value: "physical", label: "Physical server" }, { value: "proxmox", label: "Physical server (Proxmox)" }, { value: "vps", label: "VPS" }]
const WATCH_CTS = "Manage LXC containers from this host"
const WATCH_CTS_HINT = "Every container gets the agent, installed from this host. OCI containers have no init: this host measures them. Unticking removes them from Nyx, with their history."
// The path keeps working where sudo does not search /usr/local/bin, as on RHEL.
const UNINSTALL = 'sudo "$(command -v nyx-agent)" uninstall'
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k

/** Older agents report containers as `vm`: their Proxmox parent or VMID tells them apart. */
export function hostType(h: any, hosts: any[]): string {
  const parent = hosts.find((p) => p.id === h.parent)
  const guest = guestOf(h, parent)
  return h.kind === "lxc" || (h.kind === "vm" && (h.vmid > 0 || guest?.kind === "lxc")) ? "ct" : h.kind
}

/** The Proxmox guest a host runs as: by the VMID the monitor tied it to, else by name. */
export const guestOf = (h: any, parent: any) => parent?.guests?.find((g: any) => (h.vmid > 0 && g.vmid === h.vmid) || (h.guest_vmid > 0 && g.vmid === h.guest_vmid) || g.name === h.name)

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
  return <span title={t(label)} role="img" aria-label={t(label)} className="inline-flex shrink-0 text-fg2"><I className="size-5" aria-hidden /></span>
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
    const guests = guestsOf(h).filter((g) => !children.some((c) => c.vmid === g.vmid || c.guest_vmid === g.vmid) && !hosts.some((c) => c.name === g.name || c.hostname === g.name))
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
export function useUpdatePolling(running: boolean, reload: () => void) {
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
      {u.error ? <p className="max-h-24 overflow-auto font-mono text-[13px] whitespace-pre-wrap text-crit">{u.error}</p> : !u.done && <p className="truncate text-[13px] text-fg3">{u.step ?? t("Waiting for the agent")}</p>}
    </li>
  )
}

/** Outside the board: it only exists while there is something to follow or to do. */
export function FleetUpdates({ hosts }: { hosts: any[] }) {
  const [seen, setSeen] = useStored("nyx.updates-seen", 0)
  const { run, done, pct, last } = updateRun(hosts, seen)
  const restart = hosts.filter((h) => h.reboot_required)
  if (!run.length && !restart.length) return null
  return (
    <div className="mb-4 flex flex-col gap-3">
      {restart.length > 0 && (
        <p role="note" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-panel border border-warn/25 bg-warn-soft px-4 py-2.5 text-[13px]">
          <ArrowPathIcon className="size-4 shrink-0 text-warn" aria-hidden />
          <span className="font-medium text-warn">{t("{n} to restart", { n: restart.length })}</span>
          {restart.map((h) => <Link key={h.id} to={`/hosts/${h.id}`} className="text-fg2 hover:text-accent">{h.name}</Link>)}
        </p>
      )}
      {run.length > 0 && <Panel title={t("Updates")}>
        <div className="flex flex-col gap-3">
          {run.length > 0 && <>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <span className="text-[26px] leading-8 font-medium">{pct} %</span>
              <span className="text-fg2">{t("{done} of {n} hosts finished", { done, n: run.length })}</span>
            </div>
            <Progress pct={pct} label={t("Progress of the update")} />
            <ul className="divide-y divide-line">{run.map((h) => <RunRow key={h.id} host={h} />)}</ul>
          </>}
          {run.length > 0 && done === run.length && <div><Button onClick={() => setSeen(last)}>{t("Hide results")}</Button></div>}
        </div>
      </Panel>}
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
    <span className="flex items-center gap-3"><span className={`${STEP} ${active ? "bg-accent text-accent-ink" : "bg-raised text-fg2"}`}>{n}</span>{t(title)}</span>
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
                      <I className="size-6" aria-hidden />{t(k.label)}
                    </label>
                  )
                })}
              </div>
              {(f.kind === "physical" || f.kind === "proxmox") && <p className="mt-2 text-xs text-fg3">{t("SMART monitoring is included; smartmontools is installed if missing.")}</p>}
            </fieldset>
            {nested && <Select label="Runs on" disabled={!!res} value={f.parent} onChange={(e) => setF({ ...f, parent: e.target.value })} options={[{ value: "", label: "Nothing (top level)" }, ...servers.map((h) => ({ value: h.id, label: `${h.name} (${h.kind === "proxmox" ? "Proxmox" : t("Physical")})` }))]} />}
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
                <Button variant="primary" onClick={() => navigate(`/hosts/${res.id}`)}>{t("Open {name}", { name: f.name })}</Button>
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

/** Search, type, state and tag together. A guest without an agent only shows on the unfiltered tree. */
export function filterHosts(hosts: any[], q: string, type: string, state: string, tag = "") {
  const n = q.trim().toLowerCase()
  return hosts.filter((h) =>
    (!n || [h.name, h.hostname, h.ip, h.os, ...splitTags(h.tags)].some((v) => String(v ?? "").toLowerCase().includes(n))) &&
    hasTag(h, tag) &&
    (!type || hostType(h, hosts) === type) &&
    (!state || (state === "problem" ? h.status === "warn" || h.status === "crit" : h.status === state)))
}

/** "Linux (Debian GNU/Linux 13)" reads as "Debian GNU/Linux 13". */
/** Parts of a line, between dots; empty ones are skipped. */
const dots = (parts: React.ReactNode[]) => parts.filter(Boolean).map((p, i) => <Fragment key={i}>{i > 0 && " · "}{p}</Fragment>)
/** An OS name after its logo, inside a line of text. */
const OsText = ({ os, name }: { os?: string; name: string }) => <><DistroIcon os={os} className="mr-1 size-3.5 align-[-2px]" />{name}</>

/**
 * The name shown in Nyx, renamed in place: Enter or leaving the field saves, Escape
 * cancels. The machine's hostname does not change.
 */
export function HostName({ h, onSaved, link = true, className = "" }: { h: any; onSaved: () => void; link?: boolean; className?: string }) {
  const [editing, setEditing] = useState(false)
  const done = useRef(false)
  const save = async (value: string) => {
    if (done.current) return
    done.current = true
    setEditing(false)
    const name = value.trim()
    if (!name || name === h.name) return
    try { await api(`/api/hosts/${h.id}`, { method: "PATCH", body: { name } }); onSaved() } catch (e) { tell((e as Error).message) }
  }
  if (editing) return (
    <input autoFocus defaultValue={h.name} aria-label={t("Name")} onFocus={(e) => e.currentTarget.select()} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Enter") save(e.currentTarget.value); if (e.key === "Escape") { done.current = true; setEditing(false) } }}
      onBlur={(e) => save(e.currentTarget.value)} className={`h-7 w-full min-w-0 rounded-md border border-accent bg-bg px-2 text-fg ${className}`} />
  )
  return (
    <span className={`group/name flex min-w-0 items-center gap-1 ${className}`}>
      {link ? <Link to={`/hosts/${h.id}`} className="truncate hover:text-accent">{h.name}</Link> : <span className="truncate">{h.name}</span>}
      <button type="button" aria-label={t("Rename")} title={t("Rename")} onClick={() => { done.current = false; setEditing(true) }}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg3 opacity-0 group-hover/name:opacity-100 group-hover/row:opacity-100 hover:bg-raised hover:text-fg focus-visible:opacity-100 pointer-coarse:opacity-100">
        <PencilIcon className="size-3.5" aria-hidden />
      </button>
    </span>
  )
}

/** The type's icon on a tile, its corner dot coloured by the state. */
function Avatar({ type, level }: { type: string; level: Level }) {
  const { icon: I = ServerIcon, label = type } = HOST_TYPES[type] ?? {}
  return (
    <span title={t(label)} className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-fg2">
      <I className="size-[18px]" aria-hidden />
      <span className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface ${levelBg[level]}`} aria-hidden />
    </span>
  )
}

/** A thin bar and its figure, coloured past the thresholds. */
function Bar({ pct, warn, crit, className = "" }: { pct?: number | null; warn?: number; crit?: number; className?: string }) {
  const l = pct == null ? "ok" : levelOf(pct, warn, crit)
  return (
    <span className={`items-center gap-2 ${className}`}>
      {pct == null ? <span className="text-fg3">—</span> : <>
        <span className="flex-1"><Meter pct={pct} warn={warn} crit={crit} /></span>
        <span className={`w-10 text-right text-xs tabular-nums ${l === "ok" ? "text-fg2" : levelText[l]}`}>{pct < 10 ? pct.toFixed(1) : pct.toFixed(0)} %</span>
      </>}
    </span>
  )
}

/** A small tinted mark with an icon and a count. Its title says what it counts. */
function Chip({ level, icon: I, label, to, children }: { level: Level; icon: Icon; label: string; to?: string; children?: React.ReactNode }) {
  const look = `inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium ${levelSoft[level]} ${levelText[level]}`
  const body = <><I className="size-3.5" aria-hidden />{children}<span className="sr-only">{label}</span></>
  return to ? <Link to={to} title={label} className={`${look} hover:brightness-125`}>{body}</Link> : <span title={label} className={look}>{body}</span>
}

/** Name, then address, CPU, memory, disk, temperature and what needs a look. Columns drop as the list narrows instead of spilling out. */
const COLS = "grid items-center gap-x-3 grid-cols-[minmax(0,1fr)_auto] @2xl:grid-cols-[minmax(0,1fr)_6rem_6rem_7.5rem] @4xl:grid-cols-[minmax(0,1fr)_6rem_6rem_6rem_3rem_7.5rem] @5xl:grid-cols-[minmax(0,1fr)_7rem_6rem_6rem_6rem_3rem_7.5rem]"
const AT = { address: "hidden @5xl:block", cpu: "hidden @2xl:flex", mem: "hidden @2xl:flex", disk: "hidden @4xl:flex", temp: "hidden @4xl:block" }

function Flags({ h }: { h: any }) {
  const level = hostLevel(h.status)
  return (
    <span className="flex flex-wrap items-center justify-end gap-1.5">
      {!h.installed ? <span className="text-xs text-fg3">{t(h.kind === "lxc" ? "Stopped" : "Waiting for install")}</span>
        : h.status === "off" ? <span className="text-xs font-medium text-off">{t("Offline")}</span>
        : (level === "warn" || level === "crit") && <Chip level={level} icon={ExclamationTriangleIcon} label={h.issues?.map((i: any) => tn(i.message)).join("\n") || t(level === "crit" ? "Critical" : "Warning")}>{h.issues?.length || ""}</Chip>}
      {h.services_failed > 0 && <Chip level="crit" icon={XCircleIcon} to={`/services?host=${h.id}`} label={t("{n} failed", { n: h.services_failed })}>{h.services_failed}</Chip>}
      {h.updates > 0 && <Chip level={h.security ? "crit" : "info"} icon={ArrowUpIcon} to="/updates" label={h.security ? t("{n} security fixes", { n: h.security }) : t("Pending updates")}>{h.updates}</Chip>}
      {h.reboot_required && <Chip level="warn" icon={ArrowPathIcon} label={t("Restart needed")} />}
      {h.muted && <BellSlashIcon className="size-4 text-fg3" aria-label={t("Excluded from alerts")} />}
    </span>
  )
}

/** The line from a parent down to its guests: └ for the last one, ├ above it. */
const Guide = ({ depth, last }: { depth: number; last: boolean }) => {
  const x = 64 + (depth - 1) * 64
  return <>
    <span aria-hidden className={`absolute top-0 w-px bg-line2/60 ${last ? "h-1/2" : "bottom-0"}`} style={{ left: x }} />
    <span aria-hidden className="absolute top-1/2 h-px w-3 bg-line2/60" style={{ left: x }} />
  </>
}

const goTo = (e: React.MouseEvent, to: string) => { if (!(e.target as HTMLElement).closest("a, button, input")) navigate(to) }

function HostRow({ r, last, all, th, open, onToggle, onSaved }: { r: TreeRow; last: boolean; all: any[]; th: any; open: boolean; onToggle: () => void; onSaved: () => void }) {
  const h = r.host
  const type = hostType(h, all)
  const on = h.status !== "off"
  return (
    <li className={`group/row relative ${COLS} min-h-14 cursor-pointer px-4 py-2 hover:bg-raised/50 ${r.depth === 0 && r.hasChildren ? "bg-raised/30" : ""}`} onClick={(e) => goTo(e, `/hosts/${h.id}`)}>
      {r.depth > 0 && <Guide depth={r.depth} last={last} />}
      <div className="flex min-w-0 items-center gap-3" style={{ paddingLeft: r.depth * 64 }}>
        {r.hasChildren && <button type="button" aria-label={t("Toggle children")} aria-expanded={open} className="flex size-5 shrink-0 items-center justify-center text-fg3 hover:text-fg" onClick={onToggle}><ChevronRightIcon className={`size-4 ${open ? "rotate-90" : ""}`} aria-hidden /></button>}
        <Avatar type={type} level={hostLevel(h.status)} />
        <div className="min-w-0 flex-1">
          <HostName h={h} onSaved={onSaved} className={`font-medium ${r.depth === 0 && r.hasChildren ? "text-[15px]" : ""}`} />
          <p className="truncate text-xs text-fg3">{dots([t(HOST_TYPES[type]?.label ?? h.kind), h.os && <OsText os={h.os} name={osName(h.os)} />, h.hostname && h.hostname !== h.name && h.hostname])}</p>
        </div>
      </div>
      <span className={`${AT.address} truncate font-mono text-[13px] text-fg2`}>{h.ip || "—"}</span>
      <Bar className={AT.cpu} pct={on ? h.cpu : null} warn={th.warn} crit={th.crit} />
      <Bar className={AT.mem} pct={on ? h.mem : null} warn={th.warn} crit={th.crit} />
      <Bar className={AT.disk} pct={on ? h.disk : null} warn={th.disk_warn ?? th.warn} crit={th.disk_crit ?? th.crit} />
      <span className={`${AT.temp} text-right text-xs tabular-nums ${h.temp >= (th.temp_crit ?? 90) ? "text-crit" : h.temp >= (th.temp_warn ?? 80) ? "text-warn" : "text-fg2"}`}>{on && h.temp != null ? fmt.temp(h.temp) : "—"}</span>
      <Flags h={h} />
    </li>
  )
}

/** A Proxmox guest without an agent: what Proxmox knows of it, and its console. */
function GuestRow({ r, last, pve }: { r: TreeRow; last: boolean; pve?: string }) {
  const g = r.guest
  const running = g.status === "running" && g.mem_total > 0
  const pct = (used: number, total: number) => (running && total ? (used / total) * 100 : null)
  return (
    <li className={`group/row relative ${COLS} min-h-14 px-4 py-2`}>
      <Guide depth={r.depth} last={last} />
      <div className="flex min-w-0 items-center gap-3" style={{ paddingLeft: r.depth * 64 }}>
        <Avatar type={g.kind === "lxc" ? "ct" : "vm"} level={g.status === "running" ? "info" : "off"} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-fg2">{g.name}</p>
          <p className="truncate text-xs text-fg3">{dots([t(g.kind === "lxc" ? "LXC container" : "VM"), distroName(g.os) && <OsText os={g.os} name={distroName(g.os)} />, g.vmid, t("no agent"), g.status !== "running" && t("Stopped")])}</p>
        </div>
      </div>
      <span className={`${AT.address} truncate font-mono text-[13px] text-fg3`}>{g.ip || "—"}</span>
      <Bar className={AT.cpu} pct={running ? g.cpu_pct : null} />
      <Bar className={AT.mem} pct={pct(g.mem_used, g.mem_total)} />
      <Bar className={AT.disk} pct={pct(g.disk_used, g.disk_total)} />
      <span className={`${AT.temp} text-right text-fg3`}>—</span>
      <span className="flex justify-end">{pve && <a className="text-xs font-medium text-accent hover:text-accent-hover" target="_blank" rel="noreferrer" href={consoleUrl(pve, r.parent, g)}>{t("Console")}</a>}</span>
    </li>
  )
}

/** One block per host that runs others, the host on top; hosts that run nothing share the last block. */
export function fleetGroups(rows: TreeRow[]) {
  const groups: { lead?: TreeRow; rows: TreeRow[] }[] = []
  const alone: TreeRow[] = []
  for (const r of rows) {
    if (r.depth === 0 && !r.hasChildren) alone.push(r)
    else if (r.depth === 0) groups.push({ lead: r, rows: [r] })
    else groups[groups.length - 1]?.rows.push(r)
  }
  if (alone.length) groups.push({ rows: alone })
  return groups
}

function FleetList({ rows, all, th, collapsed, onToggle, onSaved, pve }: { rows: TreeRow[]; all: any[]; th: any; collapsed: Set<string>; onToggle: (id: string) => void; onSaved: () => void; pve?: string }) {
  const head = (label: string, at = "", right = false) => <span className={`${at} ${right ? "text-right" : ""}`}>{t(label)}</span>
  return (
    <div className="@container flex flex-col gap-3">
      <div className={`${COLS} sticky top-14 z-[5] -mb-1 bg-bg/90 px-[17px] py-1.5 text-xs text-fg3 backdrop-blur max-sm:top-[calc(56px+env(safe-area-inset-top))]`} aria-hidden>
        {head("Host")}{head("Address", AT.address)}{head("CPU", AT.cpu)}{head("Memory", AT.mem)}{head("Disk", AT.disk)}{head("Temp.", AT.temp, true)}{head("State", "", true)}
      </div>
      {fleetGroups(rows).map((g) => (
        <section key={g.lead?.key ?? "alone"} aria-label={g.lead ? g.lead.host.name : t("Standalone hosts")} className="overflow-hidden rounded-panel border border-line bg-surface">
          {!g.lead && <h3 className="border-b border-line px-4 py-2 text-xs font-medium text-fg3">{t("Standalone hosts")} · {g.rows.length}</h3>}
          <ul className="divide-y divide-line">
            {g.rows.map((r, i) => {
              const last = !g.rows[i + 1] || g.rows[i + 1].depth < r.depth
              return r.host
                ? <HostRow key={r.key} r={r} last={last} all={all} th={th} open={!collapsed.has(r.host.id)} onToggle={() => onToggle(r.host.id)} onSaved={onSaved} />
                : <GuestRow key={r.key} r={r} last={last} pve={pve} />
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** One host as a card: state, the three gauges that matter, then traffic, heat and uptime. */
function HostCard({ h, all, th, onTag }: { h: any; all: any[]; th: any; onTag: (tag: string) => void }) {
  const off = h.status === "off"
  const gauge = (label: string, pct: number | null | undefined, warn = th.warn, crit = th.crit) => (
    <div className="grid grid-cols-[4.5rem_1fr_3rem] items-center gap-2 text-[13px]">
      <span className="text-fg2">{t(label)}</span>
      {off || pct == null ? <span className="text-fg3">—</span> : <Meter pct={pct} warn={warn} crit={crit} />}
      <span className="text-right tabular-nums text-fg2">{off ? "" : fmt.pct(pct)}</span>
    </div>
  )
  return (
    <li className="flex cursor-pointer flex-col gap-3 rounded-box border border-line bg-surface p-3 hover:border-accent" onClick={(e) => { if (!(e.target as HTMLElement).closest("a, button")) navigate(`/hosts/${h.id}`) }}>
      <div className="flex items-center gap-2">
        <span className={`size-2.5 shrink-0 rounded-full ${levelBg[hostLevel(h.status)]}`} aria-hidden />
        <HostIcon type={hostType(h, all)} />
        <Link to={`/hosts/${h.id}`} className="min-w-0 flex-1 truncate font-medium hover:text-accent">{h.name}</Link>
        <DistroIcon os={h.os} className="size-4 text-fg3" />
        {h.services_failed > 0 && <Status cell level="crit" label={t("{n} failed", { n: h.services_failed })} />}
        {h.updates > 0 && <span title={t("Pending updates")} className={`text-xs ${h.security ? "text-crit" : "text-fg2"}`}>↑{h.updates}</span>}
      </div>
      <div className="flex flex-col gap-1.5">
        {gauge("CPU", h.cpu)}
        {gauge("Memory", h.mem)}
        {gauge("Disk", h.disk, th.disk_warn ?? th.warn, th.disk_crit ?? th.crit)}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg2">
        {!off && <span title={t("Network")}>↓ {fmt.bps(h.rx)} · ↑ {fmt.bps(h.tx)}</span>}
        {h.temp != null && <span className={h.temp >= (th.temp_crit ?? 90) ? "text-crit" : h.temp >= (th.temp_warn ?? 80) ? "text-warn" : ""}>{fmt.temp(h.temp)}</span>}
        <span>{off ? t("Offline") : t("Up {time}", { time: fmt.uptime(h.uptime_s) })}</span>
      </div>
      {splitTags(h.tags).length > 0 && <TagList tags={h.tags} onPick={onTag} />}
    </li>
  )
}

const RANK: Level[] = ["crit", "warn", "off", "ok"]
/** One chip per tag with its hosts and their worst state: which group needs a look, at a glance. */
function TagHealth({ hosts, tags, value, onPick }: { hosts: any[]; tags: string[]; value: string; onPick: (tag: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-3">
      <span className="mr-1 text-[13px] text-fg2">{t("By tag")}</span>
      {tags.map((tag) => {
        const of = hosts.filter((h) => hasTag(h, tag))
        const worst = RANK.find((l) => of.some((h) => hostLevel(h.status) === l)) ?? "ok"
        return (
          <button key={tag} type="button" aria-pressed={value === tag} onClick={() => onPick(value === tag ? "" : tag)}
            className={`inline-flex h-8 items-center gap-2 rounded-control border px-2.5 text-[13px] ${value === tag ? "border-accent bg-accent-soft" : "border-line2 hover:border-accent"}`}>
            <Tag tag={tag} /><span className="text-fg2">{of.length}</span><Status cell level={worst} label="" />
          </button>
        )
      })}
    </div>
  )
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
  // `?tag=` comes from a tag clicked elsewhere, such as the overview.
  const [tag, setTag] = useState(() => new URLSearchParams(location.search).get("tag") ?? "")
  const [view, setView] = useStored("nyx.hosts.view", "list")
  const list = hosts.data ?? []
  const filtered = !!(q.trim() || type || state || tag)
  const updating = list.some((h) => h.update && !h.update.done)
  useUpdatePolling(updating, hosts.reload)
  const rows = buildTree(filterHosts(list, q, type, state, tag), (h) => (filtered ? [] : h.guests ?? []), collapsed)
  const toggle = (id: string) => { const s = new Set(collapsed); s.has(id) ? s.delete(id) : s.add(id); setCollapsed(s) }
  const online = list.filter((h) => h.status !== "off").length
  const problems = list.filter((h) => h.status === "warn" || h.status === "crit").length
  const updatable = list.filter((h) => h.status !== "off" && h.agent_version).length
  const updates = list.reduce((n, h) => n + (h.updates || 0), 0)
  const restart = list.filter((h) => h.reboot_required).length
  const guests = list.reduce((n, h) => n + buildTree([h], (x) => x.guests ?? [], new Set()).filter((r) => r.guest).length, 0)
  const types = [...new Set(list.map((h) => hostType(h, list)))]
  const tags = allTags(list)
  const updateAll = async () => {
    if (!await ask(t("Upgrade the packages of {updatable} online hosts and bring their agents up to date? Services can restart while packages are replaced. Hosts are not rebooted.", { updatable }), { action: "Update all" })) return
    setUpdateError("")
    try { await api("/api/hosts/update-all", { method: "POST" }); hosts.reload() } catch (e) { setUpdateError((e as Error).message) }
  }
  const kpi = (label: string, value: React.ReactNode, level?: Level, sub?: string) => <div className="px-4 py-3"><Stat label={label} value={value} level={level} sub={sub} /></div>
  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
      <section aria-label={t("Summary")} className={`rounded-panel border bg-surface ${edit ? "border-dashed border-line2" : "border-line"}`}>
        {edit && <div className="flex justify-end border-b border-line px-2">{edit}</div>}
        <div className="grid grid-cols-4 divide-x divide-line max-md:grid-cols-2 max-md:[&>*:nth-child(3)]:border-l-0">
          {kpi("Online", `${online} / ${list.length}`, online === list.length ? "ok" : "warn")}
          {kpi("Need attention", problems, problems ? "warn" : "ok")}
          {kpi("Pending updates", updates, updates ? "warn" : "ok", restart ? t("{n} to restart", { n: restart }) : undefined)}
          {kpi("Agent-less guests", guests)}
        </div>
        {tags.length > 0 && <div className="border-t border-line px-4 pb-3"><TagHealth hosts={list} tags={tags} value={tag} onPick={setTag} /></div>}
      </section>
    ) },
    { id: "fleet", title: "Fleet", render: (edit: any) => (
      <section aria-label={t("Fleet")} className={`flex flex-col gap-3 ${edit ? "rounded-panel border border-dashed border-line2 p-2" : ""}`}>
        {edit && <div className="flex justify-end">{edit}</div>}
        {list.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-72 max-sm:w-full">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-2 size-5 text-fg3" aria-hidden />
              <input type="search" aria-label={t("Search")} placeholder={t("Name, address or OS")} value={q} onChange={(e) => setQ(e.target.value)} className="h-9 max-sm:h-11 w-full rounded-control border border-line2 bg-surface pl-10 pr-3 placeholder:text-fg3 hover:border-fg3" />
            </div>
            <Variable label="Type" value={type} onChange={setType} options={[{ value: "", label: "All" }, ...types.map((t) => ({ value: t, label: HOST_TYPES[t]?.label ?? t }))]} />
            <Variable label="State" value={state} onChange={setState} options={STATES} />
            {tags.length > 0 && <Variable label="Tag" value={tag} onChange={setTag} options={tagOptions(tags)} />}
            {filtered && <span className="text-[13px] text-fg3">{t("{n} of {total}", { n: rows.filter((r) => r.host).length, total: list.length })}</span>}
            <div className="ml-auto max-sm:ml-0"><Tabs tabs={[{ id: "list", label: "List" }, { id: "cards", label: "Cards" }]} value={view === "cards" ? "cards" : "list"} onChange={setView} /></div>
          </div>
        )}
        {!hosts.data ? <Skeleton lines={8} /> : list.length === 0 ? <Empty>{t("No hosts yet. Add one to get an install command.")}</Empty> : rows.length === 0 ? <Empty>{t("No host matches.")}</Empty> : view === "cards" ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
            {rows.filter((r) => r.host).map((r) => <HostCard key={r.key} h={r.host} all={list} th={th} onTag={setTag} />)}
          </ul>
        ) : <FleetList rows={rows} all={list} th={th} collapsed={collapsed} onToggle={toggle} onSaved={hosts.reload} pve={proxmox.data?.url} />}
      </section>
    ) },
  ]
  return (
    <>
      <PageHeader title="Hosts" subtitle={t("{n} hosts", { n: list.length })} onRefresh={hosts.reload} actions={<><CustomizeButton /><Button disabled={!updatable} onClick={() => setBulkDns(true)}><GlobeAltIcon className="size-5" aria-hidden />{t("Change DNS")}</Button><Button disabled={updating || !updatable} onClick={updateAll}><ArrowPathIcon className="size-5" aria-hidden />{t("Update all")}</Button><Button variant="primary" onClick={() => navigate("/hosts/new")}><PlusIcon className="size-5" aria-hidden />{t("Add host")}</Button></>} />
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
    setRuns(chosen.map((h) => ({ host: h.id, name: h.name, output: t("Sending…") })))
    const sent = await Promise.all(chosen.map(async (h): Promise<DnsRun> => {
      try {
        const { id } = await api<{ id: string }>(`/api/hosts/${h.id}/command`, { method: "POST", body: { action: "set_dns", dns: servers } })
        return { host: h.id, name: h.name, id, output: t("Waiting for the agent…") }
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
          <legend className="mb-1 text-[13px] text-fg2">{t("Hosts")} · {t("{n} of {total}", { n: picked.size, total: hosts.length })}</legend>
          <div className="flex gap-3 text-[13px]">
            <button type="button" className="text-accent" onClick={() => setPicked(new Set(hosts.map((h) => h.id)))}>{t("All")}</button>
            <button type="button" className="text-accent" onClick={() => setPicked(new Set())}>{t("None")}</button>
          </div>
          <div className="grid max-h-56 grid-cols-2 overflow-y-auto max-sm:grid-cols-1">
            {hosts.map((h) => <Check key={h.id} label={<>{h.name}</>} hint={h.dns?.length ? h.dns.join(", ") : "System resolver"} checked={picked.has(h.id)} onChange={() => toggle(h.id)} />)}
          </div>
        </fieldset>
        <div><Button variant="primary" type="submit" disabled={!picked.size || pending}>{t("Apply to {n} hosts", { n: picked.size })}</Button></div>
      </form>
      {runs.length > 0 && (
        <div className="mt-4" role="status" aria-live="polite">
          <p className="mb-2 text-[13px] text-fg2">{t("{done} of {n} answered", { done, n: runs.length })}</p>
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
      <button type="button" aria-expanded={open} aria-haspopup="true" className="rounded-md hover:brightness-125" onClick={() => setOpen(!open)}><Status level={level} label={`${t(level === "crit" ? "Critical" : "Warning")} · ${issues.length}`} /></button>
      {open && (
        <ul className="absolute right-0 top-10 z-20 flex w-72 flex-col gap-1 rounded-panel border border-line2 bg-surface p-2">
          {issues.map((i) => <li key={i.message} className={`flex items-start gap-2 rounded-control px-2 py-1.5 text-[13px] ${levelSoft[i.level]}`}><Status cell level={i.level} label="" /><span className="text-fg">{tn(i.message)}</span></li>)}
        </ul>
      )}
    </div>
  )
}

/** A chart with its title and what it shows, as one card of a grid. */
function ChartCard({ title, about, children }: { title: string; about: string; children: React.ReactNode }) {
  return (
    <section aria-label={t(title)} className="min-w-0 rounded-box border border-line p-3">
      <h3 className="font-medium">{t(title)}</h3>
      <p className="mb-2 text-xs text-fg3">{t(about)}</p>
      {children}
    </section>
  )
}

/** The line under a host's name: what it is at a glance, each fact with its icon. */
function HostFacts({ h }: { h: any }) {
  const fact = (I: Icon, text: React.ReactNode, title: string) => text ? <span className="inline-flex items-center gap-1.5" title={t(title)}><I className="size-4 shrink-0 text-fg3" aria-hidden />{text}</span> : null
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
      {fact(ClockIcon, h.status === "off" ? t("Offline") : t("Up {time}", { time: fmt.uptime(h.uptime_s) }), "Uptime")}
      {fact(GlobeAltIcon, h.ip && <Mono>{h.ip}</Mono>, "Address")}
      {fact(ServerIcon, h.hostname !== h.name && h.hostname, "Hostname")}
      {fact(distroOf(h.os) ? (p) => <DistroIcon os={h.os} {...p} /> : ComputerDesktopIcon, osName(h.os) || t("waiting for first report"), "System")}
      {fact(CpuChipIcon, [h.kernel, h.arch].filter(Boolean).join(" · "), "Kernel")}
      {fact(CommandLineIcon, h.agent_version && `${t("Agent")} ${h.agent_version}`, "Agent")}
      {h.services_total > 0 && <Link to={`/services?host=${h.id}`} className={`inline-flex items-center gap-1.5 hover:text-accent ${h.services_failed ? "text-crit" : ""}`}><QueueListIcon className="size-4 shrink-0" aria-hidden />{h.services_failed ? t("{n} services, {f} failed", { n: h.services_total, f: h.services_failed }) : t("{n} services", { n: h.services_total })}</Link>}
    </span>
  )
}

export function HostDetail({ id }: { id: string }) {
  const [range, setRange] = useState("1h")
  const { data: h, reload, error } = useApi(`/api/hosts/${id}`)
  const series = useApi<any[]>(`/api/series?range=${range}&host=${id}`)
  const proxmox = useApi("/api/settings/proxmox", { poll: false })
  const all = useApi<any[]>("/api/hosts", { poll: false }).data ?? []
  const [install, setInstall] = useState(false)
  const [note, setNote] = useState("")
  const [removing, setRemoving] = useState(false)
  const updating = !!h?.update && !h.update.done
  useUpdatePolling(updating, reload)
  if (error) return <p role="alert" className="text-crit">{error}</p>
  if (!h) return <PageSkeleton />

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
  const parent = all.find((p) => p.id === h.parent)
  // A VM with its own agent opens its noVNC console through the guest it runs as.
  const consoleLink = consoleUrl(proxmox.data?.url ?? "", h, h.kind === "vm" && !h.vmid ? guestOf(h, parent) : undefined)
  const points = series.data ?? []
  const saveTags = async (tags: string[]) => {
    try { await api(`/api/hosts/${id}`, { method: "PATCH", body: { tags } }); reload() } catch (e) { setNote((e as Error).message) }
  }
  const net = axis("rx", [...pointsOf(points, "rx"), ...pointsOf(points, "tx")].map((p) => p.v))
  const temps = pointsOf(points, "temp")
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
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-4">
          <ChartCard title="CPU" about="Average use of all cores."><TimeSeries compact series={[{ name: t("CPU"), color: "var(--color-s1)", values: pointsOf(points, "cpu") }]} /></ChartCard>
          <ChartCard title="Memory" about="Share of memory in use, cache left out."><TimeSeries compact series={[{ name: t("Memory"), color: "var(--color-s2)", values: pointsOf(points, "mem") }]} /></ChartCard>
          <ChartCard title="Disk" about="The fullest file system at each moment."><TimeSeries compact series={[{ name: t("Fullest disk"), color: "var(--color-s3)", values: pointsOf(points, "disk") }]} /></ChartCard>
          <ChartCard title="Bandwidth" about="Traffic of the physical interfaces."><TimeSeries compact fill={false} max={net.max} format={net.format} series={[{ name: t("Received"), color: "var(--color-s1)", values: pointsOf(points, "rx") }, { name: t("Sent"), color: "var(--color-s4)", values: pointsOf(points, "tx") }]} /></ChartCard>
          <ChartCard title="Temperature" about="The hottest sensor.">{temps.length ? <TimeSeries compact {...axis("temp", temps.map((p) => p.v))} series={[{ name: t("Temperature"), color: "var(--color-s3)", values: temps }]} /> : <Empty>{t("No sensor reported.")}</Empty>}</ChartCard>
        </div>
      </Panel>
    ) },
    { id: "services", title: "Services", absent: watched, render: (edit: any) => <HostServices host={h} edit={edit} /> },
    { id: "details", title: "Details", render: (edit: any) => {
      // Who the host is first, then its figures as small tiles.
      const facts: [string, React.ReactNode, boolean?][] = [
        ["Hostname", <Mono>{h.hostname || "—"}</Mono>],
        ["Address", <Mono>{h.ip || "—"}</Mono>],
        ["Type", t(HOST_TYPES[hostType(h, all)]?.label ?? kindLabel(h.kind))],
        ...(parent ? [["Runs on", <Link to={`/hosts/${parent.id}`} className="text-accent">{parent.name}</Link>] as [string, React.ReactNode]] : []),
        ["Up for", h.status === "off" ? "—" : fmt.uptime(h.uptime_s)],
        ["Last report", h.last_seen ? fmt.ago(h.last_seen) : t("Never")],
        ["System", h.os || h.kernel ? <OsText os={h.os} name={[osName(h.os), h.kernel, h.arch].filter(Boolean).join(" · ")} /> : "—", true],
      ]
      const tiles: [string, React.ReactNode, Level?][] = [
        ["Swap", fmt.pct(h.swap), levelOf(h.swap)],
        ["Temperature", fmt.temp(h.temp)],
        ["Containers", h.containers_total ? `${h.containers_running}/${h.containers_total}` : "—"],
        ["Received", fmt.bps(h.rx)],
        ["Sent", fmt.bps(h.tx)],
        ["Agent", h.agent_version || "—", h.agent_outdated ? "warn" : undefined],
      ]
      return (
        <Panel title={t("Details")} edit={edit}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
            {facts.map(([label, value, wide]) => <div key={label} className={`min-w-0 ${wide ? "col-span-full" : ""}`}><dt className="text-xs text-fg3">{t(label)}</dt><dd className="truncate" title={typeof value === "string" ? value : undefined}>{value}</dd></div>)}
          </dl>
          <dl className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded-box border border-line bg-line max-sm:grid-cols-2">
            {tiles.map(([label, value, level]) => <div key={label} className="bg-surface px-3 py-2" title={label === "Agent" && h.agent_outdated ? t("A newer agent exists") : undefined}><dt className="text-xs text-fg3">{t(label)}</dt><dd className={`font-medium tabular-nums ${level && level !== "ok" ? levelText[level] : ""}`}>{value}</dd></div>)}
          </dl>
          <div className="mt-4"><TagInput label="Tags" value={splitTags(h.tags)} onChange={saveTags} known={allTags(all)} hint="Group hosts to filter them, chart them together and update them together." /></div>
        </Panel>
      )
    } },
    { id: "logs", title: "Logs", absent: watched, render: (edit: any) => <HostLogs id={id} lines={h.logs} edit={edit} /> },
    { id: "disks", title: "File systems", render: (edit: any) => (
      <Panel title={t("File systems")} flush edit={edit}>
        {h.disks?.length ? <FileSystems rows={h.disks.map((d: any) => ({ ...d, pct: (d.used / d.total) * 100 }))} /> : <div className="px-4 pb-4"><Empty>{t("No data yet.")}</Empty></div>}
      </Panel>
    ) },
    { id: "smart", title: "Physical disks", absent: !physical, render: (edit: any) => (
      <Panel title={t("Physical disks")} edit={edit} help="Attention from 20 % life left or any bad sector, critical from 10 % or a failed self-assessment.">
        {h.smart?.length ? <DiskCards disks={h.smart} /> : <Empty>{t("No SMART data yet.")}</Empty>}
      </Panel>
    ) },
    { id: "containers", title: "Containers", absent: !h.containers?.length, render: (edit: any) => (
      <Panel title={t("Containers")} flush edit={edit}>
        <Table head={["Name", "Status", "State"]}>
          {h.containers?.map((c: any) => <tr key={c.name}><Td mono>{c.name}</Td><Td className="text-fg2">{tn(c.status)}</Td><StateCell level={c.state === "running" ? "ok" : "off"} label={c.state} /></tr>)}
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
        {h.node?.version && <p className="text-fg2">Node.js <Mono>{h.node.version}</Mono></p>}
        {h.node?.apps.map((a: any) => <p key={a.path} className="mt-2">{a.name} <Mono className="text-fg3">{a.path}</Mono>{a.manager && <span className="ml-2 text-fg3">{a.manager}</span>}</p>)}
      </Panel>
    ) },
    { id: "updates", title: "Updates", absent: watched, render: (edit: any) => (
      <Panel title={t("Updates")} edit={edit}>
        {updating && (
          <div className="mb-4 flex flex-col gap-2">
            <Progress pct={h.update.pct} label={t("Update of {name}", { name: h.name })} />
            <p role="status" className="truncate text-[13px] text-fg2">{h.update.pct} % · {h.update.step ?? t("Waiting for the agent")}</p>
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
            <Button onClick={() => setInstall(!install)}>{t(install ? "Hide install command" : "Show install command")}</Button>
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
        title={<HostName h={h} onSaved={reload} link={false} />}
        crumbs={[{ label: "Hosts", to: "/hosts" }, { label: <>{h.name}</> }]}
        subtitle={<HostFacts h={h} />}
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
        desktop={{ cols: [["details", "usage", "history", "services", "logs"], ["disks", "smart", "containers", "vpn", "firewall", "node", "updates", "agent"]], hidden: [] }}
        phone={{ cols: [["details", "usage", "services", "disks", "smart", "containers", "vpn", "firewall", "logs", "history", "node", "updates", "agent"]], hidden: [] }} />
      {removing && (
        <Modal title={t("Delete {name}", { name: h.name })} onClose={() => setRemoving(false)}>
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

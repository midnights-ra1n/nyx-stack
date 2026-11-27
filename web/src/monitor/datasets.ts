// Rows of the monitor that dashboard charts read. Every one comes from an endpoint the
// pages already use, so a card costs the server nothing it does not already do. Host
// metrics over time are also drawn by the simpler "Metrics over time" cards (metric-chart.tsx).
import type { Dataset, Field, Row } from "../ui/chart/data"
import { sharedGet } from "../ui/lib"
import { parseLog } from "./logs"

const text = (key: string, label: string): Field => ({ key, label, kind: "text" })
const date = (key: string, label: string): Field => ({ key, label, kind: "date" })
const bool = (key: string, label: string): Field => ({ key, label, kind: "bool" })
const num = (key: string, label: string, format?: Field["format"]): Field => ({ key, label, kind: "number", format })
const tags: Field = { key: "tags", label: "Tags", kind: "tags" }
const host = text("host", "Host")
const KIND: Record<string, string> = { vm: "VM", lxc: "LXC container", physical: "Physical server", proxmox: "Proxmox", vps: "VPS" }
const GUEST: Record<string, string> = { qemu: "VM", lxc: "LXC container" }
const STATE: Record<string, string> = { ok: "OK", warn: "Warning", crit: "Critical", off: "Offline", info: "Running" }
const LEVEL: Record<string, string> = { crit: "Error", warn: "Warning", info: "Info" }
const hosts = () => sharedGet<Row[]>("/api/hosts")
const probes = () => sharedGet<Row[]>("/api/probes")
const toHost = (r: Row) => (r.host_id ? `/hosts/${r.host_id}` : undefined)
const pct = (used: unknown, total: unknown) => (Number(total) > 0 ? (Number(used) * 100) / Number(total) : null)
const HOURS: Record<string, number> = { "1h": 1, "24h": 24, "7d": 168, "30d": 720, "90d": 2160, "180d": 4320, "365d": 8760 }
const since = (range: string) => new Date(Date.now() - (HOURS[range] ?? 24) * 36e5).toISOString().replace("T", " ")
/** The server charts at most this many hosts or probes at once. */
const MAX_SERIES = 24

/** Every record of a collection matching `filter`, page after page. */
async function pages(coll: string, filter: string, sort = "-created"): Promise<Row[]> {
  const rows: Row[] = []
  for (let page = 1; page <= 10; page++) {
    const res = await sharedGet<{ items: Row[]; totalPages: number }>(`/api/c/${coll}?perPage=500&page=${page}&sort=${sort}&filter=${encodeURIComponent(filter)}`)
    rows.push(...res.items)
    if (page >= (res.totalPages || 1)) break
  }
  return rows
}

/** The full record of each host `pick` keeps, with what the list leaves out: packages, firewall. */
// shortcut: one request per host on each refresh; give the server a fleet-wide endpoint if homelabs grow past ~50 hosts.
async function details(pick: (h: Row) => boolean): Promise<Row[]> {
  return Promise.all((await hosts()).filter(pick).map((h) => sharedGet<Row>(`/api/hosts/${h.id}`)))
}
const reporting = (h: Row) => h.status !== "off" && !!h.agent_version

/** One row per item of a list each host holds, with the host's name, id and tags. */
const perHost = (list: Row[], key: string, map: (x: Row, h: Row) => Row = (x) => x) =>
  list.flatMap((h) => (Array.isArray(h[key]) ? (h[key] as Row[]) : []).map((x) => ({ ...map(x, h), host: h.name, host_id: h.id, tags: h.tags })))

export const DATASETS: Dataset[] = [
  {
    id: "hosts", label: "Hosts", hint: "Each host with its type, state, latest load, updates and tags.", name: "name",
    link: (r) => `/hosts/${r.id}`,
    fields: [text("name", "Name"), text("type", "Type"), text("state", "State"), text("os", "System"), text("kernel", "Kernel"), text("arch", "Architecture"),
      text("ip", "Address"), text("runs_on", "Runs on"), num("cpu", "CPU", "pct"), num("mem", "Memory", "pct"),
      num("swap", "Swap", "pct"), num("disk", "Fullest disk", "pct"), num("temp", "Temperature", "temp"), num("uptime_s", "Uptime", "duration"),
      num("rx", "Network in", "bps"), num("tx", "Network out", "bps"), num("updates", "Updates"), num("security", "Security updates"),
      num("containers_running", "Running containers"), num("containers_total", "Containers"), num("services_running", "Running services"),
      num("services_total", "Services"), num("services_failed", "Failed services"), num("guest_count", "Proxmox guests"), num("issue_count", "Problems"),
      text("agent_version", "Agent version"), bool("agent_outdated", "Agent to update"), bool("reboot_required", "Restart required"),
      bool("muted", "Kept out of alerts"), bool("mcp_hidden", "Hidden from MCP"), date("last_seen", "Last report"), tags],
    load: async () => {
      const list = await hosts()
      return list.map((h) => ({
        ...h, type: KIND[String(h.kind)] ?? h.kind, state: STATE[String(h.status)] ?? h.status,
        runs_on: list.find((p) => p.id === h.parent)?.name ?? "", guest_count: (h.guests as Row[])?.length ?? 0, issue_count: (h.issues as Row[])?.length ?? 0,
      }))
    },
  },
  {
    id: "metrics", label: "Host metrics over time", hint: "CPU, memory, disk, temperature and network of each host, point by point over the period.", timed: true, name: "host",
    fields: [date("t", "Time"), host, text("type", "Type of host"), num("cpu", "CPU", "pct"), num("mem", "Memory", "pct"), num("disk", "Fullest disk", "pct"),
      num("temp", "Temperature", "temp"), num("rx", "Network in", "bps"), num("tx", "Network out", "bps"), tags],
    load: async (range) => {
      const list = (await hosts()).filter((h) => h.installed)
      // shortcut: reads the first 24 hosts, as the server charts no more at once; a filter on tags or type picks among those only. Pass the filters to the server if fleets grow past that.
      const series = await sharedGet<Record<string, Row[]>>(`/api/series?range=${range}&hosts=${list.slice(0, MAX_SERIES).map((h) => h.id).join(",")}`)
      return list.flatMap((h) => (series[String(h.id)] ?? []).map((p) => ({ ...p, host: h.name, type: KIND[String(h.kind)] ?? h.kind, tags: h.tags })))
    },
  },
  {
    id: "fleet", label: "Fleet load over time", hint: "Average CPU and memory of every host reporting, over the period.", timed: true,
    fields: [date("t", "Time"), num("cpu", "CPU", "pct"), num("mem", "Memory", "pct")],
    load: (range) => sharedGet<Row[]>(`/api/series?range=${range}`),
  },
  {
    id: "issues", label: "Host problems", hint: "What each host has wrong right now, as its page lists it: full disk, high load, failed service…", name: "message",
    link: toHost,
    fields: [text("message", "Problem"), host, text("level", "Severity"), text("type", "Type of host"), tags],
    load: async () => perHost(await hosts(), "issues", (x, h) => ({ ...x, level: STATE[String(x.level)] ?? x.level, type: KIND[String(h.kind)] ?? h.kind })),
  },
  {
    id: "guests", label: "Proxmox guests", hint: "Every VM and container a Proxmox host runs, with or without an agent inside.", name: "name",
    link: toHost,
    fields: [text("name", "Name"), num("vmid", "VMID"), text("type", "Type"), text("status", "State"), text("host", "Proxmox host"), text("node", "Proxmox node"),
      text("os", "System"), text("ip", "Address"), num("cpu_pct", "CPU", "pct"), num("mem_used", "Memory used", "bytes"), num("mem_pct", "Memory", "pct"),
      num("disk_used", "Disk used", "bytes"), num("disk_total", "Disk size", "bytes"), num("disk_pct", "Disk", "pct"), num("uptime_s", "Uptime", "duration"),
      num("rx_bps", "Network in", "bps"), num("tx_bps", "Network out", "bps"), bool("oci", "OCI container")],
    load: async () => perHost(await hosts(), "guests", (g) => ({ ...g, type: GUEST[String(g.kind)] ?? g.kind, mem_pct: pct(g.mem_used, g.mem_total), disk_pct: pct(g.disk_used, g.disk_total) })),
  },
  {
    id: "updates", label: "Pending updates", hint: "Each package waiting for an update on each host, security fixes marked.", name: "name",
    link: toHost,
    fields: [text("name", "Package"), text("version", "New version"), host, bool("security", "Security fix"), text("type", "Type of host"), tags],
    load: async () => perHost(await details((h) => Number(h.updates) > 0), "update_list", (u, h) => ({ ...u, type: KIND[String(h.kind)] ?? h.kind })),
  },
  {
    id: "containers", label: "Containers", hint: "Docker containers of every host, with their state and what they use.", name: "name",
    link: toHost,
    fields: [text("name", "Name"), host, text("image", "Image"), text("state", "State"), text("status", "Detail"), num("cpu_pct", "CPU", "pct"),
      num("mem_used", "Memory", "bytes"), num("mem_limit", "Memory limit", "bytes"), num("mem_pct", "Memory of its limit", "pct")],
    load: () => sharedGet<Row[]>("/api/containers"),
  },
  {
    id: "services", label: "Services", hint: "systemd services of every host, their state and what they use.", name: "name",
    link: toHost,
    fields: [text("name", "Name"), host, text("description", "Description"), text("active", "State"), text("sub", "Detail"), text("result", "Result"),
      text("enabled", "At boot"), text("kind", "Kind"), date("since", "In this state since"), num("cpu_pct", "CPU", "pct"), num("mem", "Memory", "bytes"),
      num("restarts", "Restarts")],
    load: () => sharedGet<Row[]>("/api/services"),
  },
  {
    id: "storage", label: "File systems", hint: "Each mounted file system with its host, type, size and use.", name: "mount",
    link: toHost,
    fields: [text("mount", "Mount point"), host, text("fs", "File system"), text("device", "Device"), num("used", "Used", "bytes"), num("free", "Free", "bytes"),
      num("total", "Size", "bytes"), num("pct", "Used", "pct"), bool("online", "Host online")],
    load: async () => ((await sharedGet<{ disks: Row[] }>("/api/storage")).disks).map((d) => ({ ...d, free: Number(d.total) - Number(d.used) })),
  },
  {
    id: "disks", label: "Physical disks", hint: "What SMART says of each physical disk: health, life left, temperature and wear.", name: "model",
    link: toHost,
    fields: [text("model", "Model"), host, text("device", "Device"), text("kind", "Kind"), text("health", "Health"), num("life_left_pct", "Life left", "pct"),
      num("temp_c", "Temperature", "temp"), num("powered_s", "Powered on", "duration"), num("bad_sectors", "Bad sectors"), num("power_cycles", "Power cycles"),
      num("written_bytes", "Written", "bytes"), num("capacity", "Size", "bytes"), text("serial", "Serial"), text("reason", "Reason")],
    load: async () => ((await sharedGet<{ smart: Row[] }>("/api/storage")).smart).map((d) => ({
      ...d, health: { ok: "Healthy", warn: "Attention", crit: "Critical" }[String(d.health)] ?? d.health, powered_s: d.power_on_hours == null ? null : Number(d.power_on_hours) * 3600,
    })),
  },
  {
    id: "ports", label: "Listening ports", hint: "Each port a host listens on, with the program behind it or the container that publishes it.", name: "process",
    link: toHost,
    fields: [num("port", "Port"), text("proto", "Protocol"), text("addr", "Address"), text("process", "Program"), host, bool("docker", "Published by Docker")],
    load: async () => perHost((await details(reporting)).map((h) => ({ ...h, listening: (h.firewall as Row | null)?.listening ?? [] })), "listening"),
  },
  {
    id: "firewall", label: "Firewall rules", hint: "The incoming rules of each host's firewall, as ufw, firewalld or iptables hold them.", name: "port",
    link: toHost,
    fields: [text("action", "Action"), text("port", "Port"), text("proto", "Protocol"), text("source", "From"), text("iface", "Interface"),
      text("family", "IP version"), text("chain", "Chain"), text("comment", "Comment"), text("backend", "Firewall"), host],
    load: async () => perHost((await details(reporting)).map((h) => {
      const fw = h.firewall as Row | null
      return { ...h, rules: ((fw?.rules as Row[]) ?? []).map((r) => ({ ...r, backend: fw?.backend })) }
    }), "rules"),
  },
  {
    id: "vpn", label: "VPN tunnels", hint: "Tailscale, NetBird, WireGuard and other tunnels of each host, with their traffic.", name: "iface",
    link: toHost,
    fields: [text("iface", "Interface"), text("kind", "VPN"), host, text("ip", "Address"), bool("up", "Up"), num("rx_bps", "Network in", "bps"),
      num("tx_bps", "Network out", "bps"), date("seen", "Last up"), tags],
    load: async () => perHost(await hosts(), "vpn"),
  },
  {
    id: "probes", label: "Probes", hint: "Ping, website, DNS, certificate and SNMP probes with their state, response time and 90-day uptime.", name: "name",
    link: () => "/network",
    fields: [text("name", "Name"), text("type", "Type"), text("state", "State"), text("category", "Category"), text("target", "Target"), text("message", "Message"),
      num("latency_ms", "Response time (ms)"), num("uptime_90d", "Uptime, 90 days", "pct"), num("recent", "Recent uptime", "pct"), num("cert_days", "Certificate days left"),
      num("warn_days", "Certificate warning (days)"), num("interval_s", "Interval (s)"), bool("muted", "Kept out of alerts"), bool("mcp_hidden", "Hidden from MCP")],
    load: async () => {
      const [list, cats, defs] = await Promise.all([probes(), sharedGet<{ items: Row[] }>("/api/c/probe_categories?perPage=200"), sharedGet<{ items: Row[] }>("/api/c/probes?perPage=500")])
      const category = (id: unknown) => cats.items.find((c) => c.id === defs.items.find((d) => d.id === id)?.category)?.name ?? ""
      const recent = (h: unknown) => (Array.isArray(h) && h.length ? (h.filter(Boolean).length * 100) / h.length : null)
      return list.map((p) => ({ ...p, state: p.up == null ? "Pending" : p.up ? "Up" : "Down", recent: recent(p.history), category: category(p.id) }))
    },
  },
  {
    id: "probe_series", label: "Probe response time over time", hint: "Response time of each probe, point by point over the period.", timed: true, name: "probe",
    fields: [date("t", "Time"), text("probe", "Probe"), text("type", "Type"), num("v", "Response time (ms)")],
    load: async (range) => {
      const list = (await probes()).slice(0, MAX_SERIES)
      const series = await Promise.all(list.map((p) => sharedGet<Row[]>(`/api/probes/${p.id}/series?range=${range}`)))
      return list.flatMap((p, i) => series[i].map((pt) => ({ ...pt, probe: p.name, type: p.type })))
    },
  },
  {
    id: "probe_days", label: "Probe uptime per day", hint: "Share of successful checks of each probe, day by day over the last 90 days.", name: "probe",
    fields: [date("day", "Day"), text("probe", "Probe"), text("type", "Type"), num("uptime", "Uptime", "pct")],
    load: async () => {
      const today = new Date()
      today.setHours(12, 0, 0, 0)
      return (await probes()).flatMap((p) => {
        const days = (p.days as (number | null)[]) ?? []
        // Oldest first, today last; a day without checks is left out rather than counted as down.
        return days.flatMap((v, i) => (v == null ? [] : [{ day: today.getTime() - (days.length - 1 - i) * 864e5, probe: p.name, type: p.type, uptime: v }]))
      })
    },
  },
  {
    id: "snmp", label: "SNMP readings", hint: "The latest value of each reading of the SNMP probes: traffic, temperatures, ink, battery…", name: "label",
    link: () => "/network",
    fields: [text("label", "Reading"), text("probe", "Probe"), num("value", "Value"), text("unit", "Unit"), text("text", "Text"), text("level", "State")],
    load: async () => (await probes()).flatMap((p) => ((p.readings as Row[]) ?? []).map((r) => ({ ...r, probe: p.name, level: STATE[String(r.level)] ?? r.level }))),
  },
  {
    id: "alerts", label: "Alerts", hint: "Alerts opened over the period, open or resolved, with how long they lasted. Resolved ones are kept 90 days.", timed: true, name: "message",
    fields: [text("message", "Alert"), host, text("severity", "Severity"), text("type", "Type"), bool("open", "Open"),
      date("created", "Opened"), date("resolved_at", "Resolved"), num("duration", "Lasted", "duration")],
    load: async (range) => {
      const at = (v: unknown) => (typeof v === "string" && v ? Date.parse(v.replace(" ", "T")) : NaN)
      return (await pages("alerts", `created>="${since(range)}"`)).map((a) => ({ ...a, severity: STATE[String(a.severity)] ?? a.severity, duration: ((a.open ? Date.now() : at(a.resolved_at)) - at(a.created)) / 1000 || null }))
    },
  },
  {
    id: "notifications", label: "Notifications sent", hint: "Every notification Nyx sent over the period: what about, for which host and how serious.", timed: true, name: "title",
    fields: [text("title", "Title"), text("message", "Message"), host, text("type", "About"), text("severity", "Severity"), date("created", "Sent")],
    load: async (range) => (await pages("notif_events", `created>="${since(range)}"`)).map((n) => ({ ...n, severity: STATE[String(n.severity)] ?? n.severity })),
  },
  {
    id: "logs", label: "Log lines", hint: "Warnings and errors of every host, the last 500 lines per host kept in memory.", name: "message",
    fields: [date("t", "Time"), text("level", "Level"), text("service", "Service"), host, text("message", "Message")],
    load: async () => (await sharedGet<{ line: string; host: string }[]>("/api/logs?host=&q=")).map((l) => {
      const r = parseLog(l.line, l.host)
      return { ...r, level: LEVEL[r.level] ?? r.level }
    }),
  },
  {
    id: "pipelines", label: "Pipelines", hint: "Each CI pipeline watched, with the state of its latest run.", name: "name",
    link: () => "/pipelines",
    fields: [text("name", "Name"), text("provider", "Forge"), text("repo", "Repository"), text("branch", "Branch"), text("state", "State"), text("status", "Detail"),
      text("sha", "Commit"), date("at", "Last run"), num("runs_ok", "Successful runs"), num("runs_failed", "Failed runs"), text("error", "Error")],
    load: async () => (await sharedGet<Row[]>("/api/pipelines")).map((p) => {
      const runs = (p.runs as Row[]) ?? []
      return { ...p, state: STATE[String(p.state)] ?? p.state, runs_ok: runs.filter((r) => r.state === "ok").length, runs_failed: runs.filter((r) => r.state === "crit").length }
    }),
  },
  {
    id: "runs", label: "Pipeline runs", hint: "The recent runs of every pipeline, one row each, to count successes and failures over time.", name: "pipeline",
    link: () => "/pipelines",
    fields: [date("at", "Started"), text("pipeline", "Pipeline"), text("branch", "Branch"), text("state", "State"), text("status", "Detail"), text("sha", "Commit")],
    load: async () => (await sharedGet<Row[]>("/api/pipelines")).flatMap((p) => ((p.runs as Row[]) ?? []).map((r) => ({ ...r, pipeline: p.name, branch: p.branch, state: STATE[String(r.state)] ?? r.state }))),
  },
  {
    id: "power", label: "Power plugs", hint: "What each Meross plug draws now, in watts.", name: "name",
    fields: [text("name", "Plug"), num("watts", "Power (W)")],
    load: async () => (await sharedGet<{ plugs: Row[] }>("/api/integrations/power")).plugs,
  },
  {
    id: "tempo", label: "EDF Tempo days left", hint: "Blue, white and red days left in the Tempo season, as RTE publishes them.", name: "colour",
    fields: [text("colour", "Colour"), num("left", "Days left"), num("quota", "Days in the season"), num("used", "Days used")],
    load: async () => {
      const v = await sharedGet<{ configured?: boolean; remaining?: Record<string, number> }>("/api/integrations/tempo")
      if (!v.remaining) return []
      // The season's quotas, fixed by the tariff.
      return ([["blue", "Blue", 300], ["white", "White", 43], ["red", "Red", 22]] as const).map(([k, colour, quota]) => ({ colour, quota, left: v.remaining![k], used: quota - v.remaining![k] }))
    },
  },
]

#!/usr/bin/env node
// A simulated homelab for trying the UI: creates hosts on a running monitor, then sends
// signed reports for each, like real agents. Links the manager too when it runs.
//   node dev/fake-agents.mjs [monitor URL] [manager URL]
// Sign-in: NYX_SIM_EMAIL / NYX_SIM_PASSWORD (default admin@nyx.local / dev-password-123).
// Tokens are kept in dev/.sim-hosts.json, so a second run reuses the same hosts.
import { createHmac } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

const MONITOR = (process.argv[2] ?? "http://127.0.0.1:8081").replace(/\/$/, "")
const MANAGER = (process.argv[3] ?? "http://127.0.0.1:8082").replace(/\/$/, "")
const EMAIL = process.env.NYX_SIM_EMAIL ?? "admin@nyx.local"
const PASSWORD = process.env.NYX_SIM_PASSWORD ?? "dev-password-123"
const STATE = new URL(".sim-hosts.json", import.meta.url)
const VERSION = process.env.NYX_SIM_AGENT ?? "0.1.0"
const GB = 1024 ** 3

// name, kind, parent, then what the host runs. `pve`: its name in Proxmox, when not the same.
const FLEET = [
  { name: "pve-atlas", kind: "proxmox", ip: "10.0.10.2", cores: 16, mem: 128, temp: 54, smart: true },
  { name: "nextcloud", kind: "vm", parent: "pve-atlas", ip: "10.0.10.20", mem: 8, updates: 4, reboot: true, docker: ["nextcloud", "nextcloud-db", "redis"], os: "Ubuntu 24.04.3 LTS" },
  // Named differently in Proxmox, as happens: the monitor ties them by address.
  { name: "gitea", kind: "vm", parent: "pve-atlas", ip: "10.0.10.21", mem: 4, pve: "forge-vm" },
  { name: "web-portfolio", kind: "vm", parent: "pve-atlas", ip: "10.0.10.22", mem: 2, os: "AlmaLinux 10.1", reboot: true },
  { name: "pihole", kind: "lxc", parent: "pve-atlas", ip: "10.0.10.30", mem: 1 },
  { name: "vaultwarden", kind: "lxc", parent: "pve-atlas", ip: "10.0.10.31", mem: 1, docker: ["vaultwarden"], os: "Alpine Linux v3.22" },
  { name: "home-assistant", kind: "lxc", parent: "pve-atlas", ip: "10.0.10.32", mem: 2, failed: "zigbee2mqtt" },
  { name: "tailscale-exit", kind: "lxc", parent: "pve-atlas", ip: "10.0.10.33", mem: 0.5, vpn: true },
  { name: "media", kind: "lxc", parent: "pve-atlas", ip: "10.0.10.34", mem: 6, cpu: 35, docker: ["jellyfin", "sonarr", "radarr", "prowlarr", "qbittorrent"], stopped: "prowlarr" },
  { name: "pve-orion", kind: "proxmox", ip: "10.0.20.2", cores: 8, mem: 64, temp: 49, smart: true, ct: true },
  { name: "matrix", kind: "vm", parent: "pve-orion", ip: "10.0.20.20", mem: 4, updates: 12, security: 2, os: "Fedora Linux 43 (Server Edition)" },
  { name: "k3s-worker", kind: "vm", parent: "pve-orion", ip: "10.0.20.21", mem: 8, cpu: 22, disk: 81, os: "Rocky Linux 10.0 (Red Quartz)" },
  { name: "forgejo-runner", kind: "lxc", parent: "pve-orion", ip: "10.0.20.30", mem: 4, docker: ["runner"], os: "Arch Linux" },
  { name: "nas-01", kind: "physical", ip: "10.0.10.5", cores: 4, mem: 32, temp: 63, smart: "worn", disk: 87 },
  { name: "vps-gateway", kind: "vps", ip: "203.0.113.10", mem: 2, updates: 7, security: 3, reboot: true, vpn: true, os: "Ubuntu 22.04.5 LTS" },
  { name: "vps-mail", kind: "vps", ip: "203.0.113.11", mem: 4, docker: ["mailserver", "roundcube"] },
  { name: "backup-01", kind: "vm", ip: "10.0.10.40", mem: 2, dies: true },
  { name: "staging", kind: "vm", ip: "10.0.10.41", mem: 2, never: true },
]
// Proxmox guests without an agent.
const GUESTS = {
  "pve-atlas": [
    { vmid: 120, name: "dockhand", kind: "lxc", status: "running", os: "debian", ip: "10.0.10.35" },
    { vmid: 200, name: "win11-lab", kind: "qemu", status: "stopped", os: "win11" },
    { vmid: 121, name: "test-ct", kind: "lxc", status: "stopped", os: "alpine" },
  ],
  // Watched by pve-orion: the monitor turns these into hosts measured from the node.
  "pve-orion": [
    { vmid: 130, name: "grafana", kind: "lxc", status: "running", os: "debian", ip: "10.0.20.31" },
    { vmid: 131, name: "uptime-kuma", kind: "lxc", status: "running", os: "debian", ip: "10.0.20.32" },
    { vmid: 132, name: "minecraft", kind: "lxc", status: "running", os: "ubuntu", ip: "10.0.20.33" },
  ],
}
// Proxmox lists the guests that run an agent too.
FLEET.filter((s) => FLEET.find((p) => p.name === s.parent)?.kind === "proxmox").forEach((s, i) =>
  GUESTS[s.parent].push({ vmid: 100 + i, name: s.pve ?? s.name, kind: s.kind === "lxc" ? "lxc" : "qemu", status: "running", os: "debian", ip: s.ip }))

let cookie = ""
async function call(base, path, body, method) {
  const res = await fetch(base + path, { method: method ?? (body ? "POST" : "GET"), headers: { "content-type": "application/json", cookie }, body: body && JSON.stringify(body) })
  const set = res.headers.get("set-cookie")
  if (set) cookie = set.split(";")[0]
  const text = await res.text()
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function signIn(base) {
  cookie = ""
  const s = await call(base, "/api/auth/status")
  if (s.database_setup) throw new Error(`${base} waits for its database choice: start it with NYX_PB_URL set`)
  await call(base, s.needs_setup ? "/api/auth/setup" : "/api/auth/login", { email: EMAIL, password: PASSWORD })
  return cookie
}

const rnd = (a, b) => a + Math.random() * (b - a)
const walk = (v, step, lo, hi) => Math.min(hi, Math.max(lo, v + rnd(-step, step)))

function makeAgent(spec, creds) {
  const physical = spec.kind === "physical" || spec.kind === "proxmox"
  const memTotal = spec.mem * GB
  const started = Date.now() / 1000 - rnd(2, 40) * 86400
  let cpu = spec.cpu ?? rnd(1, 8), mem = rnd(20, 60), temp = spec.temp ?? null
  const disks = [{ mount: "/", used: Math.round((spec.disk ?? rnd(15, 45)) / 100 * 64 * GB), total: 64 * GB, fs: "ext4", device: "/dev/sda1" }]
  if (physical) disks.push({ mount: spec.kind === "proxmox" ? "/var/lib/vz" : "/srv/data", used: Math.round((spec.disk ?? rnd(20, 50)) / 100 * 3.6e12), total: 3.6e12, fs: "zfs", device: "tank/data" })
  const smart = spec.smart && [
    { device: "/dev/nvme0n1", model: "Samsung SSD 980 PRO 1TB", health: "ok", life_left_pct: 92, temp_c: 41, power_on_hours: 8123, reason: "", kind: "NVMe", serial: "S5GXNF0R1", capacity: 1e12, bad_sectors: 0, power_cycles: 112, written_bytes: 48e12 },
    spec.smart === "worn"
      ? { device: "/dev/sdb", model: "WDC WD40EFRX", health: "warn", life_left_pct: null, temp_c: 44, power_on_hours: 51234, reason: "8 bad sectors", kind: "HDD", serial: "WD-WCC4E1", capacity: 4e12, bad_sectors: 8, power_cycles: 64 }
      : { device: "/dev/sda", model: "Crucial MX500 2TB", health: "ok", life_left_pct: 87, temp_c: 36, power_on_hours: 12001, reason: "", kind: "SSD", serial: "2034E4A1", capacity: 2e12, bad_sectors: 0, power_cycles: 90, written_bytes: 31e12 },
  ]
  const updates = [...Array(spec.updates ?? 0)].map((_, i) => ({ name: ["openssl", "libc6", "curl", "linux-image-amd64", "systemd", "nginx", "tzdata", "git", "vim", "python3", "sudo", "bash"][i % 12], version: `1.${i}.${i + 2}`, security: i < (spec.security ?? 0) }))
  const units = ["ssh", "cron", "nyx-agent", "systemd-journald", ...(spec.docker ? ["docker", "containerd"] : []), ...(spec.failed ? [spec.failed] : [])]
  const services = units.map((name) => {
    const failed = name === spec.failed
    return { name, description: `${name} service`, active: failed ? "failed" : "active", sub: failed ? "failed" : "running", enabled: "enabled", since: Math.round(started), pid: failed ? 0 : Math.round(rnd(200, 9000)), mem: failed ? 0 : Math.round(rnd(4, 120)) * 1024 ** 2, cpu_pct: rnd(0, 2), restarts: failed ? 5 : 0, kind: "simple", result: failed ? "exit-code" : "success", path: `/lib/systemd/system/${name}.service` }
  })
  const guests = (GUESTS[spec.name] ?? []).map((g) => ({ node: spec.name, oci: false, uptime_s: 0, cpu_pct: 0, mem_used: 0, mem_total: 2 * GB, disk_used: 4 * GB, disk_total: 16 * GB, rx_bps: 0, tx_bps: 0, ip: "", ...g }))
  let first = true, reports = 0
  return async function report() {
    const now = Math.floor(Date.now() / 1000)
    cpu = walk(cpu, 3, 0.3, spec.cpu ? spec.cpu + 30 : 25)
    mem = walk(mem, 2, 10, 92)
    if (temp != null) temp = walk(temp, 1.5, spec.temp - 6, spec.temp + 12)
    const body = {
      agent_version: VERSION, hostname: spec.name, os: `Linux (${spec.os ?? "Debian GNU/Linux 13"})`, kernel: spec.kind === "proxmox" ? "6.14.8-2-pve" : "6.12.48+deb13-amd64", arch: "x86_64", ip: spec.ip,
      kind: spec.kind, ct_autoinstall: !!spec.ct, dns: [], uptime_s: Math.round(now - started),
      cpu_pct: +cpu.toFixed(1), mem_used: Math.round(memTotal * mem / 100), mem_total: memTotal, swap_used: Math.round(rnd(0, 0.1) * GB), swap_total: GB,
      net_rx_bps: Math.round(rnd(2e3, spec.docker ? 4e6 : 4e5)), net_tx_bps: Math.round(rnd(1e3, 1e6)),
      disks, temp_c: temp == null ? null : +temp.toFixed(1),
      containers: spec.docker?.map((c, i) => ({ name: c, image: `${c}:latest`, state: c === spec.stopped ? "exited" : "running", status: c === spec.stopped ? "Exited (1) 3 hours ago" : "Up 4 days", id: `a1b2c3d4e5f${i}`, cpu_pct: rnd(0, 20), mem_used: Math.round(rnd(50, 900)) * 1024 ** 2, mem_limit: memTotal })) ?? null,
      smart: first ? smart || null : null,
      updates: first ? updates : null,
      guests: guests.length ? guests.map((g) => g.status === "running" ? { ...g, uptime_s: Math.round(now - started), cpu_pct: rnd(0, 6), mem_used: Math.round(rnd(0.2, 0.7) * g.mem_total), rx_bps: Math.round(rnd(1e3, 2e5)), tx_bps: Math.round(rnd(1e3, 1e5)) } : g) : null,
      logs: reports % 4 === 0 ? [`${now} <6> sshd: Accepted publickey for admin from 10.0.10.100`, ...(spec.failed ? [`${now} <3> ${spec.failed}: Error: serial port /dev/ttyACM0 not found`] : [])] : [],
      results: [], progress: null, reboot_required: !!spec.reboot,
      vpn: spec.vpn ? [{ iface: "tailscale0", kind: "Tailscale", ip: "100.64.0.7", up: true, rx_bps: Math.round(rnd(1e3, 5e4)), tx_bps: Math.round(rnd(1e3, 5e4)) }] : [],
      firewall: null, repos: null, services: first ? services : null,
    }
    const raw = JSON.stringify(body)
    const sig = createHmac("sha256", creds.key).update(`${now}\n${raw}`).digest("hex")
    const res = await fetch(`${MONITOR}/agent/v1/report`, { method: "POST", headers: { "content-type": "application/json", "x-nyx-token": creds.token, "x-nyx-ts": String(now), "x-nyx-sig": sig }, body: raw })
    if (!res.ok) throw new Error(`${spec.name}: ${res.status} ${await res.text()}`)
    const reply = await res.json()
    first = reply.resync
    reports++
    for (const c of reply.commands ?? []) console.log(`${spec.name}: ignored command ${JSON.stringify(c.action ?? c)}`)
    return Math.min(reply.interval_s || 15, 15)
  }
}

// Probes in categories, aimed at this machine only: what answers is up, a closed port is down.
const PROBES = [
  ["Infrastructure", [["Router", "ping", "127.0.0.1"], ["Core switch", "ping", "localhost"], ["Access point", "ping", "127.0.0.1"], ["PDU", "http", "http://127.0.0.1:9/"]]],
  ["Services", [["Nextcloud", "http", `${MONITOR}/`], ["Vaultwarden", "http", `${MANAGER}/`], ["Grafana", "http", "http://127.0.0.1:5173/"], ["Home Assistant", "http", "http://127.0.0.1:8123/"], ["Jellyfin", "http", "http://127.0.0.1:5174/"]]],
  ["DNS", [["Pi-hole", "dns", "nyx.home.arpa", "127.0.0.1"]]],
  ["", [["Old NAS", "ping", "127.0.0.1", "", false]]],
]
async function seedProbes() {
  const cats = (await call(MONITOR, "/api/c/probe_categories?perPage=200")).items
  const probes = (await call(MONITOR, "/api/c/probes?perPage=500")).items
  for (const [i, [name, list]] of PROBES.entries()) {
    const cat = !name ? null : cats.find((c) => c.name === name) ?? await call(MONITOR, "/api/c/probe_categories", { name, position: i })
    for (const [probe, type, target, dns_server = "", enabled = true] of list) {
      if (!probes.some((p) => p.name === probe)) await call(MONITOR, "/api/c/probes", { name: probe, type, target, dns_server, enabled, interval_s: 30, category: cat?.id ?? "" })
    }
  }
  await call(MONITOR, "/api/probes/reload", undefined, "POST")
}

async function main() {
  await signIn(MONITOR)
  const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {}
  const known = await call(MONITOR, "/api/hosts")
  const ids = Object.fromEntries(known.map((h) => [h.name, h.id]))
  for (const spec of FLEET) {
    if (saved[spec.name] && known.some((h) => h.id === saved[spec.name].id)) continue
    const res = await call(MONITOR, "/api/hosts", { name: spec.name, kind: spec.kind, parent: spec.parent ? ids[spec.parent] ?? "" : "", ct_autoinstall: !!spec.ct })
    ids[spec.name] = res.id
    saved[spec.name] = { id: res.id, token: res.ansible.nyx_agent_token, key: res.ansible.nyx_agent_key }
    console.log(`created ${spec.name}`)
  }
  writeFileSync(STATE, JSON.stringify(saved, null, 2))
  await seedProbes()

  // The manager reads the fleet through a link token. Optional: skipped when it is not running.
  try {
    const { token } = await call(MONITOR, "/api/link/token", undefined, "POST")
    await signIn(MANAGER)
    await call(MANAGER, "/api/settings/link", { url: MONITOR, token }, "PUT")
    console.log(`manager at ${MANAGER} linked`)
  } catch (e) { console.log(`manager not linked: ${e.message}`) }

  for (const spec of FLEET.filter((s) => !s.never)) {
    const send = makeAgent(spec, saved[spec.name])
    const loop = async () => {
      try {
        const next = await send()
        if (spec.dies) return console.log(`${spec.name}: stops reporting, to show an offline host`)
        setTimeout(loop, next * 1000)
      } catch (e) { console.error(e.message); setTimeout(loop, 15000) }
    }
    setTimeout(loop, rnd(0, 2000))
  }
  console.log(`${FLEET.length} hosts simulated on ${MONITOR}. Ctrl-C to stop.`)
}

main().catch((e) => { console.error(e.message); process.exit(1) })

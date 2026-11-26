#!/usr/bin/env node
// Fills a running manager with a sample homelab to try its pages: hardware standing in a
// rack, on a shelving unit and on a desk, a few cables, and a network map with zones.
// Run it after dev/fake-agents.mjs, which links the monitor whose hosts the map imports.
//   node dev/seed-manager.mjs [manager URL]
// Sign-in: NYX_SIM_EMAIL / NYX_SIM_PASSWORD (default admin@nyx.local / dev-password-123).
// Records are found by name, so running it again adds nothing twice.
import { arrange, H, parents, W } from "../web/src/manager/map-layout.ts"

const MANAGER = (process.argv[2] ?? "http://127.0.0.1:8082").replace(/\/$/, "")
const EMAIL = process.env.NYX_SIM_EMAIL ?? "admin@nyx.local"
const PASSWORD = process.env.NYX_SIM_PASSWORD ?? "dev-password-123"

let cookie = ""
async function call(path, body, method) {
  const res = await fetch(MANAGER + path, { method: method ?? (body ? "POST" : "GET"), headers: { "content-type": "application/json", cookie }, body: body && JSON.stringify(body) })
  const set = res.headers.get("set-cookie")
  if (set) cookie = set.split(";")[0]
  const text = await res.text()
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}
const list = async (coll) => (await call(`/api/c/${coll}?perPage=500`)).items
/** The record of that name, created with `body` when missing. */
async function ensure(coll, rows, body) {
  const found = rows.find((r) => r.name === body.name)
  if (found) return found
  const made = await call(`/api/c/${coll}`, body)
  rows.push(made)
  return made
}

const s = await call("/api/auth/status")
await call(s.needs_setup ? "/api/auth/setup" : "/api/auth/login", { email: EMAIL, password: PASSWORD })

// Places: a small rack, a wooden shelving unit, a desk.
const places = await list("racks")
const rack = await ensure("racks", places, { name: "Network rack", kind: "rack", units: 12, location: "Office" })
const shelf = await ensure("racks", places, { name: "Shelving unit", kind: "shelf", units: 3, width_cm: 80, color: "wood", location: "Office" })
const desk = await ensure("racks", places, { name: "Desk", kind: "desk", width_cm: 140, color: "white", location: "Office" })

// rack_u: unit or level, 1 at the bottom; rack_x and rack_w: columns out of 12, 0 for all.
const hardware = await list("hardware")
const hw = {}
for (const h of [
  { name: "OPNsense", category: "Firewall", manufacturer: "Protectli", model: "VP2420", rack: rack.id, rack_u: 12 },
  { name: "Core switch", category: "Switch", manufacturer: "Ubiquiti", model: "USW-24-PoE", rack: rack.id, rack_u: 11 },
  { name: "Patch panel", category: "Patch panel", rack: rack.id, rack_u: 10 },
  { name: "pve-atlas", category: "Server", manufacturer: "Dell", model: "PowerEdge R630", rack: rack.id, rack_u: 6, rack_units: 2 },
  { name: "Raspberry Pi 5", category: "Other", manufacturer: "Raspberry Pi", model: "5 · 8 GB", rack: rack.id, rack_u: 5, rack_w: 4 },
  { name: "Mini PC", category: "Server", manufacturer: "Intel", model: "NUC 12", rack: rack.id, rack_u: 5, rack_x: 4, rack_w: 4 },
  { name: "UPS", category: "UPS", manufacturer: "APC", model: "Smart-UPS 1500", rack: rack.id, rack_u: 1, rack_units: 2 },
  { name: "nas-01", category: "NAS", manufacturer: "Synology", model: "DS923+", rack: shelf.id, rack_u: 3, rack_w: 6 },
  { name: "Access point", category: "Access point", manufacturer: "Ubiquiti", model: "U6 Lite", rack: shelf.id, rack_u: 3, rack_x: 7, rack_w: 3 },
  { name: "pve-orion", category: "Server", manufacturer: "Minisforum", model: "MS-01", rack: shelf.id, rack_u: 2, rack_w: 5 },
  { name: "Printer", category: "Printer", manufacturer: "Brother", model: "HL-L2350", rack: shelf.id, rack_u: 1, rack_w: 6 },
  { name: "Desk switch", category: "Switch", manufacturer: "TP-Link", model: "TL-SG108", rack: desk.id, rack_u: 1, rack_x: 1, rack_w: 3 },
  { name: "Spare disk", category: "Other", manufacturer: "WD", model: "Red Plus 8 TB", status: "Spare" },
]) hw[h.name] = await ensure("hardware", hardware, { status: "In service", location: "Office", ...h })

// Cables from the switch to the machines.
const ports = await list("ports")
const port = async (device, name) => ports.find((p) => p.device === device.id && p.name === name) ?? (ports.push(await call("/api/c/ports", { device: device.id, name })), ports.at(-1))
for (const [n, host, nic] of [["1", "pve-atlas", "eno1"], ["2", "nas-01", "eth0"], ["3", "pve-orion", "enp2s0"], ["4", "Access point", "eth0"], ["24", "OPNsense", "igc1"]]) {
  const [a, b] = [await port(hw["Core switch"], `port ${n}`), await port(hw[host], nic)]
  if (!a.peer && !b.peer) await call(`/api/c/ports/${a.id}`, { peer: b.id }, "PATCH")
}

// The map: the monitored hosts, the network gear in front of them, then zones around both.
const first = !(await list("map_zones")).length
await call("/api/map/import", {}).catch((e) => console.warn(`No hosts imported (${e.message}): run dev/fake-agents.mjs first.`))
const nodes = await list("map_nodes")
const node = (name, type, ip) => ensure("map_nodes", nodes, { name, type, ip, x: 0, y: 0 })
const gear = {
  internet: await node("Internet", "internet", ""),
  fw: await node("OPNsense", "firewall", "10.0.0.1"),
  sw: await node("Core switch", "switch", "10.0.0.2"),
  ap: await node("Access point", "ap", "10.0.0.3"),
}
const links = await list("map_links")
const id = (name) => nodes.find((n) => n.name === name)?.id
for (const [a, b, kind, label] of [
  [gear.internet.id, gear.fw.id, "fiber", "WAN"], [gear.fw.id, gear.sw.id, "ethernet", "LAN"], [gear.sw.id, gear.ap.id, "ethernet", ""],
  [gear.fw.id, id("vps-gateway"), "vpn", "WireGuard"],
]) if (a && b && !links.some((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a))) links.push(await call("/api/c/map_links", { source: a, target: b, kind, label }))

if (first) {
  const at = arrange(nodes, links)
  await Promise.all(nodes.map((n) => at[n.id] && call(`/api/c/map_nodes/${n.id}`, at[n.id], "PATCH")))
  nodes.forEach((n) => at[n.id] && Object.assign(n, at[n.id]))
  /** A zone around some devices, with room for its label. */
  const around = (name, color, names) => {
    const ns = nodes.filter((n) => names.includes(n.name) || names.includes(n.type))
    if (!ns.length) return
    const x = Math.min(...ns.map((n) => n.x)) - 24, y = Math.min(...ns.map((n) => n.y)) - 32
    return call("/api/c/map_zones", { name, color, x, y, w: Math.max(...ns.map((n) => n.x)) + W + 24 - x, h: Math.max(...ns.map((n) => n.y)) + H + 24 - y })
  }
  await around("Network", "blue", ["internet", "firewall", "router", "switch", "ap"])
  const parent = parents(nodes, links)
  await around("Servers", "orange", nodes.filter((n) => ["proxmox", "physical"].includes(n.type) || parent[n.id]).map((n) => n.name))
  await around("Cloud", "green", ["vps"])
}
// IPAM: the VLANs and subnets of the addresses the monitor reports.
const vlans = await list("vlans")
for (const [number, name] of [[1, "Management"], [10, "Servers"], [20, "Lab"]]) await ensure("vlans", vlans, { number, name })
const subnets = await list("subnets")
for (const [name, cidr, gateway, vlan, section, location] of [
  ["Management", "10.0.0.0/24", "10.0.0.1", "1", "Home", "Office"],
  ["Servers", "10.0.10.0/24", "10.0.10.1", "10", "Home", "Office"],
  ["Lab", "10.0.20.0/24", "10.0.20.1", "20", "Home", "Office"],
  ["VPS", "203.0.113.0/24", "203.0.113.1", "", "Cloud", "OVH"],
]) await ensure("subnets", subnets, { name, cidr, gateway, vlan, section, location, threshold: 80 })

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

// Addresses: the router's leg in each segment, so that the simulator can route between
// them, and two machines on one address, a conflict to resolve.
const addresses = await list("ip_addresses")
for (const [address, device, state] of [
  ["10.0.0.1", "OPNsense", "Active"], ["10.0.10.1", "OPNsense", "Active"], ["10.0.20.1", "OPNsense", "Active"],
  ["10.0.0.2", "Core switch", "Active"], ["10.0.0.3", "Access point", "Active"],
  ["10.0.0.50", "Printer", "Reserved"], ["10.0.0.50", "Old camera", "Active"],
]) if (!addresses.some((a) => a.address === address && a.device === device)) await call("/api/c/ip_addresses", { address, device, state })

// Components: the disks of the NAS, one of them decommissioned, a spare on a shelf, the server's CPUs and memory.
const parts = await list("components")
for (const c of [
  ...[1, 2, 3, 4].map((n) => ({ name: `nas-01 disk ${n}`, type: "Hard disk", manufacturer: "WD", model: "Red Plus", capacity: "8 TB", device: hw["nas-01"].id, slot: `Bay ${n}`, status: "In service" })),
  { name: "nas-01 old disk", type: "Hard disk", manufacturer: "Seagate", model: "IronWolf", capacity: "4 TB", status: "Decommissioned", decommissioned_at: day(-40), notes: "Reallocated sectors, replaced by disk 4." },
  { name: "Spare SSD", type: "SSD", manufacturer: "Samsung", model: "870 EVO", capacity: "1 TB", status: "Spare" },
  ...[1, 2].map((n) => ({ name: `pve-atlas CPU ${n}`, type: "CPU", manufacturer: "Intel", model: "Xeon E5-2680 v4", capacity: "14 cores", device: hw["pve-atlas"].id, slot: `Socket ${n}`, status: "In service" })),
  ...["A1", "A2", "B1", "B2"].map((slot) => ({ name: `pve-atlas RAM ${slot}`, type: "RAM", manufacturer: "Samsung", capacity: "32 GB DDR4-2400 ECC", device: hw["pve-atlas"].id, slot, status: "In service" })),
]) await ensure("components", parts, c)

// Work: tasks in each state, and deployments.
const tasks = await call("/api/tasks")
for (const [title, status, due, tags, description] of [
  ["Replace the worn disk of nas-01", "todo", day(2), "hardware, urgent", "- [x] Order a WD Red Plus 8 TB\n- [ ] Swap the disk\n- [ ] Rebuild the array"],
  ["Renew the certificate of mail.example.org", "todo", day(5), "network", ""],
  ["Move Grafana to pve-orion", "doing", day(1), "proxmox", "- [x] Back up the dashboards\n- [x] Create the container\n- [ ] Restore and test"],
  ["Upgrade OPNsense to 26.1", "doing", "", "network", ""],
  ["Document the VLANs", "done", "", "network", ""],
  ["Clean the dust filters", "todo", day(-3), "hardware", ""],
]) if (!tasks.some((t) => t.title === title)) await call("/api/tasks", { title, status, due, tags, description })
const deployments = await list("deployments")
for (const [name, target, version, status, tags] of [
  ["Nextcloud 31.0.4", "nextcloud", "31.0.4", "ok", "apps"],
  ["Vaultwarden 1.34", "vaultwarden", "1.34.1", "running", "apps"],
  ["k3s 1.33 upgrade", "k3s-worker", "1.33.2", "planned", "cluster"],
  ["Pi-hole v6", "pihole", "6.1", "failed", "network"],
]) await ensure("deployments", deployments, { name, target, version, status, tags, scheduled_at: day(0) })

console.log(`Seeded ${MANAGER}: ${places.length} places, ${hardware.length} devices, ${nodes.length} map devices.`)

// Rows of the inventory that dashboard charts read.
import type { Dataset, Field, Row } from "../ui/chart/data"
import { sharedGet } from "../ui/lib"

/** Every record of a collection, page after page. */
async function all(coll: string, sort = ""): Promise<Row[]> {
  const out: Row[] = []
  for (let page = 1; page <= 20; page++) {
    const res = await sharedGet<{ items: Row[]; totalPages: number }>(`/api/c/${coll}?perPage=500&page=${page}${sort ? `&sort=${sort}` : ""}`)
    out.push(...res.items)
    if (page >= (res.totalPages || 1)) break
  }
  return out
}

const names = (rows: Row[]) => new Map(rows.map((r) => [String(r.id), String(r.name ?? "")]))
const text = (key: string, label: string): Field => ({ key, label, kind: "text" })
const date = (key: string, label: string): Field => ({ key, label, kind: "date" })
const num = (key: string, label: string, format?: Field["format"]): Field => ({ key, label, kind: "number", format })
const tags: Field = { key: "tags", label: "Tags", kind: "tags" }
const created = date("created", "Created")

export const DATASETS: Dataset[] = [
  {
    id: "hardware", label: "Hardware", hint: "Your devices, with their category, place, status, price and dates.", name: "name",
    link: (r) => `/hardware/${r.id}`,
    fields: [text("name", "Name"), text("category", "Category"), text("status", "Status"), text("location", "Place"), text("rack", "Rack"),
      text("manufacturer", "Manufacturer"), text("model", "Model"), text("supplier", "Supplier"), num("price", "Price"), num("rack_units", "Height in U"),
      date("purchased_at", "Purchased"), date("in_service_at", "In service since"), date("warranty_until", "Warranty until"), date("battery_at", "Battery replaced"), tags, created],
    load: async () => {
      const [hw, racks] = await Promise.all([all("hardware"), all("racks")])
      const rack = names(racks)
      return hw.map((h) => ({ ...h, rack: rack.get(String(h.rack ?? "")) ?? "" }))
    },
  },
  {
    id: "virtual", label: "Virtual assets", hint: "Virtual machines and containers, with what they run on and their size.", name: "name",
    link: (r) => `/virtual/${r.id}`,
    fields: [text("name", "Name"), text("type", "Type"), text("status", "Status"), text("parent", "Runs on"), text("pve_node", "Proxmox node"),
      num("vcpu", "vCPU"), num("ram", "Memory", "bytes"), num("disk", "Disk", "bytes"), text("ip", "IP address"), tags, created],
    load: async () => (await all("virtual_assets")).map((v) => ({ ...v, ram: Number(v.ram_mb || 0) * 1048576, disk: Number(v.disk_gb || 0) * 1073741824 })),
  },
  {
    id: "components", label: "Components", hint: "Disks, memory and cards, and the device each one is in.", name: "name",
    fields: [text("name", "Name"), text("type", "Type"), text("status", "Status"), text("device", "Device"), text("manufacturer", "Manufacturer"),
      text("model", "Model"), text("capacity", "Capacity"), date("purchased_at", "Purchased"), date("warranty_until", "Warranty until"), tags, created],
    load: async () => {
      const [parts, hw] = await Promise.all([all("components"), all("hardware")])
      const device = names(hw)
      return parts.map((p) => ({ ...p, device: device.get(String(p.device ?? "")) ?? "" }))
    },
  },
  {
    id: "addresses", label: "IP addresses", hint: "Addresses kept in IPAM, with their state and device.", name: "address",
    fields: [text("address", "Address"), text("state", "State"), text("device", "Device"), text("hostname", "Hostname"), text("owner", "Owner"),
      { key: "shared", label: "Shared", kind: "bool" }, date("last_seen", "Last seen"), created],
    load: () => all("ip_addresses"),
  },
  {
    id: "subnets", label: "Subnets", hint: "Each subnet with its size, the addresses in use and how full it is.", name: "name",
    link: (r) => `/ipam/subnet/${r.id}`,
    fields: [text("name", "Name"), text("cidr", "Network"), text("section", "Section"), text("location", "Place"), text("vrf", "VRF"), num("vlan", "VLAN"),
      num("capacity", "Addresses"), num("used", "In use"), num("pct", "Used", "pct"), num("threshold", "Threshold", "pct")],
    load: async () => (await sharedGet<{ subnets: Row[] }>("/api/overview")).subnets.map((s) => ({ ...s, capacity: Number(s.capacity) || 0 })),
  },
  {
    id: "tasks", label: "Tasks", hint: "Tasks, synced with Nextcloud when it is set up.", name: "title",
    fields: [text("title", "Title"), text("status", "State"), { key: "done", label: "Done", kind: "bool" }, date("due", "Due"), tags, created, date("updated", "Updated")],
    load: () => sharedGet<Row[]>("/api/tasks"),
  },
  {
    id: "interventions", label: "Interventions", hint: "Work on devices: type, state, when it was planned and done.", name: "title",
    fields: [text("title", "Title"), text("type", "Type"), text("status", "State"), text("asset", "Device"), text("owner", "Owner"),
      date("scheduled_at", "Planned"), date("done_at", "Done on"), tags, created],
    load: () => all("interventions"),
  },
  {
    id: "deployments", label: "Deployments", hint: "What was deployed where, its version and state.", name: "name",
    fields: [text("name", "Name"), text("target", "Target"), text("status", "State"), text("version", "Version"), text("owner", "Owner"),
      date("scheduled_at", "Planned"), date("done_at", "Done on"), tags, created],
    load: () => all("deployments"),
  },
  {
    id: "racks", label: "Racks and shelves", hint: "Racks, shelving units and desks, with their size.", name: "name",
    fields: [text("name", "Name"), text("kind", "Kind"), text("location", "Place"), num("units", "Height in U"), num("devices", "Devices")],
    load: async () => {
      const [racks, hw] = await Promise.all([all("racks"), all("hardware")])
      return racks.map((r) => ({ ...r, devices: hw.filter((h) => h.rack === r.id).length }))
    },
  },
]

import { beforeAll, describe, expect, it, vi } from "vitest"
import type { Dataset } from "../ui/chart/data"

const API: Record<string, unknown> = {
  "/api/hosts": [
    { id: "a", name: "pve", kind: "proxmox", status: "ok", agent_version: "1.0.0", updates: 2, tags: ["rack"], guests: [{ vmid: 101, name: "web", kind: "lxc", mem_used: 1, mem_total: 4 }] },
    { id: "b", name: "old", kind: "vm", status: "off", agent_version: "1.0.0", updates: 0, tags: [], guests: [] },
  ],
  "/api/hosts/a": {
    id: "a", name: "pve", kind: "proxmox", tags: ["rack"], update_list: [{ name: "openssl", version: "3.0.15", security: true }],
    firewall: { backend: "ufw", rules: [{ action: "allow", port: "22", proto: "tcp" }], listening: [{ proto: "tcp", port: 8006, addr: "*", process: "pveproxy", docker: false }] },
  },
  "/api/probes": [{ id: "p", name: "dns", type: "dns", days: [100, null, 50] }],
  "/api/integrations/tempo": { remaining: { blue: 280, white: 40, red: 22 } },
}
let DATASETS: Dataset[]
beforeAll(async () => {
  vi.stubGlobal("fetch", async (url: string) => (url in API ? new Response(JSON.stringify(API[url])) : new Response('{"error":"nope"}', { status: 404 })))
  DATASETS = (await import("./datasets")).DATASETS
})
const load = (id: string) => DATASETS.find((d) => d.id === id)!.load("24h")

describe("monitor datasets", () => {
  it("only ask the hosts that have something for their packages and ports", async () => {
    expect(await load("updates")).toEqual([{ name: "openssl", version: "3.0.15", security: true, type: "Proxmox", host: "pve", host_id: "a", tags: ["rack"] }])
    expect(await load("ports")).toMatchObject([{ port: 8006, process: "pveproxy", host: "pve" }])
    expect(await load("firewall")).toMatchObject([{ action: "allow", port: "22", backend: "ufw", host: "pve" }])
  })
  it("turn what the hosts hold into rows of their own", async () => {
    expect(await load("guests")).toMatchObject([{ name: "web", type: "LXC container", host: "pve", mem_pct: 25 }])
    expect((await load("hosts")).map((h) => h.guest_count)).toEqual([1, 0])
  })
  it("date the days of a probe back from today, skipping days without checks", async () => {
    const days = await load("probe_days")
    expect(days.map((d) => d.uptime)).toEqual([100, 50])
    expect(Math.round(((days[1].day as number) - (days[0].day as number)) / 864e5)).toBe(2)
  })
  it("count Tempo days used against the season's quotas", async () => {
    expect(await load("tempo")).toEqual([
      { colour: "Blue", quota: 300, left: 280, used: 20 }, { colour: "White", quota: 43, left: 40, used: 3 }, { colour: "Red", quota: 22, left: 22, used: 0 },
    ])
  })
})

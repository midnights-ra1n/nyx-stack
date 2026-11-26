import { describe, expect, it } from "vitest"
import { BOX_W, BUS, GAP, leg, OUTSIDE, place, TOP, type Topology } from "./sim-layout"

const topo: Topology = {
  segments: [
    { id: "a", name: "Servers", cidr: "10.0.10.0/24", hosts: [{ name: "nextcloud", ips: ["10.0.10.20"] }, { name: "gitea", ips: ["10.0.10.21"] }] },
    { id: "b", name: "Lab", cidr: "10.0.20.0/24", hosts: [{ name: "k3s", ips: ["10.0.20.30"] }] },
  ],
  routers: [{ name: "fw", ips: ["10.0.10.1", "10.0.20.1"], links: [{ segment: "a", ip: "10.0.10.1" }, { segment: "b", ip: "10.0.20.1" }] }],
  outside: [{ name: "lost", ips: ["192.0.2.7"] }],
}

describe("simulator layout", () => {
  it("puts segments side by side and routers over them", () => {
    const L = place(topo)
    expect(L.boxes.map((b) => [b.id, b.x])).toEqual([["a", 0], ["b", BOX_W + GAP], [OUTSIDE, 2 * (BOX_W + GAP)]])
    expect(L.routers.fw.x).toBe((BUS + BOX_W + GAP + BUS) / 2)
    expect(L.links.map((l) => l.segment)).toEqual(["a", "b"])
    expect(L.hosts.gitea.y).toBeGreaterThan(L.hosts.nextcloud.y)
  })

  it("routers do not overlap", () => {
    const two: Topology = { ...topo, routers: [{ ...topo.routers[0], name: "r1" }, { ...topo.routers[0], name: "r2" }] }
    const L = place(two)
    expect(L.routers.r2.x - L.routers.r1.x).toBeGreaterThanOrEqual(176)
  })

  it("packets leave and enter boxes by the top", () => {
    const L = place(topo)
    expect(leg(L, "nextcloud", "fw")).toEqual([L.hosts.nextcloud, { x: BUS, y: TOP }, L.routers.fw])
    expect(leg(L, "nextcloud", "gitea")).toEqual([L.hosts.nextcloud, L.hosts.gitea])
    expect(leg(L, "fw", "k3s")).toEqual([L.routers.fw, { x: BOX_W + GAP + BUS, y: TOP }, L.hosts.k3s])
  })
})

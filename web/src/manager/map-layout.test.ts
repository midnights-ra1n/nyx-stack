import { describe, expect, it } from "vitest"
import { arrange, curve, H, INDENT, parents, TOP, treePath } from "./map-layout"

const nodes = [
  { id: "r", name: "router", type: "router" },
  { id: "p2", name: "PVE-2", type: "proxmox" },
  { id: "p10", name: "PVE-10", type: "proxmox" },
  { id: "a", name: "alpha", type: "lxc" },
  { id: "b", name: "Beta", type: "vm" },
  { id: "c", name: "cloud", type: "vps" },
]
const links = [
  { source: "a", target: "p2" },
  { source: "p10", target: "b" }, // either direction
  { source: "p2", target: "p10" }, // two hosts: no hierarchy
  { source: "r", target: "p2" },
]

describe("network map layout", () => {
  it("finds the host of each guest only", () => {
    expect(parents(nodes, links)).toEqual({ a: "p2", b: "p10" })
  })

  it("puts gear on top, a column per host with its guests, then the rest", () => {
    const at = arrange(nodes, links)
    expect(at.r.y).toBe(TOP)
    expect(at.p2.y).toBe(at.p10.y)
    expect(at.p2.x).toBeLessThan(at.p10.x) // natural order: 2 before 10
    expect(at.a).toEqual({ x: at.p2.x + INDENT, y: at.p2.y + H + 14 })
    expect(at.b.x).toBe(at.p10.x + INDENT)
    expect(at.c.y).toBeGreaterThan(at.a.y)
    expect(Object.keys(at)).toHaveLength(nodes.length)
  })

  it("arcs over the row between two cards side by side", () => {
    const c = curve({ x: 0, y: 100 }, { x: 600, y: 100 })
    expect(c.my).toBeLessThan(100)
  })

  it("draws a guest moved away with a straight line", () => {
    expect(treePath({ x: 0, y: 0 }, { x: 28, y: 100 })).toMatch(/^M14 /)
    expect(treePath({ x: 300, y: 300 }, { x: 0, y: 0 })).toContain("L")
  })
})

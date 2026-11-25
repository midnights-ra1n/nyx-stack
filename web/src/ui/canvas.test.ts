import { describe, expect, it } from "vitest"
import { centered, matches, zoomed } from "./canvas"
import { family } from "../monitor/map"

describe("map canvas", () => {
  it("centres a point at the zoom asked", () => {
    const v = centered({ x: 100, y: 50 }, { x: 300, y: 200 }, 2)
    expect([100 * v.k + v.x, 50 * v.k + v.y]).toEqual([300, 200])
  })
  it("keeps the zoom point still", () => {
    const v = zoomed({ k: 1, x: 0, y: 0 }, 40, 40, 2)
    expect((40 - v.x) / v.k).toBe(40)
  })
  it("matches every word, in any field, ignoring case", () => {
    expect(matches("pve 10", "PVE-1", "10.0.0.5")).toBe(true)
    expect(matches("nas", "PVE-1", null)).toBe(false)
    expect(matches("  ", "anything")).toBe(false)
  })
  it("brings forward a node's hosts above and guests below, not its siblings", () => {
    // 0 hub child → 1 under 0 → 2 under 1; 3 is a sibling of 1.
    const nodes = [{ parent: null }, { parent: 0 }, { parent: 1 }, { parent: 0 }]
    expect([...family(nodes, 1)].sort()).toEqual([0, 1, 2])
  })
})

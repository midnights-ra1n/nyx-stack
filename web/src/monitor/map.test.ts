import { describe, expect, it } from "vitest"
import { autoLayout, hubState, type MapNode, zoomed } from "./map"

const node = (parent: number | null = null, state: MapNode["state"] = "ok"): MapNode => ({ label: "n", state, type: "vm", parent })
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

describe("autoLayout", () => {
  it("keeps nodes apart, even on a crowded homelab", () => {
    const nodes = [node(), ...Array.from({ length: 30 }, () => node(0)), ...Array.from({ length: 12 }, () => node())]
    const at = autoLayout(nodes)
    for (let i = 0; i < at.length; i++) for (let j = i + 1; j < at.length; j++) expect(distance(at[i], at[j])).toBeGreaterThan(50)
  })
  it("puts children further out, on their parent's side", () => {
    const at = autoLayout([node(), node(), node(0)])
    expect(distance(at[2], { x: 0, y: 0 })).toBeGreaterThan(distance(at[0], { x: 0, y: 0 }))
    expect(distance(at[2], at[0])).toBeLessThan(distance(at[2], at[1]))
  })
  it("gives the same answer each time, so that a refresh moves nothing", () => {
    const nodes = [node(), node(0), node(0), node()]
    expect(autoLayout(nodes)).toEqual(autoLayout(nodes))
  })
  it("copes with an empty fleet", () => {
    expect(autoLayout([])).toEqual([])
  })
})

describe("hubState", () => {
  it("is the worst of the fleet, a stopped guest being a warning", () => {
    expect(hubState([node(), node()])).toBe("ok")
    expect(hubState([node(null, "off")])).toBe("warn")
    expect(hubState([node(null, "off"), node(null, "crit")])).toBe("crit")
  })
})

describe("zoomed", () => {
  it("keeps the point under the pointer in place", () => {
    const v = zoomed({ k: 1, x: 10, y: 20 }, 100, 50, 2)
    expect([v.k, (100 - v.x) / v.k, (50 - v.y) / v.k]).toEqual([2, 90, 30])
  })
  it("stops at its limits", () => {
    expect(zoomed({ k: 3.5, x: 0, y: 0 }, 0, 0, 2).k).toBe(4)
    expect(zoomed({ k: 0.4, x: 0, y: 0 }, 0, 0, 0.5).k).toBe(0.3)
  })
})

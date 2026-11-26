import { describe, expect, it } from "vitest"
import { firstFree, fits, geo, spot } from "./racks"

const placed = [{ id: "sw", rack_u: 42, rack_units: 1 }, { id: "srv", rack_u: 38, rack_units: 2 }]

describe("placing devices", () => {
  it("refuses overlaps and the outside of the rack", () => {
    expect(fits(placed, 42, "new", 39, 1)).toBe(false)
    expect(fits(placed, 42, "new", 41, 1)).toBe(true)
    expect(fits(placed, 42, "new", 41, 2)).toBe(false)
    expect(fits(placed, 42, "new", 0, 1)).toBe(false)
    expect(fits(placed, 42, "srv", 39, 2)).toBe(true) // a device does not collide with itself
  })
  it("fills from the top, then from the left", () => {
    expect(firstFree(placed, 42, 1)).toEqual({ u: 41, x: 0 })
    expect(firstFree(placed, 42, 3)).toEqual({ u: 35, x: 0 })
    expect(firstFree([{ id: "a", rack_u: 1, rack_units: 2 }], 2, 1)).toBeNull()
  })
  it("puts narrow devices side by side on one unit or shelf", () => {
    const half = [{ id: "pi", rack_u: 2, rack_x: 0, rack_w: 6 }]
    expect(fits(half, 3, "nuc", 2, 1, 6, 6)).toBe(true)
    expect(fits(half, 3, "nuc", 2, 1, 4, 6)).toBe(false)
    expect(fits(half, 3, "big", 2, 1)).toBe(false) // full width by default
    expect(fits(half, 3, "nuc", 2, 1, 8, 6)).toBe(false) // past the right edge
    expect(firstFree(half, 2, 1, "nuc", 6)).toEqual({ u: 2, x: 6 })
  })
  it("draws each kind of place to its own scale", () => {
    expect(geo({}).rows).toBe(42)
    expect(geo({ kind: "shelf", units: 3 }).rows).toBe(3)
    expect(geo({ kind: "desk", units: 9 }).rows).toBe(1)
    const shelf = geo({ kind: "shelf", units: 3, width_cm: 80 })
    expect(shelf.cell(shelf.side + 1, shelf.top + 1)).toEqual({ u: 3, col: 0 })
    expect(spot({ kind: "shelf" }, { rack_u: 2 })).toBe("level 2")
    expect(spot({}, { rack_u: 5, rack_units: 2 })).toBe("U5–6")
  })
})

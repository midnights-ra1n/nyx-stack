import { describe, expect, it } from "vitest"
import { firstFree, fits } from "./racks"

const placed = [{ id: "sw", rack_u: 42, rack_units: 1 }, { id: "srv", rack_u: 38, rack_units: 2 }]

describe("rack placement", () => {
  it("refuses overlaps and the outside of the rack", () => {
    expect(fits(placed, 42, "new", 39, 1)).toBe(false)
    expect(fits(placed, 42, "new", 41, 1)).toBe(true)
    expect(fits(placed, 42, "new", 41, 2)).toBe(false)
    expect(fits(placed, 42, "new", 0, 1)).toBe(false)
    expect(fits(placed, 42, "srv", 39, 2)).toBe(true) // a device does not collide with itself
  })
  it("fills from the top", () => {
    expect(firstFree(placed, 42, 1)).toBe(41)
    expect(firstFree(placed, 42, 3)).toBe(35)
    expect(firstFree([{ id: "a", rack_u: 1, rack_units: 2 }], 2, 1)).toBe(0)
  })
})

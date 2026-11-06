import { describe, expect, it } from "vitest"
import { isOverdue, samplesAt, sortRows } from "./lib"

describe("sortRows", () => {
  const rows = ["srv-10", "", "srv-9", "Alpha"]
  it("orders numbers inside names naturally and ignores case", () => {
    expect(sortRows(rows, (r) => r)).toEqual(["Alpha", "srv-9", "srv-10", ""])
  })
  it("keeps blanks last when descending", () => {
    expect(sortRows(rows, (r) => r, true)).toEqual(["srv-10", "srv-9", "Alpha", ""])
  })
  it("leaves the input alone", () => {
    sortRows(rows, (r) => r)
    expect(rows[0]).toBe("srv-10")
  })
})

describe("isOverdue", () => {
  it("only counts days before today", () => {
    expect(isOverdue("2020-01-01 00:00:00.000Z")).toBe(true)
    expect(isOverdue(new Date(Date.now() + 864e5 * 2).toISOString())).toBe(false)
    expect(isOverdue("")).toBe(false)
  })
})

describe("samplesAt", () => {
  it("snaps each series to its own nearest sample", () => {
    const series = [{ values: [{ t: 0, v: 1 }, { t: 10, v: 2 }] }, { values: [{ t: 4, v: 3 }] }]
    expect(samplesAt(series, 7).map((s) => s.point.v)).toEqual([2, 3])
  })
})

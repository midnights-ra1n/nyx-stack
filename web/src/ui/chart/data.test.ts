import { describe, expect, it } from "vitest"
import { aggregate, autoBucket, bucketKey, compute, evaluate, fillBuckets, matches, OTHER, points, records, toCsv, type Field, type Row } from "./data"

const FIELDS: Field[] = [
  { key: "name", label: "Name", kind: "text" },
  { key: "category", label: "Category", kind: "text" },
  { key: "status", label: "Status", kind: "text" },
  { key: "price", label: "Price", kind: "number" },
  { key: "bought", label: "Bought", kind: "date" },
  { key: "tags", label: "Tags", kind: "tags" },
  { key: "spare", label: "Spare", kind: "bool" },
]
const ROWS: Row[] = [
  { id: "1", name: "pve-1", category: "Server", status: "In service", price: 900, bought: "2025-01-10 10:00:00.000Z", tags: "lab, core", spare: false },
  { id: "2", name: "pve-2", category: "Server", status: "In service", price: 1100, bought: "2025-01-20 10:00:00.000Z", tags: "lab", spare: false },
  { id: "3", name: "sw-1", category: "Switch", status: "Spare", price: 200, bought: "2025-03-05 10:00:00.000Z", tags: "", spare: true },
  { id: "4", name: "nas", category: "NAS", status: "In service", price: "", bought: "", tags: "core", spare: false },
]
const NOW = Date.parse("2025-03-10T12:00:00Z")

describe("filters", () => {
  it("compare text without case, several values and tags", () => {
    expect(ROWS.filter((r) => matches(r, { field: "status", op: "is", value: "in service" }, FIELDS)).length).toBe(3)
    expect(ROWS.filter((r) => matches(r, { field: "category", op: "is", value: "Switch, NAS" }, FIELDS)).length).toBe(2)
    expect(ROWS.filter((r) => matches(r, { field: "tags", op: "is", value: "core" }, FIELDS)).map((r) => r.id)).toEqual(["1", "4"])
    expect(ROWS.filter((r) => matches(r, { field: "name", op: "has", value: "PVE" }, FIELDS)).length).toBe(2)
  })
  it("compare numbers, dates and emptiness", () => {
    expect(ROWS.filter((r) => matches(r, { field: "price", op: "gte", value: "900" }, FIELDS)).length).toBe(2)
    expect(ROWS.filter((r) => matches(r, { field: "bought", op: "last", value: "30" }, FIELDS, NOW)).map((r) => r.id)).toEqual(["3"])
    expect(ROWS.filter((r) => matches(r, { field: "bought", op: "empty" }, FIELDS)).map((r) => r.id)).toEqual(["4"])
    expect(ROWS.filter((r) => matches(r, { field: "spare", op: "is", value: "true" }, FIELDS)).map((r) => r.id)).toEqual(["3"])
  })
})

describe("functions", () => {
  it("count, sum, average, median and distinct", () => {
    expect(aggregate("count", ROWS)).toBe(4)
    expect(aggregate("sum", ROWS, "price")).toBe(2200)
    expect(aggregate("avg", ROWS, "price")).toBeCloseTo(733.33, 1)
    expect(aggregate("median", ROWS, "price")).toBe(900)
    expect(aggregate("distinct", ROWS, "category")).toBe(3)
    expect(aggregate("max", [], "price")).toBeNull()
  })
  it("formulas follow precedence, functions and missing values", () => {
    expect(evaluate("A / B * 100", { A: 3, B: 4 })).toBe(75)
    expect(evaluate("round((A + 1) / 3, 2)", { A: 1 })).toBe(0.67)
    // As in Excel, the minus sign applies before the power.
    expect(evaluate("-A ^ 2 + max(1, B)", { A: 2, B: 5 })).toBe(9)
    expect(evaluate("A / B", { A: 1, B: 0 })).toBeNull()
    expect(evaluate("A + B", { A: 1, B: null })).toBeNull()
    expect(() => evaluate("A +", { A: 1 })).toThrow()
    expect(() => evaluate("C * 2", { A: 1 })).toThrow()
  })
})

describe("groups", () => {
  it("counts per category, biggest first, with the rest folded", () => {
    const r = compute({ dataset: "hw", group: "category", measures: [{ id: "A", fn: "count" }], limit: 1, other: true }, ROWS, FIELDS)
    expect(r.cats).toEqual(["Server", OTHER])
    expect(r.series[0].values).toEqual([2, 2])
  })
  it("splits into series and computes formulas per cell", () => {
    const r = compute({ dataset: "hw", group: "category", split: "status", measures: [{ id: "A", fn: "sum", field: "price" }] }, ROWS, FIELDS)
    expect(r.series.map((s) => s.name)).toEqual(["In service", "Spare"])
    const f = compute({ dataset: "hw", measures: [{ id: "A", fn: "count", where: [{ field: "status", op: "is", value: "In service" }], hidden: true }, { id: "B", fn: "count", hidden: true }, { id: "C", fn: "count", formula: "A / B * 100" }] }, ROWS, FIELDS)
    expect(f.series).toHaveLength(1)
    expect(f.series[0].values).toEqual([75])
  })
  it("puts a row in each of its tags", () => {
    const r = compute({ dataset: "hw", group: "tags", measures: [{ id: "A", fn: "count" }], sort: "label" }, ROWS, FIELDS)
    expect(r.cats).toEqual(["core", "lab", ""])
    expect(r.series[0].values).toEqual([2, 2, 1])
  })
  it("buckets dates, fills the gaps and leaves undated rows out", () => {
    const r = compute({ dataset: "hw", group: "bought", bucket: "month", measures: [{ id: "A", fn: "count" }] }, ROWS, FIELDS)
    expect(r.cats).toEqual(["2025-01", "2025-02", "2025-03"])
    expect(r.series[0].values).toEqual([2, 0, 1])
    const cum = compute({ dataset: "hw", group: "bought", bucket: "month", measures: [{ id: "A", fn: "count" }], showAs: "cumulative" }, ROWS, FIELDS)
    expect(cum.series[0].values).toEqual([2, 2, 3])
  })
  it("makes ranges of a number", () => {
    const r = compute({ dataset: "hw", group: "price", bins: 2, measures: [{ id: "A", fn: "count" }] }, ROWS, FIELDS)
    expect(r.series[0].values).toEqual([1, 2, 1])
    expect(r.labels[2]).toBe("(empty)")
  })
  it("shares add up to 100", () => {
    const r = compute({ dataset: "hw", group: "category", measures: [{ id: "A", fn: "count" }], showAs: "share" }, ROWS, FIELDS)
    expect(r.series[0].values.reduce((a, b) => a! + b!, 0)).toBeCloseTo(100)
  })
})

describe("time", () => {
  it("picks a bucket for the span and keys sort in time", () => {
    expect(autoBucket(3600e3)).toBe("minute")
    expect(autoBucket(86400e3)).toBe("15min")
    expect(autoBucket(365 * 86400e3)).toBe("week")
    expect(bucketKey(new Date(2025, 0, 8).getTime(), "week")).toBe("2025-01-06")
    expect(bucketKey(new Date(2025, 10, 3).getTime(), "quarter")).toBe("2025-Q4")
    expect(fillBuckets(["2025-01-06 10:00", "2025-01-06 13:00"], "hour")).toHaveLength(4)
    expect(fillBuckets(["3"], "weekday")).toHaveLength(7)
  })
})

describe("points and lists", () => {
  it("scatter skips rows without both values", () => {
    expect(points({ dataset: "hw", x: "price", y: "bought", measures: [] }, ROWS, FIELDS, "name").map((p) => p.name)).toEqual(["pve-1", "pve-2", "sw-1"])
  })
  it("lists sort by date with empty values last", () => {
    expect(records({ dataset: "hw", order: "bought", desc: false, measures: [], limit: 3 }, ROWS, FIELDS).map((r) => r.id)).toEqual(["1", "2", "3"])
  })
  it("quotes CSV cells", () => {
    expect(toCsv(["a", "b"], [["x,y", 2], ['say "hi"', null]])).toBe('a,b\n"x,y",2\n"say ""hi""",')
  })
})

describe("number categories", () => {
  const fields: Field[] = [{ key: "cpu", label: "CPU", kind: "number", format: "pct" }, { key: "host", label: "Host", kind: "text" }]
  const rows: Row[] = [{ cpu: 0.008619637221, host: "a" }, { cpu: 5.843186855312, host: "b" }]
  it("read in the format of their field, not as the raw value", () => {
    const r = compute({ dataset: "m", where: [], group: "cpu", measures: [{ id: "A", fn: "count" }] }, rows, fields)
    expect(r.labels.map((l) => l.replace(/\s/g, " "))).toEqual(["0.01 %", "5.84 %"])
  })
  it("and so do their ranges", () => {
    const r = compute({ dataset: "m", where: [], group: "cpu", bins: 2, measures: [{ id: "A", fn: "count" }] }, rows, fields)
    expect(r.labels[0]).toMatch(/^0.01 % – 2.93 %$/)
  })
})

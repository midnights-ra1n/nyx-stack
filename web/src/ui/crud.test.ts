import { describe, expect, it } from "vitest"
import { bulkFields, type Col, columnChoices, tabsOf } from "./crud"

const COLS: Col[] = [
  { key: "category", label: "Category", type: "select", options: ["Server"], formOnly: true },
  { key: "name", label: "Name", required: true },
  { key: "category", label: "Category", type: "select", options: ["Server"], listOnly: true },
  { key: "serial", label: "Serial", mono: true },
  { key: "cpu", label: "CPU", formOnly: true },
  { key: "notes", label: "Notes", type: "area", formOnly: true },
  { key: "supplier", label: "Supplier", formOnly: true, tab: "Management" },
  { key: "price", label: "Price", type: "number", formOnly: true },
]

describe("record tabs", () => {
  it("opens a tab at each field naming one, the next fields follow it", () => {
    const t = tabsOf(COLS.filter((c) => !c.listOnly))
    expect(t.map((x) => x.id)).toEqual(["General", "Management"])
    expect(t[1].cols.map((c) => c.key)).toEqual(["supplier", "price"])
  })
})

describe("list columns", () => {
  it("offers each field once, at the place of its list version, and never long text", () => {
    const c = columnChoices(COLS)
    expect(c.map((x) => x.key)).toEqual(["name", "category", "serial", "cpu", "supplier", "price"])
    expect(c.find((x) => x.key === "category")?.listOnly).toBe(true)
  })

  it("sets in bulk only fields that are not unique to a record", () => {
    expect(bulkFields(COLS).map((c) => c.key)).toEqual(["category", "cpu", "supplier"])
  })
})

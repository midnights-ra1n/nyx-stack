import { describe, expect, it } from "vitest"
import { columns, hide, move, place, reconcile, restore, show, slotAt, without } from "./board"

const l = { cols: [["a", "b"], ["c"]], hidden: ["d"] }

describe("dashboard layout", () => {
  it("moves within and across columns, staying put at the edges", () => {
    expect(move(l, "b", "up").cols[0]).toEqual(["b", "a"])
    expect(move(l, "a", "up")).toEqual(l)
    expect(move(l, "a", "right").cols).toEqual([["b"], ["c", "a"]])
    expect(move(l, "a", "left")).toEqual(l)
  })
  it("places a dragged panel across and within columns", () => {
    expect(place(l, "a", 1, 0).cols).toEqual([["b"], ["a", "c"]])
    expect(place(l, "a", 0, 1).cols).toEqual([["b", "a"], ["c"]])
    expect(place(l, "c", 0, 2).cols).toEqual([["a", "b", "c"], []])
  })
  it("finds the drop slot from the pointer", () => {
    const left = { left: 0, right: 100, top: 0, bottom: 500, mids: [100, 300] }
    const right = { left: 120, right: 220, top: 0, bottom: 500, mids: [] }
    expect(slotAt([left, right], 50, 50)).toEqual({ c: 0, index: 0 })
    expect(slotAt([left, right], 50, 200)).toEqual({ c: 0, index: 1 })
    expect(slotAt([left, right], 400, 900)).toEqual({ c: 1, index: 0 })
    // Stacked columns on a narrow screen: only the height tells them apart.
    const below = { left: 0, right: 100, top: 520, bottom: 900, mids: [700] }
    expect(slotAt([left, below], 50, 800)).toEqual({ c: 1, index: 1 })
  })
  it("hides and restores into the least filled column", () => {
    expect(hide(l, "a")).toEqual({ cols: [["b"], ["c"]], hidden: ["d", "a"] })
    expect(show(l, "d")).toEqual({ cols: [["a", "b"], ["c", "d"]], hidden: [] })
  })
  it("changes the number of columns without losing panels", () => {
    expect(columns(l, 3).cols).toEqual([["a", "b"], ["c"], []])
    expect(columns(l, 1).cols).toEqual([["a", "b", "c"]])
    expect(columns(l, 1).hidden).toEqual(["d"])
  })
  it("keeps panels with nothing to show through an edit", () => {
    const full = { cols: [["a", "smart", "b"], ["c"]], hidden: ["node"] }
    const edited = move(without(full, ["smart", "node"]), "a", "right")
    expect(edited.cols).toEqual([["b"], ["c", "a"]])
    expect(restore(edited, full, ["smart", "node"])).toEqual({ cols: [["b", "smart"], ["c", "a"]], hidden: ["node"] })
    // A column removed while the panel was away must not take it along.
    expect(restore(columns(without(full, ["smart"]), 1), { cols: [["a"], ["smart"]], hidden: [] }, ["smart"]).cols).toEqual([["a", "b", "c", "smart"]])
  })
  it("drops unknown panels and offers new ones as hidden", () => {
    expect(reconcile(l, ["a", "c", "e"])).toEqual({ cols: [["a"], ["c"]], hidden: ["e"] })
  })
})

import { describe, expect, it } from "vitest"
import { hide, move, reconcile, show } from "./board"

const l = { cols: [["a", "b"], ["c"]], hidden: ["d"] }

describe("dashboard layout", () => {
  it("moves within and across columns, staying put at the edges", () => {
    expect(move(l, "b", "up").cols[0]).toEqual(["b", "a"])
    expect(move(l, "a", "up")).toEqual(l)
    expect(move(l, "a", "right").cols).toEqual([["b"], ["c", "a"]])
    expect(move(l, "a", "left")).toEqual(l)
  })
  it("hides and restores into the least filled column", () => {
    expect(hide(l, "a")).toEqual({ cols: [["b"], ["c"]], hidden: ["d", "a"] })
    expect(show(l, "d")).toEqual({ cols: [["a", "b"], ["c", "d"]], hidden: [] })
  })
  it("drops unknown panels and offers new ones as hidden", () => {
    expect(reconcile(l, ["a", "c", "e"])).toEqual({ cols: [["a"], ["c"]], hidden: ["e"] })
  })
})

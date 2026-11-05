import { describe, expect, it } from "vitest"
import { addPanel, bottom, COLS, nextScroll, type PanelCfg, place, slugify, template, themeVars } from "./model"

const p = (id: string, x: number, y: number, w: number, h: number) => ({ id, x, y, w, h, type: "text", title: "", items: [], metric: "", text: "", uptime: false }) as PanelCfg
const clash = (a: PanelCfg, b: PanelCfg) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe("place", () => {
  it("pushes covered panels down, and whatever they then cover", () => {
    const out = place([p("a", 0, 0, 12, 2), p("b", 0, 2, 12, 2), p("c", 0, 4, 12, 2)], "a", { x: 0, y: 0, w: 12, h: 5 })
    expect(out.map((x) => x.y)).toEqual([0, 5, 7])
  })

  it("leaves unrelated panels alone", () => {
    const out = place([p("a", 0, 0, 6, 2), p("b", 12, 0, 6, 2)], "a", { x: 0, y: 0, w: 6, h: 9 })
    expect(out[1]).toMatchObject({ x: 12, y: 0 })
  })

  it("keeps panels inside the grid and snaps to cells", () => {
    const [a] = place([p("a", 0, 0, 6, 2)], "a", { x: 30.4, y: -3, w: 6.2, h: 0 })
    expect(a).toMatchObject({ x: COLS - 6, y: 0, w: 6, h: 1 })
    expect(place([p("a", 0, 0, 6, 2)], "a", { x: 0, y: 0, w: 99, h: 2 })[0]).toMatchObject({ x: 0, w: COLS })
  })

  it("closes the hole a panel leaves behind", () => {
    const out = place([p("a", 0, 0, 24, 3), p("b", 0, 3, 24, 3)], "a", { x: 0, y: 20, w: 24, h: 3 })
    expect(out.map((x) => x.y)).toEqual([3, 0])
  })

  it("never leaves two panels overlapping", () => {
    let panels = [p("a", 0, 0, 8, 3), p("b", 8, 0, 8, 3), p("c", 16, 0, 8, 3), p("d", 0, 3, 24, 2), p("e", 4, 5, 8, 4)]
    for (const [id, x, y, w, h] of [["e", 0, 0, 24, 4], ["a", 6, 2, 12, 5], ["d", 3, 1, 9, 9]] as const) {
      panels = place(panels, id, { x, y, w, h })
      for (const a of panels) for (const b of panels) if (a !== b) expect(clash(a, b)).toBe(false)
    }
  })
})

describe("pages", () => {
  it("adds new panels below the rest", () => {
    const out = addPanel([p("a", 0, 0, 24, 4)], "clock")
    expect(out[1].y).toBe(4)
    expect(bottom(out)).toBe(7)
  })

  it("makes addresses from names", () => {
    expect(slugify("  Statut Général / Maison ")).toBe("statut-general-maison")
  })

  it("starts walls with a full board that fits the grid and has no overlap", () => {
    const { panels } = template("wall", "NOC")
    for (const a of panels) {
      expect(a.x + a.w).toBeLessThanOrEqual(COLS)
      for (const b of panels) if (a !== b) expect(clash(a, b)).toBe(false)
    }
  })

  it("picks readable text on a custom accent", () => {
    expect(themeVars("nyx", "#ffee00")).toMatchObject({ "--color-accent-ink": "#1b1209" })
    expect(themeVars("nyx", "#102040")).toMatchObject({ "--color-accent-ink": "#ffffff" })
    expect(themeVars("light", "").colorScheme).toBe("light")
  })
})

describe("nextScroll", () => {
  it("jumps to the first item that was cut off", () => expect(nextScroll(100, 300, 900, 280)).toBe(380))
  it("moves a full view when nothing can be aligned", () => expect(nextScroll(0, 300, 900, 0)).toBe(300))
  it("goes back to the top after the last page", () => expect(nextScroll(600, 300, 900, 0)).toBe(0))
})

import { describe, expect, it } from "vitest"
import { probeLevel, recentUptime } from "./pages"

describe("probe state", () => {
  const p = (over: any) => ({ up: true, readings: [], cert_days: null, warn_days: 21, ...over })
  it("ranks down, warnings and paused probes", () => {
    expect(probeLevel(p({}))).toBe("ok")
    expect(probeLevel(p({ up: false }))).toBe("crit")
    expect(probeLevel(p({ cert_days: 10 }))).toBe("warn")
    expect(probeLevel(p({ readings: [{ level: "crit" }] }))).toBe("crit")
    expect(probeLevel(p({}), false)).toBe("off")
    expect(probeLevel(undefined)).toBe("off")
  })
  it("counts recent checks", () => {
    expect(recentUptime([])).toBeNull()
    expect(recentUptime([true, true, false, true])).toBe(75)
  })
})

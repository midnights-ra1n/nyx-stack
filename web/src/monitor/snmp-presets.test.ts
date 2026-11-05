import { describe, expect, it } from "vitest"
import { PRESETS } from "./snmp-presets"

describe("SNMP profiles", () => {
  for (const [name, items] of Object.entries(PRESETS)) {
    it(`${name} is well formed`, () => {
      // Labels key counters, rollups and alerts, so they must be unique.
      expect(new Set(items.map((i) => i.label)).size).toBe(items.length)
      for (const i of items) {
        expect(i.oid).toMatch(/^1(\.\d+)+$/)
        if (i.walk) expect(i.agg).toBeDefined()
        else expect(i.oid.endsWith(".0"), `${i.label}: a scalar GET needs its .0 instance`).toBe(true)
        if (i.warn !== undefined && i.crit !== undefined) expect(i.low ? i.warn > i.crit : i.warn < i.crit).toBe(true)
      }
    })
  }
})

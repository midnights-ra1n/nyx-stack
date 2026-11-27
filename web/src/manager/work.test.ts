import { describe, expect, it } from "vitest"
import { fromDeployment, fromIntervention, fromTask } from "./work"

describe("work items", () => {
  it("closes each kind on its own states", () => {
    expect(fromIntervention({ id: "i", title: "Swap disk", status: "doing" }).open).toBe(true)
    expect(fromIntervention({ id: "i", title: "Swap disk", status: "cancelled" }).open).toBe(false)
    expect(fromDeployment({ id: "d", name: "v2", status: "running" }).open).toBe(true)
    expect(fromDeployment({ id: "d", name: "v2", status: "failed" }).open).toBe(false)
    expect(fromDeployment({ id: "d", name: "v2" })).toMatchObject({ state: "planned", open: true })
  })
  it("keeps calendar events read-only, and behind us once their day has passed", () => {
    expect(fromTask({ id: "e", title: "Meeting", kind: "event", due: "2000-01-01 10:00:00.000Z" })).toMatchObject({ readOnly: true, open: false })
    expect(fromTask({ id: "t", title: "Rack", description: "- [x] a\n- [ ] b", done: false })).toMatchObject({ state: "todo", open: true, checklist: { done: 1, total: 2 } })
  })
})

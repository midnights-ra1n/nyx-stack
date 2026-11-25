import { describe, expect, it } from "vitest"
import { filterServices, type Service, serviceLevel, serviceWord, sinceFor } from "./services"

const svc = (o: Partial<Service>): Service => ({ name: "x", description: "", active: "active", sub: "running", enabled: "enabled", since: 0, pid: 0, mem: 0, cpu_pct: 0, restarts: 0, kind: "simple", result: "success", path: "", ...o })

describe("systemd services", () => {
  it("reads states the way a person would", () => {
    expect([serviceLevel(svc({})), serviceWord(svc({}))]).toEqual(["ok", "Running"])
    expect([serviceLevel(svc({ active: "failed", sub: "failed" })), serviceWord(svc({ active: "failed", sub: "failed" }))]).toEqual(["crit", "Failed"])
    expect([serviceLevel(svc({ active: "activating", sub: "auto-restart" })), serviceWord(svc({ active: "activating", sub: "auto-restart" }))]).toEqual(["warn", "Restarting"])
    expect([serviceLevel(svc({ sub: "exited" })), serviceWord(svc({ sub: "exited" }))]).toEqual(["info", "Done"])
    expect([serviceLevel(svc({ active: "inactive", sub: "dead" })), serviceWord(svc({ active: "inactive", sub: "dead" }))]).toEqual(["off", "Stopped"])
  })
  it("filters by text and by state, including what should run at boot but does not", () => {
    const rows = [svc({ name: "ssh", description: "OpenBSD Secure Shell" }), svc({ name: "nginx", active: "failed", sub: "failed" }), svc({ name: "cups", active: "inactive", sub: "dead", enabled: "disabled" }), svc({ name: "cron", active: "inactive", sub: "dead" })]
    const names = (l: Service[]) => l.map((s) => s.name)
    expect(names(filterServices(rows, "shell", ""))).toEqual(["ssh"])
    expect(names(filterServices(rows, "", "failed"))).toEqual(["nginx"])
    expect(names(filterServices(rows, "", "stopped"))).toEqual(["cups", "cron"])
    expect(names(filterServices(rows, "", "enabled-stopped"))).toEqual(["nginx", "cron"])
  })
  it("says how long, or a dash when systemd did not say", () => {
    expect(sinceFor(0)).toBe("—")
    expect(sinceFor(1000, 1000 + 2 * 86400)).toMatch(/^2/)
  })
})

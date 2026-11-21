import { describe, expect, it } from "vitest"
import { alertBody, bars, parseProbes, renderStatus, step, uptime } from "./status"

const T = Date.UTC(2026, 10, 21, 12)

describe("edge checks", () => {
  it("goes down after failures in a row, up on the first success", () => {
    let s = step(undefined, false, null, T, 2)
    expect([s.next.up, s.changed]).toEqual([true, false])
    s = step(s.next, false, null, T + 60_000, 2)
    expect([s.next.up, s.changed, s.next.since]).toEqual([false, true, T + 60_000])
    s = step(s.next, false, null, T + 120_000, 2)
    expect(s.changed).toBe(false)
    s = step(s.next, true, 40, T + 180_000, 2)
    expect([s.next.up, s.changed, s.next.fails, s.next.ms]).toEqual([true, true, 0, 40])
  })

  it("keeps only well-formed probes", () => {
    const p = parseProbes(JSON.stringify([
      { name: "Blog", url: "https://blog.example.org" }, { name: "SSH", url: "tcp://h.example.org:22" },
      { name: "No port", url: "tcp://h.example.org" }, { name: "FTP", url: "ftp://x" }, { name: "instance", url: "https://x" }, { url: "https://x" },
    ]))
    expect(p.map((x) => x.name)).toEqual(["Blog", "SSH"])
    expect(parseProbes("not json")).toEqual([])
    expect(parseProbes(undefined)).toEqual([])
  })

  it("computes uptime over days and fills missing ones", () => {
    const days = [{ day: "2026-11-21", up: 9, total: 10 }, { day: "2026-11-15", up: 10, total: 10 }, { day: "2026-10-01", up: 0, total: 10 }]
    expect(uptime(days, T, 1)).toBe(0.9)
    expect(uptime(days, T, 7)).toBe(0.95)
    expect(uptime([], T, 7)).toBeNull()
    const b = bars(days, T)
    expect(b).toHaveLength(30)
    expect(b.at(-1)).toEqual({ day: "2026-11-21", pct: 0.9 })
    expect(b[0].pct).toBeNull()
  })

  it("writes one alert and an escaped page", () => {
    const a = alertBody("Nyx", [{ name: "instance", up: false }, { name: "Blog", up: true }], (n) => n)
    expect(a.title).toBe("Nyx: down")
    expect(a.content).toContain("🔴 instance is down\n🟢 Blog is back up")
    const html = renderStatus({ name: "<b>", at: T, checks: [{ name: "x", up: false, since: T, ms: null, uptime: { d1: 1, d7: null, d30: 0.5 }, days: [] }] }, (n) => n)
    expect(html).not.toContain("<b>")
    expect(html).toContain("1 of 1 down")
    expect(html).toContain("50.00 %")
  })
})

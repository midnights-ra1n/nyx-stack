import { describe, expect, it } from "vitest"
import { logRows, parseLog } from "./logs"

describe("log lines", () => {
  it("reads the priority, service and message", () => {
    expect(parseLog("1793000000 <3> sshd: bad key: rsa", "web")).toEqual({ t: 1793000000, level: "crit", service: "sshd", message: "bad key: rsa", host: "web", count: 1 })
    expect(parseLog("1 <4> a: b").level).toBe("warn")
    expect(parseLog("1 <6> a: b").level).toBe("info")
  })
  it("reads the journal lines of older agents as warnings", () => {
    const r = parseLog("2026-11-06T10:00:00+0100 web-01 sshd[123]: Failed password")
    expect([r.t, r.level, r.service, r.message]).toEqual([Date.UTC(2026, 10, 6, 9) / 1000, "warn", "sshd", "Failed password"])
  })
  it("keeps a line it cannot read", () => {
    expect(parseLog("-- No entries --").message).toBe("-- No entries --")
  })
  it("sorts newest first and folds repeats per host", () => {
    const rows = logRows([{ line: "1 <3> a: x", host: "h" }, { line: "3 <3> a: x", host: "h" }, { line: "2 <4> b: y", host: "h" }, { line: "2 <3> a: x", host: "other" }])
    expect(rows.map((r) => [r.t, r.host, r.count])).toEqual([[3, "h", 2], [2, "h", 1], [2, "other", 1]])
  })
})

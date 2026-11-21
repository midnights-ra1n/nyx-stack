import { describe, expect, it } from "vitest"
import { dnsRunState } from "./hosts"

describe("dnsRunState", () => {
  it("fills in the hosts whose agent answered and leaves the others waiting", () => {
    const runs = [
      { host: "a", name: "a", id: "c1", output: "Waiting" },
      { host: "b", name: "b", id: "c2", output: "Waiting" },
      { host: "c", name: "c", ok: false, output: "not found" },
    ]
    const out = dnsRunState(runs, [{ id: "c1", ok: true, output: "DNS set to 1.1.1.1" }, { id: "zz", ok: false, output: "other" }])
    expect(out.map((r) => r.ok)).toEqual([true, undefined, false])
    expect(out[0].output).toBe("DNS set to 1.1.1.1")
    expect(out[2].output).toBe("not found")
  })
})

describe("looksLikeIp", () => {
  it("takes one IPv4 or IPv6 address and nothing else", async () => {
    const { looksLikeIp } = await import("./pages")
    expect(["1.1.1.1", "2606:4700:4700::1111", "::1"].every(looksLikeIp)).toBe(true)
    expect(["dns.google", "1.1.1.1, 9.9.9.9", "1.1.1"].some(looksLikeIp)).toBe(false)
  })
})

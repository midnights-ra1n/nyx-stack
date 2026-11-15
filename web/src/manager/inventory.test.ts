import { describe, expect, it } from "vitest"
import { peerOf, warranty } from "./inventory"
import { cables } from "./map"

describe("warranty", () => {
  const now = Date.parse("2026-11-15")
  it("is unknown without a date", () => {
    expect(warranty(undefined, now)).toBeNull()
    expect(warranty("", now)).toBeNull()
  })
  it("is expired the day after its end", () => expect(warranty("2026-11-14 00:00:00.000Z", now)?.level).toBe("crit"))
  it("warns within 60 days", () => {
    expect(warranty("2026-11-15 00:00:00.000Z", now)).toEqual({ level: "warn", label: "Ends today" })
    expect(warranty("2027-01-14 00:00:00.000Z", now)).toEqual({ level: "warn", label: "Ends in 60 days" })
  })
  it("runs past 60 days", () => expect(warranty("2027-06-01 00:00:00.000Z", now)?.level).toBe("ok"))
})

describe("network ports", () => {
  const ports = [
    { id: "p1", device: "sw", name: "1", peer: "p2" },
    { id: "p2", device: "pve", name: "eno1", peer: "" },
    { id: "p3", device: "sw", name: "2", peer: "" },
  ]

  it("finds the far end whichever port keeps the cable", () => {
    expect(peerOf(ports[0], ports)?.id).toBe("p2")
    expect(peerOf(ports[1], ports)?.id).toBe("p1")
    expect(peerOf(ports[2], ports)).toBeUndefined()
  })

  it("draws one cable per pair of devices on the map, unless a link joins them", () => {
    const node = (d: string) => ({ sw: "n1", pve: "n2" })[d]
    expect(cables([], ports, node)).toEqual([{ id: "p1", source: "n1", target: "n2", label: "1 – eno1", cable: true }])
    expect(cables([{ id: "l", source: "n2", target: "n1" }], ports, node)).toEqual([])
  })
})

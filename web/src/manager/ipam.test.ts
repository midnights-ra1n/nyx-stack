import { describe, expect, it } from "vitest"
import { addressMap, ip4, ip4str } from "./ipam"
import { parseLinks } from "./overview"

describe("ipam helpers", () => {
  it("converts IPv4 both ways and rejects the rest", () => {
    expect(ip4("192.168.1.10")).toBe(3232235786)
    expect(ip4str(3232235786)).toBe("192.168.1.10")
    expect(ip4("256.0.0.1")).toBeNull()
    expect(ip4("fe80::1")).toBeNull()
  })

  it("maps a /29 cell by cell", () => {
    const cells = addressMap("10.0.0.0/29", "10.0.0.1", [{ address: "10.0.0.2", state: "Reserved" }], ["10.0.0.3"], ["10.0.0.4"])!
    expect(cells.map((c) => c.kind)).toEqual(["network", "gateway", "Reserved", "alive", "seen", "free", "free", "broadcast"])
  })

  it("does not draw large or IPv6 subnets", () => {
    expect(addressMap("10.0.0.0/16", "", [], [], [])).toBeNull()
    expect(addressMap("2001:db8::/64", "", [], [], [])).toBeNull()
  })
})

describe("link widget", () => {
  it("keeps only http(s) links", () => {
    expect(parseLinks("Proxmox | https://pve.lan:8006\nbad | javascript:alert(1)\nhttp://bare.lan")).toEqual([
      { label: "Proxmox", url: "https://pve.lan:8006" },
      { label: "http://bare.lan", url: "http://bare.lan" },
    ])
  })
})

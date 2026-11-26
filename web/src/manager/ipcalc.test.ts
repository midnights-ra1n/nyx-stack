import { describe, expect, it } from "vitest"
import { calc, ip4, kindOf, parse, split } from "./ipcalc"

describe("ip calculator", () => {
  it("reads a prefix, a mask or nothing", () => {
    expect(parse("192.168.1.37/26")).toEqual({ ip: ip4("192.168.1.37"), prefix: 26, assumed: false })
    expect(parse(" 192.168.1.37 255.255.255.192 ")?.prefix).toBe(26)
    expect(parse("10.0.0.1")).toMatchObject({ prefix: 24, assumed: true })
    expect(parse("10.0.0.1/33")).toBeNull()
    expect(parse("10.0.0.1 255.0.255.0")).toBeNull()
    expect(parse("nope")).toBeNull()
  })

  it("works out the network", () => {
    const c = calc(ip4("192.168.1.37")!, 26)
    expect(c).toMatchObject({ network: "192.168.1.0", broadcast: "192.168.1.63", first: "192.168.1.1", last: "192.168.1.62", usable: 62, netmask: "255.255.255.192", wildcard: "0.0.0.63", kind: "Private" })
    expect(c.bits).toEqual(["11000000.10101000.00000001.00", "100101"])
    expect(calc(ip4("10.0.0.0")!, 31)).toMatchObject({ first: "10.0.0.0", last: "10.0.0.1", usable: 2 })
    expect(calc(ip4("8.8.8.8")!, 32)).toMatchObject({ usable: 1, kind: "Public" })
    expect(calc(ip4("1.2.3.4")!, 0)).toMatchObject({ network: "0.0.0.0", broadcast: "255.255.255.255", netmask: "0.0.0.0" })
  })

  it("names special ranges", () => {
    expect(kindOf(ip4("100.100.1.1")!)).toBe("Shared (CGNAT)")
    expect(kindOf(ip4("172.31.255.1")!)).toBe("Private")
    expect(kindOf(ip4("172.32.0.1")!)).toBe("Public")
    expect(kindOf(ip4("239.1.1.1")!)).toBe("Multicast")
  })

  it("splits a network", () => {
    expect(split(ip4("10.0.0.0")!, 24, 26)).toEqual({ list: ["10.0.0.0/26", "10.0.0.64/26", "10.0.0.128/26", "10.0.0.192/26"], count: 4 })
    expect(split(ip4("10.0.0.0")!, 16, 24, 3)).toEqual({ list: ["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24"], count: 256 })
  })
})

import { describe, expect, it } from "vitest"
import { reach } from "./firewall"

const rule = (r: any) => ({ action: "allow", proto: "", port: "", source: "", iface: "", comment: "", ...r })
const fw = (rules: any[], default_in = "drop") => ({ active: true, default_in, rules })

describe("reach", () => {
  it("takes the first rule for the port, else the default", () => {
    const f = fw([rule({ comment: "state related,established" }), rule({ action: "deny", source: "10.0.0.5" }), rule({ proto: "tcp", port: "22", source: "192.168.1.0/24" }), rule({ proto: "tcp", port: "80,443" }), rule({ proto: "tcp", port: "8000:8100" })])
    expect(reach(f, { proto: "tcp", port: 443 })).toBe("open")
    expect(reach(f, { proto: "tcp", port: 8050 })).toBe("open")
    expect(reach(f, { proto: "tcp", port: 22 })).toBe("restricted")
    expect(reach(f, { proto: "udp", port: 443 })).toBe("blocked")
    expect(reach(fw([], "accept"), { proto: "tcp", port: 3000 })).toBe("open")
  })

  it("judges ports published by Docker on DOCKER-USER alone", () => {
    const f = fw([rule({ proto: "tcp", port: "8080", action: "deny" }), rule({ chain: "DOCKER-USER", proto: "tcp", port: "3001", source: "192.168.1.0/24" }), rule({ chain: "DOCKER-USER", proto: "tcp", port: "3001", action: "deny" })])
    expect(reach(f, { proto: "tcp", port: 8080, docker: true })).toBe("open")
    expect(reach(f, { proto: "tcp", port: 8080 })).toBe("blocked")
    expect(reach(f, { proto: "tcp", port: 3001, docker: true })).toBe("restricted")
    expect(reach({ ...fw([]), active: false }, { proto: "tcp", port: 9000, docker: true })).toBe("open")
  })

  it("knows firewalld services and an inactive firewall", () => {
    expect(reach(fw([rule({ port: "ssh" })]), { proto: "tcp", port: 22 })).toBe("open")
    expect(reach({ ...fw([]), active: false }, { proto: "tcp", port: 22 })).toBe("open")
    expect(reach(fw([rule({ action: "deny", proto: "tcp", port: "3306" })], "accept"), { proto: "tcp", port: 3306 })).toBe("blocked")
  })
})

import { describe, expect, it } from "vitest"
import { buildTree, consoleUrl } from "./hosts"

const pve = { id: "p", kind: "proxmox", hostname: "pve1", guests: [{ vmid: 101, name: "web", kind: "lxc", node: "pve1" }, { vmid: 102, name: "db", kind: "qemu", node: "pve1" }] }
const ct = { id: "c", parent: "p", vmid: 101 }

describe("host tree", () => {
  it("nests agents and shows only agent-less guests as extra rows", () => {
    const rows = buildTree([pve, ct], (h) => h.guests ?? [], new Set())
    expect(rows.map((r) => [r.host?.id ?? r.guest.name, r.depth])).toEqual([["p", 0], ["c", 1], ["db", 1]])
  })
  it("recognises a guest whose agent was installed by hand, without a vmid", () => {
    const vm = { id: "v", parent: "p", name: "db", vmid: 0 }
    const rows = buildTree([pve, vm], (h) => h.guests ?? [], new Set())
    expect(rows.map((r) => r.host?.id ?? r.guest.name)).toEqual(["p", "v", "web"])
  })
  it("collapses children and treats orphans as roots", () => {
    expect(buildTree([pve, ct], (h) => h.guests ?? [], new Set(["p"]))).toHaveLength(1)
    expect(buildTree([{ id: "x", parent: "gone" }], () => [], new Set())[0].depth).toBe(0)
  })
})

describe("noVNC links", () => {
  it("targets the right console type", () => {
    expect(consoleUrl("https://pve:8006/", pve)).toBe("https://pve:8006/?novnc=1&console=shell&node=pve1")
    expect(consoleUrl("https://pve:8006", pve, pve.guests[1])).toContain("console=kvm&vmid=102")
    expect(consoleUrl("", pve)).toBe("")
  })
})

import { describe, expect, it } from "vitest"
import { buildTree, consoleUrl, hostType, noAgent, updateRun } from "./hosts"

const pve = { id: "p", kind: "proxmox", hostname: "pve1", guests: [{ vmid: 101, name: "web", kind: "lxc", node: "pve1" }, { vmid: 102, name: "db", kind: "qemu", node: "pve1" }] }
const ct = { id: "c", parent: "p", vmid: 101 }

describe("hostType", () => {
  const hosts = [pve, { id: "v", kind: "vm", parent: "p", name: "db" }, { id: "n", kind: "vm", parent: "p", name: "web" }]
  it("tells containers from VMs through the Proxmox parent", () => {
    expect(hostType({ kind: "vm", vmid: 101 }, hosts)).toBe("ct")
    expect(hostType(hosts[1], hosts)).toBe("vm")
    expect(hostType(hosts[2], hosts)).toBe("ct")
  })
  it("takes the type containers now report", () => {
    expect(hostType({ kind: "lxc", vmid: 101 }, [])).toBe("ct")
  })
  it("keeps the kind of everything else", () => {
    expect(["vps", "physical", "proxmox"].map((kind) => hostType({ kind }, hosts))).toEqual(["vps", "physical", "proxmox"])
    expect(hostType({ kind: "vm" }, [])).toBe("vm")
  })
})

describe("update run", () => {
  const host = (id: string, started: number, pct: number, done = false) => ({ id, update: { started, pct, done } })

  it("averages the hosts and counts the finished ones", () => {
    const { run, done, pct, last } = updateRun([host("a", 10, 100, true), host("b", 11, 50), { id: "c" }], 0)
    expect([run.map((h) => h.id), done, pct, last]).toEqual([["a", "b"], 1, 75, 11])
  })
  it("leaves out what was dismissed, until a newer update starts", () => {
    expect(updateRun([host("a", 10, 100, true)], 10).run).toEqual([])
    expect(updateRun([host("a", 11, 0)], 10).run).toHaveLength(1)
  })
  it("has nothing to show on an idle fleet", () => {
    expect(updateRun([], 5)).toEqual({ run: [], done: 0, pct: 0, last: 5 })
  })
})

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
  it("does not repeat a guest whose agent sits at the top level", () => {
    const rows = buildTree([pve, { id: "v", name: "db", vmid: 0 }, { id: "w", hostname: "web", vmid: 0 }], (h) => h.guests ?? [], new Set())
    expect(rows.map((r) => r.host?.id ?? r.guest.name)).toEqual(["p", "v", "w"])
  })
  it("collapses children and treats orphans as roots", () => {
    expect(buildTree([pve, ct], (h) => h.guests ?? [], new Set(["p"]))).toHaveLength(1)
    expect(buildTree([{ id: "x", parent: "gone" }], () => [], new Set())[0].depth).toBe(0)
  })
})

describe("noAgent", () => {
  it("is only true for a container measured by its node", () => {
    expect([noAgent({ kind: "lxc" }), noAgent({ kind: "lxc", agent_version: "0.1.0" }), noAgent({ kind: "vm" })]).toEqual([true, false, false])
  })
})

describe("noVNC links", () => {
  it("targets the right console type", () => {
    expect(consoleUrl("https://pve:8006/", pve)).toBe("/api/proxmox/console?console=shell&node=pve1")
    expect(consoleUrl("https://pve:8006", pve, pve.guests[1])).toContain("console=kvm&vmid=102")
    expect(consoleUrl("", pve)).toBe("")
  })
})

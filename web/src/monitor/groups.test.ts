import { describe, expect, it } from "vitest"
import { averages, inScope, regroup, scopeOptions } from "./groups"

const hosts = [
  { id: "a", name: "pve", kind: "proxmox", tags: ["rack"], status: "ok", cpu: 20, mem: 40, temp: 50 },
  { id: "b", name: "web", kind: "vm", parent: "a", tags: ["rack", "prod"], status: "ok", cpu: 60, mem: 80, temp: null },
  { id: "c", name: "nas", kind: "physical", tags: [], status: "ok", cpu: 10, mem: 30, temp: 40 },
  { id: "d", name: "old", kind: "vm", tags: [], status: "off", cpu: 99, mem: 99, temp: null },
]

describe("inScope", () => {
  it("keeps every host, a type, a group or one host", () => {
    const ids = (scope: string) => hosts.filter((h) => inScope(h, scope, hosts)).map((h) => h.id)
    expect(ids("")).toEqual(["a", "b", "c", "d"])
    expect(ids("type:vm")).toEqual(["b", "d"])
    expect(ids("tag:rack")).toEqual(["a", "b"])
    expect(ids("host:c")).toEqual(["c"])
  })
  it("lists types and groups under their heading, hosts only when asked", () => {
    expect(scopeOptions(hosts).map((o) => o.value)).toEqual(["", "type:proxmox", "type:vm", "type:physical", "tag:prod", "tag:rack", "host:a", "host:b", "host:c", "host:d"])
    expect(scopeOptions(hosts, false).some((o) => o.value.startsWith("host:"))).toBe(false)
  })
})

describe("averages", () => {
  it("counts online hosts, and only those with a sensor for the temperature", () => {
    expect(averages(hosts)).toEqual({ n: 3, sensors: 2, cpu: 30, mem: 50, temp: 45 })
    expect(averages(hosts.filter((h) => h.kind === "vm")).temp).toBeNull()
  })
})

describe("regroup", () => {
  it("adds and removes the group, touching only the hosts that change", () => {
    expect(regroup(hosts, "", "prod", ["b", "c"])).toEqual([{ id: "c", tags: ["prod"] }])
    expect(regroup(hosts, "rack", "lab", ["a"])).toEqual([{ id: "a", tags: ["lab"] }, { id: "b", tags: ["prod"] }])
  })
  it("deletes a group from every host", () => {
    expect(regroup(hosts, "rack", "", [])).toEqual([{ id: "a", tags: [] }, { id: "b", tags: ["prod"] }])
  })
})

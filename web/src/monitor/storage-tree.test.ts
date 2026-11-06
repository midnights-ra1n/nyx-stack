import { describe, expect, it } from "vitest"
import { storageTree } from "./storage-tree"

const hosts = [{ id: "pve", name: "pve", kind: "proxmox" }, { id: "web", name: "web", kind: "vm", parent: "pve" }, { id: "nas", name: "nas", kind: "physical" }]
const mount = (host_id: string, mount: string, pct: number) => ({ host_id, mount, pct })
const storage = [mount("pve", "/boot/efi", 6), mount("pve", "/", 9), mount("web", "/", 95), mount("nas", "/", 40)]
const shape = (rows: ReturnType<typeof storageTree>) => rows.map((r) => [r.depth, r.host?.name ?? "", r.mount ?? "", r.pct ?? null])

describe("storageTree", () => {
  it("nests guests and mount points, with one row for a single mount point", () => {
    expect(shape(storageTree(hosts, storage, [], new Set()))).toEqual([
      [0, "pve", "", null], [1, "", "/", 9], [1, "", "/boot/efi", 6], [1, "web", "/", 95], [0, "nas", "/", 40],
    ])
  })
  it("shows the fullest mount point of everything a collapsed host holds", () => {
    expect(shape(storageTree(hosts, storage, [], new Set(["pve"])))).toEqual([[0, "pve", "", 95], [0, "nas", "/", 40]])
  })
  it("leaves out hidden mount points and hosts with nothing left", () => {
    expect(shape(storageTree(hosts, storage, ["pve/boot/efi", "nas/"], new Set()))).toEqual([[0, "pve", "/", 9], [1, "web", "/", 95]])
  })
  it("keeps a parent without mount points as a header for its guests", () => {
    expect(shape(storageTree(hosts, storage, ["pve/boot/efi", "pve/", "nas/"], new Set()))).toEqual([[0, "pve", "", null], [1, "web", "/", 95]])
  })
  it("cannot collapse what has nothing inside", () => {
    expect(shape(storageTree(hosts, storage, [], new Set(["nas"])))[4]).toEqual([0, "nas", "/", 40])
  })
})

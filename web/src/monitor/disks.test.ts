import { describe, expect, it } from "vitest"
import { capacity } from "./disks"

describe("storage capacity", () => {
  it("adds up plain file systems", () => {
    expect(capacity([{ host_id: "a", device: "/dev/sda1", used: 10, total: 30 }, { host_id: "b", device: "/dev/sda1", used: 5, total: 10 }])).toEqual({ used: 15, free: 25, total: 40 })
  })
  it("counts the free space of a ZFS pool once, per host", () => {
    const d = (host_id: string, device: string, used: number) => ({ host_id, fs: "zfs", device, used, total: used + 100 })
    expect(capacity([d("a", "rpool/ROOT", 10), d("a", "rpool/data", 20), d("b", "rpool/ROOT", 5)])).toEqual({ used: 35, free: 200, total: 235 })
  })
})

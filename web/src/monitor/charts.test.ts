import { describe, expect, it } from "vitest"
import { type ChartCfg, chartHosts, chartTitle } from "./charts"
import { axis, combine, pointsOf } from "./metrics"
import { updateRank } from "./updates"
import { filterHosts } from "./hosts"
import { splitTags } from "../ui/tags"
import { findHost } from "../manager/live"

const hosts = [
  { id: "a", name: "pve", tags: ["lab", "prod"], status: "ok" },
  { id: "b", name: "web", tags: ["prod"], status: "ok" },
  { id: "c", name: "nas", tags: [], status: "ok" },
]
const chart = (o: Partial<ChartCfg>): ChartCfg => ({ id: "x", title: "", metric: "cpu", source: "all", show: "each", look: "line", ...o })
const vars = { host: "", tag: "", range: "24h" }
const ids = (l: any[]) => l.map((h) => h.id)

describe("custom charts", () => {
  it("takes the hosts of a source, filling in the variables", () => {
    expect(ids(chartHosts(chart({}), hosts, vars))).toEqual(["a", "b", "c"])
    expect(ids(chartHosts(chart({ source: "tag", tag: "prod" }), hosts, vars))).toEqual(["a", "b"])
    expect(ids(chartHosts(chart({ source: "$tag" }), hosts, { ...vars, tag: "lab" }))).toEqual(["a"])
    expect(ids(chartHosts(chart({ source: "$tag" }), hosts, vars))).toEqual(["a", "b", "c"]) // empty variable: all
    expect(ids(chartHosts(chart({ source: "$host" }), hosts, { ...vars, host: "c" }))).toEqual(["c"])
    expect(ids(chartHosts(chart({ source: "hosts", hosts: ["b"] }), hosts, vars))).toEqual(["b"])
  })
  it("reads variables in titles", () => {
    expect(chartTitle(chart({ title: "CPU of $host in $tag" }), hosts, { ...vars, host: "b", tag: "prod" })).toBe("CPU of web in prod")
  })
  it("folds hosts into their average or maximum per slot", () => {
    const lines = [[{ t: 0, v: 10 }, { t: 60, v: 20 }], [{ t: 5, v: 30 }, { t: 58, v: 40 }]]
    expect(combine(lines, "avg", 60)).toEqual([{ t: 0, v: 20 }, { t: 60, v: 30 }])
    expect(combine(lines, "max", 60)).toEqual([{ t: 0, v: 30 }, { t: 60, v: 40 }])
  })
  it("skips missing values and sensorless temperatures, and sizes the axis", () => {
    expect(pointsOf([{ t: 1, temp: 0 }, { t: 2, temp: 45 }, { t: 3 }], "temp")).toEqual([{ t: 2, v: 45 }])
    expect(axis("cpu", [3]).max).toBe(100)
    expect(axis("rx", [730]).max).toBe(1000)
  })
})

describe("tags and hosts", () => {
  it("splits, trims and dedupes tags from either form", () => {
    expect(splitTags(" lab, prod ,lab,")).toEqual(["lab", "prod"])
    expect(splitTags(["a", " a "])).toEqual(["a"])
    expect(splitTags(undefined)).toEqual([])
  })
  it("filters hosts by tag, and finds tags by search", () => {
    expect(ids(filterHosts(hosts, "", "", "", "prod"))).toEqual(["a", "b"])
    expect(ids(filterHosts(hosts, "lab", "", "", ""))).toEqual(["a"])
  })
  it("puts security fixes first, then restarts", () => {
    const order = [{ updates: 3 }, { agent_outdated: true }, { reboot_required: true }, { updates: 1, security: 1 }, {}].sort((x, y) => updateRank(x) - updateRank(y))
    expect(order.map(updateRank)).toEqual([0, 1, 2, 3, 4])
  })
  it("matches an inventory record to a monitored host by name or address", () => {
    const live = [{ name: "PVE", hostname: "pve.lan", ip: "10.0.0.2" }]
    expect(findHost(live, { name: "pve" })).toBe(live[0])
    expect(findHost(live, { name: "x", ip: "10.0.0.2" })).toBe(live[0])
    expect(findHost(live, { name: "x", ip: "" })).toBeUndefined()
    expect(findHost(null, { name: "pve" })).toBeUndefined()
  })
})

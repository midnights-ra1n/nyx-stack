import { describe, expect, it } from "vitest"
import { upgradeChart } from "./charts"
import { ALL, chartLines, fromChart, toChart } from "./metric-chart"
import { axis, combine, pointsOf } from "./metrics"
import { updateRank } from "./updates"
import { filterHosts } from "./hosts"
import { splitTags } from "../ui/tags"

const hosts = [
  { id: "a", name: "pve", tags: ["lab", "prod"], status: "ok" },
  { id: "b", name: "web", tags: ["prod"], status: "ok" },
  { id: "c", name: "nas", tags: [], status: "ok" },
]
const ids = (l: any[]) => l.map((h) => h.id)

describe("metric charts", () => {
  const fleet = [
    { id: "a", name: "pve", tags: ["metal"], installed: true },
    { id: "b", name: "nas", tags: ["metal"], installed: true },
    { id: "c", name: "web", tags: ["vms"], installed: true },
  ]
  const series = {
    a: [{ t: 0, cpu: 10, temp: 50 }, { t: 60, cpu: 20, temp: 60 }],
    b: [{ t: 0, cpu: 30, temp: 40 }, { t: 60, cpu: 40, temp: 40 }],
    c: [{ t: 0, cpu: 50, temp: 0 }, { t: 60, cpu: 60 }],
  }
  const names = (c: Parameters<typeof chartLines>[0]) => chartLines(c, fleet, series).lines.map((l) => l.name)
  it("draws a line per group, named by the group, and leaves out groups without data", () => {
    const r = chartLines({ groups: ["metal", "vms"], metrics: ["cpu", "temp"], combine: "avg" }, fleet, series)
    expect(r.lines.map((l) => [l.name, l.values.map((p) => p.v)])).toEqual([["metal", [20, 30]], ["vms", [50, 60]], ["metal", [45, 50]]])
    expect(r.empty).toEqual(["vms · Temperature"])
  })
  it("names the metric when several share an axis, and the group only when there are several", () => {
    expect(names({ groups: ["metal"], metrics: ["cpu", "mem", "temp"], combine: "max" })).toEqual(["CPU", "metal"])
    expect(names({ groups: ["metal", "vms"], metrics: ["cpu", "mem"], combine: "max" })).toEqual(["metal · CPU", "vms · CPU"])
  })
  it("draws each host once, even in two groups", () => {
    expect(names({ groups: ["metal", ALL], metrics: ["cpu"], combine: "each" })).toEqual(["pve", "nas", "web"])
  })
  it("brings older charts to groups and metrics", () => {
    expect(upgradeChart({ id: "x", title: "CPU of $tag", metric: "cpu", source: "tag", tag: "prod", show: "avg", look: "bars" }))
      .toEqual({ id: "x", wide: undefined, type: "metrics", title: "CPU of prod", groups: ["prod"], metrics: ["cpu"], combine: "avg", look: "line" })
    expect(upgradeChart({ id: "y", groups: [ALL], metrics: ["mem"], combine: "max" })).toMatchObject({ type: "metrics" })
  })
  it("opens a simple chart in the full editor and back, keeping what it shows", () => {
    const simple = { id: "s", type: "metrics", title: "", groups: ["metal", "vms"], metrics: ["cpu", "temp"], combine: "max", look: "area" }
    const chart = toChart(simple)
    expect(chart.query).toMatchObject({ dataset: "metrics", group: "t", split: "tags", where: [{ field: "tags", op: "is", value: "metal, vms" }] })
    expect(chart.query.measures.map((m) => [m.fn, m.field])).toEqual([["max", "cpu"], ["max", "temp"]])
    expect(chart.look.type).toBe("area")
    expect(toChart({ ...simple, groups: [ALL], combine: "each" }).query).toMatchObject({ split: "host", where: [] })
    expect(fromChart({ id: "c", type: "chart", title: "", chart })).toEqual({ groups: [ALL], metrics: ["cpu", "temp"], combine: "max", look: "area", range: undefined })
    expect(fromChart({ id: "o", type: "chart", title: "", chart: { query: { dataset: "alerts", measures: [] }, look: { type: "pie" } } })).toEqual({})
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
})

import { describe, expect, it } from "vitest"
import type { Dataset } from "./data"
import { retype } from "./editor"

const ds: Dataset = { id: "metrics", label: "Metrics", fields: [{ key: "t", label: "Time", kind: "date" }, { key: "host", label: "Host", kind: "text" }, { key: "cpu", label: "CPU", kind: "number" }], load: async () => [] }
const card = { query: { dataset: "metrics", where: [], group: "t", split: "host", measures: [{ id: "A", fn: "avg" as const, field: "cpu" }] }, look: { type: "line" as const } }

describe("retype", () => {
  it("brings lines back to time after a look at the histogram", () => {
    const histogram = retype(card, "histogram", ds)
    expect(histogram.query.group).toBe("cpu")
    expect(retype(histogram, "line", ds).query.group).toBe("t")
  })
  it("keeps a category or ranges the lines were given", () => {
    expect(retype({ ...card, query: { ...card.query, group: "host" } }, "area", ds).query.group).toBe("host")
    expect(retype({ ...card, query: { ...card.query, group: "cpu", bins: 5 } }, "line", ds).query.group).toBe("cpu")
  })
})

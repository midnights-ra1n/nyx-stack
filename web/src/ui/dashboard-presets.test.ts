import { describe, expect, it } from "vitest"
import { fr } from "./fr"
import type { Dataset } from "./chart/data"
import { DATASETS as MANAGER } from "../manager/datasets"
import { PRESETS as MANAGER_PRESETS } from "../manager/presets"
import { DATASETS as MONITOR } from "../monitor/datasets"
import { PRESETS as MONITOR_PRESETS } from "../monitor/presets"
import type { TabPreset } from "./dashboard"

/** Every field a card reads that its rows do not have. */
function unknownFields(presets: TabPreset[], datasets: Dataset[]) {
  const out: string[] = []
  for (const p of presets)
    for (const card of p.cards) {
      if (!card.chart) continue // cards of the app's own kinds read no rows
      const q = card.chart.query
      const ds = datasets.find((d) => d.id === q.dataset)
      if (!ds) { out.push(`${card.title}: no rows named ${q.dataset}`); continue }
      const used = [q.group, q.split, q.order, q.x, q.y, ...(q.columns ?? []), ...(q.where ?? []).map((w: any) => w.field), ...q.measures.map((m: any) => m.field)]
      for (const f of used) if (f && !ds.fields.some((x) => x.key === f)) out.push(`${card.title}: ${f}`)
    }
  return out
}

describe("ready-made tabs", () => {
  it("only read fields their rows have", () => {
    expect(unknownFields(MANAGER_PRESETS, MANAGER)).toEqual([])
    expect(unknownFields(MONITOR_PRESETS, MONITOR)).toEqual([])
  })
  it("have French for their names, hints and card titles", () => {
    const texts = [...MANAGER_PRESETS, ...MONITOR_PRESETS].flatMap((p) => [p.name, p.hint, ...p.cards.map((c) => c.title)])
    expect(texts.filter((s) => !(s in fr))).toEqual([])
  })
})

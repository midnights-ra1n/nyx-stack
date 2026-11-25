import { niceMax } from "../ui/nextdns"
import { fmt } from "../ui/lib"

/** What a host reports over time, as `/api/series` gives it. */
export const METRICS = {
  cpu: { label: "CPU", pct: true },
  mem: { label: "Memory", pct: true },
  disk: { label: "Fullest disk", pct: true },
  temp: { label: "Temperature", format: (v: number) => fmt.temp(v) },
  rx: { label: "Network in", format: (v: number) => fmt.bps(v) },
  tx: { label: "Network out", format: (v: number) => fmt.bps(v) },
} as const
export type Metric = keyof typeof METRICS
export const METRIC_KEYS = Object.keys(METRICS) as Metric[]

export interface Point { t: number; v: number }

/** The points of one measure. A temperature of 0 is a host without a sensor, not a cold one. */
export const pointsOf = (rows: any[] | undefined, m: Metric): Point[] =>
  (rows ?? []).flatMap((p) => (typeof p[m] === "number" && !(m === "temp" && p[m] <= 0) ? [{ t: p.t, v: p[m] }] : []))

/** The top of the axis and how values read: 100 for a percentage, a round number above the highest value otherwise. */
export function axis(m: Metric, values: number[]): { max: number; format?: (v: number) => string; unit: string } {
  const def = METRICS[m]
  if ("pct" in def) return { max: 100, unit: " %" }
  return { max: niceMax(Math.max(1, ...values)), format: def.format, unit: "" }
}

/**
 * Several hosts as one line: the average or the highest value per time slot. Hosts
 * report at their own instants, so samples are grouped into slots of `step` seconds.
 */
export function combine(lines: Point[][], how: "avg" | "max", step: number): Point[] {
  const slots = new Map<number, number[]>()
  for (const p of lines.flat()) {
    const at = Math.round(p.t / step) * step
    slots.set(at, [...(slots.get(at) ?? []), p.v])
  }
  return [...slots].sort(([a], [b]) => a - b).map(([t, vs]) => ({ t, v: how === "max" ? Math.max(...vs) : vs.reduce((a, b) => a + b, 0) / vs.length }))
}

/** A slot about 1/150 of the time shown, at least a minute. */
export const slotFor = (lines: Point[][]) => {
  const ts = lines.flat().map((p) => p.t)
  return ts.length ? Math.max(60, (Math.max(...ts) - Math.min(...ts)) / 150) : 60
}

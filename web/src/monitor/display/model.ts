/** Page model shared by the viewer and the editor: a 24-column grid, like Grafana. */
export const COLS = 24

export type PanelType = "overall" | "services" | "tiles" | "stat" | "gauge" | "bars" | "timeseries" | "alerts" | "text" | "clock" | "tempo" | "map"
export interface Item { kind: "host" | "probe"; id: string; label: string }
export interface Box { x: number; y: number; w: number; h: number }
export interface PanelCfg extends Box { id: string; type: PanelType; title: string; items: Item[]; metric: string; text: string; uptime: boolean }
export interface PageConfig {
  title: string; description: string; footer: string; notice: string; notice_level: string
  logo: string; preset: string; accent: string; refresh_s: number; zoom: number; embed?: boolean; panels: PanelCfg[]
  /** On a wall: the pages shown in turn after this one, and for how long each. */
  rotate?: string[]; rotate_s?: number
}

export const PANEL_TYPES: { type: PanelType; label: string; w: number; h: number; title: string; metric?: string; uptime?: boolean }[] = [
  { type: "overall", label: "Overall status", w: 24, h: 2, title: "" },
  { type: "services", label: "Service list", w: 12, h: 8, title: "Services", uptime: true },
  { type: "tiles", label: "State tiles", w: 12, h: 6, title: "Status" },
  { type: "stat", label: "Big number", w: 6, h: 3, title: "Online", metric: "online" },
  { type: "gauge", label: "Gauges", w: 8, h: 5, title: "CPU", metric: "cpu" },
  { type: "bars", label: "Bar gauges", w: 8, h: 5, title: "Memory", metric: "mem" },
  { type: "timeseries", label: "Time series", w: 12, h: 6, title: "CPU", metric: "cpu" },
  { type: "alerts", label: "Open alerts", w: 8, h: 6, title: "Open alerts" },
  { type: "text", label: "Text", w: 8, h: 3, title: "Notes" },
  { type: "clock", label: "Clock", w: 4, h: 3, title: "" },
  { type: "tempo", label: "EDF Tempo", w: 24, h: 4, title: "" },
  { type: "map", label: "Live map", w: 24, h: 14, title: "" },
]

// Not crypto.randomUUID: browsers only offer it over HTTPS, and Nyx also runs on plain HTTP.
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")

const blank = { items: [], metric: "", text: "", uptime: false }
const panel = (type: PanelType, box: Box, over: Partial<PanelCfg> = {}): PanelCfg => {
  const d = PANEL_TYPES.find((p) => p.type === type)!
  return { ...blank, id: newId(), type, title: d.title, metric: d.metric ?? "", uptime: !!d.uptime, ...box, ...over }
}

/** A new panel goes under everything else, so it never covers existing work. */
export function addPanel(panels: PanelCfg[], type: PanelType): PanelCfg[] {
  const d = PANEL_TYPES.find((p) => p.type === type)!
  return [...panels, panel(type, { x: 0, y: bottom(panels), w: d.w, h: d.h })]
}

export const bottom = (panels: Box[]) => panels.reduce((m, p) => Math.max(m, p.y + p.h), 0)
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Slide everything up into free space, as Grafana does: a wall has no room for holes. */
function compact(panels: PanelCfg[]): PanelCfg[] {
  const settled: PanelCfg[] = []
  for (const p of [...panels].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let y = p.y
    while (y > 0 && !settled.some((s) => overlaps({ ...p, y: y - 1 }, s))) y--
    settled.push({ ...p, y })
  }
  return panels.map((p) => settled.find((s) => s.id === p.id)!)
}

/** Clamp a panel to the grid, push whatever it covers down, then close the gaps. */
export function place(panels: PanelCfg[], id: string, box: Box): PanelCfg[] {
  const w = Math.min(COLS, Math.max(2, Math.round(box.w)))
  const moved: Box = { w, h: Math.max(1, Math.round(box.h)), x: Math.min(COLS - w, Math.max(0, Math.round(box.x))), y: Math.max(0, Math.round(box.y)) }
  const settled: PanelCfg[] = [{ ...panels.find((p) => p.id === id)!, ...moved }]
  for (const p of panels.filter((p) => p.id !== id).sort((a, b) => a.y - b.y || a.x - b.x)) {
    let y = p.y
    while (settled.some((s) => overlaps({ ...p, y }, s))) y = Math.max(y + 1, ...settled.filter((s) => overlaps({ ...p, y }, s)).map((s) => s.y + s.h))
    settled.push({ ...p, y })
  }
  return compact(panels.map((p) => settled.find((s) => s.id === p.id)!))
}

/** Where a wall panel jumps next: to the first item cut off at the bottom, and back to the top after the last page. */
export function nextScroll(top: number, view: number, height: number, cut: number) {
  if (top + view >= height - 1) return 0
  return top + (cut > 1 ? cut : view)
}

export const slugify = (name: string) => name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)

export function template(kind: "status" | "wall", title: string, start = "standard"): PageConfig {
  const page = { title, description: "", footer: "", notice: "", notice_level: "", logo: "", preset: kind === "wall" ? "graphite" : "nyx", accent: "", refresh_s: kind === "wall" ? 15 : 60, zoom: 1 }
  if (start === "map") return { ...page, panels: [panel("overall", { x: 0, y: 0, w: 24, h: 2 }), panel("map", { x: 0, y: 2, w: 24, h: 18 })] }
  if (kind === "status") return { ...page, panels: [panel("overall", { x: 0, y: 0, w: 24, h: 2 }), panel("services", { x: 0, y: 2, w: 24, h: 8 })] }
  return { ...page, panels: [
    panel("stat", { x: 0, y: 0, w: 5, h: 3 }, { title: "Online", metric: "online" }),
    panel("stat", { x: 5, y: 0, w: 5, h: 3 }, { title: "Down", metric: "down" }),
    panel("stat", { x: 10, y: 0, w: 5, h: 3 }, { title: "Open alerts", metric: "alerts" }),
    panel("stat", { x: 15, y: 0, w: 5, h: 3 }, { title: "Availability, 30 days", metric: "availability" }),
    panel("clock", { x: 20, y: 0, w: 4, h: 3 }),
    panel("tiles", { x: 0, y: 3, w: 16, h: 9 }),
    panel("alerts", { x: 16, y: 3, w: 8, h: 9 }),
    panel("timeseries", { x: 0, y: 12, w: 12, h: 6 }, { title: "CPU", metric: "cpu" }),
    panel("timeseries", { x: 12, y: 12, w: 12, h: 6 }, { title: "Memory", metric: "mem" }),
  ] }
}

const PRESETS: Record<string, Record<string, string>> = {
  nyx: {},
  graphite: { bg: "#111217", sidebar: "#16181d", surface: "#181b1f", raised: "#22252b", line: "#272a31", line2: "#34373e", fg: "#d8d9da", fg2: "#b4b6bc", fg3: "#92949a", "off-soft": "#23252b", "ok-soft": "#1c2d27", "warn-soft": "#2f2a1c", "crit-soft": "#33211f", "info-soft": "#1e2835" },
  light: {
    bg: "#f3f2f0", sidebar: "#ebe9e6", surface: "#ffffff", raised: "#f0eeeb", line: "#e4e1dc", line2: "#d3cfc8", fg: "#201e1c", fg2: "#57524b", fg3: "#6b655d",
    accent: "#b85a1c", "accent-hover": "#a04c14", "accent-soft": "#f7e6d9", "accent-ink": "#ffffff",
    ok: "#1f7a5c", "ok-soft": "#dff1e8", warn: "#8a6100", "warn-soft": "#f7ecd0", crit: "#b3303c", "crit-soft": "#fae1e3", info: "#2867b2", "info-soft": "#dfeafa", off: "#6b655d", "off-soft": "#ebe9e5",
    s1: "#b85a1c", s2: "#2867b2", s3: "#6a55c2", s4: "#7a6a4f",
  },
}

/** Dark or light text, whichever reads on this colour. */
function inkFor(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#1b1209" : "#ffffff"
}

/** Tailwind colours are CSS variables, so a theme is just a set of overrides. */
export function themeVars(preset: string, accent: string) {
  const vars = Object.fromEntries(Object.entries(PRESETS[preset] ?? {}).map(([k, v]) => [`--color-${k}`, v]))
  if (accent) Object.assign(vars, { "--color-accent": accent, "--color-accent-hover": accent, "--color-s1": accent, "--color-accent-ink": inkFor(accent), "--color-accent-soft": `color-mix(in srgb, ${accent} 20%, var(--color-surface))` })
  return { ...vars, colorScheme: preset === "light" ? "light" : "dark" } as React.CSSProperties
}

export const uptimeBar = (v: number | null) => (v == null ? "bg-raised" : v >= 99.9 ? "bg-ok" : v >= 95 ? "bg-warn" : "bg-crit")

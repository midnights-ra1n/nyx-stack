/** The Worker's own uptime checks: what it decides and shows. No Cloudflare API here. */

export interface Probe { name: string; url: string }
export interface State { up: boolean; since: number; fails: number; ms: number | null }
export interface Check { name: string; up: boolean; since: number; ms: number | null; uptime: { d1: number | null; d7: number | null; d30: number | null }; days: { day: string; pct: number | null }[] }
export interface Summary { name: string; at: number; checks: Check[] }

/** `[{"name": "Blog", "url": "https://blog.example.org"}, {"name": "SSH", "url": "tcp://host:22"}]` */
export function parseProbes(json: string | undefined): Probe[] {
  let list: unknown
  try { list = JSON.parse(json || "[]") } catch { return [] }
  if (!Array.isArray(list)) return []
  return list.filter((p): p is Probe => typeof p?.name === "string" && p.name !== INSTANCE && typeof p?.url === "string" && validTarget(p.url))
}

export const INSTANCE = "instance"

function validTarget(url: string): boolean {
  try {
    const u = new URL(url.replace(/^tcp:\/\//, "http://"))
    return /^(https?|tcp):\/\//.test(url) && !!u.hostname && (!url.startsWith("tcp://") || !!u.port)
  } catch { return false }
}

/**
 * Down after `downAfter` failed checks in a row, back up on the first success, so one
 * lost packet does not page anyone. `changed` is the transition to announce.
 */
export function step(prev: State | undefined, ok: boolean, ms: number | null, now: number, downAfter: number): { next: State; changed: boolean } {
  const was = prev ?? { up: true, since: now, fails: 0, ms: null }
  const fails = ok ? 0 : was.fails + 1
  const up = ok || (was.up && fails < downAfter)
  const changed = up !== was.up
  return { next: { up, since: changed ? now : was.since, fails, ms }, changed }
}

export const day = (t: number) => new Date(t).toISOString().slice(0, 10)

/** Uptime over the last `n` days, from per-day counters. */
export function uptime(days: { day: string; up: number; total: number }[], now: number, n: number): number | null {
  const from = day(now - (n - 1) * 86_400_000)
  let up = 0, total = 0
  for (const d of days) if (d.day >= from) { up += d.up; total += d.total }
  return total ? up / total : null
}

export function bars(days: { day: string; up: number; total: number }[], now: number, n = 30) {
  const by = new Map(days.map((d) => [d.day, d]))
  return Array.from({ length: n }, (_, i) => {
    const k = day(now - (n - 1 - i) * 86_400_000)
    const d = by.get(k)
    return { day: k, pct: d?.total ? d.up / d.total : null }
  })
}

/** One message for every change of a minute: Discord, Slack, Gotify and Mattermost each read their own field. */
export function alertBody(name: string, changes: { name: string; up: boolean }[], label: (n: string) => string) {
  const lines = changes.map((c) => `${c.up ? "🟢" : "🔴"} ${label(c.name)} is ${c.up ? "back up" : "down"}`)
  const title = changes.every((c) => c.up) ? `${name}: recovered` : `${name}: down`
  const message = lines.join("\n")
  return { title, message, text: `*${title}*\n${message}`, content: `**${title}**\n${message}` }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const pct = (v: number | null) => (v === null ? "—" : `${(Math.floor(v * 10000) / 100).toFixed(2)} %`)

export function renderStatus(s: Summary, label: (n: string) => string): string {
  const down = s.checks.filter((c) => !c.up).length
  const rows = s.checks.map((c) => `
  <section>
    <div class="row"><h2><span class="dot ${c.up ? "ok" : "crit"}"></span>${esc(label(c.name))}</h2><span class="muted">${c.up ? "Up" : "Down"} since ${new Date(c.since).toISOString().slice(0, 16).replace("T", " ")} UTC${c.ms === null ? "" : ` · ${c.ms} ms`}</span></div>
    <div class="bars" role="img" aria-label="Daily uptime over 30 days">${c.days.map((d) => `<i class="${d.pct === null ? "none" : d.pct >= 0.999 ? "ok" : d.pct >= 0.95 ? "warn" : "crit"}" title="${d.day}: ${pct(d.pct)}"></i>`).join("")}</div>
    <dl><div><dt>24 h</dt><dd>${pct(c.uptime.d1)}</dd></div><div><dt>7 days</dt><dd>${pct(c.uptime.d7)}</dd></div><div><dt>30 days</dt><dd>${pct(c.uptime.d30)}</dd></div></dl>
  </section>`).join("")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><meta name="robots" content="noindex">
<title>${esc(s.name)} status</title><link rel="icon" href="/nyx-mark.svg">
<style>
:root{color-scheme:dark;--bg:#141a22;--surface:#1b232d;--line:#c5d3e51f;--fg:#edf1f6;--fg2:#bcc6d2;--ok:#91e3ae;--warn:#f2cf6d;--crit:#fb909e;--off:#3a4554}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Ubuntu,system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px;display:flex;flex-direction:column;gap:16px}
header{display:flex;align-items:center;gap:12px}header img{width:32px;height:32px}h1{font-size:20px;margin:0}
.banner{padding:14px 18px;border-radius:16px;font-weight:500}.banner.ok{background:#91e3ae24;color:var(--ok)}.banner.crit{background:#fb909e24;color:var(--crit)}
section{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:18px 20px;display:flex;flex-direction:column;gap:12px}
.row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;align-items:baseline}h2{font-size:16px;margin:0;display:flex;align-items:center;gap:8px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}.dot.ok{background:var(--ok)}.dot.crit{background:var(--crit)}
.muted,dt{color:var(--fg2);font-size:13px}.bars{display:flex;gap:2px;height:28px}.bars i{flex:1;border-radius:3px}
.bars .ok{background:var(--ok)}.bars .warn{background:var(--warn)}.bars .crit{background:var(--crit)}.bars .none{background:var(--off)}
dl{display:flex;gap:24px;margin:0}dd{margin:0;font-variant-numeric:tabular-nums}footer{color:var(--fg2);font-size:13px}
</style></head><body><main>
<header><img src="/nyx-mark.svg" alt=""><h1>${esc(s.name)}</h1></header>
<div class="banner ${down ? "crit" : "ok"}" role="status">${down ? `${down} of ${s.checks.length} down` : "All systems operational"}</div>
${rows || `<section><p class="muted">No check has run yet.</p></section>`}
<footer>Checked every minute from Cloudflare's network. Updated ${new Date(s.at).toISOString().slice(0, 16).replace("T", " ")} UTC.</footer>
</main></body></html>`
}

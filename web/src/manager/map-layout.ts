/** Card size and spacing of the network map. */
export const W = 176, H = 52, GAP_Y = 14, INDENT = 28, GAP_X = 56, PAD = 24
/** Room above the first row for the arcs between its cards. */
export const TOP = PAD + 64
const COL = W + INDENT + GAP_X
const ROW = H + GAP_Y

/** Machines that run guests. */
export const HOSTS = ["proxmox", "physical", "server"]
/** Network gear, drawn above the hosts. */
export const GEAR = ["router", "switch"]

interface N { id: string; name: string; type?: string }
interface L { source: string; target: string }

const byName = (a: N, b: N) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })

/** Child id → host id: anything that is not a host or network gear, linked to a host. */
export function parents(nodes: N[], links: L[]): Record<string, string> {
  const type = new Map(nodes.map((n) => [n.id, n.type ?? ""]))
  const out: Record<string, string> = {}
  for (const l of links) {
    for (const [c, p] of [[l.source, l.target], [l.target, l.source]]) {
      const ct = type.get(c), pt = type.get(p)
      if (ct === undefined || pt === undefined || out[c]) continue
      if (!HOSTS.includes(ct) && !GEAR.includes(ct) && HOSTS.includes(pt)) out[c] = p
    }
  }
  return out
}

/**
 * Tidy places for every node: network gear on top, then one column per host with its
 * guests listed under it, then everything else in rows.
 */
export function arrange(nodes: N[], links: L[]): Record<string, { x: number; y: number }> {
  const parent = parents(nodes, links)
  const kids = (id: string) => nodes.filter((n) => parent[n.id] === id).sort(byName)
  const top = nodes.filter((n) => !parent[n.id])
  const gear = top.filter((n) => GEAR.includes(n.type ?? "")).sort(byName)
  const hosts = top.filter((n) => !gear.includes(n) && (HOSTS.includes(n.type ?? "") || kids(n.id).length > 0)).sort(byName)
  const loose = top.filter((n) => !gear.includes(n) && !hosts.includes(n)).sort(byName)
  const out: Record<string, { x: number; y: number }> = {}
  let y = TOP
  gear.forEach((n, i) => { out[n.id] = { x: PAD + i * COL, y } })
  if (gear.length) y += ROW + 40
  hosts.forEach((h, i) => {
    const x = PAD + i * COL
    out[h.id] = { x, y }
    kids(h.id).forEach((k, j) => { out[k.id] = { x: x + INDENT, y: y + (j + 1) * ROW } })
  })
  if (hosts.length) y += (Math.max(...hosts.map((h) => kids(h.id).length)) + 1) * ROW + 40
  const perRow = Math.max(hosts.length, gear.length, 4)
  loose.forEach((n, i) => { out[n.id] = { x: PAD + (i % perRow) * COL, y: y + Math.floor(i / perRow) * ROW } })
  return out
}

/** Frame around a host and its guests, from where they actually are. */
export function frame(host: { x: number; y: number }, kids: { x: number; y: number }[]) {
  const all = [host, ...kids]
  const x = Math.min(...all.map((p) => p.x)) - 10, y = Math.min(...all.map((p) => p.y)) - 10
  return { x, y, w: Math.max(...all.map((p) => p.x)) + W + 10 - x, h: Math.max(...all.map((p) => p.y)) + H + 10 - y }
}

/** Path from a host to one guest: down a rail on the host's left, then across. Straight when the guest was moved elsewhere. */
export function treePath(p: { x: number; y: number }, c: { x: number; y: number }) {
  const rail = p.x + INDENT / 2
  if (c.x > rail && c.y > p.y + H) return `M${rail} ${p.y + H}V${c.y + H / 2}H${c.x}`
  return `M${p.x + W / 2} ${p.y + H / 2}L${c.x + W / 2} ${c.y + H / 2}`
}

/** A link between two cards that bends instead of crossing them straight. */
export function curve(a: { x: number; y: number }, b: { x: number; y: number }) {
  const [x1, y1, x2, y2] = [a.x + W / 2, a.y + H / 2, b.x + W / 2, b.y + H / 2]
  if (Math.abs(y1 - y2) < H) {
    // Side by side: an arc over the row, so that it clears the cards between them.
    const lift = Math.min(64, 24 + Math.abs(x2 - x1) * 0.12)
    const top = Math.min(a.y, b.y) - lift
    return { d: `M${x1} ${a.y}C${x1} ${top} ${x2} ${top} ${x2} ${b.y}`, mx: (x1 + x2) / 2, my: top + lift * 0.25 }
  }
  const [u, d] = y1 < y2 ? [a, b] : [b, a]
  const [sx, sy, ex, ey] = [u.x + W / 2, u.y + H, d.x + W / 2, d.y]
  return { d: `M${sx} ${sy}C${sx} ${(sy + ey) / 2} ${ex} ${(sy + ey) / 2} ${ex} ${ey}`, mx: (sx + ex) / 2, my: (sy + ey) / 2 }
}

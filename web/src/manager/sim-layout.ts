// Where the simulator draws things: each segment (subnet) as a box listing its machines,
// routers in a row above with a cable to every segment they have a leg in.

export interface Host { name: string; ips: string[]; conflict?: boolean }
export interface Segment { id: string; name: string; cidr: string; vlan?: number | string; gateway?: string | null; gateway_known?: boolean; hosts: Host[] }
export interface Router extends Host { links: { segment: string; ip: string }[] }
export interface Topology { segments: Segment[]; routers: Router[]; outside: Host[] }
export interface Point { x: number; y: number }

// BUS: how far from the left of a box its cable runs down, past the dot of each machine, like a switch.
export const BOX_W = 248, ROW = 32, HEAD = 58, GAP = 40, TOP = 150, R_W = 176, R_H = 54, BUS = 22
export const OUTSIDE = "_outside"

export interface Box { id: string; seg: Segment; x: number; y: number; h: number }

export function place(t: Topology) {
  const segs: Segment[] = [...t.segments, ...(t.outside.length ? [{ id: OUTSIDE, name: "Outside any subnet", cidr: "", hosts: t.outside }] : [])]
  const boxes: Box[] = segs.map((seg, i) => ({ id: seg.id, seg, x: i * (BOX_W + GAP), y: TOP, h: HEAD + Math.max(seg.hosts.length, 1) * ROW + 10 }))
  const box = Object.fromEntries(boxes.map((b) => [b.id, b]))
  const hosts: Record<string, Point & { box: string }> = {}
  for (const b of boxes) b.seg.hosts.forEach((h, i) => { hosts[h.name] = { x: b.x + BUS, y: b.y + HEAD + i * ROW + ROW / 2, box: b.id } })
  // Each router over the middle of its segments, pushed right until it does not overlap.
  const wanted = t.routers.map((r) => {
    const xs = r.links.map((l) => box[l.segment]).filter(Boolean).map((b) => b.x + BUS)
    return { r, x: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0 }
  }).sort((a, b) => a.x - b.x)
  const routers: Record<string, Point> = {}
  let next = R_W / 2
  for (const { r, x } of wanted) { const at = Math.max(x, next); routers[r.name] = { x: at, y: R_H / 2 }; next = at + R_W + 24 }
  const links = t.routers.flatMap((r) => r.links.filter((l) => box[l.segment]).map((l) => ({ router: r.name, segment: l.segment, ip: l.ip, from: { x: routers[r.name].x, y: R_H }, to: { x: box[l.segment].x + BUS, y: TOP } })))
  const width = Math.max(boxes.length ? boxes.at(-1)!.x + BOX_W : 0, ...Object.values(routers).map((p) => p.x + R_W / 2))
  const height = Math.max(TOP + 40, ...boxes.map((b) => b.y + b.h))
  return { boxes, hosts, routers, links, width, height }
}

export type Layout = ReturnType<typeof place>

/** The points a packet passes from one machine to the next: out of its box by the top,
 *  into the other box by the top, so that it follows the cables. */
export function leg(L: Layout, a: string, b: string): Point[] {
  const at = (n: string): Point | undefined => L.routers[n] ?? L.hosts[n]
  const [pa, pb] = [at(a), at(b)]
  if (!pa || !pb) return pa ? [pa] : pb ? [pb] : []
  const [ba, bb] = [L.hosts[a]?.box, L.hosts[b]?.box]
  const top = (id: string) => { const x = L.boxes.find((o) => o.id === id)!; return { x: x.x + BUS, y: x.y } }
  return [pa, ...(ba && ba !== bb ? [top(ba)] : []), ...(bb && bb !== ba ? [top(bb)] : []), pb]
}

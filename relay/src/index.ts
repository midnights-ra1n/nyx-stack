/**
 * Nyx relay: a zero-knowledge Cloudflare Worker in front of a Nyx server.
 *
 * The server keeps one outbound WebSocket here (`/_relay/up`), so it needs no open port
 * and its address stays private. Agents and browsers seal each request with the relay
 * key and POST it to `/_relay`; this Worker forwards the bytes and returns the sealed
 * answer. It never has the key. See docs/cloudflare.md.
 *
 * It also checks, every minute, that the server is linked and that the edge probes
 * answer, alerts a webhook on changes, and serves the result at `/_status`.
 */
import { DurableObject } from "cloudflare:workers"
import { connect } from "cloudflare:sockets"
import { isPublic, pack, unpack, type ResHead } from "../../web/src/ui/envelope"
import { alertBody, bars, day, INSTANCE, parseProbes, renderStatus, step, uptime, type State, type Summary } from "./status"

interface Env {
  RELAY: DurableObjectNamespace<Relay>
  /** Secrets, set with `wrangler secret put`. */
  RELAY_SECRET: string
  ALERT_WEBHOOK?: string
  NAME?: string
  STATUS_PAGE?: string
  PROBES?: string
  DOWN_AFTER?: string
}

const SEALED = 0
const PLAIN = 1
const WAIT_MS = 100_000
const MINUTE = 60_000
/** The server says `hb` every 30 s; the runtime answers `ok` without waking this object. */
const BEAT_MS = 90_000
const KEEP_DAYS = 90
const KEY_NEEDED = "relay key needed: open this server with the link from Settings, This server"

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } })

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url)
    // The API only goes through sealed: a plain call means a browser without the key.
    if ((pathname.startsWith("/api/") && pathname !== "/api/health") || pathname.startsWith("/mcp")) return json(428, { error: KEY_NEEDED })
    return env.RELAY.get(env.RELAY.idFromName("main")).fetch(req)
  },
} satisfies ExportedHandler<Env>

export class Relay extends DurableObject<Env> {
  private pending = new Map<number, { ws: WebSocket; done: (r: Response) => void }>()
  private next = 1

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("hb", "ok"))
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS days (name TEXT, day TEXT, up INTEGER, total INTEGER, PRIMARY KEY (name, day));
      CREATE TABLE IF NOT EXISTS state (name TEXT PRIMARY KEY, up INTEGER, since INTEGER, fails INTEGER, ms INTEGER)`)
  }

  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url)
    if (pathname === "/_relay/up") return this.upstream(req)
    if (pathname === "/_status" || pathname === "/_status.json") {
      if (this.env.STATUS_PAGE === "off") return new Response("Not found", { status: 404 })
      await this.ensureAlarm()
      const s = this.summary()
      return pathname.endsWith(".json") ? json(200, s) : new Response(renderStatus(s, this.label), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
    }
    if (pathname === "/_relay" && req.method === "POST") return this.forward(SEALED, new Uint8Array(await req.arrayBuffer()))
    if (req.method === "GET" && isPublic(pathname)) return this.forward(PLAIN, pack({ m: "GET", p: pathname, h: [], t: 0 }, new Uint8Array()))
    return json(404, { error: "not found" })
  }

  private async upstream(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(426, { error: "WebSocket expected" })
    if (!sameSecret(req.headers.get("authorization") ?? "", `Bearer ${this.env.RELAY_SECRET ?? ""}`) || (this.env.RELAY_SECRET ?? "").length < 32) return json(401, { error: "bad relay secret" })
    // One server per relay: a reconnect replaces the old link.
    for (const old of this.ctx.getWebSockets("up")) try { old.close(1012, "replaced") } catch { /* already gone */ }
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server, ["up"])
    await this.ensureAlarm()
    return new Response(null, { status: 101, webSocket: client })
  }

  private forward(kind: number, payload: Uint8Array): Promise<Response> {
    const [up] = this.ctx.getWebSockets("up")
    if (!up) return Promise.resolve(json(503, { error: "the Nyx server is offline: it has no link to the relay" }))
    const id = this.next
    this.next = (this.next + 1) >>> 0 || 1
    const frame = new Uint8Array(5 + payload.length)
    new DataView(frame.buffer).setUint32(0, id)
    frame[4] = kind
    frame.set(payload, 5)
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(json(504, { error: "the Nyx server did not answer in time" })), WAIT_MS)
      const done = (r: Response) => { clearTimeout(timer); this.pending.delete(id); resolve(r) }
      this.pending.set(id, { ws: up, done })
      try { up.send(frame) } catch { done(json(503, { error: "the link to the Nyx server just closed" })) }
    })
  }

  async webSocketMessage(_ws: WebSocket, msg: ArrayBuffer | string) {
    if (typeof msg === "string" || msg.byteLength < 5) return
    const buf = new Uint8Array(msg)
    const done = this.pending.get(new DataView(msg).getUint32(0))?.done
    if (!done) return
    const payload = buf.subarray(5)
    if (buf[4] === SEALED) return done(new Response(payload, { headers: { "content-type": "application/octet-stream", "x-nyx-relay": "sealed", "cache-control": "no-store" } }))
    // Plain: public files and the server's refusals. Only their type is passed on.
    const res = unpack<ResHead>(payload)
    if (!res) return done(json(502, { error: "malformed answer from the Nyx server" }))
    const type = res.head.h.find(([k]) => k.toLowerCase() === "content-type")?.[1]
    done(new Response([204, 304].includes(res.head.s) ? null : res.body, { status: res.head.s, headers: { "cache-control": "no-store", ...(type ? { "content-type": type } : {}) } }))
  }

  async webSocketClose(ws: WebSocket, code: number) {
    for (const p of [...this.pending.values()]) if (p.ws === ws) p.done(json(503, { error: "the link to the Nyx server closed" }))
    try { ws.close(code === 1005 ? 1000 : code, "closed") } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011)
  }

  private async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + MINUTE)
  }

  /** Every minute: is the server linked, do the probes answer. One webhook per minute at most. */
  async alarm() {
    const now = Date.now()
    await this.ctx.storage.setAlarm(now + MINUTE)
    const [up] = this.ctx.getWebSockets("up")
    const beat = up ? this.ctx.getWebSocketAutoResponseTimestamp(up)?.getTime() ?? 0 : 0
    const results = [{ name: INSTANCE, ok: now - beat < BEAT_MS, ms: null as number | null }]
    results.push(...(await Promise.all(parseProbes(this.env.PROBES).map(async (p) => ({ name: p.name, ...(await probe(p.url)) })))))
    const downAfter = Math.max(1, Number(this.env.DOWN_AFTER) || 2)
    const changes: { name: string; up: boolean }[] = []
    for (const r of results) {
      const prev = this.ctx.storage.sql.exec<{ up: number; since: number; fails: number; ms: number | null }>("SELECT up, since, fails, ms FROM state WHERE name = ?", r.name).toArray()[0]
      const { next, changed } = step(prev && { ...prev, up: !!prev.up }, r.ok, r.ms, now, downAfter)
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO state VALUES (?, ?, ?, ?, ?)", r.name, +next.up, next.since, next.fails, next.ms)
      this.ctx.storage.sql.exec("INSERT INTO days VALUES (?, ?, ?, 1) ON CONFLICT (name, day) DO UPDATE SET up = up + excluded.up, total = total + 1", r.name, day(now), +r.ok)
      if (changed) changes.push({ name: r.name, up: next.up })
    }
    this.ctx.storage.sql.exec("DELETE FROM days WHERE day < ?", day(now - KEEP_DAYS * 86_400_000))
    if (changes.length && this.env.ALERT_WEBHOOK) {
      const body = alertBody(this.env.NAME || "Nyx", changes, this.label)
      await fetch(this.env.ALERT_WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch((e) => console.error("alert webhook", e))
    }
  }

  private label = (name: string) => (name === INSTANCE ? `${this.env.NAME || "Nyx"} server` : name)

  private summary(): Summary {
    const now = Date.now()
    const names = [INSTANCE, ...parseProbes(this.env.PROBES).map((p) => p.name)]
    const checks = names.flatMap((name) => {
      const s = this.ctx.storage.sql.exec<{ up: number; since: number; ms: number | null }>("SELECT up, since, ms FROM state WHERE name = ?", name).toArray()[0]
      if (!s) return []
      const days = this.ctx.storage.sql.exec<{ day: string; up: number; total: number }>("SELECT day, up, total FROM days WHERE name = ?", name).toArray()
      return [{ name, up: !!s.up, since: s.since, ms: s.ms, uptime: { d1: uptime(days, now, 1), d7: uptime(days, now, 7), d30: uptime(days, now, 30) }, days: bars(days, now) }]
    })
    return { name: this.env.NAME || "Nyx", at: now, checks }
  }
}

/** HTTP answers below 400 and TCP ports that accept a connection are up. */
async function probe(target: string): Promise<{ ok: boolean; ms: number | null }> {
  const t0 = Date.now()
  try {
    if (target.startsWith("tcp://")) {
      const u = new URL(target.replace("tcp://", "http://"))
      const socket = connect({ hostname: u.hostname, port: Number(u.port) })
      await Promise.race([socket.opened, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 10_000))])
      await socket.close()
    } else {
      const res = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "Nyx edge probe" } })
      await res.body?.cancel()
      if (res.status >= 400) return { ok: false, ms: Date.now() - t0 }
    }
    return { ok: true, ms: Date.now() - t0 }
  } catch {
    return { ok: false, ms: null }
  }
}

function sameSecret(a: string, b: string): boolean {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)]
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y)
}

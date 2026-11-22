import { describe, expect, it, vi } from "vitest"
import { importKey, open, pack, seal, unpack, type Bytes, type ReqHead } from "./envelope"
import { relayFetch, relayKey, setRelayKey } from "./relay"

const K = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
const mem = new Map<string, string>()
vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) })
vi.stubGlobal("location", { hash: `#relay=${K}`, pathname: "/hosts", search: "", href: "https://relay.example/hosts" })
vi.stubGlobal("history", { replaceState: vi.fn() })
// POSTs first: the socket has its own test below.
vi.stubGlobal("WebSocket", undefined)

/** The server end, as crates/nyx-srv/src/relay.rs does it. */
function server(handle: (h: ReqHead, body: string) => { s: number; h: [string, string][]; body: string }) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const k = await importKey(K)
    const sealed = new Uint8Array(init.body as ArrayBuffer)
    const req = unpack<ReqHead>(await open(k, new Uint8Array(), sealed))!
    const res = handle(req.head, new TextDecoder().decode(req.body))
    const out = await seal(k, sealed.subarray(0, 12), pack({ s: res.s, h: res.h }, new TextEncoder().encode(res.body)))
    return new Response(out, { headers: { "x-nyx-relay": "sealed" } })
  })
}

describe("relayFetch", () => {
  it("takes the key from the link and keeps the session inside the envelope", async () => {
    expect(relayKey()).toBe(K)
    const seen: ReqHead[] = []
    vi.stubGlobal("fetch", server((h, body) => {
      seen.push(h)
      return h.p === "/api/auth/login"
        ? { s: 200, h: [["set-cookie", "nyx_session=abc; Path=/; HttpOnly"], ["content-type", "application/json"]], body: `{"ok":${body}}` }
        : { s: 204, h: [], body: "" }
    }))
    const res = await relayFetch("/api/auth/login", { method: "POST", body: "1" })
    expect([res.status, await res.json(), res.headers.get("set-cookie")]).toEqual([200, { ok: 1 }, null])
    expect((await relayFetch("/api/hosts")).status).toBe(204)
    expect(seen[1].h).toContainEqual(["cookie", "nyx_session=abc"])
    expect(Math.abs(seen[1].t - Date.now() / 1000)).toBeLessThan(5)
  })

  it("forgets a cleared cookie and passes the relay's own errors through", async () => {
    vi.stubGlobal("fetch", server(() => ({ s: 200, h: [["set-cookie", "nyx_session=; Max-Age=0"]], body: "" })))
    await relayFetch("/api/auth/logout", { method: "POST" })
    const seen: ReqHead[] = []
    vi.stubGlobal("fetch", server((h) => (seen.push(h), { s: 200, h: [], body: "" })))
    await relayFetch("/api/x")
    expect(seen[0].h.find(([n]) => n === "cookie")).toBeUndefined()
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "the Nyx server is offline" }, { status: 503 })))
    expect((await relayFetch("/api/x")).status).toBe(503)
    location.hash = ""
    setRelayKey("ff".repeat(32))
    vi.stubGlobal("fetch", server(() => ({ s: 200, h: [], body: "" })))
    await expect(relayFetch("/api/x")).rejects.toThrow()
  })
})

/** The Worker and the server behind a socket: answers each sealed frame, in frames. */
class FakeSocket {
  static OPEN = 1
  static opened = 0
  readyState = 1
  binaryType = ""
  onopen?: () => void
  onmessage?: (e: { data: ArrayBuffer }) => void
  onclose?: () => void
  constructor(readonly url: URL) { FakeSocket.opened++; queueMicrotask(() => this.onopen?.()) }
  async send(frame: Bytes) {
    const k = await importKey(K)
    const sealed = frame.subarray(5)
    const req = unpack<ReqHead>(await open(k, new Uint8Array(), sealed))!
    if (req.head.p === "/api/drop") return this.onclose?.()
    const answer = await seal(k, sealed.subarray(0, 12), pack({ s: 200, h: [["content-type", "text/plain"]] }, new TextEncoder().encode(`${this.url} ${req.head.p}`)))
    const out = new Uint8Array(5 + answer.length)
    out.set(frame.subarray(0, 5))
    out.set(answer, 5)
    this.onmessage?.({ data: out.buffer })
  }
}

describe("relay socket", () => {
  it("carries the calls of the page over one socket, and keeps a wall's key in the fragment", async () => {
    location.hash = `#key=wall-key&relay=${K}`
    expect(relayKey()).toBe(K)
    expect(history.replaceState).toHaveBeenLastCalledWith(null, "", "/hosts#key=wall-key")
    vi.stubGlobal("WebSocket", FakeSocket)
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no POST while the socket works") }))
    const [a, b] = await Promise.all([relayFetch("/api/a"), relayFetch("/api/b")])
    expect([await a.text(), await b.text()]).toEqual(["wss://relay.example/_relay/ws /api/a", "wss://relay.example/_relay/ws /api/b"])
    expect(FakeSocket.opened).toBe(1)
    await expect(relayFetch("/api/drop")).rejects.toThrow(/lost/)
    await relayFetch("/api/c")
    expect(FakeSocket.opened).toBe(2)
  })
})

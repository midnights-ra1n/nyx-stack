/**
 * The browser end of the Cloudflare relay. Every API call is sealed with the relay key
 * before it leaves the page, so the Worker only forwards ciphertext. The key arrives in
 * the fragment of the link from Settings, which browsers never send to any server.
 *
 * Calls go over one WebSocket to the Worker, the one agents use too, so a refresh costs
 * no Cloudflare request. A Worker deployed before that gets them as POSTs.
 */
import { importKey, isKey, open, pack, seal, unpack, type Bytes, type ResHead } from "./envelope"

const KEY = "nyx.relay"
const COOKIES = "nyx.relay.cookies"
const SEALED = 0
/** As long as the Worker waits for the server. */
const WAIT_MS = 100_000
/** After the socket could not be opened: an older Worker, or a network that blocks it. */
const RETRY_MS = 600_000
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* private mode */ } },
}

let key: Promise<CryptoKey> | undefined

/** Takes `relay=` from the fragment, next to a wall display's `key=` for instance. */
export function relayKey(): string | null {
  const params = new URLSearchParams(typeof location === "undefined" ? "" : location.hash.slice(1))
  const hex = params.get("relay")
  if (hex && isKey(hex)) {
    setRelayKey(hex)
    params.delete("relay")
    const rest = params.toString()
    history.replaceState(null, "", location.pathname + location.search + (rest ? `#${rest}` : ""))
  }
  return store.get(KEY)
}

export function setRelayKey(hex: string | null) {
  store.set(KEY, hex?.trim().toLowerCase() ?? null)
  store.set(COOKIES, null)
  key = undefined
}

let socket: Promise<WebSocket> | undefined
let noSocketUntil = 0
let next = 0
const waiting = new Map<number, (frame: Bytes | null) => void>()

/** Opened on first use, and again after it drops. `undefined` while it cannot be. */
function relaySocket(): Promise<WebSocket> | undefined {
  if (typeof WebSocket === "undefined" || Date.now() < noSocketUntil) return undefined
  socket ??= new Promise<WebSocket>((resolve, reject) => {
    const url = new URL("/_relay/ws", location.href)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const ws = new WebSocket(url)
    ws.binaryType = "arraybuffer"
    ws.onopen = () => resolve(ws)
    ws.onmessage = (e) => {
      const f = new Uint8Array(e.data as ArrayBuffer)
      if (f.length >= 5) waiting.get(new DataView(f.buffer, f.byteOffset).getUint32(0))?.(f)
    }
    ws.onclose = () => {
      socket = undefined
      waiting.forEach((done) => done(null))
      reject(new Error("the relay socket did not open")) // ignored once open
    }
  }).catch((e) => {
    noSocketUntil = Date.now() + RETRY_MS
    throw e
  })
  return socket
}

/** The answer frame: `id || kind || payload`. `null` when there is no socket to use. */
async function overSocket(sealed: Bytes): Promise<Bytes | null> {
  let ws: WebSocket
  try { ws = await (relaySocket() ?? Promise.reject()) } catch { return null }
  if (ws.readyState !== WebSocket.OPEN) return null
  const id = next = (next % 0xffffffff) + 1
  const frame = new Uint8Array(5 + sealed.length)
  new DataView(frame.buffer).setUint32(0, id)
  frame[4] = SEALED
  frame.set(sealed, 5)
  const answer = await new Promise<Bytes | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), WAIT_MS)
    waiting.set(id, (f) => { clearTimeout(timer); resolve(f) })
    ws.send(frame)
  })
  waiting.delete(id)
  // Sent, so not sent again: it may have run on the server, as with a fetch cut short.
  if (!answer) throw new Error("The link to the relay was lost. Try again.")
  return answer
}

/** The sealed answer, or the relay's own one in clear: server offline, key refused. */
async function send(sealed: Bytes): Promise<Bytes | Response> {
  const frame = await overSocket(sealed)
  if (frame?.[4] === SEALED) return frame.subarray(5)
  if (frame) {
    const plain = unpack<ResHead>(frame.subarray(5))
    return new Response(plain && ![204, 205, 304].includes(plain.head.s) ? plain.body as BodyInit : null, { status: plain?.head.s ?? 502, headers: plain?.head.h })
  }
  const res = await fetch("/_relay", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: sealed as BodyInit })
  return res.headers.get("x-nyx-relay") === "sealed" ? new Uint8Array(await res.arrayBuffer()) : res
}

/**
 * `fetch`, through the relay. The session cookie travels inside the envelope, so this
 * page keeps it itself: the Worker's domain never gets one.
 */
export async function relayFetch(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  key ??= importKey(relayKey() ?? "")
  const k = await key
  const cookies: Record<string, string> = JSON.parse(store.get(COOKIES) ?? "{}")
  const headers: [string, string][] = Object.entries(init.headers ?? {})
  const cookie = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join("; ")
  if (cookie) headers.push(["cookie", cookie])
  const head = { m: init.method ?? "GET", p: path, h: headers, t: Math.floor(Date.now() / 1000) }
  const sealed = await seal(k, new Uint8Array(), pack(head, new TextEncoder().encode(init.body ?? "")))
  const answer = await send(sealed)
  if (answer instanceof Response) return answer
  let plain
  try { plain = unpack<ResHead>(await open(k, sealed.subarray(0, 12), answer)) } catch { /* below */ }
  if (!plain) throw new Error("The relay answer does not open with this key.")
  const out = new Headers()
  for (const [n, v] of plain.head.h) {
    if (n.toLowerCase() !== "set-cookie") { out.append(n, v); continue }
    const [pair, ...attrs] = v.split(";")
    const i = pair.indexOf("=")
    const [name, value] = [pair.slice(0, i).trim(), pair.slice(i + 1).trim()]
    if (!value || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) delete cookies[name]
    else cookies[name] = value
  }
  store.set(COOKIES, JSON.stringify(cookies))
  const empty = [204, 205, 304].includes(plain.head.s)
  return new Response(empty ? null : plain.body as BodyInit, { status: plain.head.s, headers: out })
}

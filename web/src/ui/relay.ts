/**
 * The browser end of the Cloudflare relay. Every API call is sealed with the relay key
 * before it leaves the page, so the Worker only forwards ciphertext. The key arrives in
 * the fragment of the link from Settings, which browsers never send to any server.
 */
import { importKey, open, pack, seal, unpack, type ResHead } from "./envelope"

const KEY = "nyx.relay"
const COOKIES = "nyx.relay.cookies"
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* private mode */ } },
}

let key: Promise<CryptoKey> | undefined

export function relayKey(): string | null {
  const m = typeof location === "undefined" ? null : location.hash.match(/^#relay=([0-9a-f]{64})$/i)
  if (m) {
    setRelayKey(m[1])
    history.replaceState(null, "", location.pathname + location.search)
  }
  return store.get(KEY)
}

export function setRelayKey(hex: string | null) {
  store.set(KEY, hex?.trim().toLowerCase() ?? null)
  store.set(COOKIES, null)
  key = undefined
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
  const res = await fetch("/_relay", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: sealed })
  // The relay's own answers come in clear: server offline, key refused.
  if (res.headers.get("x-nyx-relay") !== "sealed") return res
  let plain
  try { plain = unpack<ResHead>(await open(k, sealed.subarray(0, 12), new Uint8Array(await res.arrayBuffer()))) } catch { /* below */ }
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

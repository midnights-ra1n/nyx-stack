/**
 * Envelope of the Cloudflare relay, shared by the browser and the Worker. It mirrors
 * crates/nyx-proto/src/relay.rs: see there for the layout.
 */
export type Pairs = [string, string][]
export type Bytes = Uint8Array<ArrayBuffer>
export interface ReqHead { m: string; p: string; h: Pairs; t: number }
export interface ResHead { s: number; h: Pairs }

const enc = new TextEncoder()
const dec = new TextDecoder()

export function pack(head: ReqHead | ResHead, body: Bytes): Bytes {
  const h = enc.encode(JSON.stringify(head))
  const out = new Uint8Array(4 + h.length + body.length)
  new DataView(out.buffer).setUint32(0, h.length)
  out.set(h, 4)
  out.set(body, 4 + h.length)
  return out
}

export function unpack<T>(buf: Bytes): { head: T; body: Bytes } | undefined {
  if (buf.length < 4) return
  const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0)
  if (4 + n > buf.length) return
  try { return { head: JSON.parse(dec.decode(buf.subarray(4, 4 + n))), body: buf.subarray(4 + n) } } catch { return }
}

/** Files fetched without the key, such as by `curl … | sh`. */
export const isPublic = (path: string) => path === "/install.sh" || path === "/api/health" || /^\/agent\/v1\/binary\/[^/]+$/.test(path)

export const isKey = (hex: string) => /^[0-9a-f]{64}$/i.test(hex.trim())

export function importKey(hex: string): Promise<CryptoKey> {
  if (!isKey(hex)) throw new Error("A relay key is 64 hexadecimal characters.")
  const bytes = new Uint8Array(hex.trim().match(/../g)!.map((b) => parseInt(b, 16)))
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"])
}

/** `nonce || ciphertext || tag`, as ring writes it. */
export async function seal(key: CryptoKey, aad: Bytes, plain: Bytes): Promise<Bytes> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plain))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return out
}

export async function open(key: CryptoKey, aad: Bytes, sealed: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(0, 12), additionalData: aad }, key, sealed.subarray(12)))
}

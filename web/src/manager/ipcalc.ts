// IPv4 calculator, worked out in the browser as you type. IPv6 goes to the server.

/** IPv4 as a number, or null for anything else. */
export function ip4(s: string): number | null {
  const p = s.trim().split(".")
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) < 256)) return null
  return p.reduce((a, x) => a * 256 + Number(x), 0)
}
export const ip4str = (n: number) => [24, 16, 8, 0].map((b) => Math.floor(n / 2 ** b) % 256).join(".")

export interface Calc {
  address: string
  prefix: number
  network: string
  netmask: string
  wildcard: string
  broadcast: string
  first: string
  last: string
  usable: number
  total: number
  kind: string
  /** The address in binary, split as network bits and host bits. */
  bits: [string, string]
  /** The network as a number, for `split`. */
  base: number
}

const mask = (prefix: number) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0)
/** Whether `ip` is in the network `net`/`prefix`. */
export const inside = (ip: number, net: number, prefix: number) => ((ip & mask(prefix)) >>> 0) === ((net & mask(prefix)) >>> 0)

/** Prefix from a length or a dotted mask; null when the mask has holes. */
function prefixOf(m: string): number | null {
  if (/^\d{1,2}$/.test(m)) return Number(m) <= 32 ? Number(m) : null
  const n = ip4(m)
  if (n == null) return null
  const p = 32 - Math.log2(((~n) >>> 0) + 1)
  return Number.isInteger(p) ? p : null
}

/** "192.168.1.37/26", "192.168.1.37 26", "192.168.1.37 255.255.255.192", or a bare address
 *  (taken as /24, the usual home network). */
export function parse(input: string): { ip: number; prefix: number; assumed: boolean } | null {
  const [a, m, ...rest] = input.trim().split(/\s*\/\s*|\s+/)
  const ip = ip4(a ?? "")
  if (ip == null || rest.length) return null
  if (m == null || m === "") return { ip, prefix: 24, assumed: true }
  const prefix = prefixOf(m)
  return prefix == null ? null : { ip, prefix, assumed: false }
}

// Special ranges, most specific first.
const KINDS: [string, number, string][] = [
  ["0.0.0.0", 8, "This network"], ["127.0.0.0", 8, "Loopback"], ["169.254.0.0", 16, "Link-local"],
  ["10.0.0.0", 8, "Private"], ["172.16.0.0", 12, "Private"], ["192.168.0.0", 16, "Private"], ["100.64.0.0", 10, "Shared (CGNAT)"],
  ["192.0.2.0", 24, "Documentation"], ["198.51.100.0", 24, "Documentation"], ["203.0.113.0", 24, "Documentation"],
  ["224.0.0.0", 4, "Multicast"], ["255.255.255.255", 32, "Broadcast"], ["240.0.0.0", 4, "Reserved"],
]
export const kindOf = (ip: number) => KINDS.find(([n, p]) => ((ip & mask(p)) >>> 0) === ip4(n))?.[2] ?? "Public"

export function calc(ip: number, prefix: number): Calc {
  const m = mask(prefix)
  const base = (ip & m) >>> 0
  const total = 2 ** (32 - prefix)
  const top = base + total - 1
  // /31 links and /32 hosts have no network or broadcast address to spare (RFC 3021).
  const [first, last] = prefix >= 31 ? [base, top] : [base + 1, top - 1]
  const bin = ip.toString(2).padStart(32, "0").replace(/(.{8})(?!$)/g, "$1.")
  const cut = prefix + Math.floor(Math.max(prefix - 1, 0) / 8)
  return {
    address: ip4str(ip), prefix, network: ip4str(base), netmask: ip4str(m), wildcard: ip4str((~m) >>> 0), broadcast: ip4str(top),
    first: ip4str(first), last: ip4str(last), usable: prefix >= 31 ? total : total - 2, total, kind: kindOf(ip),
    bits: [bin.slice(0, cut), bin.slice(cut)], base,
  }
}

/** The first `max` subnets of `newPrefix` in a network. */
export function split(base: number, prefix: number, newPrefix: number, max = 64): { list: string[]; count: number } {
  const count = 2 ** (newPrefix - prefix)
  const step = 2 ** (32 - newPrefix)
  return { list: Array.from({ length: Math.min(count, max) }, (_, i) => `${ip4str(base + i * step)}/${newPrefix}`), count }
}

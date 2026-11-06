import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: opts.body === undefined ? opts.headers : { "content-type": "application/json", ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText)
  return data
}

export const REFRESH: [number, string][] = [[5000, "5 s"], [15000, "15 s"], [30000, "30 s"], [60000, "1 min"], [0, "Off"]]

// Global auto-refresh, set by the control bar. 0 turns it off.
let refreshMs = Number(globalThis.localStorage?.getItem("nyx.refresh") ?? 15000)
const listeners = new Set<() => void>()
export const setRefresh = (ms: number) => {
  refreshMs = ms
  localStorage.setItem("nyx.refresh", String(ms))
  listeners.forEach((l) => l())
}
export const useRefresh = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => refreshMs)

/** Fired when the session expired, so the shell can show the login screen. */
export const AUTH_LOST = "nyx:auth-lost"

/**
 * Fetch `path` and keep it fresh. Costs nothing in the background: polling stops
 * while the tab is hidden, and the old data stays on screen until the fresh data
 * arrives when the user comes back, the network returns or the device wakes up.
 */
export function useApi<T = any>(path: string | null, opts: { poll?: boolean } = {}) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [updated, setUpdated] = useState<Date>()
  const ms = useRefresh()
  const live = useRef(path)
  live.current = path

  const reload = useCallback(async () => {
    if (!path) return
    try {
      const d = await api<T>(path)
      if (live.current === path) { setData(d); setError(undefined); setUpdated(new Date()) }
    } catch (e) {
      if (live.current === path) setError((e as Error).message)
      if (e instanceof ApiError && e.status === 401) dispatchEvent(new Event(AUTH_LOST))
    }
  }, [path])

  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    if (opts.poll === false || !ms) return
    const id = setInterval(() => { if (!document.hidden) reload() }, ms)
    return () => clearInterval(id)
  }, [reload, ms, opts.poll])
  useEffect(() => {
    if (opts.poll === false) return
    const wake = () => { if (!document.hidden) reload() }
    document.addEventListener("visibilitychange", wake)
    addEventListener("online", wake)
    addEventListener("pageshow", wake) // restored from the back/forward cache
    return () => {
      document.removeEventListener("visibilitychange", wake)
      removeEventListener("online", wake)
      removeEventListener("pageshow", wake)
    }
  }, [reload, opts.poll])

  return { data, error, reload, updated }
}

const onConnectivity = (l: () => void) => {
  addEventListener("online", l); addEventListener("offline", l)
  return () => { removeEventListener("online", l); removeEventListener("offline", l) }
}
export const useOnline = () => useSyncExternalStore(onConnectivity, () => navigator.onLine)

export function useMedia(query: string) {
  return useSyncExternalStore(
    (l) => { const m = matchMedia(query); m.addEventListener("change", l); return () => m.removeEventListener("change", l) },
    () => matchMedia(query).matches,
  )
}

/** State mirrored in localStorage. */
export function useStored<T>(key: string, initial: T) {
  const [value, set] = useState<T>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? initial } catch { return initial }
  })
  return [value, (v: T) => { set(v); localStorage.setItem(key, JSON.stringify(v)) }] as const
}

const units = (v: number, base: number, names: string[]) => {
  let i = 0
  while (v >= base && i < names.length - 1) { v /= base; i++ }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${names[i]}`
}

export const fmt = {
  pct: (v?: number | null) => (v == null ? "—" : `${v.toFixed(v < 10 ? 1 : 0)} %`),
  bytes: (v?: number | null) => (v == null ? "—" : units(v, 1024, ["B", "KiB", "MiB", "GiB", "TiB", "PiB"])),
  bps: (v?: number | null) => (v == null ? "—" : `${units(v, 1024, ["B", "KiB", "MiB", "GiB"])}/s`),
  temp: (v?: number | null) => (v == null ? "—" : `${v.toFixed(0)} °C`),
  uptime(s?: number | null) {
    if (s == null) return "—"
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
    return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`
  },
  ago(t?: string | number | null) {
    if (!t) return "—"
    const ms = typeof t === "number" ? t * 1000 : Date.parse(t.replace(" ", "T"))
    if (Number.isNaN(ms)) return "—"
    const s = Math.max(0, (Date.now() - ms) / 1000)
    if (s < 60) return "just now"
    if (s < 3600) return `${Math.floor(s / 60)} min ago`
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`
    return `${Math.floor(s / 86400)} d ago`
  },
  date: (t?: string | null) => (t ? new Date(t.replace(" ", "T")).toLocaleDateString() : "—"),
  time: (d?: Date) => d?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) ?? "—",
}

export type Level = "ok" | "warn" | "crit" | "info" | "off"
export const levelOf = (v: number | null | undefined, warn = 75, crit = 90): Level =>
  v == null ? "off" : v >= crit ? "crit" : v >= warn ? "warn" : "ok"
export const levelText: Record<Level, string> = { ok: "text-ok", warn: "text-warn", crit: "text-crit", info: "text-info", off: "text-off" }
export const levelBg: Record<Level, string> = { ok: "bg-ok", warn: "bg-warn", crit: "bg-crit", info: "bg-info", off: "bg-off" }
export const levelSoft: Record<Level, string> = { ok: "bg-ok-soft", warn: "bg-warn-soft", crit: "bg-crit-soft", info: "bg-info-soft", off: "bg-off-soft" }

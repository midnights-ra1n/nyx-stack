import type { ReactNode } from "react"
import { fr } from "./fr"

/**
 * Translations keyed by the English text, which stays the fallback: a string missing
 * from a dictionary shows in English instead of breaking. `{name}` marks a value.
 */
export const LANGS = [{ value: "en", label: "English" }, { value: "fr", label: "Français" }]
const DICTS: Record<string, Record<string, string>> = { fr }

const stored = (() => { try { return localStorage.getItem("nyx.lang") } catch { return null } })()
export const lang = stored && (stored === "en" || DICTS[stored]) ? stored : globalThis.navigator?.language?.toLowerCase().startsWith("fr") ? "fr" : "en"
const dict = DICTS[lang] ?? {}
if (globalThis.document) document.documentElement.lang = lang

export function t(text: string, vars?: Record<string, unknown>) {
  const out = dict[text] ?? text
  return vars ? out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : out
}

// Keys with a `{part}`, for text built elsewhere: those that open with words first, as
// they are the most telling, then the ones with the most words.
let shapes: { re: RegExp; names: string[]; to: string }[] | undefined
/** Parts that are text of their own, translated in turn. Every other part is a name. */
const NESTED = ["msg", "reason", "what", "color", "error", "since"]
const NUMBERS = ["n", "p", "t", "days"]
const words = (k: string) => k.replace(/\{\w+\}/g, "")

/**
 * Text built by the server or an agent, such as "nas: /dev/sdb 8 bad sectors", found by
 * the key it was built from ("{host}: {device} {reason}"). Text no key fits stays as it is.
 */
export function tn(text: string): string {
  if (!text || text in dict) return t(text)
  shapes ??= Object.keys(dict).filter((k) => /\{\w+\}/.test(k) && words(k).trim())
    .sort((a, b) => Number(a.startsWith("{")) - Number(b.startsWith("{")) || words(b).length - words(a).length)
    .map((k) => ({
      to: dict[k],
      names: [...k.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
      re: new RegExp(`^${k.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, (_, n) => (NUMBERS.includes(n) ? "(-?[\\d.]+)" : "(.+?)"))}$`, "s"),
    }))
  for (const s of shapes) {
    const m = s.re.exec(text)
    if (m) return s.to.replace(/\{(\w+)\}/g, (_, k: string) => { const v = m[s.names.indexOf(k) + 1] ?? ""; return NESTED.includes(k) ? tn(v) : v })
  }
  return text
}

/** Translates a prop that may be text or an element already built. */
export const tx = <T extends ReactNode>(v: T): T | string => (typeof v === "string" ? t(v) : v)

/** Kept on this device; the page reloads so that every screen switches at once. */
export function setLang(value: string) {
  try { localStorage.setItem("nyx.lang", value) } catch { /* private mode: this visit only */ }
  location.reload()
}

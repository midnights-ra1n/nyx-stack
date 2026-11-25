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

/** Translates a prop that may be text or an element already built. */
export const tx = <T extends ReactNode>(v: T): T | string => (typeof v === "string" ? t(v) : v)

/** Kept on this device; the page reloads so that every screen switches at once. */
export function setLang(value: string) {
  try { localStorage.setItem("nyx.lang", value) } catch { /* private mode: this visit only */ }
  location.reload()
}

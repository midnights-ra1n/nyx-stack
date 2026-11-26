import { describe, expect, it } from "vitest"
import { fr } from "./fr"
import { t } from "./i18n"

const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.*"], { query: "?raw", import: "default", eager: true }) as Record<string, string>

/** Every string literal written as `t("…")`, or as a branch of `t(cond ? "…" : "…")`. */
function keys() {
  const out = new Set<string>()
  for (const src of Object.values(sources)) {
    for (const m of src.matchAll(/\bt\(((?:[^()"]|"(?:[^"\\]|\\.)*")*?)[,)]/g))
      for (const s of m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        // A literal compared with `===` is a value tested, not text shown.
        if (/[A-Za-z]{2}/.test(s[1]) && !/[=!]==\s*$/.test(m[1].slice(0, s.index))) out.add(JSON.parse(`"${s[1]}"`))
      }
    // Components translate these props themselves, so their literals need French too.
    for (const m of src.matchAll(/\b(?:label|title|hint|sub|footer|subtitle)=\{?"((?:[^"\\]|\\.)*)"/g))
      if (/[A-Za-z]{2}/.test(m[1]) && !m[1].includes("${")) out.add(JSON.parse(`"${m[1]}"`))
  }
  return [...out]
}

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe("i18n", () => {
  it("interpolates and falls back to English", () => {
    expect(t("Nothing to see {here}", { here: "there" })).toBe("Nothing to see there")
  })
  it("has French for every literal passed to t()", () => {
    const all = keys()
    expect(all.length).toBeGreaterThan(300) // the scan found the sources
    const missing = all.filter((k) => !(k in fr))
    expect(missing).toEqual([])
  })
  it("keeps the same placeholders in French", () => {
    expect(Object.entries(fr).filter(([en, f]) => vars(en).join() !== vars(f).join())).toEqual([])
  })
})

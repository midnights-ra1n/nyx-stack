import { XMarkIcon } from "@heroicons/react/24/outline"
import { useId, useState } from "react"
import { t } from "./i18n"

/** Tags as stored: a comma-separated string in the manager, a list on the monitor. */
export function splitTags(v: string | string[] | null | undefined): string[] {
  const list = Array.isArray(v) ? v : String(v ?? "").split(",")
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))]
}

/** Every tag in use, sorted, for filters and suggestions. */
export const allTags = (rows: any[], key = "tags") => [...new Set(rows.flatMap((r) => splitTags(r[key])))].sort((a, b) => a.localeCompare(b))

export const hasTag = (row: any, tag: string, key = "tags") => !tag || splitTags(row[key]).includes(tag)

const HUES = ["s1", "s2", "s3", "s4"]
/** The same tag gets the same colour everywhere, from its name. */
export function tagColor(tag: string) {
  let h = 0
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) | 0
  return `var(--color-${HUES[Math.abs(h) % HUES.length]})`
}

export function Tag({ tag, onPick, onRemove }: { tag: string; onPick?: (tag: string) => void; onRemove?: () => void }) {
  const dot = <span className="size-2 shrink-0 rounded-full" style={{ background: tagColor(tag) }} aria-hidden />
  const look = "inline-flex h-6 max-w-40 items-center gap-1.5 rounded-full border border-line bg-raised px-2 text-xs text-fg2"
  if (onRemove) return <span className={look}>{dot}<span className="truncate">{tag}</span><button type="button" aria-label={t("Remove {tag}", { tag })} className="-mr-1 text-fg3 hover:text-fg" onClick={onRemove}><XMarkIcon className="size-3.5" aria-hidden /></button></span>
  if (onPick) return <button type="button" title={t("Show only {tag}", { tag })} className={`${look} hover:border-accent hover:text-fg`} onClick={(e) => { e.stopPropagation(); onPick(tag) }}>{dot}<span className="truncate">{tag}</span></button>
  return <span className={look}>{dot}<span className="truncate">{tag}</span></span>
}

export function TagList({ tags, onPick, empty = "—" }: { tags: string | string[] | null | undefined; onPick?: (tag: string) => void; empty?: string }) {
  const list = splitTags(tags)
  if (!list.length) return <span className="text-fg3">{empty}</span>
  return <span className="flex flex-wrap gap-1">{list.map((tag) => <Tag key={tag} tag={tag} onPick={onPick} />)}</span>
}

/** Chips and a box to type more: Enter or a comma adds one, Backspace on an empty box takes the last one off. */
export function TagInput({ label, hint, value, onChange, known = [] }: { label: string; hint?: string; value: string[]; onChange: (tags: string[]) => void; known?: string[] }) {
  const id = useId()
  const [text, setText] = useState("")
  const add = (raw: string) => { const next = splitTags([...value, ...raw.split(",")]); if (next.length !== value.length) onChange(next); setText("") }
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-fg2">{t(label)}</label>
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-control border border-line2 bg-surface px-2 py-1 focus-within:border-accent max-sm:min-h-11">
        {value.map((tag) => <Tag key={tag} tag={tag} onRemove={() => onChange(value.filter((x) => x !== tag))} />)}
        <input id={id} list={`${id}-known`} value={text} placeholder={value.length ? "" : t("Type a tag, then Enter")} className="h-7 min-w-24 flex-1 bg-transparent text-[13px] outline-none max-sm:text-base"
          onChange={(e) => (e.target.value.includes(",") ? add(e.target.value) : setText(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) { e.preventDefault(); add(text) }
            else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1))
          }}
          onBlur={() => text.trim() && add(text)} />
      </div>
      <datalist id={`${id}-known`}>{known.filter((k) => !value.includes(k)).map((k) => <option key={k} value={k} />)}</datalist>
      {hint && <p className="text-xs text-fg3">{t(hint)}</p>}
    </div>
  )
}

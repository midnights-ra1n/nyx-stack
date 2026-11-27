// Cards that hold no data of their own: a note, links, a clock, a web page. Both apps offer them.
import { ClockIcon, DocumentTextIcon, GlobeAltIcon, LinkIcon, WindowIcon } from "@heroicons/react/24/outline"
import { useEffect, useState, type ReactNode } from "react"
import { Empty, type Icon, Input, TextArea } from "./components"
import { lang, t } from "./i18n"
import type { ChartCard } from "./chart/draw"

/** A card on a dashboard. Chart cards hold their settings in `chart`, other kinds in their own fields. */
export interface Card { id: string; type: string; title: string; tab?: string; [field: string]: any }

export interface CardKind {
  label: string
  icon: Icon
  hint: string
  /** `range` is the period picked at the top of the page. */
  body: (c: Card, ctx?: { range: string }) => ReactNode
  form?: (c: Card, set: (patch: Partial<Card>) => void) => ReactNode
  /** What keeps the card from being saved. */
  check?: (c: Card) => string | undefined
  /** What a chart card picked into this kind keeps of its settings. */
  from?: (c: Card) => Partial<Card>
  /** The same card as a chart, when a chart type is picked for it: its advanced form. */
  toChart?: (c: Card) => ChartCard
  flush?: boolean
}

const safeUrl = (u: string) => /^https?:\/\//i.test(u.trim())

/** `Label | https://url` per line. Lines without an http(s) address are dropped. */
export function parseLinks(text = "") {
  return text.split("\n").map((l) => {
    const i = l.lastIndexOf("|")
    const [label, url] = i < 0 ? [l, l] : [l.slice(0, i), l.slice(i + 1)]
    return { label: label.trim(), url: url.trim() }
  }).filter((l) => safeUrl(l.url))
}

function Clock({ tz }: { tz?: string }) {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 10_000); return () => clearInterval(id) }, [])
  const opts = (o: Intl.DateTimeFormatOptions) => { try { return now.toLocaleString(lang, { ...o, timeZone: tz || undefined }) } catch { return now.toLocaleString(lang, o) } }
  return (
    <div className="py-2 text-center">
      <div className="text-[44px] leading-none font-medium tabular-nums">{opts({ hour: "2-digit", minute: "2-digit" })}</div>
      <div className="mt-2 text-fg2">{opts({ weekday: "long", day: "numeric", month: "long" })}{tz && <span className="text-fg3"> · {tz}</span>}</div>
    </div>
  )
}

export const BASIC_KINDS: Record<string, CardKind> = {
  note: {
    label: "Note", icon: DocumentTextIcon, hint: "Free text: a procedure, a reminder, a phone number.",
    body: (c) => (c.text ? <p className="whitespace-pre-wrap text-fg2">{c.text}</p> : <Empty>{t("Empty note.")}</Empty>),
    form: (c, set) => <div className="col-span-full"><TextArea label="Text" rows={5} value={c.text ?? ""} onChange={(e) => set({ text: e.target.value })} /></div>,
  },
  links: {
    label: "Links", icon: LinkIcon, hint: "Bookmarks to your services.",
    body: (c) => {
      const links = parseLinks(c.links)
      return links.length ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
          {links.map((l) => <li key={l.url + l.label}><a href={l.url} target="_blank" rel="noreferrer noopener" className="flex h-10 items-center gap-2 truncate rounded-control border border-line px-3 hover:border-line2 hover:text-accent"><GlobeAltIcon className="size-4 shrink-0 text-fg3" aria-hidden /><span className="truncate">{l.label || l.url}</span></a></li>)}
        </ul>
      ) : <Empty>{t("No links yet.")}</Empty>
    },
    form: (c, set) => <div className="col-span-full"><TextArea label="Links" rows={5} placeholder={"Proxmox | https://pve.lan:8006\nNextcloud | https://cloud.lan"} value={c.links ?? ""} onChange={(e) => set({ links: e.target.value })} hint="One per line: a label, a bar, then an http(s) address." /></div>,
  },
  clock: {
    label: "Clock", icon: ClockIcon, hint: "Time and date, in any time zone.",
    body: (c) => <Clock tz={c.tz} />,
    form: (c, set) => <Input label="Time zone" placeholder={t("Europe/Paris")} value={c.tz ?? ""} onChange={(e) => set({ tz: e.target.value })} hint="Empty: the time zone of this browser." />,
  },
  embed: {
    label: "Web page", icon: WindowIcon, hint: "Shows a page of your own, such as a Grafana panel. Your browser loads it directly.", flush: true,
    body: (c) => (c.url && safeUrl(c.url)
      ? <div className="px-4 pb-4"><iframe title={c.title} src={c.url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerPolicy="no-referrer" loading="lazy" className="w-full rounded-control border border-line bg-bg" style={{ height: c.height || 320 }} /></div>
      : <div className="px-4 pb-4"><Empty>{t("Set an http(s) address.")}</Empty></div>),
    form: (c, set) => <>
      <Input label="Address" required placeholder={t("https://grafana.lan/d-solo/…")} value={c.url ?? ""} onChange={(e) => set({ url: e.target.value })} hint="The page must allow being framed." />
      <Input label="Height (px)" type="number" min={120} max={1200} value={c.height ?? 320} onChange={(e) => set({ height: Number(e.target.value) })} />
    </>,
    check: (c) => (safeUrl(c.url ?? "") ? undefined : "The address must start with http:// or https://."),
  },
}

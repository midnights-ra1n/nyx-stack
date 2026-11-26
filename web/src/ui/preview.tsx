import { Fragment, useState, type ReactNode } from "react"
import { fmt, markUrl } from "./lib"
import { t } from "./i18n"

/** A digest as the server renders it (notify.rs, `parse` and `compose`). */
export interface Card { severity: string; title: string; lines: string[]; small: string[] }
export interface Rendered { title: string; head: string[]; cards: Card[]; tail: string[]; plain: string; email?: string | null; title_tpl: string; body_tpl: string }

interface Chat { label: string; bg: string; text: string; meta: string; bubble?: string }

const CHATS: Record<string, Chat> = {
  discord: { label: "Discord", bg: "#313338", text: "#dbdee1", meta: "#949ba4", bubble: "#2b2d31" },
  slack: { label: "Slack", bg: "#ffffff", text: "#1d1c1d", meta: "#616061" },
  telegram: { label: "Telegram", bg: "#0e1621", text: "#f5f5f5", meta: "#6d7f8f", bubble: "#182533" },
  teams: { label: "Teams", bg: "#f5f5f5", text: "#242424", meta: "#616161", bubble: "#ffffff" },
  matrix: { label: "Matrix", bg: "#15191e", text: "#edf3ff", meta: "#a9b2bc" },
}
const LOOKS = [{ id: "email", label: "Email" }, ...Object.entries(CHATS).map(([id, c]) => ({ id, label: c.label })), { id: "phone", label: "Phone" }]
const LOOK_OF: Record<string, string> = { smtp: "email", discord: "discord", slack: "slack", telegram: "telegram", teams: "teams", matrix: "matrix" }

// As the server sends them: the interface's colours on Discord and in mails, an icon elsewhere.
const COLOR: Record<string, string> = { crit: "#fb909e", warn: "#f2cf6d", info: "#87d7f7", ok: "#91e3ae" }
const ICON: Record<string, string> = { crit: "🔴", warn: "🟠", ok: "🟢" }

/** `**bold**` in bold. A `**` without a partner stays as it is, as on the server. */
function Rich({ text }: { text: string }) {
  const parts = text.split("**")
  const paired = Math.floor((parts.length - 1) / 2) * 2
  return <>{parts.map((p, i) => (i === 0 ? p : i > paired ? `**${p}` : i % 2 ? <strong key={i}>{p}</strong> : p))}</>
}

const Avatar = ({ size = 36 }: { size?: number }) => <img src={markUrl()} alt="" style={{ width: size, height: size }} className="shrink-0 rounded-full" />

function Frame({ id, children }: { id: string; children: ReactNode }) {
  const c = CHATS[id]
  return (
    <div className="flex gap-3 rounded-box p-4 text-[14px]" style={{ background: c.bg, color: c.text }}>
      <Avatar />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline gap-2">
          <span className="font-medium">Nyx</span>
          {id === "discord" && <span className="rounded-full bg-[#5865f2] px-1.5 text-[10px] leading-4 font-medium text-white">BOT</span>}
          <span className="text-xs" style={{ color: c.meta }}>{fmt.time(new Date())}</span>
        </div>
        {children}
      </div>
    </div>
  )
}

/** The title in bold, then an embed per card with its colour on the left and its small print as the footer. */
function DiscordLook({ r }: { r: Rendered }) {
  const c = CHATS.discord
  const embed = (key: string, color: string | undefined, title: string, lines: string[], small: string[]) => (
    <div key={key} className="max-w-[520px] rounded-[4px] px-3 py-2" style={{ background: c.bubble, borderLeft: `4px solid ${color ?? "#1e1f22"}` }}>
      {title && <div className="font-semibold text-white">{title}</div>}
      {lines.map((l, i) => <div key={i} className="break-words"><Rich text={l} /></div>)}
      {small.length > 0 && <div className="mt-1.5 text-xs" style={{ color: c.meta }}>{small.map((s, i) => <div key={i}>{s}</div>)}</div>}
    </div>
  )
  return (
    <Frame id="discord">
      <div className="font-semibold">{r.title}</div>
      {r.head.length > 0 && embed("head", undefined, "", r.head, [])}
      {r.cards.map((x, i) => embed(String(i), COLOR[x.severity], x.title, x.lines, x.small))}
      {r.tail.length > 0 && embed("tail", undefined, "", r.tail, [])}
    </Frame>
  )
}

/** Apps without colours: the severity icon leads each card. Slack gets one line per card. */
function TextLook({ id, r }: { id: string; r: Rendered }) {
  const c = CHATS[id]
  const slack = id === "slack"
  const free = (lines: string[]) => lines.length > 0 && <div>{lines.map((l, i) => <div key={i}><Rich text={l} /></div>)}</div>
  return (
    <Frame id={id}>
      <div className={`flex min-w-0 flex-col gap-3 break-words ${c.bubble ? "rounded-box px-3 py-2" : ""}`} style={{ background: c.bubble }}>
        {r.title && <div className="font-semibold">{r.title}</div>}
        {free(r.head)}
        <div className={`flex flex-col ${slack ? "gap-1" : "gap-3"}`}>
          {r.cards.map((x, i) => {
            const parts = [x.title && <strong>{x.title}</strong>, ...x.lines.map((l) => <Rich text={l} />), ...x.small.map((s) => <em style={{ color: c.meta }}>{s}</em>)].filter(Boolean)
            return (
              <div key={i} className={slack ? "border-l-4 border-[#dddddd] pl-3" : ""}>
                {ICON[x.severity] ?? "🔵"} {parts.map((p, j) => <Fragment key={j}>{j > 0 && (slack ? " · " : <br />)}{p}</Fragment>)}
              </div>
            )
          })}
        </div>
        {free(r.tail)}
      </div>
    </Frame>
  )
}

function EmailLook({ r, html }: { r: Rendered; html: boolean }) {
  return (
    <div className="overflow-hidden rounded-box bg-white text-[#1d1c1d]">
      <div className="flex items-center gap-3 border-b border-[#e4e4ec] p-4">
        <Avatar />
        <div className="min-w-0">
          <div className="truncate font-medium">{r.title}</div>
          <div className="text-xs text-[#616161]">Nyx · {fmt.time(new Date())}</div>
        </div>
      </div>
      {html
        ? <iframe title={t("Message preview")} sandbox="" srcDoc={`<style>body{margin:0}</style>${r.email ?? ""}`} className="h-[28rem] w-full" />
        : <pre className="p-4 font-sans whitespace-pre-wrap break-words">{r.plain}</pre>}
    </div>
  )
}

function PhoneLook({ r }: { r: Rendered }) {
  return (
    <div className="rounded-box bg-sidebar p-4">
      <div className="rounded-panel border border-line bg-raised p-4 text-fg">
        <div className="flex items-center gap-2 text-xs text-fg2"><Avatar size={20} /><span className="flex-1">NYX</span>{fmt.time(new Date())}</div>
        <div className="mt-2 font-medium">{r.title}</div>
        <div className="line-clamp-6 whitespace-pre-wrap break-words text-fg2">{r.plain}</div>
      </div>
    </div>
  )
}

/** What a message looks like where it lands, guessed from the channel's URL. */
export function MessagePreview({ url, rendered: r, html }: { url: string; rendered?: Rendered; html: boolean }) {
  const [picked, setPicked] = useState<string>()
  const look = html ? "email" : picked ?? LOOK_OF[url.split(":")[0]] ?? "phone"
  return (
    <div className="flex flex-col gap-3">
      {!html && (
        <div role="tablist" aria-label={t("Preview as")} className="flex flex-wrap gap-1">
          {LOOKS.map((l) => (
            <button key={l.id} type="button" role="tab" aria-selected={l.id === look} onClick={() => setPicked(l.id)} className={`h-8 rounded-control px-3 text-[13px] ${l.id === look ? "bg-accent-soft text-accent" : "text-fg2 hover:bg-raised hover:text-fg"}`}>{t(l.label)}</button>
          ))}
        </div>
      )}
      {!r ? <div className="h-48 animate-pulse rounded-box bg-raised" /> : look === "email" ? <EmailLook r={r} html={html} /> : look === "phone" ? <PhoneLook r={r} /> : look === "discord" ? <DiscordLook r={r} /> : <TextLook id={look} r={r} />}
      <p className="text-xs text-fg3">{t("Sample events. Each app has the last word on the final look.")}</p>
    </div>
  )
}

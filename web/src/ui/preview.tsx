import { useState } from "react"
import { fmt, markUrl } from "./lib"

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

const Avatar = ({ size = 36 }: { size?: number }) => <img src={markUrl()} alt="" style={{ width: size, height: size }} className="shrink-0 rounded-full" />

function ChatLook({ id, title, body }: { id: string; title: string; body: string }) {
  const c = CHATS[id]
  // Shoutrrr sends each line as its own Discord embed, and only the first has the title.
  const blocks = id === "discord" ? body.split("\n").filter((l) => l.trim()) : [body.trim()]
  return (
    <div className="flex gap-3 rounded-box p-4" style={{ background: c.bg, color: c.text }}>
      <Avatar />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium">Nyx</span>
          {id === "discord" && <span className="rounded-full bg-[#5865f2] px-1.5 text-[10px] leading-4 font-medium text-white">BOT</span>}
          <span className="text-xs" style={{ color: c.meta }}>{fmt.time(new Date())}</span>
        </div>
        {blocks.map((b, i) => (
          <div key={i} className={`min-w-0 whitespace-pre-wrap break-words ${c.bubble ? "rounded-box px-3 py-2" : ""}`} style={{ background: c.bubble, ...(id === "discord" ? { borderLeft: "4px solid var(--color-crit)" } : {}) }}>
            {i === 0 && title && <div className="font-medium">{title}</div>}
            {b}
          </div>
        ))}
      </div>
    </div>
  )
}

function EmailLook({ title, body, html }: { title: string; body: string; html: boolean }) {
  return (
    <div className="overflow-hidden rounded-box bg-white text-[#1d1c1d]">
      <div className="flex items-center gap-3 border-b border-[#e4e4ec] p-4">
        <Avatar />
        <div className="min-w-0">
          <div className="truncate font-medium">{title}</div>
          <div className="text-xs text-[#616161]">Nyx · {fmt.time(new Date())}</div>
        </div>
      </div>
      {html
        ? <iframe title="Message preview" sandbox="" srcDoc={`<style>body{margin:0}</style>${body}`} className="h-96 w-full" />
        : <pre className="p-4 font-sans whitespace-pre-wrap break-words">{body}</pre>}
    </div>
  )
}

function PhoneLook({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-box bg-sidebar p-4">
      <div className="rounded-panel border border-line bg-raised p-4 text-fg">
        <div className="flex items-center gap-2 text-xs text-fg2"><Avatar size={20} /><span className="flex-1">NYX</span>{fmt.time(new Date())}</div>
        <div className="mt-2 font-medium">{title}</div>
        <div className="line-clamp-6 whitespace-pre-wrap break-words text-fg2">{body}</div>
      </div>
    </div>
  )
}

/** What a message looks like where it lands, guessed from the channel's URL. */
export function MessagePreview({ url, title, body, html }: { url: string; title: string; body: string; html: boolean }) {
  const [picked, setPicked] = useState<string>()
  const look = html ? "email" : picked ?? LOOK_OF[url.split(":")[0]] ?? "phone"
  return (
    <div className="flex flex-col gap-3">
      {!html && (
        <div role="tablist" aria-label="Preview as" className="flex flex-wrap gap-1">
          {LOOKS.map((l) => (
            <button key={l.id} type="button" role="tab" aria-selected={l.id === look} onClick={() => setPicked(l.id)} className={`h-8 rounded-control px-3 text-[13px] ${l.id === look ? "bg-accent-soft text-accent" : "text-fg2 hover:bg-raised hover:text-fg"}`}>{l.label}</button>
          ))}
        </div>
      )}
      {look === "email" ? <EmailLook title={title} body={body} html={html} /> : look === "phone" ? <PhoneLook title={title} body={body} /> : <ChatLook id={look} title={title} body={body} />}
      <p className="text-xs text-fg3">Sample events. Each app has the last word on the final look.</p>
    </div>
  )
}

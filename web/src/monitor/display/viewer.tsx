import { ArrowsPointingOutIcon, PauseIcon, PlayIcon } from "@heroicons/react/24/outline"
import { useCallback, useEffect, useRef, useState } from "react"
import { IconButton, Status } from "../../ui/components"
import { api, type Level, levelSoft, levelText, useMedia } from "../../ui/lib"
import { bottom, themeVars } from "./model"
import { DashPanel } from "./panels"

/** These grow with their content on a phone. Charts need a fixed height. */
const FLOWING = ["services", "tiles", "alerts", "text"]

export function Grid({ page, fit, paused, render }: { page: any; fit?: boolean; paused?: boolean; render?: (p: any) => React.ReactNode }) {
  const rows = bottom(page.panels)
  const style = fit ? { height: "100%", gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` } : { gridAutoRows: "36px" }
  return (
    <div className="dash" style={style}>
      {page.panels.map((p: any) => (
        <div key={p.id} className={FLOWING.includes(p.type) ? "dash-flow" : ""} style={{ "--x": p.x, "--y": p.y, "--w": p.w, "--h": p.h, "--o": p.y * 100 + p.x } as React.CSSProperties}>
          {render ? render(p) : <DashPanel p={p} overall={page.overall} generated={page.generated} paged={fit} paused={paused} />}
        </div>
      ))}
    </div>
  )
}

function usePage(path: string, key: string | null, seconds: number, paused: boolean) {
  const [page, setPage] = useState<any>()
  const [status, setStatus] = useState<"ok" | "stale" | "gone">("ok")
  const [updated, setUpdated] = useState<Date>()
  const load = useCallback(async () => {
    try { setPage(await api(path, key ? { headers: { "x-nyx-page-key": key } } : {})); setStatus("ok"); setUpdated(new Date()) } catch (e: any) { setStatus(e.status === 404 ? "gone" : "stale") }
  }, [path, key])
  useEffect(() => {
    if (paused) return
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, seconds * 1000)
    const wake = () => { if (!document.hidden) load() }
    document.addEventListener("visibilitychange", wake)
    addEventListener("online", wake)
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", wake); removeEventListener("online", wake) }
  }, [load, seconds, paused])
  return { page, status, updated }
}

function Header({ page, updated, compact, step, paused, onPause }: { page: any; updated?: Date; compact?: boolean; step: number; paused: boolean; onPause?: () => void }) {
  return (
    <header className={`flex items-center gap-3 ${compact ? "h-12 shrink-0 px-1" : "flex-wrap pb-5"}`}>
      {page.logo && <img src={page.logo} alt="" className={compact ? "h-8" : "h-10"} />}
      <div className="min-w-0 flex-1">
        <h1 className={`truncate font-medium ${compact ? "text-xl" : "text-[26px] leading-[34px]"}`}>{page.title}</h1>
        {page.description && !compact && <p className="text-fg2">{page.description}</p>}
      </div>
      {compact && <Status level={page.overall} />}
      {page.rotation && <span className="text-xs text-fg2">Page {step + 1} of {page.rotation.count}</span>}
      {updated && <span className="text-xs text-fg3">{paused ? "Paused at" : "Updated"} {updated.toLocaleTimeString()}</span>}
      {onPause && <IconButton label={paused ? "Resume" : "Pause"} icon={paused ? PlayIcon : PauseIcon} onClick={onPause} />}
      {compact && document.fullscreenEnabled && <IconButton label="Full screen" icon={ArrowsPointingOutIcon} onClick={() => document.documentElement.requestFullscreen()} />}
    </header>
  )
}

function Notice({ page }: { page: any }) {
  if (!page.notice) return null
  const level: Level = page.notice_level || "info"
  return <p role="status" className={`mb-2 rounded-panel px-4 py-3 whitespace-pre-wrap ${levelSoft[level]} ${levelText[level]}`}>{page.notice}</p>
}

/** A dead link or a lost network must not look like an outage. */
function Lost({ updated }: { updated?: Date }) {
  return <p role="alert" className="mb-2 rounded-panel bg-warn-soft px-4 py-2 text-warn">Connection lost. Showing data from {updated?.toLocaleTimeString() ?? "earlier"}.</p>
}

/** Screens in a room must stay awake and survive network cuts unattended. */
function useWakeLock(on: boolean) {
  const lock = useRef<any>(null)
  useEffect(() => {
    if (!on) return
    const take = () => { if (!document.hidden) (navigator as any).wakeLock?.request("screen").then((l: any) => { lock.current = l }).catch(() => {}) }
    take()
    document.addEventListener("visibilitychange", take)
    return () => { document.removeEventListener("visibilitychange", take); lock.current?.release() }
  }, [on])
}

export function DisplayPage({ slug }: { slug: string }) {
  // In the fragment, which browsers never send: it stays out of access logs.
  const key = new URLSearchParams(location.hash.slice(1)).get("key")
  const [seconds, setSeconds] = useState(30)
  const [paused, setPaused] = useState(false)
  const [step, setStep] = useState(0)
  const { page, status, updated } = usePage(`/api/public/pages/${slug}${step ? `/${step}` : ""}`, key, seconds, paused)
  const [count, delay] = [page?.rotation?.count, page?.rotation?.seconds]
  const phone = useMedia("(max-width: 639px)")
  const wall = page?.kind === "wall" || !!page?.rotation // A status page in a rotation is on the same screen.
  useWakeLock(wall)
  useEffect(() => {
    if (!count || paused) return
    const id = setInterval(() => setStep((s) => (s + 1) % count), delay * 1000)
    return () => clearInterval(id)
  }, [count, delay, paused])
  useEffect(() => {
    if (!page) return
    setSeconds(page.refresh_s)
    document.title = page.title || "Status"
    document.documentElement.style.cssText = "" // The next page of a rotation may have no theme of its own.
    const vars = themeVars(page.preset, page.accent) as Record<string, string>
    for (const [k, v] of Object.entries(vars)) k.startsWith("--") ? document.documentElement.style.setProperty(k, v) : (document.documentElement.style.colorScheme = v)
  }, [page])

  if (!page) return status === "ok" ? null : (
    <main className="flex h-dvh items-center justify-center p-5 text-center text-fg2">
      {status === "gone" ? "This page does not exist or is not published." : "Cannot reach this page. Retrying."}
    </main>
  )
  if (wall && !phone) {
    const z = page.zoom || 1
    return (
      <main className="flex flex-col overflow-hidden bg-bg p-2" style={{ zoom: z, height: `calc(100dvh / ${z})` }}>
        <Header page={page} updated={updated} compact step={step} paused={paused} onPause={wall ? () => setPaused(!paused) : undefined} />
        {status === "stale" && <Lost updated={updated} />}
        <Notice page={page} />
        <div className="min-h-0 flex-1"><Grid page={page} fit paused={paused} /></div>
      </main>
    )
  }
  return (
    <main className="min-h-dvh bg-bg">
      <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
        <Header page={page} updated={updated} step={step} paused={paused} onPause={wall ? () => setPaused(!paused) : undefined} />
        {status === "stale" && <Lost updated={updated} />}
        <Notice page={page} />
        <Grid page={page} />
        {page.footer && <footer className="mt-6 whitespace-pre-wrap text-[13px] text-fg3">{page.footer}</footer>}
      </div>
    </main>
  )
}

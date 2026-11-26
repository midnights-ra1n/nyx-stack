// The IPAM simulator, after Cisco Packet Tracer's simulation mode: the recorded network drawn
// as segments and routers, and a ping between two machines played hop by hop, there and back.
import { ArrowUturnLeftIcon, BackwardIcon, ForwardIcon, PaperAirplaneIcon, PauseIcon, PlayIcon } from "@heroicons/react/24/outline"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { MapControls, useFullscreen, usePanZoom } from "../ui/canvas"
import { Button, Empty, ErrorNote, IconButton, Input, Panel, Select, Status, Table, Td } from "../ui/components"
import { t, tn } from "../ui/i18n"
import { api, type Level, useApi } from "../ui/lib"
import { PageHeader } from "../ui/shell"
import { BOX_W, BUS, HEAD, type Layout, leg, OUTSIDE, place, type Point, R_H, R_W, ROW, type Topology } from "./sim-layout"

const LEVEL: Record<string, Level> = { reached: "ok", conflict: "warn", exit: "info", unreachable: "crit", loop: "crit" }
const STEP_MS = 900

interface Hop { device: string; ip: string; detail: string; level: Level; way: "request" | "reply" }

const d = (pts: Point[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ")
const short = (s: string, n = 20) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches

/** The packet: an envelope, orange on its way, green coming back. It glides along `pts`. */
function Packet({ pts, way, failed }: { pts: Point[]; way: Hop["way"]; failed: boolean }) {
  const body = (
    <>
      <rect x={-10} y={-7} width={20} height={14} rx={2} className={way === "reply" ? "fill-ok stroke-bg" : "fill-accent stroke-bg"} strokeWidth={1.5} />
      <path d="M-10 -7 L0 1 L10 -7" fill="none" className="stroke-bg" strokeWidth={1.5} />
      {failed && <g transform="translate(12 -12)"><circle r={8} className="fill-crit" /><path d="M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5" className="stroke-bg" strokeWidth={2} /></g>}
    </>
  )
  if (pts.length < 2) return pts[0] ? <g transform={`translate(${pts[0].x} ${pts[0].y})`}>{body}</g> : null
  // Started by hand: an animation added after the page loaded would otherwise count from page load and be over already.
  return <g><animateMotion ref={(el) => (el as unknown as SVGAnimationElement | null)?.beginElement()} begin="indefinite" dur={still() ? "0.01s" : `${STEP_MS - 200}ms`} fill="freeze" path={d(pts)} />{body}</g>
}

function Drawing({ L, picked, hops, step, failed, onPick }: { L: Layout; picked: string[]; hops: Hop[]; step: number; failed: boolean; onPick: (name: string) => void }) {
  const at = (n: string) => L.routers[n] ?? L.hosts[n]
  const trail = hops.slice(1, step + 1).map((h, i) => ({ way: h.way, pts: leg(L, hops[i].device, h.device) }))
  const cur = hops[step]
  const role = (n: string) => (picked[0] === n ? "source" : picked[1] === n ? "destination" : "")
  return (
    <>
      {L.links.map((l) => (
        <g key={l.router + l.segment}>
          <line x1={l.from.x} y1={l.from.y} x2={l.to.x} y2={l.to.y} className="stroke-line2" strokeWidth={2} />
          <text x={l.to.x + 6} y={l.to.y - 8} className="fill-fg2 font-mono text-[10px]">{l.ip}</text>
        </g>
      ))}
      {L.boxes.map((b) => {
        const s = b.seg
        const gw = s.gateway ? <tspan className={s.gateway_known ? "fill-fg3" : "fill-warn"}> · {t("gw")} {s.gateway}{s.gateway_known ? "" : " ⚠"}</tspan> : null
        return (
          <g key={b.id}>
            <rect x={b.x} y={b.y} width={BOX_W} height={b.h} rx={10} className={`fill-surface ${b.id === OUTSIDE ? "stroke-line2 [stroke-dasharray:6_4]" : "stroke-line2"}`} strokeWidth={1.5} />
            {s.gateway && !s.gateway_known && <title>{t("Gateway {ip} is not recorded: add it to the addresses of your router", { ip: s.gateway })}</title>}
            <line x1={b.x + BUS} x2={b.x + BUS} y1={b.y} y2={b.y + HEAD + Math.max(s.hosts.length - 0.5, 0.5) * ROW} className="stroke-line2" strokeWidth={2} />
            <text x={b.x + 36} y={b.y + 22} className="fill-fg text-[13px] font-medium">{short(b.id === OUTSIDE ? t(s.name) : s.name, 22)}{s.vlan ? <tspan className="fill-fg3 text-[11px] font-normal"> · VLAN {s.vlan}</tspan> : null}</text>
            <text x={b.x + 36} y={b.y + 40} className="fill-fg3 font-mono text-[11px]">{s.cidr}{gw}</text>
            <line x1={b.x + 36} x2={b.x + BOX_W} y1={b.y + HEAD - 8} y2={b.y + HEAD - 8} className="stroke-line" />
            {s.hosts.length === 0 && <text x={b.x + 36} y={b.y + HEAD + ROW / 2 + 4} className="fill-fg3 text-[12px]">{t("Only routers")}</text>}
            {s.hosts.map((h, i) => {
              const y = b.y + HEAD + i * ROW
              const r = role(h.name)
              return (
                <g key={h.name} className="cursor-pointer" role="button" tabIndex={0} aria-label={`${h.name} ${h.ips.join(" ")}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => onPick(h.name)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(h.name) } }}>
                  <rect x={b.x + 4} y={y + 1} width={BOX_W - 8} height={ROW - 2} rx={6} className={r ? "fill-accent-soft" : "fill-transparent hover:fill-raised"} />
                  <circle cx={b.x + BUS} cy={y + ROW / 2} r={5} className={h.conflict ? "fill-crit" : r ? "fill-accent" : "fill-fg3"} />
                  <text x={b.x + 36} y={y + ROW / 2 + 4} className={`text-[13px] ${h.conflict ? "fill-crit" : "fill-fg"}`}>{short(h.name, 17)}</text>
                  <text x={b.x + BOX_W - 12} y={y + ROW / 2 + 4} textAnchor="end" className="fill-fg2 font-mono text-[11px]">{h.ips[0]}{h.ips.length > 1 ? ` +${h.ips.length - 1}` : ""}</text>
                  <title>{[h.name, ...h.ips, h.conflict ? t("Address shared with another machine") : ""].filter(Boolean).join("\n")}</title>
                </g>
              )
            })}
          </g>
        )
      })}
      {Object.entries(L.routers).map(([name, p]) => {
        const r = role(name)
        return (
          <g key={name} className="cursor-pointer" role="button" tabIndex={0} aria-label={name} onPointerDown={(e) => e.stopPropagation()} onClick={() => onPick(name)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(name) } }}>
            <rect x={p.x - R_W / 2} y={0} width={R_W} height={R_H} rx={10} className={r ? "fill-accent-soft stroke-accent" : "fill-raised stroke-line2 hover:stroke-fg3"} strokeWidth={1.5} />
            <text x={p.x} y={22} textAnchor="middle" className="fill-fg text-[13px] font-medium">{short(name, 22)}</text>
            <text x={p.x} y={40} textAnchor="middle" className="fill-fg3 text-[11px]">{t("Router")}</text>
          </g>
        )
      })}
      {trail.map((s, i) => <path key={i} d={d(s.pts)} fill="none" className={s.way === "reply" ? "stroke-ok" : "stroke-accent"} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" opacity={0.7} />)}
      {cur && at(cur.device) && <Packet key={step} pts={step > 0 ? leg(L, hops[step - 1].device, cur.device) : [at(cur.device)!]} way={cur.way} failed={failed} />}
    </>
  )
}

export function Simulator({ tabs, aside }: { tabs: ReactNode; aside: ReactNode }) {
  const topo = useApi<Topology>("/api/ipam/topology", { poll: false })
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [result, setResult] = useState<any>()
  const [error, setError] = useState("")
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const svg = useRef<SVGSVGElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const zoom = usePanZoom(svg)
  const full = useFullscreen(frame)
  const L = useMemo(() => (topo.data ? place(topo.data) : null), [topo.data])
  const machines = topo.data ? [...topo.data.routers, ...topo.data.segments.flatMap((s) => s.hosts), ...topo.data.outside] : []
  const hops: Hop[] = result ? [...result.request.hops.map((h: any) => ({ ...h, way: "request" })), ...(result.reply?.hops ?? []).map((h: any) => ({ ...h, way: "reply" }))] : []
  const last = step >= hops.length - 1
  const failed = !!result && last && LEVEL[result.status] === "crit"

  useEffect(() => {
    if (!playing) return
    if (last) { setPlaying(false); return }
    const id = setTimeout(() => setStep((s) => s + 1), STEP_MS)
    return () => clearTimeout(id)
  }, [playing, step, last])

  const send = async (a: string, b: string) => {
    if (!a.trim() || !b.trim()) return
    try {
      setResult(await api("/api/ipam/simulate", { body: { from: a, destination: b } }))
      setError("")
      setStep(0)
      setPlaying(true)
    } catch (e) { setError((e as Error).message); setResult(undefined) }
  }
  // Like the PDU tool: the first machine clicked sends, the second receives.
  const pick = (name: string) => {
    if (!from || to) { setFrom(name); setTo(""); setResult(undefined) } else if (name !== from) { setTo(name); send(from, name) }
  }
  const go = (s: number) => { setPlaying(false); setStep(Math.max(0, Math.min(hops.length - 1, s))) }

  return (
    <>
      <PageHeader title={t("IPAM")} variables={tabs} onRefresh={topo.reload} />
      <div ref={frame} className="mb-4 flex flex-col overflow-hidden rounded-panel border border-line bg-surface [&:fullscreen]:h-dvh">
        <form className="flex flex-wrap items-end gap-2 border-b border-line p-3" onSubmit={(e) => { e.preventDefault(); send(from, to) }}>
          <div className="w-52 max-sm:w-full"><Select label="From" value={from} onChange={(e) => { setFrom(e.target.value); setResult(undefined) }} options={[{ value: "", label: t("Choose…") }, ...machines.map((m) => ({ value: m.name, label: m.name }))]} /></div>
          <div className="w-52 max-sm:w-full"><Input label="To" list="sim-targets" placeholder={t("Machine or address")} value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <datalist id="sim-targets">{machines.flatMap((m) => [m.name, ...m.ips]).map((v) => <option key={v} value={v} />)}</datalist>
          <Button type="submit" variant="primary" disabled={!from || !to.trim()}><PaperAirplaneIcon className="size-5" aria-hidden />{t("Send a ping")}</Button>
          {hops.length > 0 && (
            <div className="flex items-center rounded-control border border-line2" role="group" aria-label={t("Simulation")}>
              <IconButton label="Previous step" icon={BackwardIcon} disabled={step === 0} onClick={() => go(step - 1)} />
              <IconButton label={playing ? "Pause" : "Play"} icon={playing ? PauseIcon : PlayIcon} onClick={() => { if (last) setStep(0); setPlaying(!playing) }} />
              <IconButton label="Next step" icon={ForwardIcon} disabled={last} onClick={() => go(step + 1)} />
              <IconButton label="Start again" icon={ArrowUturnLeftIcon} onClick={() => { setStep(0); setPlaying(true) }} />
              <span className="px-2 text-[13px] text-fg2 tabular-nums">{step + 1} / {hops.length}</span>
            </div>
          )}
          <MapControls zoom={zoom} full={full} className="ml-auto max-sm:ml-0" />
        </form>
        <div className="relative h-[clamp(22rem,calc(100dvh-24rem),40rem)] [:fullscreen_&]:h-auto [:fullscreen_&]:flex-1">
          {!L ? <div className="p-4"><ErrorNote>{topo.error}</ErrorNote></div> : !L.boxes.length && !Object.keys(L.routers).length ? <div className="p-4"><Empty>{t("Record subnets and addresses to draw the network.")}</Empty></div> : (
            <svg ref={svg} viewBox={`-24 -24 ${L.width + 48} ${L.height + 48}`} className="size-full touch-none select-none outline-none cursor-grab active:cursor-grabbing" tabIndex={0} onKeyDown={zoom.onKeyDown}
              {...zoom.handlers} role="img" aria-label={t("Network drawn from the IPAM: {n} machines. The steps of the ping are listed below.", { n: machines.length })}>
              <g transform={zoom.transform}><Drawing L={L} picked={[from, to]} hops={hops} step={step} failed={failed} onPick={pick} /></g>
            </svg>
          )}
          {!result && L && (L.boxes.length > 0 || Object.keys(L.routers).length > 0) && <p className="pointer-events-none absolute bottom-3 left-3 rounded-control bg-bg/80 px-3 py-1.5 text-[13px] text-fg2">{from ? t("Now click the machine to ping.") : t("Click a machine to send from, then another to ping it.")}</p>}
        </div>
        {(result || error) && (
          <div className="flex items-baseline gap-3 border-t border-line px-4 py-3">
            {error ? <ErrorNote>{error}</ErrorNote> : <><Status level={LEVEL[result.status] ?? "off"} label={result.status === "reached" ? "Reached" : result.status === "conflict" ? "Conflict" : result.status === "exit" ? "Leaves the network" : result.status === "loop" ? "Loop" : "Unreachable"} /><span>{tn(result.summary)}</span></>}
          </div>
        )}
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel title={t("Event list")} flush help="Each step of the ping: where the packet is, from which address, and what the machine decides. Orange goes there, green comes back. Click a step to see it on the drawing.">
          {!hops.length ? <div className="px-4 pb-4"><Empty>{t("Choose two machines and send a ping to see its way there and back.")}</Empty></div> : (
            <Table head={["#", "", "Machine", "Address", "What happens"]}>
              {hops.map((h, i) => (
                <tr key={i} onClick={() => go(i)} className={`cursor-pointer ${i === step ? "bg-accent-soft/40" : "hover:bg-raised"}`} aria-current={i === step ? "step" : undefined}>
                  <Td className="w-10 text-fg3 tabular-nums">{i + 1}</Td>
                  <Td className={`w-8 ${h.way === "reply" ? "text-ok" : "text-accent"}`}><span aria-hidden>{h.way === "reply" ? "←" : "→"}</span><span className="sr-only">{t(h.way === "reply" ? "Reply" : "Request")}</span></Td>
                  <Td className="font-medium"><span className="flex items-center gap-2"><Status cell level={h.level} label="" />{h.device}</span></Td>
                  <Td mono>{h.ip || "—"}</Td>
                  <Td className="text-fg2">{tn(h.detail)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
        {aside}
      </div>
    </>
  )
}

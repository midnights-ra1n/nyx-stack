import { LinkIcon, LinkSlashIcon, PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useRef, useState } from "react"
import { Button, Empty, ErrorNote, IconButton, Input, Meter, Panel, Select, Stat, Tabs, ask } from "../ui/components"
import { type Col, RecordForm } from "../ui/crud"
import { t } from "../ui/i18n"
import { api, sortRows, useApi, useStored } from "../ui/lib"
import { Link, navigate, PageHeader } from "../ui/shell"
import { peerOf } from "./inventory"

export const RACK: Col[] = [
  { key: "name", label: "Name", required: true },
  { key: "location", label: "Location", suggest: true, hint: "Room or site, as in the hardware inventory." },
  { key: "units", label: "Height (U)", type: "number", hint: "Such as 42, 24, or 12 for a wall cabinet." },
  { key: "notes", label: "Notes", type: "area" },
]

export interface Placed { id: string; rack_u: number; rack_units: number }
export const height = (d: { rack_units?: number }) => Math.max(1, d.rack_units || 1)

/** Whether a device of `h` units fits at unit `u` (its lowest one, 1 at the bottom) without covering another. */
export function fits(placed: Placed[], units: number, id: string, u: number, h: number) {
  if (u < 1 || u + h - 1 > units) return false
  return placed.every((d) => d.id === id || u + h - 1 < d.rack_u || d.rack_u + height(d) - 1 < u)
}

/** The highest free place for `h` units, as racks fill from the top; 0 when none is left. */
export function firstFree(placed: Placed[], units: number, h: number, id = "") {
  for (let u = units - h + 1; u >= 1; u--) if (fits(placed, units, id, u, h)) return u
  return 0
}

const UH = 24, X0 = 36, BODY = 340, CABLE = 90

/** One rack seen from the front, drawn to scale. Devices are dragged in from the list or moved inside it. */
function Elevation({ rack, devices, ports, selected, onSelect, onPlace }: { rack: any; devices: any[]; ports: any[]; selected?: string; onSelect: (id: string) => void; onPlace: (id: string, u: number) => void }) {
  const units = rack.units || 42
  const svg = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<{ id: string; u: number; dy: number } | null>(null)
  const unitAt = (clientY: number, dy = 0) => {
    const p = new DOMPoint(0, clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse())
    return units - Math.floor((p.y - dy) / UH)
  }
  const top = (d: any) => (units - (d.rack_u + height(d) - 1)) * UH
  const shown = devices.map((d) => (drag && drag.id === d.id ? { ...d, rack_u: drag.u } : d))
  const ok = !drag || fits(devices, units, drag.id, drag.u, height(devices.find((d) => d.id === drag.id)))
  // Cables between two devices of this rack, drawn on the right as on the back of a real one.
  const cables = ports.flatMap((p) => {
    const q = ports.find((q) => q.id === p.peer)
    const [a, b] = [shown.find((d) => d.id === p.device), q && shown.find((d) => d.id === q.device)]
    return a && b && a !== b ? [{ id: p.id, a, b, label: `${a.name} · ${p.name} → ${b.name} · ${q.name}` }] : []
  })
  return (
    <div className="overflow-x-auto" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/nyx-device"); if (id) onPlace(id, unitAt(e.clientY)) }}>
      <svg ref={svg} width={X0 + BODY + CABLE} height={units * UH + 2} viewBox={`0 0 ${X0 + BODY + CABLE} ${units * UH + 2}`} role="img" aria-label={t("Rack {name}, {units} units, front view. Devices are listed beside it.", { name: rack.name, units })} className="select-none">
        <rect x={X0 - 6} y={0} width={BODY + 12} height={units * UH + 2} rx={6} className="fill-bg stroke-line2" />
        {Array.from({ length: units }, (_, i) => (
          <g key={i}>
            <line x1={X0} x2={X0 + BODY} y1={i * UH + 1} y2={i * UH + 1} className="stroke-line" />
            <text x={X0 - 12} y={i * UH + 16} textAnchor="end" className="fill-fg3 font-mono text-[11px]">{units - i}</text>
          </g>
        ))}
        {cables.map((c) => {
          const ya = top(c.a) + (height(c.a) * UH) / 2, yb = top(c.b) + (height(c.b) * UH) / 2, bend = Math.min(CABLE - 8, 16 + Math.abs(ya - yb) / 4)
          return <path key={c.id} d={`M ${X0 + BODY} ${ya} C ${X0 + BODY + bend} ${ya}, ${X0 + BODY + bend} ${yb}, ${X0 + BODY} ${yb}`} fill="none" strokeWidth={2} className="stroke-info/80"><title>{c.label}</title></path>
        })}
        {shown.map((d) => {
          const h = height(d), y = top(d), moving = drag?.id === d.id
          return (
            <g key={d.id} transform={`translate(${X0} ${y + 2})`} className="cursor-grab touch-none" tabIndex={0} role="button" aria-label={t("{name}, unit {u}", { name: d.name, u: d.rack_u })}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(d.id); if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); onPlace(d.id, d.rack_u + (e.key === "ArrowUp" ? 1 : -1)) } }}
              onPointerDown={(e) => { const p = new DOMPoint(0, e.clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse()); setDrag({ id: d.id, u: d.rack_u, dy: p.y - y }); e.currentTarget.setPointerCapture(e.pointerId) }}
              onPointerMove={(e) => { if (drag && drag.id === d.id) setDrag({ ...drag, u: unitAt(e.clientY, drag.dy) - h + 1 }) }}
              onPointerUp={() => { if (!drag) return; const moved = drag.u !== d.rack_u; setDrag(null); if (moved) { if (ok) onPlace(d.id, drag.u) } else onSelect(d.id) }}>
              <title>{`${d.name}${d.model ? ` · ${d.model}` : ""} · U${d.rack_u}${h > 1 ? `–${d.rack_u + h - 1}` : ""}`}</title>
              <rect width={BODY} height={h * UH - 3} rx={4} className={moving && !ok ? "fill-crit-soft stroke-crit" : selected === d.id ? "fill-accent-soft stroke-accent" : "fill-raised stroke-line2 hover:stroke-fg3"} />
              <text x={10} y={Math.min(h * UH / 2 + 4, 16)} className="fill-fg text-[13px] font-medium">{d.name.length > 30 ? `${d.name.slice(0, 29)}…` : d.name}</text>
              {h > 1 && <text x={10} y={34} className="fill-fg3 text-xs">{[d.manufacturer, d.model].filter(Boolean).join(" ") || d.category}</text>}
              <text x={BODY - 10} y={Math.min(h * UH / 2 + 4, 16)} textAnchor="end" className="fill-fg3 text-xs">{h}U</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/** Cables of the selected device, and a form to plug it into another one. */
function Cables({ device, devices, ports, onChange }: { device: any; devices: any[]; ports: any[]; onChange: () => void }) {
  const [f, setF] = useState({ to: "", here: "", there: "" })
  const [error, setError] = useState("")
  const name = (id: string) => devices.find((d) => d.id === id)?.name ?? "?"
  const mine = sortRows(ports.filter((p) => p.device === device.id), (p) => p.name)
  /** The port of that name on that device, made if it does not exist yet. */
  const port = async (dev: string, n: string) => ports.find((p) => p.device === dev && p.name === n) ?? api("/api/c/ports", { body: { device: dev, name: n } })
  const connect = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    try {
      const [a, b] = [await port(device.id, f.here.trim()), await port(f.to, f.there.trim())]
      // A port holds one cable: whatever was plugged into either end comes out first.
      const stale = ports.filter((q) => q.id !== a.id && (q.peer === a.id || q.peer === b.id))
      await Promise.all([...stale, ...(b.peer ? [b] : [])].map((q) => api(`/api/c/ports/${q.id}`, { method: "PATCH", body: { peer: "" } })))
      await api(`/api/c/ports/${a.id}`, { method: "PATCH", body: { peer: b.id } })
      setF({ to: "", here: "", there: "" })
      onChange()
    } catch (err) { setError((err as Error).message) }
  }
  const unplug = async (p: any) => {
    const q = peerOf(p, ports)
    await api(`/api/c/ports/${p.peer ? p.id : q.id}`, { method: "PATCH", body: { peer: "" } })
    onChange()
  }
  return (
    <div className="flex flex-col gap-3">
      {mine.length ? (
        <ul className="divide-y divide-line text-[13px]">
          {mine.map((p) => {
            const q = peerOf(p, ports)
            return (
              <li key={p.id} className="flex items-center gap-2 py-1">
                <span className="w-20 truncate font-mono">{p.name}</span>
                <span className="flex-1 truncate text-fg2">{q ? `→ ${name(q.device)} · ${q.name}` : t("Not cabled")}</span>
                {q && <IconButton label={t("Unplug {port}", { port: p.name })} icon={LinkSlashIcon} onClick={() => unplug(p)} />}
              </li>
            )
          })}
        </ul>
      ) : <Empty>{t("No port yet.")}</Empty>}
      <form className="grid grid-cols-2 gap-3 border-t border-line pt-3" onSubmit={connect}>
        <div className="col-span-full"><Select label="Plug into" required value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} options={[{ value: "", label: "Choose a device…" }, ...sortRows(devices.filter((d) => d.id !== device.id), (d) => d.name).map((d) => ({ value: d.id, label: d.name }))]} /></div>
        <Input label="Port here" required placeholder={t("eth0")} value={f.here} onChange={(e) => setF({ ...f, here: e.target.value })} />
        <Input label="Port there" required placeholder={t("port 1")} value={f.there} onChange={(e) => setF({ ...f, there: e.target.value })} />
        <div className="col-span-full flex items-center gap-3"><Button type="submit"><LinkIcon className="size-5" aria-hidden />{t("Add cable")}</Button><ErrorNote>{error}</ErrorNote></div>
      </form>
    </div>
  )
}

export function Racks() {
  const racks = useApi("/api/c/racks?sort=name&perPage=200", { poll: false })
  const hardware = useApi("/api/c/hardware?perPage=500", { poll: false })
  const ports = useApi("/api/c/ports?perPage=1000", { poll: false })
  const [current, setCurrent] = useStored("nyx.rack", "")
  const [edit, setEdit] = useState<any | null | undefined>()
  const [selected, setSelected] = useState<string>()
  const [note, setNote] = useState("")
  const list: any[] = racks.data?.items ?? []
  const rack = list.find((r) => r.id === current) ?? list[0]
  const all: any[] = hardware.data?.items ?? []
  const inRack = all.filter((h) => rack && h.rack === rack.id && h.rack_u > 0)
  const loose = sortRows(all.filter((h) => !h.rack || !list.some((r) => r.id === h.rack)), (h) => h.name)
  const units = rack?.units || 42
  const used = inRack.reduce((n, d) => n + height(d), 0)
  const sel = all.find((h) => h.id === selected)
  const reload = () => { hardware.reload(); ports.reload() }

  const patch = async (id: string, body: any) => {
    try { await api(`/api/c/hardware/${id}`, { method: "PATCH", body }); setNote(""); reload() } catch (e) { setNote((e as Error).message) }
  }
  const place = (id: string, u: number) => {
    const d = all.find((h) => h.id === id)
    if (!d || !rack) return
    const h = height(d), at = Math.min(units - h + 1, Math.max(1, u))
    // Dropped on a full spot: the nearest free one above, or anywhere left.
    const free = fits(inRack, units, id, at, h) ? at : firstFree(inRack.filter((x) => x.rack_u >= at), units, h, id) || firstFree(inRack, units, h, id)
    if (!free) return setNote(t("No room left for {name} ({h}U) in {rack}.", { name: d.name, h, rack: rack.name }))
    setSelected(id)
    patch(id, { rack: rack.id, rack_u: free, rack_units: h })
  }
  const resize = (d: any, h: number) => fits(inRack, units, d.id, d.rack_u, h) ? patch(d.id, { rack_units: h }) : setNote(t("{n}U does not fit there: move {name} first.", { n: h, name: d.name }))
  const removeRack = async () => {
    if (!rack || !await ask(t("Delete the rack {name}? Its devices stay in the inventory, out of any rack.", { name: rack.name }), { action: "Delete", danger: true })) return
    await Promise.all(all.filter((h) => h.rack === rack.id).map((h) => api(`/api/c/hardware/${h.id}`, { method: "PATCH", body: { rack: "", rack_u: 0 } })))
    await api(`/api/c/racks/${rack.id}`, { method: "DELETE" })
    racks.reload(); reload()
  }

  return (
    <>
      <PageHeader title={t("Racks")} subtitle={note || t("Drag a device from the list into the rack, or inside it to move it. Click a device for its cables.")} actions={<>
        {rack && <Button onClick={() => setEdit(rack)}><PencilSquareIcon className="size-5" aria-hidden />{t("Edit rack")}</Button>}
        {rack && <Button variant="danger" onClick={removeRack}><TrashIcon className="size-5" aria-hidden />{t("Delete")}</Button>}
        <Button variant="primary" onClick={() => setEdit(null)}><PlusIcon className="size-5" aria-hidden />{t("Add rack")}</Button>
      </>} />
      {edit !== undefined && <RecordForm key={edit?.id ?? "new"} cols={RACK} row={edit} collection="racks" rows={list} defaults={{ units: 42 }} title={edit ? t("Edit {name}", { name: edit.name }) : "Add rack"}
        onSaved={(r) => setCurrent(r.id)} onDone={() => { setEdit(undefined); racks.reload() }} />}
      <ErrorNote>{racks.error || hardware.error}</ErrorNote>
      {!rack ? <Panel title={t("Racks")}><Empty>{t("No rack yet. Add one, then drag your servers, switches and patch panels into it.")}</Empty></Panel> : (
        <div className="flex flex-col gap-4">
          {list.length > 1 && <Tabs tabs={list.map((r) => ({ id: r.id, label: r.name }))} value={rack.id} onChange={(id) => { setCurrent(id); setSelected(undefined) }} />}
          <div className="grid grid-cols-[auto_minmax(280px,1fr)] items-start gap-4 max-lg:grid-cols-1">
            <Panel title={rack.name} badge={rack.location && <span className="text-[13px] text-fg2">{rack.location}</span>} footer="Blue curves are cables between devices of this rack, recorded on their network ports.">
              <Elevation rack={rack} devices={inRack} ports={ports.data?.items ?? []} selected={selected} onSelect={setSelected} onPlace={place} />
            </Panel>
            <div className="flex flex-col gap-4">
              <Panel title={t("Capacity")}>
                <div className="grid grid-cols-2 gap-4"><Stat label="Units used" value={`${used} / ${units}`} /><Stat label="Devices" value={inRack.length} /></div>
                <div className="mt-3"><Meter pct={(used / units) * 100} warn={80} crit={95} /></div>
              </Panel>
              {sel && sel.rack === rack.id && (
                <Panel title={sel.name} actions={[{ label: "Open the record", onClick: () => navigate(`/hardware/${sel.id}`) }]}>
                  <div className="mb-3 grid grid-cols-2 gap-3">
                    <Input label="Position (U)" type="number" min={1} max={units} value={sel.rack_u} onChange={(e) => place(sel.id, Number(e.target.value))} />
                    <Select label="Height (U)" value={String(height(sel))} onChange={(e) => resize(sel, Number(e.target.value))} options={Array.from({ length: 10 }, (_, i) => String(i + 1))} />
                  </div>
                  <div className="mb-4 flex flex-wrap gap-3">
                    <Link to={`/hardware/${sel.id}`} className="inline-flex h-9 items-center text-accent">{t("Open the record")}</Link>
                    <Button onClick={() => { setSelected(undefined); patch(sel.id, { rack: "", rack_u: 0 }) }}>{t("Take out of the rack")}</Button>
                  </div>
                  <h3 className="mb-2 text-[13px] font-medium text-fg2">{t("Cables")}</h3>
                  <Cables device={sel} devices={all} ports={ports.data?.items ?? []} onChange={reload} />
                </Panel>
              )}
              <Panel title={t("Not in a rack")} flush>
                {loose.length === 0 ? <div className="px-4 pb-4"><Empty>{t("Every device has a place.")}</Empty></div> : (
                  <ul className="max-h-96 divide-y divide-line overflow-y-auto">
                    {loose.map((h) => (
                      <li key={h.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/nyx-device", h.id)} className="flex cursor-grab items-center gap-3 px-4 py-1.5">
                        <span className="min-w-0 flex-1"><span className="block truncate font-medium">{h.name}</span><span className="block truncate text-xs text-fg3">{t(h.category || "Other")}</span></span>
                        <Button onClick={() => place(h.id, units)}>{t("Place")}</Button>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

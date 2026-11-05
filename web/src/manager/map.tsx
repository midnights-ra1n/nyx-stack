import { ArrowDownTrayIcon, LinkIcon, PlusIcon, ServerStackIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useRef, useState } from "react"
import { Button, Empty, ErrorNote, IconButton, Modal, Panel, Select, Table, Td, Input } from "../ui/components"
import { type Col, RecordForm } from "../ui/crud"
import { api, useApi } from "../ui/lib"
import { PageHeader, Section } from "../ui/shell"

const W = 140, H = 56
const FORMATS = [["svg", "SVG"], ["drawio", "draw.io"], ["mermaid", "Mermaid"], ["dot", "Graphviz"], ["json", "JSON"]]
const NODE: Col[] = [
  { key: "name", label: "Name", required: true },
  { key: "ip", label: "Address", mono: true },
  { key: "type", label: "Type", type: "select", options: ["router", "switch", "server", "vm", "proxmox", "physical", "vps", "other"] },
]

function LinkForm({ nodes, onDone }: { nodes: any[]; onDone: () => void }) {
  const options = [{ value: "", label: "Choose…" }, ...nodes.map((n) => ({ value: n.id, label: n.name }))]
  const [f, setF] = useState({ source: "", target: "", label: "" })
  const [error, setError] = useState("")
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try { await api("/api/c/map_links", { body: f }); onDone() } catch (err) { setError((err as Error).message) }
  }
  return (
    <Modal title="Add link" onClose={onDone}>
      <form className="flex flex-col gap-4" onSubmit={save}>
        <Select label="From" required value={f.source} options={options} onChange={(e) => setF({ ...f, source: e.target.value })} />
        <Select label="To" required value={f.target} options={options} onChange={(e) => setF({ ...f, target: e.target.value })} />
        <Input label="Label" placeholder="VLAN 10" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
        <ErrorNote>{error}</ErrorNote>
        <div><Button variant="primary" type="submit">Save</Button></div>
      </form>
    </Modal>
  )
}

export function NetworkMap() {
  const nodes = useApi("/api/c/map_nodes?perPage=500", { poll: false })
  const links = useApi("/api/c/map_links?perPage=500", { poll: false })
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({})
  const [form, setForm] = useState<"node" | "link" | any>()
  const [note, setNote] = useState("")
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)

  const list: any[] = (nodes.data?.items ?? []).map((n: any) => ({ ...n, ...moved[n.id] }))
  const byId = Object.fromEntries(list.map((n) => [n.id, n]))
  const right = Math.max(600, ...list.map((n) => n.x + W + 40))
  const bottom = Math.max(320, ...list.map((n) => n.y + H + 40))

  const toSvg = (e: React.PointerEvent) => {
    const m = svg.current!.getScreenCTM()!.inverse()
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m)
    return { x: p.x, y: p.y }
  }
  const down = (e: React.PointerEvent, n: any) => {
    const p = toSvg(e)
    drag.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return
    const p = toSvg(e)
    const { id, dx, dy } = drag.current
    setMoved((m) => ({ ...m, [id]: { x: Math.max(0, Math.round(p.x - dx)), y: Math.max(0, Math.round(p.y - dy)) } }))
  }
  const up = () => {
    const id = drag.current?.id
    drag.current = null
    if (id && moved[id]) api(`/api/c/map_nodes/${id}`, { method: "PATCH", body: moved[id] }).catch((e) => setNote(e.message))
  }
  const done = () => { setForm(undefined); nodes.reload(); links.reload() }
  const remove = async (coll: string, id: string) => { await api(`/api/c/${coll}/${id}`, { method: "DELETE" }); done() }
  const removeNode = async (n: any) => {
    if (!confirm(`Delete ${n.name}?`)) return
    for (const l of links.data.items.filter((l: any) => l.source === n.id || l.target === n.id)) await api(`/api/c/map_links/${l.id}`, { method: "DELETE" })
    remove("map_nodes", n.id)
  }
  const importHosts = async () => {
    try { const r = await api("/api/map/import", { method: "POST" }); setNote(`${r.added} hosts added.`); done() } catch (e) { setNote((e as Error).message) }
  }

  return (
    <>
      <PageHeader title="Network map" subtitle={note} actions={<>
        <Button onClick={importHosts}><ServerStackIcon className="size-5" aria-hidden />Import hosts</Button>
        <Button onClick={() => setForm("link")} disabled={list.length < 2}><LinkIcon className="size-5" aria-hidden />Add link</Button>
        <Button variant="primary" onClick={() => setForm("node")}><PlusIcon className="size-5" aria-hidden />Add device</Button>
      </>} />
      <Section>
        <Panel title="Map" flush>
          {list.length === 0 ? <div className="px-5 pb-5"><Empty>Add a device or import hosts from monitoring.</Empty></div> : (
            // Nodes capture touches to drag, the empty canvas keeps scrolling the page.
            <div className="overflow-auto">
              <svg ref={svg} width={right} height={bottom} viewBox={`0 0 ${right} ${bottom}`} role="img" aria-label={`Network map with ${list.length} devices. The same data is listed below.`}>
                {links.data?.items.map((l: any) => {
                  const [a, b] = [byId[l.source], byId[l.target]]
                  if (!a || !b) return null
                  const [x1, y1, x2, y2] = [a.x + W / 2, a.y + H / 2, b.x + W / 2, b.y + H / 2]
                  return <g key={l.id}><line x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-line2" />{l.label && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} textAnchor="middle" className="fill-fg3 text-xs">{l.label}</text>}</g>
                })}
                {list.map((n) => (
                  <g key={n.id} transform={`translate(${n.x} ${n.y})`} className="cursor-grab touch-none" onPointerDown={(e) => down(e, n)} onPointerMove={move} onPointerUp={up} onDoubleClick={() => setForm(n)}>
                    <rect width={W} height={H} rx={6} className="fill-raised stroke-line2" />
                    <text x={W / 2} y={24} textAnchor="middle" className="fill-fg text-sm font-medium">{n.name}</text>
                    <text x={W / 2} y={42} textAnchor="middle" className="fill-fg2 font-mono text-xs">{n.ip}</text>
                  </g>
                ))}
              </svg>
            </div>
          )}
        </Panel>
        <Panel title="Export">
          <div className="flex flex-wrap gap-2">
            {FORMATS.map(([f, label]) => <a key={f} href={`/api/map/export/${f}`} download><Button><ArrowDownTrayIcon className="size-5" aria-hidden />{label}</Button></a>)}
          </div>
        </Panel>
        {list.length > 0 && (
          <Panel title="Devices" flush>
            <Table head={["Name", "Address", "Type", ""]}>
              {list.map((n) => (
                <tr key={n.id}>
                  <Td className="font-medium"><button className="min-h-11 text-left" onClick={() => setForm(n)}>{n.name}</button></Td>
                  <Td mono>{n.ip || "—"}</Td>
                  <Td className="text-fg2">{n.type || "—"}</Td>
                  <Td className="w-12 text-right"><IconButton label="Delete" icon={TrashIcon} onClick={() => removeNode(n)} /></Td>
                </tr>
              ))}
            </Table>
          </Panel>
        )}
        {(links.data?.items.length ?? 0) > 0 && (
          <Panel title="Links" flush>
            <Table head={["From", "To", "Label", ""]}>
              {links.data.items.map((l: any) => (
                <tr key={l.id}>
                  <Td className="font-medium">{byId[l.source]?.name ?? "—"}</Td>
                  <Td>{byId[l.target]?.name ?? "—"}</Td>
                  <Td className="text-fg2">{l.label || "—"}</Td>
                  <Td className="w-12 text-right"><IconButton label="Delete" icon={TrashIcon} onClick={() => remove("map_links", l.id)} /></Td>
                </tr>
              ))}
            </Table>
          </Panel>
        )}
      </Section>
      {form === "link" && <LinkForm nodes={list} onDone={done} />}
      {form && form !== "link" && <RecordForm title={form === "node" ? "Add device" : "Edit device"} cols={NODE} collection="map_nodes" row={form === "node" ? null : form} onDone={done} defaults={undefined} />}
    </>
  )
}

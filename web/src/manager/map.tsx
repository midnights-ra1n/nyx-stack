import { ArrowDownTrayIcon, ArrowsRightLeftIcon, CloudIcon, ComputerDesktopIcon, CubeIcon, CubeTransparentIcon, LinkIcon, PlusIcon, ServerIcon, ServerStackIcon, SignalIcon, Squares2X2Icon, TrashIcon } from "@heroicons/react/24/outline"
import { useRef, useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { Button, Empty, IconButton, Panel, Select, Table, Td, Input } from "../ui/components"
import { type Col, Editor, EditorGroup, RecordForm } from "../ui/crud"
import { api, useApi } from "../ui/lib"
import { ProxmoxIcon } from "../ui/brand-icons"
import { PageHeader } from "../ui/shell"
import { arrange, curve, frame, H, parents, treePath, W } from "./map-layout"

const TYPE_ICONS: Record<string, any> = { proxmox: ProxmoxIcon, physical: ServerIcon, server: ServerIcon, vm: ComputerDesktopIcon, lxc: CubeIcon, docker: CubeTransparentIcon, vps: CloudIcon, router: SignalIcon, switch: ArrowsRightLeftIcon }
const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const FORMATS = [["svg", "SVG"], ["drawio", "draw.io"], ["mermaid", "Mermaid"], ["dot", "Graphviz"], ["json", "JSON"]]
const NODE: Col[] = [
  { key: "name", label: "Name", required: true },
  { key: "ip", label: "Address", mono: true },
  { key: "type", label: "Type", type: "select", options: ["router", "switch", "server", "vm", "lxc", "docker", "proxmox", "physical", "vps", "other"], hint: "A VM, container or other device linked to a Proxmox, physical or server node is drawn under it." },
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
    <Editor title="Add link" onCancel={onDone} onSubmit={save} error={error}>
      <EditorGroup title="Between">
        <Select label="From" required value={f.source} options={options} onChange={(e) => setF({ ...f, source: e.target.value })} />
        <Select label="To" required value={f.target} options={options} onChange={(e) => setF({ ...f, target: e.target.value })} />
        <Input label="Label" placeholder="VLAN 10" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
      </EditorGroup>
    </Editor>
  )
}

export function NetworkMap() {
  const nodes = useApi("/api/c/map_nodes?perPage=500", { poll: false })
  const links = useApi("/api/c/map_links?perPage=500", { poll: false })
  const vpn = useApi("/api/c/vpn_links?perPage=500", { poll: false })
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({})
  const [form, setForm] = useState<"node" | "link" | any>()
  const [note, setNote] = useState("")
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)

  const list: any[] = (nodes.data?.items ?? []).map((n: any) => ({ ...n, ...moved[n.id] }))
  const byId = Object.fromEntries(list.map((n) => [n.id, n]))
  // Kept on the VPN page, and drawn here when both ends are devices of this map.
  const nodeId = (name: string) => list.find((n) => n.name === name)?.id
  const tunnels = (vpn.data?.items ?? []).filter((v: any) => v.side_b && nodeId(v.side_a) && nodeId(v.side_b)).map((v: any) => ({ id: v.id, source: nodeId(v.side_a), target: nodeId(v.side_b), label: v.name, vpn: true }))
  const right = Math.max(600, ...list.map((n) => n.x + W + 40))
  const bottom = Math.max(320, ...list.map((n) => n.y + H + 40))
  const allLinks: any[] = [...(links.data?.items ?? []), ...tunnels]
  const parent = parents(list, links.data?.items ?? [])
  const isTree = (l: any) => !l.vpn && (parent[l.source] === l.target || parent[l.target] === l.source)
  const hosts = list.filter((n) => Object.values(parent).includes(n.id))

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
  /** Writes the tidy places of every node that is not there yet. */
  const tidy = async (all: any[], allLinks: any[]) => {
    const at = arrange(all, allLinks)
    const changed = all.filter((n) => at[n.id] && (at[n.id].x !== n.x || at[n.id].y !== n.y))
    await Promise.all(changed.map((n) => api(`/api/c/map_nodes/${n.id}`, { method: "PATCH", body: at[n.id] })))
    setMoved({})
  }
  const arrangeAll = async () => {
    if (!confirm("Place every device again: network gear on top, each host with its guests under it, the rest below? Places you set by hand are replaced.")) return
    try { await tidy(list, links.data?.items ?? []); setNote("Map arranged."); done() } catch (e) { setNote((e as Error).message) }
  }
  const importHosts = async () => {
    try {
      const r = await api("/api/map/import", { method: "POST" })
      // A first import is arranged right away; later ones leave your places alone.
      if (list.length === 0) {
        const [n, l] = await Promise.all([api("/api/c/map_nodes?perPage=500"), api("/api/c/map_links?perPage=500")])
        await tidy(n.items, l.items)
      }
      setNote(`${r.added} hosts added.${list.length && r.added ? " Press Arrange to place them." : ""}`)
      done()
    } catch (e) { setNote((e as Error).message) }
  }

  return (
    <>
      <PageHeader title="Network map" subtitle={note} actions={<>
        <CustomizeButton />
        <Button onClick={importHosts}><ServerStackIcon className="size-5" aria-hidden />Import hosts</Button>
        <Button onClick={arrangeAll} disabled={list.length < 2}><Squares2X2Icon className="size-5" aria-hidden />Arrange</Button>
        <Button onClick={() => setForm("link")} disabled={list.length < 2}><LinkIcon className="size-5" aria-hidden />Add link</Button>
        <Button variant="primary" onClick={() => setForm("node")}><PlusIcon className="size-5" aria-hidden />Add device</Button>
      </>} />
      {form === "link" && <LinkForm nodes={list} onDone={done} />}
      {form && form !== "link" && <RecordForm title={form === "node" ? "Add device" : "Edit device"} cols={NODE} collection="map_nodes" key={form === "node" ? "new" : form.id} row={form === "node" ? null : form} onDone={done} defaults={undefined} />}
      <Board id="map" desktop={{ cols: [["map", "export", "devices", "links"]], hidden: [] }} phone={{ cols: [["map", "export", "devices", "links"]], hidden: [] }} panels={[
        { id: "map", title: "Map", render: (edit: any) => (
        <Panel title="Map" flush edit={edit} footer="Drag a device to move it, double-click it to edit. Guests sit in the frame of their host; blue curves are your own links, dashed orange ones VPN tunnels.">
          {list.length === 0 ? <div className="px-4 pb-4"><Empty>Add a device or import hosts from monitoring.</Empty></div> : (
            // Nodes capture touches to drag, the empty canvas keeps scrolling the page.
            <div className="overflow-auto">
              <svg ref={svg} width={right} height={bottom} viewBox={`0 0 ${right} ${bottom}`} role="img" aria-label={`Network map with ${list.length} devices. The same data is listed below.`}>
                {hosts.map((h) => {
                  const f = frame(h, list.filter((n) => parent[n.id] === h.id))
                  return <rect key={`f${h.id}`} x={f.x} y={f.y} width={f.w} height={f.h} rx={12} className="fill-bg/60 stroke-line" />
                })}
                {allLinks.map((l: any) => {
                  const [a, b] = [byId[l.source], byId[l.target]]
                  if (!a || !b) return null
                  if (isTree(l)) {
                    const [p, c] = parent[l.source] === l.target ? [b, a] : [a, b]
                    return <path key={l.id} d={treePath(p, c)} fill="none" className="stroke-line2" />
                  }
                  const c = curve(a, b)
                  return (
                    <g key={l.id}>
                      <path d={c.d} fill="none" strokeWidth={1.5} className={l.vpn ? "stroke-accent" : "stroke-info/70"} strokeDasharray={l.vpn ? "6 4" : undefined} />
                      {l.label && <text x={c.mx} y={c.my - 6} textAnchor="middle" className="fill-fg2 text-xs" stroke="var(--color-surface)" strokeWidth={3} paintOrder="stroke">{l.label}</text>}
                    </g>
                  )
                })}
                {list.map((n) => {
                  const I = TYPE_ICONS[n.type] ?? CubeIcon
                  const host = hosts.includes(n)
                  return (
                    <g key={n.id} transform={`translate(${n.x} ${n.y})`} className="cursor-grab touch-none [&:hover>rect]:stroke-accent" onPointerDown={(e) => down(e, n)} onPointerMove={move} onPointerUp={up} onDoubleClick={() => setForm(n)}>
                      <title>{`${n.name}${n.ip ? ` · ${n.ip}` : ""}${n.type ? ` · ${n.type}` : ""}`}</title>
                      <rect width={W} height={H} rx={8} className={host ? "fill-raised stroke-accent/70" : "fill-raised stroke-line2"} />
                      <I x={12} y={H / 2 - 10} width={20} height={20} className={host ? "text-accent" : "text-fg3"} />
                      <text x={42} y={n.ip ? 22 : 31} className="fill-fg text-[13px] font-medium">{fit(n.name, 19)}</text>
                      {n.ip && <text x={42} y={39} className="fill-fg2 font-mono text-xs">{n.ip}</text>}
                    </g>
                  )
                })}
              </svg>
            </div>
          )}
        </Panel>
        ) },
        { id: "export", title: "Export", render: (edit: any) => (
        <Panel title="Export" edit={edit}>
          <div className="flex flex-wrap gap-2">
            {FORMATS.map(([f, label]) => <a key={f} href={`/api/map/export/${f}`} download><Button><ArrowDownTrayIcon className="size-5" aria-hidden />{label}</Button></a>)}
          </div>
        </Panel>
        ) },
        { id: "devices", title: "Devices", absent: list.length === 0, render: (edit: any) => (
          <Panel title="Devices" flush edit={edit}>
            <Table head={["Name", "Address", "Type", ""]}>
              {list.map((n) => (
                <tr key={n.id}>
                  <Td className="font-medium"><button className="min-h-9 max-sm:min-h-11 text-left" onClick={() => setForm(n)}>{n.name}</button></Td>
                  <Td mono>{n.ip || "—"}</Td>
                  <Td className="text-fg2">{n.type || "—"}</Td>
                  <Td className="w-12 text-right"><IconButton label="Delete" icon={TrashIcon} onClick={() => removeNode(n)} /></Td>
                </tr>
              ))}
            </Table>
          </Panel>
        ) },
        { id: "links", title: "Links", absent: !links.data?.items.length, render: (edit: any) => (
          <Panel title="Links" flush edit={edit}>
            <Table head={["From", "To", "Label", ""]}>
              {links.data?.items.map((l: any) => (
                <tr key={l.id}>
                  <Td className="font-medium">{byId[l.source]?.name ?? "—"}</Td>
                  <Td>{byId[l.target]?.name ?? "—"}</Td>
                  <Td className="text-fg2">{l.label || "—"}</Td>
                  <Td className="w-12 text-right"><IconButton label="Delete" icon={TrashIcon} onClick={() => remove("map_links", l.id)} /></Td>
                </tr>
              ))}
            </Table>
          </Panel>
        ) },
      ]} />
    </>
  )
}

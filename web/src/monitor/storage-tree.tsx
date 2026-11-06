import { ChevronRightIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Button, Check, Empty, Meter, Modal, Mono, Panel } from "../ui/components"
import { levelOf, levelText, sortRows, useStored } from "../ui/lib"
import { buildTree, HostIcon, hostType } from "./hosts"

export interface StorageRow { key: string; depth: number; host?: any; mount?: string; pct?: number; expandable: boolean; open: boolean }

const WORD: Record<string, string> = { ok: "OK", warn: "Warning", crit: "Critical" }
const mountKey = (d: any) => `${d.host_id}${d.mount}`

/**
 * Hosts in their Proxmox tree, each with its mount points. A host with one mount point
 * is one row. A collapsed host shows its fullest one, so that closing it hides no problem.
 */
export function storageTree(hosts: any[], storage: any[], hidden: string[], collapsed: Set<string>): StorageRow[] {
  const shown = storage.filter((d) => !hidden.includes(mountKey(d)))
  const mountsOf = (id: string) => sortRows(shown.filter((d) => d.host_id === id), (d) => d.mount)
  const kids = (id: string) => hosts.filter((h) => h.parent === id)
  const fullest = (h: any): number | undefined => {
    const all = [...mountsOf(h.id).map((d) => d.pct), ...kids(h.id).map(fullest)].filter((p) => p != null)
    return all.length ? Math.max(...all) : undefined
  }
  const rows: StorageRow[] = []
  for (const { host, depth } of buildTree(hosts, () => [], collapsed)) {
    if (fullest(host) == null) continue
    const mounts = mountsOf(host.id)
    const single = mounts.length === 1
    const expandable = mounts.length > 1 || kids(host.id).some((k) => fullest(k) != null)
    const open = !expandable || !collapsed.has(host.id)
    rows.push({ key: host.id, depth, host, expandable, open, mount: single && open ? mounts[0].mount : undefined, pct: !open ? fullest(host) : single ? mounts[0].pct : undefined })
    if (open && !single) rows.push(...mounts.map((d) => ({ key: mountKey(d), depth: depth + 1, mount: d.mount, pct: d.pct, expandable: false, open: true })))
  }
  return rows
}

function Row({ row: r, hosts, th, onToggle }: { row: StorageRow; hosts: any[]; th: { warn: number; crit: number }; onToggle: () => void }) {
  const level = levelOf(r.pct, th.warn, th.crit)
  return (
    <li className="grid min-h-8 grid-cols-[minmax(0,1fr)_30%_auto] items-center gap-3 text-[13px]">
      <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: r.depth * 20 }} title={[r.host?.name, r.mount].filter(Boolean).join(" ")}>
        {r.expandable
          ? <button type="button" aria-label={`Toggle ${r.host.name}`} aria-expanded={r.open} className="shrink-0 text-fg3" onClick={onToggle}><ChevronRightIcon className={`size-4 ${r.open ? "rotate-90" : ""}`} aria-hidden /></button>
          : <span className="w-4 shrink-0" />}
        {r.host && <HostIcon type={hostType(r.host, hosts)} />}
        {r.host && <span className="ml-1 truncate font-medium">{r.host.name}</span>}
        {r.mount && <Mono className={`truncate text-fg2 ${r.host ? "ml-1 max-w-1/2 shrink-0" : ""}`}>{r.mount}</Mono>}
      </span>
      {r.pct == null ? <span /> : <Meter pct={r.pct} warn={th.warn} crit={th.crit} />}
      <span className={`w-28 text-right font-medium whitespace-nowrap ${levelText[level]}`}>{r.pct != null && `${r.pct.toFixed(0)} % · ${WORD[level]}`}</span>
    </li>
  )
}

function Picker({ hosts, storage, hidden, onChange, onClose }: { hosts: any[]; storage: any[]; hidden: string[]; onChange: (hidden: string[]) => void; onClose: () => void }) {
  const set = (keys: string[], show: boolean) => onChange(show ? hidden.filter((k) => !keys.includes(k)) : [...new Set([...hidden, ...keys])])
  const groups = buildTree(hosts, () => [], new Set()).map((r) => ({ ...r, mounts: sortRows(storage.filter((d) => d.host_id === r.host.id), (d) => d.mount) })).filter((g) => g.mounts.length)
  return (
    <Modal title="Mount points to show" onClose={onClose}>
      <p className="text-fg2">Saved on this device. New mount points are shown until you hide them.</p>
      <ul className="flex flex-col gap-3">
        {groups.map(({ host, depth, mounts }) => {
          const keys = mounts.map(mountKey)
          return (
            <li key={host.id} style={{ paddingLeft: depth * 20 }}>
              <div className="flex items-center gap-2">
                <HostIcon type={hostType(host, hosts)} />
                <Check label={host.name} checked={keys.some((k) => !hidden.includes(k))} onChange={(e) => set(keys, e.target.checked)} />
              </div>
              {mounts.length > 1 && <ul className="pl-7">{mounts.map((d) => <li key={mountKey(d)}><Check label={d.mount} checked={!hidden.includes(mountKey(d))} onChange={(e) => set([mountKey(d)], e.target.checked)} /></li>)}</ul>}
            </li>
          )
        })}
      </ul>
      <div><Button onClick={() => onChange([])}>Show all</Button></div>
    </Modal>
  )
}

/** Block of the overview. What it shows is a preference of this device, like the layout. */
export function StoragePanel({ hosts, allHosts, storage, th, edit }: { hosts: any[]; allHosts: any[]; storage: any[]; th: { warn: number; crit: number }; edit: any }) {
  const [hidden, setHidden] = useStored<string[]>("nyx.storage.hidden", [])
  const [closed, setClosed] = useStored<string[]>("nyx.storage.collapsed", [])
  const [choosing, setChoosing] = useState(false)
  const inScope = storage.filter((d) => hosts.some((h) => h.id === d.host_id))
  const rows = storageTree(hosts, inScope, hidden, new Set(closed))
  const left = inScope.filter((d) => hidden.includes(mountKey(d))).length
  const toggle = (id: string) => setClosed(closed.includes(id) ? closed.filter((c) => c !== id) : [...closed, id])
  return (
    <Panel title="Storage" edit={edit} actions={[{ label: "Choose mount points", onClick: () => setChoosing(true) }]} footer={left > 0 ? `${left} mount ${left > 1 ? "points" : "point"} hidden` : undefined}>
      {!inScope.length ? <Empty>No disks reported.</Empty> : !rows.length ? <Empty>Every mount point is hidden.</Empty> : (
        // Focusable, so that the keyboard can scroll it too.
        <ul tabIndex={0} aria-label="Mount points" className="flex max-h-96 flex-col overflow-y-auto pr-2">
          {rows.map((r) => <Row key={r.key} row={r} hosts={allHosts} th={th} onToggle={() => toggle(r.key)} />)}
        </ul>
      )}
      {choosing && <Picker hosts={hosts} storage={inScope} hidden={hidden} onChange={setHidden} onClose={() => setChoosing(false)} />}
    </Panel>
  )
}

import type { ComponentType, SVGProps } from "react"
import { Empty, Status } from "./components"
import { type Level, levelSoft, levelText } from "./lib"
import { navigate } from "./shell"

export interface ViewNode { label: string; state: Level; type: string; /** Position of the parent in the list. */ parent: number | null; link?: string; sub?: string }
export type TypeIcons = Record<string, { label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }>

const ORDER: Level[] = ["crit", "warn", "off", "info", "ok"]
const worst = (nodes: ViewNode[]) => ORDER.find((l) => nodes.some((n) => n.state === l)) ?? "ok"

function Item({ n, icons }: { n: ViewNode; icons: TypeIcons }) {
  const I = icons[n.type]?.icon
  const body = (
    <>
      {I && <I className={`size-5 shrink-0 ${levelText[n.state]}`} aria-hidden />}
      <span className="min-w-0 flex-1"><span className="block truncate font-medium">{n.label}</span>{n.sub && <span className="block truncate font-mono text-xs text-fg3">{n.sub}</span>}</span>
      <Status cell level={n.state} />
    </>
  )
  const look = `flex w-full min-h-11 items-center gap-3 rounded-control px-3 py-1.5 text-left ${levelSoft[n.state]}`
  return n.link ? <button type="button" className={`${look} hover:outline hover:outline-1 hover:outline-accent`} onClick={() => navigate(n.link!)}>{body}</button> : <div className={look}>{body}</div>
}

/** Hosts with their guests under them, as the indented outline of a file explorer. */
export function TreeView({ nodes, icons }: { nodes: ViewNode[]; icons: TypeIcons }) {
  if (!nodes.length) return <div className="p-4"><Empty>Nothing to show yet.</Empty></div>
  const kids = (parent: number | null) => nodes.flatMap((n, i) => (n.parent === parent ? [i] : []))
  const branch = (i: number, depth: number): React.ReactNode => (
    <li key={i} className="flex flex-col gap-1.5">
      <div style={{ marginLeft: depth * 20 }}><Item n={nodes[i]} icons={icons} /></div>
      {kids(i).length > 0 && <ul className="flex flex-col gap-1.5">{kids(i).map((k) => branch(k, depth + 1))}</ul>}
    </li>
  )
  return <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] items-start gap-x-6 gap-y-4 p-4">{kids(null).map((r) => <div key={r} className="flex flex-col gap-1.5">{branch(r, 0)}</div>)}</ul>
}

/** One card per kind of device, with the worst state of its members in the header. */
export function GroupedView({ nodes, icons }: { nodes: ViewNode[]; icons: TypeIcons }) {
  if (!nodes.length) return <div className="p-4"><Empty>Nothing to show yet.</Empty></div>
  const types = [...new Set(nodes.map((n) => n.type || "other"))].sort((a, b) => (icons[a]?.label ?? a).localeCompare(icons[b]?.label ?? b))
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] items-start gap-4 p-4">
      {types.map((t) => {
        const members = nodes.filter((n) => (n.type || "other") === t)
        const level = worst(members)
        return (
          <section key={t} className="flex flex-col gap-1.5 rounded-box border border-line p-3" aria-label={icons[t]?.label ?? t}>
            <h3 className="mb-1 flex items-center justify-between text-[13px] font-medium text-fg2"><span>{icons[t]?.label ?? t} · {members.length}</span><Status cell level={level} label={members.filter((m) => m.state !== "ok" && m.state !== "info").length ? `${members.filter((m) => m.state !== "ok" && m.state !== "info").length} to check` : "All fine"} /></h3>
            {members.map((n, i) => <Item key={i} n={n} icons={icons} />)}
          </section>
        )
      })}
    </div>
  )
}

export const MAP_VIEWS = [{ id: "diagram", label: "Diagram" }, { id: "tree", label: "Tree" }, { id: "groups", label: "By type" }]

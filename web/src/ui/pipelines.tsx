import { Empty, Status } from "./components"
import { fmt, type Level, levelBg, levelSoft, levelText } from "./lib"

const WORD: Record<string, string> = { ok: "Passed", crit: "Failed", info: "Running", off: "Unknown" }
/** Only web addresses become links: the address comes from a remote server. */
const safe = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : undefined)

/** State of a pipeline: the forge's own word wins for the grey cases (cancelled, skipped). */
export const pipelineWord = (p: { state: string; status?: string }) => (p.state === "off" && p.status ? p.status.replace(/_/g, " ") : WORD[p.state] ?? "Unknown")

export const PIPELINE_VIEWS = [{ id: "cards", label: "Cards" }, { id: "timeline", label: "Timeline" }, { id: "board", label: "Board" }, { id: "list", label: "List" }]

interface Run { state: Level; status?: string; sha?: string; at?: string; url?: string }
interface Row { name: string; repo?: string; branch?: string; state: Level; status?: string; url?: string; sha?: string; at?: string; error?: string; runs: Run[] }

/** Signed-in rows and public ones differ: a public page only has names, verdicts and times. */
const norm = (r: any): Row => ({ ...r, name: r.name ?? r.label, runs: (r.runs ?? []).map((x: any) => (typeof x === "string" ? { state: x } : x)) })

const word = (r: Row) => (r.error && r.state === "off" ? "Unreachable" : pipelineWord(r))
const rate = (r: Row) => {
  const done = r.runs.filter((x) => x.state === "ok" || x.state === "crit")
  return done.length ? Math.round((done.filter((x) => x.state === "ok").length / done.length) * 100) : null
}
const when = (x: Run) => [x.status?.replace(/_/g, " "), x.sha, x.at ? fmt.ago(x.at) : ""].filter(Boolean).join(" · ")

/** Oldest on the left, newest on the right, like a heartbeat. */
function Strip({ runs, tall, grow }: { runs: Run[]; tall?: boolean; grow?: boolean }) {
  if (!runs.length) return <span className="text-fg3">No runs yet</span>
  return (
    <div className={`flex gap-1 ${grow ? "w-full" : ""}`} role="img" aria-label={`Last ${runs.length} runs, newest on the right: ${[...runs].reverse().map((x) => WORD[x.state]).join(", ")}`}>
      {[...runs].reverse().map((x, i) => <span key={i} title={`${WORD[x.state] ?? x.state}${when(x) ? ` · ${when(x)}` : ""}`} className={`rounded-full ${levelBg[x.state] ?? levelBg.off} ${tall ? "h-8" : "h-5"} ${grow ? "min-w-0 flex-1" : "w-2"} ${i === runs.length - 1 ? "" : "opacity-70"}`} />)}
    </div>
  )
}

function Name({ r, className = "" }: { r: Row; className?: string }) {
  const href = safe(r.url)
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" className={`hover:text-accent ${className}`}>{r.name}</a> : <span className={className}>{r.name}</span>
}

const where = (r: Row) => [r.repo, r.branch].filter(Boolean).join(" · ")

function Cards({ rows }: { rows: Row[] }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
      {rows.map((r, i) => (
        <li key={i} className={`flex flex-col gap-3 rounded-panel border border-line p-4 ${levelSoft[r.state]}`}>
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0"><Name r={r} className="block truncate text-[15px] font-medium" /><span className="block truncate text-xs text-fg3" title={where(r)}>{where(r) || "any branch"}</span></span>
            <Status cell level={r.state} label={word(r)} />
          </div>
          <Strip runs={r.runs} tall />
          <div className="flex items-center justify-between text-xs text-fg2">
            <span>{[r.sha, r.at && fmt.ago(r.at)].filter(Boolean).join(" · ") || "—"}</span>
            <span className={rate(r) == null ? "" : rate(r)! >= 90 ? levelText.ok : rate(r)! >= 60 ? levelText.warn : levelText.crit}>{rate(r) == null ? "" : `${rate(r)} % passed`}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

function Timeline({ rows }: { rows: Row[] }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-[minmax(110px,1fr)_minmax(0,3fr)_auto] gap-4 px-1 text-xs text-fg3"><span /><span className="flex justify-between"><span>Older</span><span>Latest</span></span><span className="w-24" /></div>
      {rows.map((r, i) => (
        <div key={i} className="grid min-h-12 grid-cols-[minmax(110px,1fr)_minmax(0,3fr)_auto] items-center gap-4 rounded-control px-1 py-1.5 hover:bg-raised max-sm:grid-cols-1 max-sm:gap-2">
          <span className="min-w-0"><Name r={r} className="block truncate font-medium" /><span className="block truncate text-xs text-fg3">{r.branch || "any branch"}</span></span>
          <Strip runs={r.runs} tall grow />
          <span className="flex w-24 justify-end max-sm:w-auto max-sm:justify-start"><Status cell level={r.state} label={word(r)} /></span>
        </div>
      ))}
    </div>
  )
}

const COLUMNS: [string, string, Level[]][] = [["Failed", "crit", ["crit"]], ["Running", "info", ["info"]], ["Passed", "ok", ["ok"]], ["Other", "off", ["off", "warn"]]]

function Board({ rows }: { rows: Row[] }) {
  return (
    <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
      {COLUMNS.map(([title, level, states]) => {
        const here = rows.filter((r) => states.includes(r.state))
        return (
          <section key={title} aria-label={title} className="flex min-h-24 flex-col gap-2 rounded-panel bg-raised/50 p-2">
            <h3 className={`flex items-center justify-between px-2 pt-1 text-[13px] font-medium ${levelText[level as Level]}`}><span>{title}</span><span className="rounded-full bg-surface px-2 text-xs">{here.length}</span></h3>
            {here.map((r, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-box border border-line bg-surface p-3">
                <Name r={r} className="truncate font-medium" />
                <span className="truncate text-xs text-fg3">{where(r) || "any branch"}</span>
                <Strip runs={r.runs} />
                <span className="text-xs text-fg2">{[r.sha, r.at && fmt.ago(r.at)].filter(Boolean).join(" · ") || "—"}</span>
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}

function List({ rows }: { rows: Row[] }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((r, i) => (
        <li key={i} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0"><Name r={r} className="block truncate font-medium" /><span className="block truncate text-xs text-fg3">{where(r) || "any branch"}</span></span>
          <span className="flex items-center gap-3"><Strip runs={r.runs.slice(0, 6)} /><Status cell level={r.state} label={word(r)} /></span>
        </li>
      ))}
    </ul>
  )
}

/** One set of pipelines, shown the way `view` says. */
export function PipelineView({ rows, view = "list" }: { rows: any[] | null | undefined; view?: string }) {
  if (!rows?.length) return <Empty>No pipelines followed yet.</Empty>
  const r = rows.map(norm)
  return view === "cards" ? <Cards rows={r} /> : view === "timeline" ? <Timeline rows={r} /> : view === "board" ? <Board rows={r} /> : <List rows={r} />
}

export const PipelineList = ({ rows }: { rows: any[] }) => <PipelineView rows={rows} view="list" />

import { CheckCircleIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline"
import { Empty, Progress } from "../ui/components"
import { t } from "../ui/i18n"
import { isOverdue, useApi } from "../ui/lib"
import { splitTags as parseTags } from "../ui/tags"

export interface Item { text: string; done: boolean }
const LINE = /^\s*- \[( |x|X)\] ?(.*)$/

/**
 * A task's checklist lives in its description as Markdown `- [ ]` lines, so that it
 * syncs with Nextcloud as written. The rest of the description is kept as notes.
 */
export function splitChecklist(description = "") {
  const items: Item[] = [], notes: string[] = []
  for (const l of description.split("\n")) {
    const m = l.match(LINE)
    if (m) items.push({ text: m[2], done: m[1] !== " " }); else notes.push(l)
  }
  return { notes: notes.join("\n").trim(), items }
}

export const joinChecklist = (notes: string, items: Item[]) =>
  [notes.trim(), items.filter((i) => i.text.trim()).map((i) => `- [${i.done ? "x" : " "}] ${i.text.trim()}`).join("\n")].filter(Boolean).join("\n\n")

const closed = (task: any) => ["done", "cancelled"].includes(task.status) || (!task.status && task.done)

/** From 0 to 1: closed tasks count whole, open ones by their ticked checklist items. */
export function taskProgress(task: any) {
  if (closed(task)) return 1
  const { items } = splitChecklist(task.description)
  // Without a checklist, a task in progress counts half: neither nothing nor done.
  return items.length ? items.filter((i) => i.done).length / items.length : task.status === "doing" ? 0.5 : 0
}

/** Overall and per-tag progress of the tasks; cancelled ones and calendar events do not count. */
export function summarize(tasks: any[]) {
  const counted = tasks.filter((x) => x.kind !== "event" && x.status !== "cancelled")
  const share = (rows: any[]) => (rows.length ? Math.round((rows.reduce((n, x) => n + taskProgress(x), 0) / rows.length) * 100) : 0)
  const tags = [...new Set(counted.flatMap((x) => parseTags(x.tags)))].sort()
  return {
    pct: share(counted),
    total: counted.length,
    done: counted.filter(closed).length,
    doing: counted.filter((x) => x.status === "doing").length,
    late: counted.filter((x) => !closed(x) && isOverdue(x.due)).length,
    tags: tags.map((tag) => { const rows = counted.filter((x) => parseTags(x.tags).includes(tag)); return { tag, pct: share(rows), done: rows.filter(closed).length, total: rows.length } }),
  }
}

function Row({ label, pct, sub }: { label: string; pct: number; sub: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-3 text-[13px]">
      <span className="truncate text-fg2" title={label}>{label}</span>
      <Progress thin pct={pct} label={label} />
      <span className="w-24 text-right whitespace-nowrap">{pct} % <span className="text-fg3">· {sub}</span></span>
    </div>
  )
}

/** Where everything stands: tasks overall and per tag, and deployments. */
export function ProgressSummary() {
  const tasks = useApi<any[]>("/api/tasks")
  const deploys = useApi("/api/c/deployments?perPage=500&fields=status")
  const s = summarize(tasks.data ?? [])
  const d: any[] = deploys.data?.items ?? []
  const ok = d.filter((x) => x.status === "ok").length, failed = d.filter((x) => x.status === "failed").length, running = d.filter((x) => x.status === "running").length
  if (!tasks.data) return <Empty>{t("Loading…")}</Empty>
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[26px] leading-8 font-medium">{s.pct} %</span>
          <span className="flex flex-wrap gap-3 text-[13px] text-fg2">
            <span className="inline-flex items-center gap-1"><CheckCircleIcon className="size-4 text-ok" aria-hidden />{t("{done} of {total} tasks done", { done: s.done, total: s.total })}</span>
            {s.doing > 0 && <span>{t("{n} in progress", { n: s.doing })}</span>}
            {s.late > 0 && <span className="inline-flex items-center gap-1 text-crit"><ExclamationTriangleIcon className="size-4" aria-hidden />{t("{n} late", { n: s.late })}</span>}
          </span>
        </div>
        <Progress pct={s.pct} label={t("Tasks")} />
      </div>
      {s.tags.length > 0 && <div className="flex flex-col gap-2">{s.tags.map((x) => <Row key={x.tag} label={x.tag} pct={x.pct} sub={`${x.done}/${x.total}`} />)}</div>}
      {d.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <Row label={t("Deployments")} pct={Math.round((ok / d.length) * 100)} sub={`${ok}/${d.length}`} />
          {(failed > 0 || running > 0) && <p className="text-[13px] text-fg2">{[running && t("{n} running", { n: running }), failed && t("{n} failed", { n: failed })].filter(Boolean).join(" · ")}</p>}
        </div>
      )}
    </div>
  )
}

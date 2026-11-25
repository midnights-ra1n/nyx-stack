import { ArrowPathIcon, ChevronRightIcon, MagnifyingGlassIcon, SparklesIcon } from "@heroicons/react/24/outline"
import { Fragment, useState } from "react"
import { Button, Check, Empty, ErrorNote, Mono, Panel, Stat, StateCell, Status, Table, Td, Variable, ask } from "../ui/components"
import { t } from "../ui/i18n"
import { api, useApi } from "../ui/lib"
import { Link, PageHeader } from "../ui/shell"
import { allTags, hasTag, TagList } from "../ui/tags"
import { FleetUpdates, HostIcon, hostType, noAgent, useUpdatePolling } from "./hosts"
import { hostLevel } from "./overview"

/** Hosts an update can reach: online, with an agent of their own. */
export const reachable = (h: any) => h.status !== "off" && !!h.agent_version

/** What needs doing first: security fixes, then a restart, then plain updates, then an old agent. */
export function updateRank(h: any) {
  return h.security ? 0 : h.reboot_required ? 1 : h.updates ? 2 : h.agent_outdated ? 3 : 4
}

function Packages({ id }: { id: string }) {
  const { data, error } = useApi(`/api/hosts/${id}`, { poll: false })
  if (error) return <ErrorNote>{error}</ErrorNote>
  if (!data) return <p className="text-fg3">{t("Loading…")}</p>
  const list: any[] = [...(data.update_list ?? [])].sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name))
  if (!list.length) return <p className="text-fg3">{t("No pending updates known.")}</p>
  return (
    <ul className="grid max-h-72 grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-x-6 overflow-auto">
      {list.map((u) => <li key={u.name} className="flex justify-between gap-3 py-1"><Mono className="truncate">{u.name}</Mono><span className={`shrink-0 ${u.security ? "text-warn" : "text-fg3"}`}>{u.security ? t("Security") : u.version}</span></li>)}
    </ul>
  )
}

/** Every pending update of the fleet in one place: what is waiting, where, and buttons to act on a choice of hosts. */
export function Updates() {
  const hosts = useApi<any[]>("/api/hosts")
  const [tag, setTag] = useState("")
  const [only, setOnly] = useState(true)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [note, setNote] = useState("")
  const all = hosts.data ?? []
  const updating = all.some((h) => h.update && !h.update.done)
  useUpdatePolling(updating, hosts.reload)
  const pending = (h: any) => h.updates > 0 || h.reboot_required || h.agent_outdated
  const rows = all.filter((h) => !noAgent(h)).filter((h) => hasTag(h, tag) && (!only || pending(h)))
    .sort((a, b) => updateRank(a) - updateRank(b) || b.updates - a.updates || a.name.localeCompare(b.name))
  const chosen = rows.filter((h) => picked.has(h.id) && reachable(h))
  const targets = chosen.length ? chosen : rows.filter(reachable)
  const sum = (f: (h: any) => number) => all.reduce((n, h) => n + f(h), 0)
  const toggle = (set: Set<string>, id: string) => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); return n }

  const check = async () => {
    const res = await Promise.allSettled(targets.map((h) => api(`/api/hosts/${h.id}/command`, { body: { action: "check_updates" } })))
    const failed = res.filter((r) => r.status === "rejected").length
    setNote(failed ? t("{n} checks could not be sent.", { n: failed }) : t("Check requested on {n} hosts. Lists refresh with their next report.", { n: targets.length }))
  }
  const update = async () => {
    if (!await ask(t("Upgrade the packages of {n} hosts and bring their agents up to date? Services can restart while packages are replaced. Hosts are not rebooted.", { n: targets.length }), { action: "Update" })) return
    try { await api("/api/hosts/update-all", { method: "POST", body: { ids: targets.map((h) => h.id) } }); setPicked(new Set()); setNote(""); hosts.reload() } catch (e) { setNote((e as Error).message) }
  }
  const scope = chosen.length ? t("{n} selected", { n: chosen.length }) : tag ? t("tagged {tag}", { tag }) : t("all")

  return (
    <>
      <PageHeader title={t("Updates")} subtitle="Packages waiting on each host, security fixes first. Tick hosts to act on them only." onRefresh={hosts.reload}
        variables={<>
          <Variable label="Tag" value={tag} onChange={setTag} options={[{ value: "", label: "All" }, ...allTags(all).map((x) => ({ value: x, label: x }))]} />
        </>}
        actions={<>
          <Button disabled={!targets.length} onClick={check}><MagnifyingGlassIcon className="size-5" aria-hidden />{t("Check ({scope})", { scope })}</Button>
          <Button variant="primary" disabled={updating || !targets.length} onClick={update}><ArrowPathIcon className="size-5" aria-hidden />{t("Update ({scope})", { scope })}</Button>
        </>} />
      <ErrorNote>{hosts.error}</ErrorNote>
      {note && <p role="status" className="mb-4 rounded-panel bg-raised px-4 py-2.5 text-fg2">{note}</p>}
      <div className="mb-4">
        <Panel title={t("Summary")}>
          <div className="grid grid-cols-5 gap-4 max-md:grid-cols-2">
            <Stat label="Hosts to update" value={all.filter((h) => h.updates > 0).length} level={all.some((h) => h.updates > 0) ? "warn" : "ok"} />
            <Stat label="Pending packages" value={sum((h) => h.updates || 0)} />
            <Stat label="Security fixes" value={sum((h) => h.security || 0)} level={sum((h) => h.security || 0) ? "crit" : "ok"} />
            <Stat label="To restart" value={all.filter((h) => h.reboot_required).length} level={all.some((h) => h.reboot_required) ? "warn" : "ok"} />
            <Stat label="Old agents" value={all.filter((h) => h.agent_outdated).length} level={all.some((h) => h.agent_outdated) ? "warn" : "ok"} />
          </div>
        </Panel>
      </div>
      <FleetUpdates hosts={all} />
      <Panel title={t("Hosts")} flush badge={<Check label="Only hosts with something to do" checked={only} onChange={(e) => setOnly(e.target.checked)} />}>
        {rows.length === 0 ? <div className="flex items-center gap-3 px-4 pb-4 text-fg2"><SparklesIcon className="size-5 text-ok" aria-hidden />{all.length ? t("Everything is up to date.") : t("No hosts yet. Add one to get an install command.")}</div> : (
          <Table head={[<span key="all" className="flex"><input type="checkbox" aria-label={t("Select all")} checked={rows.filter(reachable).every((h) => picked.has(h.id))} onChange={(e) => setPicked(e.target.checked ? new Set(rows.filter(reachable).map((h) => h.id)) : new Set())} /></span>, "Host", "Tags", "Packages", "Security", "Restart", "Agent", "State"]}>
            {rows.map((h) => (
              <Fragment key={h.id}>
                <tr className="hover:bg-raised">
                  <Td><input type="checkbox" aria-label={t("Select {name}", { name: h.name })} disabled={!reachable(h)} checked={picked.has(h.id)} onChange={() => setPicked(toggle(picked, h.id))} /></Td>
                  <Td className="font-medium">
                    <span className="flex items-center gap-2">
                      <button type="button" aria-label={t("Show the packages of {name}", { name: h.name })} aria-expanded={open.has(h.id)} disabled={!h.updates} className="text-fg3 disabled:opacity-30" onClick={() => setOpen(toggle(open, h.id))}><ChevronRightIcon className={`size-4 ${open.has(h.id) ? "rotate-90" : ""}`} aria-hidden /></button>
                      <HostIcon type={hostType(h, all)} />
                      <span className="flex min-w-0 flex-col"><Link to={`/hosts/${h.id}`} className="truncate hover:text-accent">{h.name}</Link>{h.os && <span className="truncate text-xs font-normal text-fg3">{h.os}</span>}</span>
                    </span>
                  </Td>
                  <Td><TagList tags={h.tags} onPick={setTag} /></Td>
                  <Td className={h.updates ? "font-medium" : "text-fg3"}>{h.updates || "—"}</Td>
                  <Td>{h.security ? <Status cell level="crit" label={String(h.security)} /> : <span className="text-fg3">—</span>}</Td>
                  <Td>{h.reboot_required ? <Status cell level="warn" label="Needed" /> : <span className="text-fg3">—</span>}</Td>
                  <Td className="whitespace-nowrap"><Mono className="text-fg2">{h.agent_version || "—"}</Mono>{h.agent_outdated && <span className="ml-2"><Status cell level="warn" label="Old" /></span>}</Td>
                  {h.update && !h.update.done ? <Td><span className="text-accent">{h.update.pct} %</span></Td> : <StateCell level={hostLevel(h.status)} />}
                </tr>
                {open.has(h.id) && <tr><td colSpan={8} className="bg-bg/50 px-6 py-3"><Packages id={h.id} /></td></tr>}
              </Fragment>
            ))}
          </Table>
        )}
      </Panel>
    </>
  )
}

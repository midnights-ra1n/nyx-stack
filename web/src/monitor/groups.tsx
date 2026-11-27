import { PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Button, Check, Empty, ErrorNote, IconButton, Input, Modal, type VarOption, ask } from "../ui/components"
import { t } from "../ui/i18n"
import { api } from "../ui/lib"
import { allTags, hasTag, splitTags, Tag } from "../ui/tags"
import { HOST_TYPES, HostIcon, hostType } from "./hosts"

/**
 * Which hosts a page shows, in one string that fits a select: "" for all of them,
 * `type:vm` for a type of host, `tag:prod` for a group, `host:<id>` for one host.
 */
export function inScope(h: any, scope: string, all: any[]) {
  const at = scope.indexOf(":")
  const [kind, value] = at < 0 ? ["", ""] : [scope.slice(0, at), scope.slice(at + 1)]
  return kind === "type" ? hostType(h, all) === value : kind === "tag" ? hasTag(h, value) : kind === "host" ? h.id === value : true
}

/** Every host, then each type of host present, each group and, unless `single` is false, each host. */
export function scopeOptions(hosts: any[], single = true): VarOption[] {
  const types = [...new Set(hosts.map((h) => hostType(h, hosts)))]
  return [
    { value: "", label: "All hosts" },
    ...types.map((x) => ({ value: `type:${x}`, label: HOST_TYPES[x]?.label ?? x, group: "Types" })),
    ...allTags(hosts).map((x) => ({ value: `tag:${x}`, label: x, raw: true, group: "Groups" })),
    ...(single ? hosts.map((h) => ({ value: `host:${h.id}`, label: h.name, raw: true, group: "Hosts" })) : []),
  ]
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/** Averages of the online hosts among `hosts`. Temperature only counts the hosts with a sensor: VMs have none. */
export function averages(hosts: any[]) {
  const live = hosts.filter((h) => h.status !== "off" && typeof h.cpu === "number")
  const hot = live.filter((h) => h.temp > 0)
  return { n: live.length, sensors: hot.length, cpu: mean(live.map((h) => h.cpu)), mem: mean(live.map((h) => h.mem ?? 0)), temp: mean(hot.map((h) => h.temp)) }
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

/** The tags of each host once group `from` is renamed `name` and holds exactly `ids`; only the hosts that change. */
export function regroup(hosts: any[], from: string, name: string, ids: string[]): { id: string; tags: string[] }[] {
  return hosts.flatMap((h) => {
    const now = splitTags(h.tags)
    const kept = now.filter((x) => x !== from && x !== name)
    const next = name && ids.includes(h.id) ? [...kept, name] : kept
    return sameSet(now, next) ? [] : [{ id: h.id, tags: next }]
  })
}

/** A group is a tag on its hosts, so it also filters the host list, the charts and the updates. */
export function GroupsModal({ hosts, onClose, onSaved }: { hosts: any[]; onClose: () => void; onSaved: () => void }) {
  const [edit, setEdit] = useState<{ from: string; name: string; ids: string[] } | null>(null)
  const [error, setError] = useState("")
  const groups = allTags(hosts)
  const types = [...new Set(hosts.map((h) => hostType(h, hosts)))]
  const write = async (from: string, name: string, ids: string[]) => {
    try {
      await Promise.all(regroup(hosts, from, name.trim(), ids).map((c) => api(`/api/hosts/${c.id}`, { method: "PATCH", body: { tags: c.tags } })))
      setError("")
      setEdit(null)
    } catch (e) { setError((e as Error).message) }
    onSaved()
  }
  const remove = async (g: string) => { if (await ask(t("Delete the group {name}? Its hosts stay, only the group goes.", { name: g }), { action: "Delete", danger: true })) write(g, "", []) }

  if (edit) {
    const toggle = (ids: string[], on: boolean) => setEdit({ ...edit, ids: on ? [...new Set([...edit.ids, ...ids])] : edit.ids.filter((x) => !ids.includes(x)) })
    return (
      <Modal title={edit.from ? t("Edit {name}", { name: edit.from }) : t("New group")} onClose={onClose}>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (edit.name.trim()) write(edit.from, edit.name, edit.ids) }}>
          <Input label="Name" value={edit.name} required maxLength={32} onChange={(e) => setEdit({ ...edit, name: e.target.value.replace(/,/g, " ") })} placeholder={t("Physical servers")} />
          <div className="flex flex-wrap gap-2">
            {types.map((x) => {
              const ids = hosts.filter((h) => hostType(h, hosts) === x).map((h) => h.id)
              const on = ids.every((id) => edit.ids.includes(id))
              return <Button key={x} type="button" aria-pressed={on} variant={on ? "primary" : undefined} onClick={() => toggle(ids, !on)}><HostIcon type={x} />{t(HOST_TYPES[x]?.label ?? x)}</Button>
            })}
          </div>
          <fieldset className="flex max-h-72 flex-col overflow-auto rounded-control border border-line p-2">
            <legend className="px-1 text-[13px] text-fg2">{t("{n} of {total}", { n: edit.ids.length, total: hosts.length })}</legend>
            {hosts.map((h) => <Check key={h.id} label={h.name} checked={edit.ids.includes(h.id)} onChange={(e) => toggle([h.id], e.target.checked)} />)}
          </fieldset>
          <ErrorNote>{error}</ErrorNote>
          <div className="flex gap-3 border-t border-line pt-4">
            <Button variant="primary" type="submit" disabled={!edit.name.trim()}>{t("Save")}</Button>
            <Button type="button" onClick={() => setEdit(null)}>{t("Back")}</Button>
          </div>
        </form>
      </Modal>
    )
  }

  return (
    <Modal title={t("Host groups")} onClose={onClose}>
      <p className="mb-4 text-[13px] text-fg2">{t("A group is a tag on its hosts: it also filters the host list, the charts and the updates. Types of host make groups by themselves.")}</p>
      {groups.length ? (
        <ul className="divide-y divide-line border-y border-line">
          {groups.map((g) => {
            const ids = hosts.filter((h) => hasTag(h, g)).map((h) => h.id)
            return (
              <li key={g} className="flex items-center gap-3 py-2">
                <Tag tag={g} /><span className="flex-1 text-[13px] text-fg3">{t("{n} hosts", { n: ids.length })}</span>
                <IconButton label="Edit" icon={PencilSquareIcon} onClick={() => setEdit({ from: g, name: g, ids })} />
                <IconButton label="Delete" icon={TrashIcon} className="text-crit hover:text-crit" onClick={() => remove(g)} />
              </li>
            )
          })}
        </ul>
      ) : <Empty>{t("No group yet.")}</Empty>}
      <ErrorNote>{error}</ErrorNote>
      <div className="mt-4 flex gap-3">
        <Button variant="primary" onClick={() => setEdit({ from: "", name: "", ids: [] })}><PlusIcon className="size-5" aria-hidden />{t("New group")}</Button>
        <Button onClick={onClose}>{t("Close")}</Button>
      </div>
    </Modal>
  )
}

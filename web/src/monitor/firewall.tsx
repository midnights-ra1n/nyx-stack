import { TrashIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Button, Empty, ErrorNote, IconButton, Input, Mono, Select, StateCell, Status, Table, Td } from "../ui/components"
import { api, type Level } from "../ui/lib"

const DOCKER = "DOCKER-USER"
const ACTIONS: Record<string, { label: string; level: Level }> = {
  allow: { label: "Allow", level: "ok" },
  limit: { label: "Limit", level: "warn" },
  deny: { label: "Drop", level: "crit" },
  reject: { label: "Reject", level: "crit" },
}
/** firewalld lists services by name: the common ones, to match them with open ports. */
const SERVICES: Record<string, string> = { ssh: "22", http: "80", https: "443", dns: "53", smtp: "25", imap: "143", imaps: "993", "dhcpv6-client": "546", cockpit: "9090", wireguard: "51820", samba: "445", nfs: "2049", mysql: "3306", postgresql: "5432", ntp: "123" }

function portMatches(spec: string, port: number): boolean {
  if (!spec) return true
  return spec.split(",").some((p) => {
    const s = SERVICES[p] ?? p
    const [a, b] = s.split(/[:-]/).map(Number)
    return b ? port >= a && port <= b : port === a
  })
}

export type Reach = "open" | "restricted" | "blocked"

/** Whether anyone on the network can reach a port: the first rule for any source wins,
 * else the default. A rule for some sources only says those get in, or do not.
 * A port published by Docker skips the host rules: only DOCKER-USER applies, and
 * Docker lets in what it does not stop.
 * Rules on connection state or an interface are left out, as they say nothing of a port. */
export function reach(fw: any, l: { proto: string; port: number; docker?: boolean }): Reach {
  if (!l.docker && !fw.active) return "open"
  let some = false
  for (const r of fw.rules) {
    if ((r.chain === DOCKER) !== !!l.docker) continue
    if (r.iface || r.comment?.startsWith("state ") || !ACTIONS[r.action]) continue
    if ((r.proto && r.proto !== l.proto) || !portMatches(r.port, l.port)) continue
    const allows = r.action === "allow" || r.action === "limit"
    if (r.source) { some ||= allows; continue }
    return allows ? "open" : some ? "restricted" : "blocked"
  }
  return l.docker || fw.default_in === "accept" ? "open" : some ? "restricted" : "blocked"
}

const REACH: Record<Reach, { label: string; level: Level }> = {
  open: { label: "Open to all", level: "ok" },
  restricted: { label: "Some sources", level: "info" },
  blocked: { label: "Blocked", level: "off" },
}

const empty = { action: "allow", proto: "tcp", port: "", source: "", comment: "", chain: "" }

/** Whether the rules come back after a restart, and what to do when they do not. */
function Saving({ fw, send }: { fw: any; send: (op: string, rule: any, what: string) => void }) {
  if (fw.backend === "ufw" || fw.backend === "firewalld") {
    return <p className="text-fg2">Saved by {fw.backend}.{fw.docker && " Docker rules are put back by Nyx after a restart, as Docker starts with an empty DOCKER-USER chain."}</p>
  }
  if (fw.backend !== "iptables") return null
  if (fw.saved_by) {
    return fw.unsaved
      ? <div className="flex flex-wrap items-center gap-3"><Status level="warn" label="Not saved" /><span className="text-fg2">The live rules differ from the file {fw.saved_by} loads at boot.</span><Button onClick={() => send("save", {}, "Saving sent.")}>Save rules</Button></div>
      : <p className="text-fg2">Saved by {fw.saved_by}: the rules come back after a restart.</p>
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Status level="warn" label="Not saved" />
      <span className="text-fg2">Rules made outside Nyx are lost at the next restart. Nyx puts its own back.</span>
      {fw.installable && <Button onClick={() => { if (confirm(`Install ${fw.installable} on this host, then save the current rules for the next boot?`)) send("persist", {}, `Installing ${fw.installable}.`) }}>Install {fw.installable}</Button>}
    </div>
  )
}

export function FirewallPanel({ id, fw, name, onSent }: { id: string; fw: any; name: string; onSent: () => void }) {
  const [form, setForm] = useState(empty)
  const [note, setNote] = useState("")
  const [error, setError] = useState("")
  const editable = fw.backend && fw.backend !== "nftables"
  const send = async (op: string, rule: any, what: string) => {
    setError("")
    try {
      await api(`/api/hosts/${id}/command`, { body: { action: "firewall", op, rule } })
      setNote(`${what} Queued: the agent applies it with its next report${op === "add" || op === "delete" ? ", and undoes it if it then cannot reach Nyx" : ""}.`)
      onSent()
    } catch (e) { setError((e as Error).message) }
  }
  // A port Docker publishes skips the host rules: its rule goes in DOCKER-USER.
  const published = form.port ? fw.listening?.find((l: any) => l.docker && portMatches(form.port, l.port) && (!form.proto || form.proto === l.proto)) : undefined
  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const rule = { ...form, chain: published ? DOCKER : "" }
    if (!published && form.action !== "allow" && (!form.port || portMatches(form.port, 22)) && !confirm(`This can block SSH to ${name}. Nyx can still undo it, as the agent does not need SSH. Continue?`)) return
    send("add", rule, published ? `Rule for ${published.process} sent.` : "Rule sent.").then(() => setForm(empty))
  }
  const remove = (r: any) => {
    const ssh = r.chain !== DOCKER && r.action === "allow" && r.port && portMatches(r.port, 22)
    if (!confirm(ssh ? `This rule lets SSH in. Removing it can lock you out of ${name} over SSH. Remove it?` : `Remove this rule from ${name}?`)) return
    send("delete", r, "Removal sent.")
  }
  const field = (k: "port" | "source", label: string, p: any = {}) => <Input label={label} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} {...p} />
  const canAdd = editable && (fw.active || fw.docker)

  if (!fw.backend && !fw.docker) return <div className="px-4 pb-4"><Empty>No firewall found on this host. Install ufw, firewalld or iptables to manage its rules here.</Empty></div>
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 px-4">
        <div className="flex flex-wrap items-center gap-3">
          {fw.backend && <Status level={fw.active ? "ok" : "warn"} label={`${fw.backend} ${fw.active ? "on" : "off"}`} />}
          {fw.docker && <Status level="info" label="Docker" />}
          {fw.default_in && <span className="text-fg2">Other incoming traffic: <b>{fw.default_in === "accept" ? "let in" : fw.default_in === "reject" ? "rejected" : "dropped"}</b></span>}
        </div>
        <Saving fw={fw} send={send} />
      </div>
      {fw.rules.length ? (
        <Table head={["Action", "Port", "Source", "Note", ""]}>
          {fw.rules.map((r: any, i: number) => (
            <tr key={`${i}${r.family}${r.raw}`}>
              <StateCell level={ACTIONS[r.action]?.level ?? "off"} label={ACTIONS[r.action]?.label ?? `→ ${r.action}`} />
              <Td>
                <Mono>{r.port || "any"}{r.proto && `/${r.proto}`}</Mono>
                {r.iface && <span className="ml-2 text-fg3">on {r.iface}</span>}
                {r.chain === DOCKER ? <span className="ml-2 text-fg3">Docker</span> : r.chain && r.chain !== "INPUT" && <span className="ml-2 text-fg3" title="iptables chain">{r.chain}</span>}
              </Td>
              <Td><Mono className="text-fg2">{r.source || "anywhere"}</Mono>{r.family && <span className="ml-2 text-fg3">IPv{r.family} only</span>}</Td>
              <Td className="max-w-48 truncate text-fg2" title={r.raw}>{r.comment}</Td>
              <Td className="w-12 text-right">{(editable || r.chain === DOCKER) && ACTIONS[r.action] && <IconButton label="Remove rule" icon={TrashIcon} onClick={() => remove(r)} />}</Td>
            </tr>
          ))}
        </Table>
      ) : <div className="px-4"><Empty>{fw.active ? "No incoming rules." : "Off: nothing is filtered."}</Empty></div>}
      {canAdd && (
        <form onSubmit={add} className="flex flex-col gap-2 px-4">
          <div className="grid grid-cols-5 items-end gap-3 max-md:grid-cols-2">
            <Select label="Action" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} options={[{ value: "allow", label: "Allow" }, { value: "deny", label: "Drop" }, { value: "reject", label: "Reject" }]} />
            <Select label="Protocol" value={form.proto} onChange={(e) => setForm({ ...form, proto: e.target.value })} options={[{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }, { value: "", label: "Both" }]} />
            {field("port", "Port", { placeholder: "443 or 8000:8100", inputMode: "numeric", className: "font-mono" })}
            {field("source", "Source", { placeholder: "anywhere, or 192.168.1.0/24", className: "font-mono" })}
            <Button type="submit" variant="primary" disabled={(!form.port && !form.source) || (!fw.active && !published)}>Add rule</Button>
          </div>
          {published && <p className="text-[13px] text-fg2">Port published by Docker for <b>{published.process}</b>: Docker skips the host rules, so this one goes in DOCKER-USER. To let only some sources in, allow them, then drop the port for everyone.</p>}
        </form>
      )}
      {fw.backend === "nftables" && <p className="px-4 text-fg2">Nyx shows nftables rules but does not change them: edit <Mono>/etc/nftables.conf</Mono>, or switch to ufw or firewalld.</p>}
      {editable && !fw.active && fw.backend !== "iptables" && <p className="px-4 text-fg2">{fw.backend} is installed but off. Turn it on from the host to add rules: <Mono>{fw.backend === "ufw" ? "ufw enable" : "systemctl enable --now firewalld"}</Mono></p>}
      <div className="px-4" role="status">{note && <p className="text-[13px] text-fg2">{note}</p>}<ErrorNote>{error}</ErrorNote></div>
      {fw.listening?.length > 0 && <>
        <h3 className="px-4 font-medium">Ports open to the network</h3>
        <Table head={["Port", "Listens on", "Program", "Reachable", ""]}>
          {fw.listening.map((l: any) => {
            const state = reach(fw, l)
            const canOpen = state === "blocked" && (l.docker ? fw.docker : editable && fw.active)
            return (
              <tr key={`${l.proto}${l.port}`}>
                <Td><Mono>{l.port}/{l.proto}</Mono></Td>
                <Td><Mono className="text-fg2">{l.addr === "*" ? "all addresses" : l.addr}</Mono></Td>
                <Td className="text-fg2">{l.process || "—"}{l.docker && <span className="ml-2 text-fg3">Docker</span>}</Td>
                <StateCell level={REACH[state].level} label={REACH[state].label} />
                <Td className="text-right">{canOpen && <Button variant="ghost" onClick={() => send("add", { ...empty, proto: l.proto, port: String(l.port), chain: l.docker ? DOCKER : "", comment: l.process.replace(/[^\w .-]/g, "").slice(0, 64) }, `Opening ${l.port}/${l.proto} sent.`)}>Allow</Button>}</Td>
              </tr>
            )
          })}
        </Table>
      </>}
      {fw.raw && <details className="px-4 pb-4"><summary className="cursor-pointer text-fg2">Full ruleset</summary><pre className="mt-2 max-h-80 overflow-auto rounded-box bg-bg p-3 font-mono text-[13px]">{fw.raw}</pre></details>}
    </div>
  )
}

import { ArrowPathIcon, PencilSquareIcon, PlayIcon, PlusIcon, RocketLaunchIcon, StopIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useEffect, useState } from "react"
import { Board, CustomizeButton } from "../ui/board"
import { Button, Copy, Empty, ErrorNote, IconButton, Input, Meter, Modal, Mono, Panel, Select, Stat, Status, Table, Td, Tabs, TextArea } from "../ui/components"
import { api, fmt, type Level, useApi } from "../ui/lib"
import { PageHeader } from "../ui/shell"
import { deployLevel } from "./overview"

/** Sends an operation to the host of a site and waits for the agent to answer. */
async function runOnSite(siteId: string, op: string) {
  const { id } = await api(`/api/sites/${siteId}/control`, { body: { op } })
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const r = await api(`/api/sites/result/${id}`)
    if (r) return r as { ok: boolean; output: string }
  }
  throw new Error("The agent did not answer in time.")
}

const fullCommit = (notes: string) => notes.trim().split("\n").pop()?.trim() ?? ""

function Details({ site, onClose, onChange }: { site: any; onClose: () => void; onChange: () => void }) {
  const { data } = useApi(`/api/sites/${site.id}/details`, { poll: false })
  const history = useApi(`/api/c/deployments?filter=${encodeURIComponent(`name='${site.name}'`)}&sort=-created&perPage=20`, { poll: false })
  const [tab, setTab] = useState("setup")
  const [out, setOut] = useState<{ ok: boolean; text: string } | undefined>()
  const [busy, setBusy] = useState("")
  const run = async (op: string) => {
    setBusy(op); setOut(undefined)
    try { const r = await runOnSite(site.id, op); setOut({ ok: r.ok, text: r.output }); if (op === "logs") setTab("logs") } catch (e) { setOut({ ok: false, text: (e as Error).message }) }
    setBusy("")
  }
  useEffect(() => { if (tab === "logs" && !out) run("logs") }, [tab])
  const rollback = async (d: any) => {
    if (!confirm(`Deploy ${d.version} again?`)) return
    try { await api(`/api/sites/${site.id}/rollback/${d.id}`, { method: "POST" }); onChange(); onClose() } catch (e) { setOut({ ok: false, text: (e as Error).message }); setTab("setup") }
  }
  return (
    <Modal title={site.name} onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => run("restart")} disabled={!!busy}><ArrowPathIcon className="size-5" aria-hidden />Restart</Button>
          <Button onClick={() => run("stop")} disabled={!!busy}><StopIcon className="size-5" aria-hidden />Stop</Button>
          <Button onClick={() => run("start")} disabled={!!busy}><PlayIcon className="size-5" aria-hidden />Start</Button>
          <Button variant="ghost" onClick={() => run("logs")} disabled={!!busy}>Refresh logs</Button>
          {busy && <span className="text-fg2">Waiting for the agent…</span>}
        </div>
        {out && tab !== "logs" && <p role="status" className={out.ok ? "text-ok" : "text-crit"}>{out.text}</p>}
        <Tabs value={tab} onChange={setTab} tabs={[{ id: "setup", label: "Setup" }, { id: "logs", label: "Logs" }, { id: "history", label: "History" }]} />
        {tab === "setup" && <>
          <p className="text-fg2">Add the public key to the repository as a read-only deploy key. Add the webhook for push events with content type JSON, and the secret below. Each push to the branch deploys the site again.</p>
          {data && <>
            <div><div className="mb-1 text-[13px] text-fg2">Public deploy key</div><Copy text={data.ssh_public_key} /></div>
            <div><div className="mb-1 text-[13px] text-fg2">Webhook URL</div><Copy text={data.webhook_url} /></div>
            <div><div className="mb-1 text-[13px] text-fg2">Webhook secret</div><Copy text={data.webhook_secret} /></div>
          </>}
          <div>
            <div className="mb-1 text-[13px] text-fg2">Last deploy output</div>
            <pre className="max-h-72 overflow-auto rounded-box bg-bg p-3 font-mono text-[13px] whitespace-pre-wrap">{site.last_output || "No deploy yet."}</pre>
          </div>
        </>}
        {tab === "logs" && <pre className="max-h-96 min-h-32 overflow-auto rounded-box bg-bg p-3 font-mono text-[13px] whitespace-pre-wrap" aria-live="polite">{busy === "logs" ? "Waiting for the agent…" : out?.text || "No logs."}</pre>}
        {tab === "history" && (history.data?.items.length ? (
          <ul className="divide-y divide-line">
            {history.data.items.map((d: any) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0"><Mono>{d.version || "—"}</Mono><span className="ml-3 text-fg2">{fmt.date(d.done_at || d.created)}</span></span>
                <span className="flex items-center gap-3"><Status cell level={deployLevel(d.status)} label={d.status} />{d.status === "ok" && fullCommit(d.notes).length === 40 && <Button variant="ghost" onClick={() => rollback(d)}>Deploy again</Button>}</span>
              </li>
            ))}
          </ul>
        ) : <Empty>No deploy yet.</Empty>)}
      </div>
    </Modal>
  )
}

/** The form starts from what the agent saw, so that an adopted site keeps how it runs today. */
function presetOf(a: any) {
  return { name: a.name.replace(/^@[^/]+\//, "").replace(/[^\w-]/g, "-"), host: a.host.id, path: a.path, repo: a.repo, branch: a.branch, run_user: a.user, install_cmd: a.install_cmd, build_cmd: a.build_cmd, start_cmd: a.start_cmd, service: a.service }
}

const runsUnder = (a: any) => ({ systemd: `systemd: ${a.service}`, pm2: `PM2: ${a.service.replace("pm2:", "")}`, docker: "Docker" } as Record<string, string>)[a.manager] ?? "Started by hand"

const EDITABLE = ["host", "repo", "branch", "path", "run_user", "install_cmd", "build_cmd", "start_cmd", "service", "cache_max_age", "env", "health_url"]

/** HTTP cache forced on the site's pages, in seconds. Empty: the app's own headers. */
const CACHE_CHOICES = [["", "The app's own"], ["0", "Always revalidate (recommended)"], ["60", "1 minute"], ["300", "5 minutes"], ["3600", "1 hour"], ["86400", "1 day"]].map(([value, label]) => ({ value, label }))

function SiteForm({ hosts, preset, onDone }: { hosts: any[]; preset: any; onDone: (site?: any) => void }) {
  const editing = !!preset.id
  const [f, setF] = useState<any>({ name: "", host: "", repo: "", branch: "main", path: "", run_user: "", install_cmd: "", build_cmd: "", start_cmd: "", service: "", cache_max_age: "0", env: "", health_url: "", ssh_private_key: "", ...preset })
  const [error, setError] = useState("")
  const input = (k: string, label: string, p: any = {}) => <Input label={label} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...p} />
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      if (editing) {
        const body = Object.fromEntries(EDITABLE.map((k) => [k, f[k]]))
        await api(`/api/c/sites/${f.id}`, { method: "PATCH", body })
        onDone()
      } else { const r = await api("/api/sites", { body: f }); onDone({ ...f, id: r.id }) }
    } catch (err) { setError((err as Error).message) }
  }
  return (
    <Modal title={editing ? `Edit ${preset.name}` : "Add site"} onClose={() => onDone()} wide>
      <form className="grid grid-cols-2 gap-4 max-sm:grid-cols-1" onSubmit={save}>
        {input("name", "Name", { required: true, disabled: editing, hint: editing ? "Fixed: the service of the site is named after it." : "Letters, digits, - and _." })}
        {hosts.length
          ? <Select label="Host" required value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} options={[{ value: "", label: "Choose…" }, ...hosts.map((h) => ({ value: h.id, label: h.name }))]} />
          : input("host", "Host ID", { required: true, hint: "Link a monitor in Settings to pick from a list." })}
        <div className="col-span-full">{input("repo", "Git repository", { required: true, className: "font-mono", placeholder: "git@github.com:you/site.git" })}</div>
        {input("branch", "Branch")}
        {input("path", "Directory", { placeholder: "/srv/<name>", className: "font-mono" })}
        {input("run_user", "Run as", { placeholder: "www-data" })}
        {input("service", "Existing service", { className: "font-mono", placeholder: "my-app.service or pm2:my-app", hint: "Restarted after a deploy. Empty: Nyx creates and runs its own service." })}
        {input("install_cmd", "Install command", { placeholder: "npm ci", className: "font-mono" })}
        {input("build_cmd", "Build command", { placeholder: "npm run build --if-present", className: "font-mono" })}
        {input("start_cmd", "Start command", { placeholder: "npm start", className: "font-mono", hint: f.service ? "Not used: the existing service starts the site." : undefined })}
        <div className="col-span-full"><Select label="HTTP cache" value={f.cache_max_age ?? ""} onChange={(e) => setF({ ...f, cache_max_age: e.target.value })} options={CACHE_CHOICES}
          hint={f.service.startsWith("pm2:") ? "Not applied to PM2 services: set Cache-Control in the app." : "Replaces the Cache-Control header of pages, not of hashed files, from the next deploy. Always revalidate: browsers get the new version right after a deploy. A CDN or proxy with its own cache must be purged separately."} /></div>
        <div className="col-span-full">{input("health_url", "Health check address", { placeholder: "https://site.example.org/health", hint: "Asked every minute from the manager. Two misses in a row raise a notification, and an answer ends it." })}</div>
        <div className="col-span-full"><TextArea label="Environment variables" rows={4} className="font-mono" placeholder={"PORT=3000\nDATABASE_URL=..."} value={f.env} onChange={(e) => setF({ ...f, env: e.target.value })}
          hint={f.service.startsWith("pm2:") ? "Not applied to PM2 services: use PM2's own ecosystem file." : "One NAME=value per line, read by the site's service from the next deploy. Kept readable by root only on the host."} /></div>
        {!editing && <div className="col-span-full"><TextArea label="SSH private key" rows={3} className="font-mono" value={f.ssh_private_key} onChange={(e) => setF({ ...f, ssh_private_key: e.target.value })} hint="Leave empty to generate a new ed25519 deploy key." /></div>}
        {f.path && !editing && preset.path && <p role="note" className="col-span-full rounded-panel bg-warn-soft px-4 py-2.5 text-warn">A deploy resets tracked files in this directory to the branch. Commit local changes first. Ignored files, such as .env, stay.</p>}
        <div className="col-span-full flex flex-col gap-3"><ErrorNote>{error}</ErrorNote><div><Button variant="primary" type="submit">{editing ? "Save" : "Create site"}</Button></div></div>
      </form>
    </Modal>
  )
}

/** What an app takes on its host: CPU averaged since the agent's last look, and memory. */
function Usage({ app }: { app?: any }) {
  if (!app) return <span className="text-fg3">—</span>
  return (
    <div className="flex min-w-36 flex-col gap-1 text-[13px]">
      <span>{fmt.pct(app.cpu_pct)} CPU · {fmt.bytes(app.mem_bytes)}</span>
      <Meter pct={app.cpu_pct} />
    </div>
  )
}

const HEALTH: Record<string, [Level, string]> = { ok: ["ok", "Healthy"], failing: ["warn", "Not answering"], down: ["crit", "Down"] }
const WHERE = [{ value: "all", label: "Docker and host" }, { value: "host", label: "On the host only" }, { value: "docker", label: "Docker only" }]

export function Sites() {
  const { data, reload, error } = useApi("/api/c/sites?sort=name&perPage=200")
  const monitor = useApi<any[] | null>("/api/monitor/hosts", { poll: false })
  const [form, setForm] = useState<any>()
  const [open, setOpen] = useState<any>()
  const [note, setNote] = useState("")
  const [where, setWhere] = useState("all")
  const hosts = monitor.data ?? []
  const nameOf = (id: string) => hosts.find((h) => h.id === id)?.name ?? id
  const apps = hosts.flatMap((h) => (h.node?.apps ?? []).map((a: any) => ({ ...a, host: h, version: a.version || h.node.version })))
  const appOf = (s: any) => apps.find((a) => a.host.id === s.host && a.path === s.path)
  const running = (s: any) => !!appOf(s)
  const siteOf = (a: any) => data?.items.find((s: any) => s.host === a.host.id && s.path === a.path)
  const shown = (manager?: string) => where === "all" || (where === "docker") === (manager === "docker")
  const sites = (data?.items ?? []).filter((s: any) => shown(appOf(s)?.manager))
  const listed = apps.filter((a) => shown(a.manager))
  const managed = (data?.items ?? []).map(appOf).filter(Boolean)
  const down = (data?.items ?? []).filter((s: any) => s.health === "down").length
  const deploy = async (s: any) => {
    try { await api(`/api/sites/${s.id}/deploy`, { method: "POST" }); setNote(`Deploy of ${s.name} queued.`); reload() } catch (e) { setNote((e as Error).message) }
  }
  const remove = async (s: any) => { if (confirm(`Stop tracking ${s.name}? Nothing is removed from the host.`)) { await api(`/api/c/sites/${s.id}`, { method: "DELETE" }); reload() } }
  const panels = [
    { id: "summary", title: "Summary", render: (edit: any) => (
        <Panel title="Summary" edit={edit}>
          <div className="grid grid-cols-4 gap-4 max-sm:grid-cols-2">
            <Stat label="Sites" value={data?.items.length ?? 0} sub={`${apps.length} Node.js apps detected`} />
            <Stat label="Running" value={`${managed.length} / ${data?.items.length ?? 0}`} level={managed.length === (data?.items.length ?? 0) ? "ok" : "warn"} />
            <Stat label="CPU used" value={fmt.pct(managed.reduce((t: number, a: any) => t + a.cpu_pct, 0))} sub="by managed sites" />
            <Stat label="Memory used" value={fmt.bytes(managed.reduce((t: number, a: any) => t + a.mem_bytes, 0))} sub={down ? `${down} site${down > 1 ? "s" : ""} down` : "all sites answering"} level={down ? "crit" : undefined} />
          </div>
        </Panel>
    ) },
    { id: "sites", title: "Sites", render: (edit: any) => (
        <Panel title="Sites" flush edit={edit}>
          <ErrorNote>{error}</ErrorNote>
          {sites.length === 0 ? <div className="px-4 pb-4"><Empty>No sites yet.</Empty></div> : (
            <Table head={["Name", "Host", "Branch", "Process", "Resources", "Health", "Last deploy", "State", ""]}>
              {sites.map((s: any) => (
                <tr key={s.id}>
                  <Td className="font-medium"><button className="min-h-9 max-sm:min-h-11 text-left text-accent" onClick={() => setOpen(s)}>{s.name}</button></Td>
                  <Td className="text-fg2">{nameOf(s.host)}</Td>
                  <Td mono>{s.branch}</Td>
                  <Td>{monitor.data ? <Status cell level={running(s) ? "ok" : "off"} label={running(s) ? "Running" : "Not detected"} /> : "—"}</Td>
                  <Td><Usage app={appOf(s)} /></Td>
                  <Td>{HEALTH[s.health] ? <Status cell level={HEALTH[s.health][0]} label={HEALTH[s.health][1]} /> : <span className="text-fg3">{s.health_url ? "Pending" : "—"}</span>}</Td>
                  <Td className="text-fg2">{fmt.date(s.last_deploy)}</Td>
                  <Td><Status level={deployLevel(s.last_status)} label={s.last_status || "never"} /></Td>
                  <Td className="w-32 whitespace-nowrap text-right">
                    <IconButton label="Deploy" icon={RocketLaunchIcon} onClick={() => deploy(s)} />
                    <IconButton label="Edit" icon={PencilSquareIcon} onClick={() => setForm(s)} />
                    <IconButton label="Delete" icon={TrashIcon} onClick={() => remove(s)} />
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
    ) },
    { id: "apps", title: "Detected Node.js apps", render: (edit: any) => (
        <Panel title="Detected Node.js apps" flush edit={edit}>
          {listed.length === 0 ? <div className="px-4 pb-4"><Empty>{monitor.data ? "No Node.js apps detected on your hosts. Agents look every 5 minutes." : "Link a monitor in Settings to detect Node.js apps."}</Empty></div> : (
            <Table head={["App", "Host", "Node.js", "Resources", "Directory", "Git", "Runs under", ""]}>
              {listed.map((a) => (
                <tr key={`${a.host.id}${a.path}`}>
                  <Td className="font-medium">{a.name}</Td>
                  <Td className="text-fg2">{a.host.name}</Td>
                  <Td mono>{a.version || "—"}</Td>
                  <Td><Usage app={a} /></Td>
                  <Td><Mono>{a.path}</Mono></Td>
                  <Td className="max-w-64 truncate" title={a.repo}>{a.repo ? <Mono className="text-fg2">{a.branch ? `${a.branch} · ` : ""}{a.repo}</Mono> : <span className="text-fg3">No Git origin</span>}</Td>
                  <Td className="text-fg2">{runsUnder(a)}</Td>
                  <Td className="text-right">
                    {siteOf(a) ? <span className="text-fg3">Managed</span> : a.manager === "docker" ? <span className="text-fg3" title="Nyx deploys on the host, not inside containers.">Not supported</span> : <Button variant="ghost" onClick={() => setForm(presetOf(a))}>Manage</Button>}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
    ) },
  ]
  return (
    <>
      <PageHeader title="Node.js sites" subtitle={note} actions={<><Select label="Show" value={where} onChange={(e) => setWhere(e.target.value)} options={WHERE} /><CustomizeButton /><Button variant="primary" onClick={() => setForm({})}><PlusIcon className="size-5" aria-hidden />Add site</Button></>} />
      <Board id="sites" panels={panels} desktop={{ cols: [["summary", "sites", "apps"]], hidden: [] }} phone={{ cols: [["summary", "sites", "apps"]], hidden: [] }} />
      {form && <SiteForm hosts={hosts} preset={form} onDone={(site) => { setForm(undefined); reload(); if (site) setOpen(site) }} />}
      {open && <Details site={open} onClose={() => setOpen(undefined)} onChange={reload} />}
    </>
  )
}

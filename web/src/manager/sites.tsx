import { PlusIcon, RocketLaunchIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Button, Copy, Empty, ErrorNote, IconButton, Input, Modal, Mono, Panel, Select, Status, Table, Td, TextArea } from "../ui/components"
import { api, fmt, useApi } from "../ui/lib"
import { PageHeader, Section } from "../ui/shell"
import { deployLevel } from "./overview"

function Details({ site, onClose }: { site: any; onClose: () => void }) {
  const { data } = useApi(`/api/sites/${site.id}/details`, { poll: false })
  return (
    <Modal title={site.name} onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <p className="text-fg2">Add the public key to the repository as a read-only deploy key. Add the webhook for push events with content type JSON, and the secret below.</p>
        {data && <>
          <div><div className="mb-1 text-[13px] text-fg2">Public deploy key</div><Copy text={data.ssh_public_key} /></div>
          <div><div className="mb-1 text-[13px] text-fg2">Webhook URL</div><Copy text={data.webhook_url} /></div>
          <div><div className="mb-1 text-[13px] text-fg2">Webhook secret</div><Copy text={data.webhook_secret} /></div>
        </>}
        <div>
          <div className="mb-1 text-[13px] text-fg2">Last deploy output</div>
          <pre className="max-h-72 overflow-auto rounded-control bg-bg p-3 font-mono text-[13px] whitespace-pre-wrap">{site.last_output || "No deploy yet."}</pre>
        </div>
      </div>
    </Modal>
  )
}

function SiteForm({ hosts, preset, onDone }: { hosts: any[]; preset: any; onDone: (site?: any) => void }) {
  const [f, setF] = useState<any>({ name: "", host: "", repo: "", branch: "main", path: "", run_user: "", install_cmd: "", build_cmd: "", start_cmd: "", ssh_private_key: "", ...preset })
  const [error, setError] = useState("")
  const input = (k: string, label: string, p: any = {}) => <Input label={label} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...p} />
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try { const r = await api("/api/sites", { body: f }); onDone({ ...f, id: r.id }) } catch (err) { setError((err as Error).message) }
  }
  return (
    <Modal title="Add site" onClose={() => onDone()} wide>
      <form className="grid grid-cols-2 gap-4 max-sm:grid-cols-1" onSubmit={save}>
        {input("name", "Name", { required: true, hint: "Letters, digits, - and _." })}
        {hosts.length
          ? <Select label="Host" required value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} options={[{ value: "", label: "Choose…" }, ...hosts.map((h) => ({ value: h.id, label: h.name }))]} />
          : input("host", "Host ID", { required: true, hint: "Link a monitor in Settings to pick from a list." })}
        <div className="col-span-full">{input("repo", "Git repository", { required: true, className: "font-mono", placeholder: "git@github.com:you/site.git" })}</div>
        {input("branch", "Branch")}
        {input("path", "Directory", { placeholder: "/srv/<name>", className: "font-mono" })}
        {input("run_user", "Run as", { placeholder: "www-data" })}
        {input("install_cmd", "Install command", { placeholder: "npm ci", className: "font-mono" })}
        {input("build_cmd", "Build command", { placeholder: "npm run build --if-present", className: "font-mono" })}
        {input("start_cmd", "Start command", { placeholder: "npm start", className: "font-mono" })}
        <div className="col-span-full"><TextArea label="SSH private key" rows={3} className="font-mono" value={f.ssh_private_key} onChange={(e) => setF({ ...f, ssh_private_key: e.target.value })} hint="Leave empty to generate a new ed25519 deploy key." /></div>
        <div className="col-span-full flex flex-col gap-3"><ErrorNote>{error}</ErrorNote><div><Button variant="primary" type="submit">Create site</Button></div></div>
      </form>
    </Modal>
  )
}

export function Sites() {
  const { data, reload, error } = useApi("/api/c/sites?sort=name&perPage=200")
  const monitor = useApi<any[] | null>("/api/monitor/hosts", { poll: false })
  const [form, setForm] = useState<any>()
  const [open, setOpen] = useState<any>()
  const [note, setNote] = useState("")
  const hosts = monitor.data ?? []
  const nameOf = (id: string) => hosts.find((h) => h.id === id)?.name ?? id
  const apps = hosts.flatMap((h) => (h.node?.apps ?? []).map((a: any) => ({ ...a, host: h, version: h.node.version })))
  const deploy = async (s: any) => {
    try { await api(`/api/sites/${s.id}/deploy`, { method: "POST" }); setNote(`Deploy of ${s.name} queued.`); reload() } catch (e) { setNote((e as Error).message) }
  }
  const remove = async (s: any) => { if (confirm(`Stop tracking ${s.name}? Nothing is removed from the host.`)) { await api(`/api/c/sites/${s.id}`, { method: "DELETE" }); reload() } }
  return (
    <>
      <PageHeader title="Node.js sites" subtitle={note} actions={<Button variant="primary" onClick={() => setForm({})}><PlusIcon className="size-5" aria-hidden />Add site</Button>} />
      <Section>
        <Panel title="Sites" flush>
          <ErrorNote>{error}</ErrorNote>
          {data?.items.length === 0 ? <div className="px-5 pb-5"><Empty>No sites yet.</Empty></div> : (
            <Table head={["Name", "Host", "Branch", "Last deploy", "State", ""]}>
              {data?.items.map((s: any) => (
                <tr key={s.id}>
                  <Td className="font-medium"><button className="min-h-11 text-left text-accent" onClick={() => setOpen(s)}>{s.name}</button></Td>
                  <Td className="text-fg2">{nameOf(s.host)}</Td>
                  <Td mono>{s.branch}</Td>
                  <Td className="text-fg2">{fmt.date(s.last_deploy)}</Td>
                  <Td><Status level={deployLevel(s.last_status)} label={s.last_status || "never"} /></Td>
                  <Td className="w-24 whitespace-nowrap text-right">
                    <IconButton label="Deploy" icon={RocketLaunchIcon} onClick={() => deploy(s)} />
                    <IconButton label="Delete" icon={TrashIcon} onClick={() => remove(s)} />
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
        <Panel title="Detected Node.js apps" flush>
          {apps.length === 0 ? <div className="px-5 pb-5"><Empty>{monitor.data ? "No Node.js apps detected on your hosts." : "Link a monitor in Settings to detect Node.js apps."}</Empty></div> : (
            <Table head={["App", "Host", "Node.js", "Directory", ""]}>
              {apps.map((a) => (
                <tr key={`${a.host.id}${a.pid}`}>
                  <Td className="font-medium">{a.name}</Td>
                  <Td className="text-fg2">{a.host.name}</Td>
                  <Td mono>{a.version}</Td>
                  <Td><Mono>{a.path}</Mono></Td>
                  <Td className="text-right"><Button variant="ghost" onClick={() => setForm({ name: a.name.replace(/[^\w-]/g, "-"), host: a.host.id, path: a.path })}>Manage</Button></Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </Section>
      {form && <SiteForm hosts={hosts} preset={form} onDone={(site) => { setForm(undefined); reload(); if (site) setOpen(site) }} />}
      {open && <Details site={open} onClose={() => setOpen(undefined)} />}
    </>
  )
}

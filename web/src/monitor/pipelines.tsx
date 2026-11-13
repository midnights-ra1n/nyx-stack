import { PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Button, Check, Empty, ErrorNote, IconButton, Input, Modal, Panel, Select, Stat, StateCell, Table, Td, Tabs } from "../ui/components"
import { api, type Level, useApi } from "../ui/lib"
import { PIPELINE_VIEWS, pipelineWord, PipelineView } from "../ui/pipelines"
import { PageHeader } from "../ui/shell"

const PROVIDERS = [{ value: "github", label: "GitHub" }, { value: "gitlab", label: "GitLab" }, { value: "forgejo", label: "Forgejo" }, { value: "gitea", label: "Gitea" }]
const HINT: Record<string, string> = {
  github: "Owner and name, for example me/site. Needs GitHub Actions. A token is only needed for private repositories (read access to Actions).",
  gitlab: "Full path, for example group/site, or the numeric project ID. A token with read_api is only needed for private projects.",
  forgejo: "Owner and name, for example me/site. Needs Forgejo Actions and a token with read access to the repository.",
  gitea: "Owner and name, for example me/site. Needs Gitea Actions (1.22 or later) and a token with read access to the repository.",
}

function PipelineForm({ row, onDone }: { row: any | null; onDone: () => void }) {
  const [f, setF] = useState<any>(row ?? { name: "", provider: "github", url: "", repo: "", branch: "main", token: "", enabled: true })
  const [error, setError] = useState("")
  const set = (k: string, v: any) => setF({ ...f, [k]: v })
  const selfHosted = f.provider === "forgejo" || f.provider === "gitea"
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try { await api(row ? `/api/c/pipelines/${row.id}` : "/api/c/pipelines", { method: row ? "PATCH" : "POST", body: f }); onDone() } catch (err) { setError((err as Error).message) }
  }
  return (
    <Modal title={row ? "Edit pipeline" : "Add pipeline"} onClose={onDone}>
      <form className="flex flex-col gap-4" onSubmit={save}>
        <Input label="Name" required value={f.name} onChange={(e) => set("name", e.target.value)} />
        <Select label="Forge" value={f.provider} onChange={(e) => set("provider", e.target.value)} options={PROVIDERS} />
        <Input label="Server address" required={selfHosted} placeholder={selfHosted ? "https://git.example.org" : "Empty for the public service"} value={f.url} hint="Only for a self-hosted server." onChange={(e) => set("url", e.target.value)} />
        <Input label="Repository" required value={f.repo} hint={HINT[f.provider]} onChange={(e) => set("repo", e.target.value)} />
        <Input label="Branch" value={f.branch} hint="Empty follows the latest run of any branch." onChange={(e) => set("branch", e.target.value)} />
        <Input label="Access token" type="password" autoComplete="off" value={f.token} onChange={(e) => set("token", e.target.value)} />
        <Check label="Enabled" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        <ErrorNote>{error}</ErrorNote>
        <div><Button variant="primary" type="submit">Save</Button></div>
      </form>
    </Modal>
  )
}

const remembered = () => { try { return localStorage.getItem("nyx.pipelines.view") || "cards" } catch { return "cards" } }

export function Pipelines() {
  const live = useApi<any[]>("/api/pipelines")
  const defs = useApi("/api/c/pipelines?sort=name", { poll: false })
  const [edit, setEdit] = useState<any | null | undefined>()
  const [view, setView] = useState(remembered)
  const pick = (v: string) => { setView(v); try { localStorage.setItem("nyx.pipelines.view", v) } catch { /* private window */ } }
  const done = async () => { setEdit(undefined); await api("/api/pipelines/refresh", { method: "POST" }).catch(() => {}); defs.reload(); live.reload() }
  const rows = live.data ?? []
  const count = (s: string) => rows.filter((p) => p.state === s).length
  const manage = view === "manage"
  return (
    <>
      <PageHeader title="Pipelines" subtitle="CI/CD runs on GitHub, GitLab, Forgejo and Gitea. A failed run raises an alert." onRefresh={live.reload} actions={<Button variant="primary" onClick={() => setEdit(null)}><PlusIcon className="size-5" aria-hidden />Add pipeline</Button>} />
      <div className="mb-4 grid grid-cols-4 gap-4 max-sm:grid-cols-2">
        <Stat label="Passing" value={count("ok")} level="ok" />
        <Stat label="Failing" value={count("crit")} level={count("crit") ? "crit" : "ok"} />
        <Stat label="Running" value={count("info")} level={count("info") ? "info" : undefined} />
        <Stat label="Followed" value={rows.length} sub={rows.some((p) => p.error) ? "some unreachable" : undefined} level={rows.some((p) => p.error) ? "warn" : undefined} />
      </div>
      <div className="mb-4"><Tabs tabs={[...PIPELINE_VIEWS.filter((v) => v.id !== "list"), { id: "list", label: "List" }, { id: "manage", label: "Manage" }]} value={view} onChange={pick} /></div>
      {!manage && <Panel title={PIPELINE_VIEWS.find((v) => v.id === view)?.label ?? "Pipelines"}><PipelineView rows={rows} view={view} /></Panel>}
      {manage && (
        <Panel title="Pipelines" flush>
          {defs.data?.items.length === 0 ? <div className="px-4 pb-4"><Empty>No pipelines yet.</Empty></div> : (
            <Table head={["Name", "Forge", "Repository", "Branch", "Latest run", "Result", "State", ""]}>
              {defs.data?.items.map((d: any) => {
                const p = live.data?.find((x) => x.id === d.id)
                const level: Level = !d.enabled || !p ? "off" : p.state
                return (
                  <tr key={d.id}>
                    <Td className="font-medium">{d.name}</Td>
                    <Td className="text-fg2">{PROVIDERS.find((x) => x.value === d.provider)?.label}</Td>
                    <Td mono>{d.repo}</Td>
                    <Td className="text-fg2">{d.branch || "any"}</Td>
                    <Td className="text-fg2">{p?.sha || "—"}</Td>
                    <Td className="max-w-64 truncate text-fg2 max-sm:max-w-none max-sm:whitespace-normal">{!d.enabled ? "Disabled" : p?.error || p?.status || "Pending"}</Td>
                    <StateCell level={level} label={!d.enabled ? "Disabled" : !p ? "Pending" : p.error && p.state === "off" ? "Unreachable" : pipelineWord(p)} />
                    <Td className="whitespace-nowrap">
                      <IconButton label="Edit" icon={PencilSquareIcon} onClick={() => setEdit(d)} />
                      <IconButton label="Delete" icon={TrashIcon} onClick={async () => { if (confirm(`Delete ${d.name}?`)) { await api(`/api/c/pipelines/${d.id}`, { method: "DELETE" }); done() } }} />
                    </Td>
                  </tr>
                )
              })}
            </Table>
          )}
        </Panel>
      )}
      {edit !== undefined && <PipelineForm row={edit} onDone={done} />}
    </>
  )
}

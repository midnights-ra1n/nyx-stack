import { TrashIcon } from "@heroicons/react/24/outline"
import { type ReactNode, useState } from "react"
import { Button, Check, Copy, Empty, ErrorNote, type Icon, IconButton, Input, Mono, Panel, Select, Status } from "./components"
import { api, download, fmt, REFRESH, setRefresh, useApi, useRefresh } from "./lib"
import { PageHeader } from "./shell"
import { t, tn, tx } from "./i18n"
export { NotificationSettings } from "./notify"

export function PasskeySettings() {
  const { data: status } = useApi("/api/auth/status", { poll: false })
  const list = useApi<any[]>(status?.passkeys ? "/api/auth/passkeys" : null, { poll: false })
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const add = async () => {
    setError("")
    try {
      const options = await api("/api/auth/passkey/register/start", { method: "POST" })
      const publicKey = (PublicKeyCredential as any).parseCreationOptionsFromJSON(options.publicKey)
      const cred = (await navigator.credentials.create({ publicKey })) as any
      await api("/api/auth/passkey/register/finish", { body: { name, credential: cred.toJSON() } })
      setName(""); list.reload()
    } catch (e) { setError((e as Error).message) }
  }
  return (
    <Panel title={t("Passkeys")}>
      {!status?.passkeys ? <Empty>{t("Passkeys need HTTPS. Set an https:// NYX_PUBLIC_URL.")}</Empty> : (
        <div className="flex flex-col gap-4">
          {list.data?.map((k) => (
            <div key={k.id} className="flex items-center justify-between">
              <span>{k.name || "Passkey"} <span className="text-[13px] text-fg3">· {fmt.ago(k.created)}</span></span>
              <IconButton label="Delete passkey" icon={TrashIcon} onClick={async () => { await api(`/api/auth/passkeys/${k.id}`, { method: "DELETE" }); list.reload() }} />
            </div>
          ))}
          <div className="flex items-end gap-3">
            <div className="flex-1"><Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Laptop")} /></div>
            <Button onClick={add} disabled={!name}>{t("Add passkey")}</Button>
          </div>
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Panel>
  )
}

export function McpSettings() {
  const { data: status } = useApi("/api/auth/status", { poll: false })
  const tokens = useApi("/api/c/mcp_tokens?sort=name", { poll: false })
  const [name, setName] = useState("")
  const [created, setCreated] = useState<{ token: string; url: string }>()
  // The relay key is in the fragment of the link Settings gives to signed-in users.
  const relay = status?.relay?.link ? { url: status.relay.url, key: status.relay.link.split("#relay=")[1] } : undefined
  const [error, setError] = useState("")
  const add = async () => {
    setError("")
    try { setCreated(await api("/api/mcp/tokens", { body: { name } })); setName(""); tokens.reload() } catch (e) { setError((e as Error).message) }
  }
  return (
    <Panel title={t("MCP server")}>
      {!status?.https && !relay ? <Empty>{t("MCP is served over HTTPS only. Set an https:// NYX_PUBLIC_URL, or link the Cloudflare relay.")}</Empty> : (
        <div className="flex flex-col gap-4">
          {status.https && <p className="text-fg2">{t("Connect Claude, ChatGPT, Codex or any MCP client to")} <Mono>{status.public_url}/mcp</Mono> {t("with a bearer token. Tools are read-only.")}</p>}
          {relay && <p className="text-fg2">{t("Through the Cloudflare relay, run")} <Mono>{"nyx-mcp"}</Mono> {t("on your computer: it seals each call, so Cloudflare cannot read your infrastructure. It works with any client that starts local MCP servers, such as Claude Desktop, Claude Code or Codex.")}</p>}
          {tokens.data?.items.map((tok: any) => (
            <div key={tok.id} className="flex items-center justify-between">
              <span>{tok.name} <span className="text-[13px] text-fg3">· {t("used {ago}", { ago: fmt.ago(tok.last_used) })}</span></span>
              <IconButton label="Revoke token" icon={TrashIcon} onClick={async () => { await api(`/api/c/mcp_tokens/${tok.id}`, { method: "DELETE" }); tokens.reload() }} />
            </div>
          ))}
          <div className="flex items-end gap-3">
            <div className="flex-1"><Input label="Client name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Claude")} /></div>
            <Button onClick={add} disabled={!name}>{t("Create token")}</Button>
          </div>
          {created && (
            <div className="flex flex-col gap-2">
              <p className="text-fg2">{t("Copy this token now, it will not be shown again.")}</p>
              <Copy text={created.token} />
              {status.https && <p className="text-[13px] text-fg3">{t("For clients that only accept a URL:")} <Mono>{created.url}/{created.token}</Mono></p>}
              {relay && <>
                <p className="text-fg2">{t("Claude Code, through the relay:")}</p>
                <Copy text={`claude mcp add nyx -e NYX_URL=${relay.url} -e NYX_RELAY_KEY=${relay.key} -e NYX_MCP_TOKEN=${created.token} -- nyx-mcp`} />
                <p className="text-fg2">{t("Claude Desktop and other clients, in their MCP configuration:")}</p>
                <Copy text={JSON.stringify({ mcpServers: { nyx: { command: "nyx-mcp", env: { NYX_URL: relay.url, NYX_RELAY_KEY: relay.key, NYX_MCP_TOKEN: created.token } } } }, null, 2)} />
              </>}
            </div>
          )}
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Panel>
  )
}

/** Small JSON-backed settings form. */
export function SettingForm({ title, setting, fields, needs, children }: { title: string; setting: string; fields: { key: string; label: string; type?: string; hint?: string }[]; needs?: string[]; children?: ReactNode }) {
  const { data, reload } = useApi(`/api/settings/${setting}`, { poll: false })
  const [form, setForm] = useState<any>()
  const [note, setNote] = useState("")
  const value = form ?? data ?? {}
  const save = async () => {
    try { await api(`/api/settings/${setting}`, { method: "PUT", body: { ...data, ...value } }); setNote("Saved."); reload() } catch (e) { setNote((e as Error).message) }
  }
  return (
    <Panel title={title} badge={needs && data && <Status level={needs.every((k) => data[k]) ? "ok" : "off"} label={needs.every((k) => data[k]) ? "Configured" : "Not configured"} />}>
      <div className="flex flex-col gap-4">
        {children}
        {fields.map((f) => f.type === "checkbox"
          ? <Check key={f.key} label={f.label} hint={f.hint} checked={!!value[f.key]} onChange={(e) => setForm({ ...value, [f.key]: e.target.checked })} />
          : <Input key={f.key} label={f.label} hint={f.hint} type={f.type ?? "text"} value={value[f.key] ?? ""} onChange={(e) => setForm({ ...value, [f.key]: f.type === "number" ? Number(e.target.value) : e.target.value })} />)}
        <div className="flex items-center gap-3"><Button onClick={save}>{t("Save")}</Button><span className="text-[13px] text-fg2">{note}</span></div>
      </div>
    </Panel>
  )
}

/** Where the Console buttons lead, and who signs in there. */
export function ProxmoxSettings() {
  const [note, setNote] = useState("")
  const test = async () => {
    setNote("Checking…")
    try { const r = await api("/api/proxmox/test", { method: "POST" }); setNote(t("Connected to Proxmox VE {version}.", { version: r.version })) } catch (e) { setNote((e as Error).message) }
  }
  return (
    <>
      <SettingForm title={t("Proxmox console")} setting="proxmox" needs={["url"]} fields={[
        { key: "url", label: "Proxmox URL", hint: "For example https://pve.lan:8006. Adds a noVNC console button." },
        { key: "user", label: "User", hint: "With its realm, for example root@pam." },
        { key: "password", label: "Password", type: "password", hint: "Opens the console already signed in, when Nyx and Proxmox share a domain such as nyx.home.lan and pve.home.lan. Elsewhere, Proxmox asks you to sign in." },
        { key: "token", label: "API token", type: "password", hint: "Instead of a password: user@realm!name=secret. A token checks the connection but cannot sign a browser in. Prefer a dedicated user with the PVEVMConsole role over root." },
        { key: "insecure", label: "Accept a self-signed certificate", type: "checkbox", hint: "Proxmox uses one until you install your own. This only applies to the calls Nyx makes." },
      ]} />
      <Panel title={t("Check Proxmox")}><div className="flex items-center gap-3"><Button onClick={test}>{t("Test the connection")}</Button><span className="text-[13px] text-fg2" role="status">{note}</span></div></Panel>
    </>
  )
}

type Step = { time: string; state: "run" | "ok" | "fail"; text: string }
type UpdateLog = { version: string; steps: Step[] }

/** What update.sh did, one line per step; the last one says how it ended. */
function UpdateSteps({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-col gap-1 text-[13px]">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span className="shrink-0 text-fg3 tabular-nums">{new Date(s.time).toLocaleTimeString()}</span>
          <span className={`min-w-0 break-words ${s.state === "fail" ? "text-crit" : s.state === "ok" ? "text-ok" : "text-fg2"}`}>{tn(s.text)}</span>
        </li>
      ))}
    </ol>
  )
}

/** GitHub is only contacted when the user presses Check. */
export function SystemUpdates({ agents }: { agents?: boolean }) {
  const { data } = useApi("/api/system/version", { poll: false })
  const { data: channel, reload } = useApi("/api/settings/updates", { poll: false })
  const { data: last } = useApi<UpdateLog>(data?.managed ? "/api/system/update" : null, { poll: false })
  const [latest, setLatest] = useState<{ latest: string; available: boolean }>()
  const [note, setNote] = useState("")
  const [run, setRun] = useState<{ steps: Step[]; text: string }>()
  const setBeta = async (beta: boolean) => {
    try { await api("/api/settings/updates", { method: "PUT", body: { beta } }); setLatest(undefined); reload() } catch (e) { setNote((e as Error).message) }
  }
  const check = async () => { try { setLatest(await api("/api/system/check", { method: "POST" })); setNote("") } catch (e) { setNote((e as Error).message) } }
  const update = async () => {
    let requested: string
    try { ({ requested } = await api("/api/system/update", { body: { tag: latest!.latest } })) } catch (e) { return setNote((e as Error).message) }
    setNote("")
    let steps: Step[] = []
    setRun({ steps, text: "Waiting for the updater…" })
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      const now = await api<UpdateLog>("/api/system/update").catch(() => null)
      // Steps of earlier updates are older than this request.
      if (now) steps = now.steps.filter((s) => s.time >= requested)
      const end = steps.at(-1)?.state
      if (end === "fail") return setRun({ steps, text: "The update did not go through. The last step says why." })
      // Updaters before 1.1.0 write no steps: the new version is all there is to see.
      if (now && now.version !== data?.version && (end === "ok" || !steps.length)) {
        setRun({ steps, text: t("Updated to {version}. Reloading…", { version: now.version }) })
        return setTimeout(() => location.reload(), 3000)
      }
      setRun({ steps, text: now ? "Updating…" : "Restarting…" })
    }
    setRun(undefined)
    setNote("The update did not finish. Run journalctl -u nyx-update on the server to see why.")
  }
  const past = last?.steps ?? []
  const end = past.at(-1)
  return (
    <Panel title={t("Software updates")}>
      <div className="flex flex-col gap-3">
        <p className="text-fg2">{t("Version {version}.", { version: data?.version ?? "—" })} {t(data?.managed ? "Installed from packages." : "Pull a new image to update a Docker install.")}</p>
        {data?.managed && <Check label="Include beta versions" checked={!!channel?.beta} onChange={(e) => setBeta(e.target.checked)} />}
        {data?.managed && agents && <p className="text-[13px] text-fg3">{t("Agents follow this server: they update to the version it ships.")}</p>}
        {data?.managed && <p className="text-[13px] text-fg3">{t("Before installing, the updater checks the database and the free space, then saves each database to /var/backups/nyx.")}</p>}
        {latest && <p>{latest.available ? t("{version} is available.", { version: latest.latest }) : t("You are up to date.")}</p>}
        {run && <div className="flex flex-col gap-2"><UpdateSteps steps={run.steps} /><p role="status" className="text-fg2">{t(run.text)}</p></div>}
        {!run && end && (
          <details>
            <summary className="cursor-pointer text-[13px] text-fg2">{t("Last update, {when}: {what}", { when: new Date(end.time).toLocaleString(), what: tn(end.text) })}</summary>
            <div className="mt-2"><UpdateSteps steps={past} /></div>
          </details>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={check}>{t("Check on GitHub")}</Button>
          {latest?.available && data?.managed && <Button variant="primary" disabled={!!run} onClick={update}>{t("Update to {version}", { version: latest.latest })}</Button>}
          <span className="text-[13px] text-fg2">{tn(note)}</span>
        </div>
      </div>
    </Panel>
  )
}

export function AboutPanel() {
  const { data: status } = useApi("/api/auth/status", { poll: false })
  const { data: system } = useApi("/api/system/version", { poll: false })
  const rows: [string, ReactNode][] = [
    ["Version", system?.version ?? "—"],
    ["Installed with", system ? (system.managed ? "Packages" : "Docker or by hand") : "—"],
    ["Public URL", <Mono key="url">{status?.public_url ?? "—"}</Mono>],
    ["HTTPS", status?.https ? "On: passkeys and MCP are available" : "Off: passkeys and MCP need an https:// NYX_PUBLIC_URL"],
    ["Database", status?.shared_database ? "Shared nyx-db" : "Local to this server"],
    ["Cloudflare relay", status?.relay ? <span key="relay"><Status level={status.relay.connected ? "ok" : "crit"} label={status.relay.connected ? "Linked" : "Not linked"} /> <Mono>{status.relay.url}</Mono></span> : "Off"],
  ]
  const link = status?.relay?.link
  return (
    <Panel title={t("This server")}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2">
        {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-fg2">{t(k)}</dt><dd className="break-words">{tx(v)}</dd></div>)}
      </dl>
      {link && <div className="mt-4 flex flex-col gap-2">
        <p className="text-fg2">{t("Open this link once on each device that should reach this server through Cloudflare. The relay key is in the part after #, which the browser keeps to itself: Cloudflare only ever sees encrypted traffic.")}</p>
        <Copy text={link} />
        <p className="text-warn">{t("Anyone with this link can reach the sign-in page. Share it like a password.")}</p>
      </div>}
    </Panel>
  )
}

/** Kept on this device, like the layouts it resets. */
export function AppearanceSettings() {
  const ms = useRefresh()
  const [note, setNote] = useState("")
  const reset = () => {
    Object.keys(localStorage).filter((k) => k.startsWith("nyx.layout.")).forEach((k) => localStorage.removeItem(k))
    setNote("Every page is back to its default layout.")
  }
  return (
    <Panel title={t("Appearance on this device")}>
      <div className="flex flex-col gap-4">
        <Select label="Auto-refresh" value={String(ms)} onChange={(e) => setRefresh(Number(e.target.value))} options={REFRESH.map(([v, l]) => ({ value: String(v), label: l }))} hint="Pages stop refreshing while their tab is hidden." />
        <div className="flex flex-wrap items-center gap-3"><Button onClick={reset}>{t("Reset all page layouts")}</Button><span className="text-[13px] text-fg2">{note}</span></div>
      </div>
    </Panel>
  )
}

export function AccountSettings() {
  const { data: status } = useApi("/api/auth/status", { poll: false })
  const [current, setCurrent] = useState("")
  const [password, setPassword] = useState("")
  const [note, setNote] = useState("")
  const [error, setError] = useState("")
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(""); setNote("")
    try {
      await api("/api/auth/password", { body: { current, password } })
      setCurrent(""); setPassword(""); setNote("Password changed.")
    } catch (err) { setError((err as Error).message) }
  }
  return (
    <Panel title={t("Account")}>
      <form className="flex flex-col gap-4" onSubmit={save}>
        <p className="text-fg2">{t("Signed in as")} <Mono>{status?.email ?? "—"}</Mono>.{status?.shared_database ? " This account is shared with the other server." : ""}</p>
        <Input label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Input label="New password" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 10 characters. Other browsers stay signed in for up to 7 days." />
        <ErrorNote>{error}</ErrorNote>
        <div className="flex items-center gap-3"><Button type="submit">{t("Change password")}</Button><span className="text-[13px] text-fg2">{note}</span></div>
      </form>
    </Panel>
  )
}

/** Restoring happens on a new install, while creating its first account. */
export function BackupSettings() {
  const [history, setHistory] = useState(true)
  const [error, setError] = useState("")
  return (
    <Panel title={t("Backup")}>
      <div className="flex flex-col gap-3">
        <p className="text-fg2">{t("One file with everything this server knows: hosts with their agent tokens and keys, probes, integrations, notification channels, pages and settings. Accounts are not in it.")}</p>
        <p className="text-fg2">{t("To restore, install a new server with the same public URL and pick the file when creating the account. Agents reconnect on their own.")}</p>
        <p className="text-warn">{t("The file holds secrets such as agent keys, SSH keys and integration passwords. Keep it somewhere safe.")}</p>
        <Check label="Include metrics history" hint="Charts, uptime and past events. Makes the file much larger." checked={history} onChange={(e) => setHistory(e.target.checked)} />
        <div><Button variant="primary" onClick={() => { setError(""); download(`/api/backup?history=${history}`).catch((e) => setError(e.message)) }}>{t("Download backup")}</Button></div>
        <ErrorNote>{error}</ErrorNote>
      </div>
    </Panel>
  )
}

export interface SettingsSection { id: string; label: string; icon: Icon; description: string; body: ReactNode }

/** One section at a time. The address keeps it, so a reload or a link lands on the same one. */
export function SettingsPage({ sections }: { sections: SettingsSection[] }) {
  const [id, setId] = useState(location.hash.slice(1))
  const shown = sections.find((s) => s.id === id) ?? sections[0]
  const open = (next: string) => { setId(next); history.replaceState(null, "", `#${next}`) }
  return (
    <>
      <PageHeader title={t("Settings")} actions={<SignOut />} />
      <div className="grid items-start gap-8 lg:grid-cols-[216px_minmax(0,1fr)]">
        <nav aria-label={t("Settings sections")} className="flex gap-1 lg:sticky lg:top-6 lg:flex-col max-lg:overflow-x-auto">
          {sections.map((s) => {
            const I = s.icon
            return <button key={s.id} type="button" aria-current={s === shown ? "page" : undefined} onClick={() => open(s.id)} className={`flex h-10 shrink-0 items-center gap-3 rounded-control px-4 text-left whitespace-nowrap ${s === shown ? "bg-accent-soft text-accent" : "text-fg2 hover:bg-raised hover:text-fg"}`}><I className="size-5" aria-hidden />{t(s.label)}</button>
          })}
        </nav>
        <div className="flex max-w-4xl min-w-0 flex-col gap-4">
          <div>
            <h2 className="text-lg font-medium">{t(shown.label)}</h2>
            <p className="text-[13px] text-fg2">{t(shown.description)}</p>
          </div>
          {shown.body}
        </div>
      </div>
    </>
  )
}

export function SignOut() {
  return <Button variant="danger" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); location.href = "/" }}>{t("Sign out")}</Button>
}

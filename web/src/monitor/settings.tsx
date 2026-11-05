import { useState } from "react"
import { Button, Copy, Panel, Tabs, TextArea } from "../ui/components"
import { api, useApi } from "../ui/lib"
import { McpSettings, NotificationSettings, PasskeySettings, SettingForm, SignOut, SystemUpdates } from "../ui/settings"
import { PageHeader, Section } from "../ui/shell"

const TABS = [{ id: "notifications", label: "Notifications" }, { id: "monitoring", label: "Monitoring" }, { id: "integrations", label: "Integrations" }, { id: "access", label: "Access" }]

function Meross() {
  const { data, reload } = useApi("/api/settings/meross", { poll: false })
  const [text, setText] = useState<string>()
  const [note, setNote] = useState("")
  const plugs = text ?? (data?.plugs ?? []).map((p: any) => `${p.name}=${p.ip}`).join("\n")
  const [key, setKey] = useState<string>()
  const save = async () => {
    const list = plugs.split("\n").map((l: string) => l.trim()).filter(Boolean).map((l: string) => { const [name, ip] = l.split("="); return { name, ip } })
    await api("/api/settings/meross", { method: "PUT", body: { key: key ?? data?.key ?? "", plugs: list } })
    setNote("Saved."); reload()
  }
  return (
    <Panel title="Meross plugs">
      <div className="flex flex-col gap-4">
        <TextArea label="Plugs, one name=ip per line" value={plugs} rows={3} onChange={(e) => setText(e.target.value)} placeholder="nas=192.168.10.50" hint="Plugs are read over the local network only." />
        <TextArea label="Device key" rows={1} value={key ?? data?.key ?? ""} onChange={(e) => setKey(e.target.value)} />
        <div className="flex items-center gap-3"><Button onClick={save}>Save</Button><span className="text-[13px] text-fg2">{note}</span></div>
      </div>
    </Panel>
  )
}

function ManagerLink() {
  const [token, setToken] = useState("")
  return (
    <Panel title="Manager link">
      <div className="flex flex-col gap-3">
        <p className="text-fg2">Optional. Lets a Nyx Manager read the fleet and deploy Node.js sites through agents. Creating a token replaces the previous one.</p>
        <div><Button onClick={async () => setToken((await api("/api/link/token", { method: "POST" })).token)}>Create link token</Button></div>
        {token && <Copy text={token} />}
      </div>
    </Panel>
  )
}

export function Settings() {
  const [tab, setTab] = useState("notifications")
  return (
    <>
      <PageHeader title="Settings" actions={<SignOut />} variables={<Tabs tabs={TABS} value={tab} onChange={setTab} />} />
      <div className="max-w-5xl">
        <Section>
          {tab === "notifications" && <NotificationSettings />}
          {tab === "monitoring" && <>
            <SettingForm title="Thresholds" setting="thresholds" fields={[
              { key: "warn", label: "Warning from (%)", type: "number" }, { key: "crit", label: "Critical from (%)", type: "number" },
              { key: "temp_warn", label: "Temperature warning (°C)", type: "number" }, { key: "temp_crit", label: "Temperature critical (°C)", type: "number" }]} />
            <SettingForm title="Daily maintenance" setting="maintenance" fields={[
              { key: "check_hour", label: "Update check hour", type: "number", hint: "Agents look for system updates once a day at this hour." },
              { key: "agent_auto_update", label: "Update agents automatically", type: "checkbox" },
              { key: "retention_days", label: "Keep history for (days)", type: "number", hint: "From 30 to 365. Past 7 days, history is stored hour by hour, so a year takes about 3 MB per host." }]} />
          </>}
          {tab === "integrations" && <>
            <SettingForm title="EDF Tempo (RTE)" setting="tempo" fields={[{ key: "client_id", label: "Client ID" }, { key: "client_secret", label: "Client secret", type: "password" }]} />
            <SettingForm title="Proxmox console" setting="proxmox" fields={[{ key: "url", label: "Proxmox URL", hint: "For example https://pve.lan:8006. Adds a noVNC console button." }]} />
            <Meross />
          </>}
          {tab === "access" && <><PasskeySettings /><McpSettings /><SystemUpdates agents /><ManagerLink /></>}
        </Section>
      </div>
    </>
  )
}

import { ArrowPathIcon, BellIcon, ChartBarIcon, Cog6ToothIcon, PuzzlePieceIcon, ShieldCheckIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Button, Copy, Panel, TextArea } from "../ui/components"
import { api, useApi } from "../ui/lib"
import { AboutPanel, AccountSettings, AppearanceSettings, McpSettings, NotificationSettings, PasskeySettings, SettingForm, SettingsPage, SystemUpdates } from "../ui/settings"

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

/** Asks RTE right now, so a refused key shows here and not later on the dashboard. */
function TempoTest() {
  const [note, setNote] = useState("")
  const test = async () => {
    setNote("Asking RTE…")
    try {
      const t = await api("/api/integrations/tempo")
      setNote(t.configured ? `RTE answers. Today is ${(t.today ?? "not published").toLowerCase()}.` : "Save a client ID and a client secret first.")
    } catch (e) { setNote((e as Error).message) }
  }
  return <div className="flex flex-wrap items-center gap-3"><Button onClick={test}>Test the connection</Button><span role="status" className="text-[13px] text-fg2">{note}</span></div>
}

/** Sends the whole season again, so that this also repairs deleted events. */
function TempoCalendarSync() {
  const [note, setNote] = useState("")
  const sync = async () => {
    setNote("Sending the season to Nextcloud…")
    try { const r = await api("/api/integrations/tempo/calendar", { method: "POST" }); setNote(`${r.sent} days are in the calendar.`) } catch (e) { setNote((e as Error).message) }
  }
  return <div className="flex flex-wrap items-center gap-3"><Button onClick={sync}>Sync now</Button><span role="status" className="text-[13px] text-fg2">{note}</span></div>
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
  return (
    <SettingsPage sections={[
      { id: "general", label: "General", icon: Cog6ToothIcon, description: "This server, and its look on this device.", body: <><AboutPanel /><AppearanceSettings /></> },
      { id: "monitoring", label: "Monitoring", icon: ChartBarIcon, description: "What counts as a problem, and how long history is kept.", body: <>
        <SettingForm title="Thresholds" setting="thresholds" fields={[
          { key: "warn", label: "Warning from (%)", type: "number" }, { key: "crit", label: "Critical from (%)", type: "number" },
          { key: "temp_warn", label: "Temperature warning (°C)", type: "number" }, { key: "temp_crit", label: "Temperature critical (°C)", type: "number" }]} />
        <SettingForm title="Daily maintenance" setting="maintenance" fields={[
          { key: "check_hour", label: "Update check hour", type: "number", hint: "Agents look for system updates once a day at this hour." },
          { key: "agent_auto_update", label: "Update agents automatically", type: "checkbox" },
          { key: "retention_days", label: "Keep history for (days)", type: "number", hint: "From 30 to 365. Past 7 days, history is stored hour by hour, so a year takes about 3 MB per host." }]} />
      </> },
      { id: "integrations", label: "Integrations", icon: PuzzlePieceIcon, description: "Optional links to the services around the monitor.", body: <>
        <ManagerLink />
        <SettingForm title="EDF Tempo (RTE)" setting="tempo" needs={["client_id", "client_secret"]} fields={[{ key: "client_id", label: "Client ID" }, { key: "client_secret", label: "Client secret", type: "password" }]}>
          <p className="text-fg2">Your application on data.rte-france.com must be subscribed to the Tempo Like Supply Contract API. The calls come from this server, so it works over plain HTTP too.</p>
        </SettingForm>
        <Panel title="Check EDF Tempo"><TempoTest /></Panel>
        <SettingForm title="EDF Tempo in Nextcloud" setting="tempo_calendar" needs={["url", "user", "password", "calendar"]} fields={[
          { key: "url", label: "Nextcloud URL" }, { key: "user", label: "User" },
          { key: "password", label: "App password", type: "password" },
          { key: "calendar", label: "Calendar", hint: "The name in the calendar's link, for example tempo. Create it in Nextcloud first." }]}>
          <p className="text-fg2">Adds an all-day event for each day: 🔵 Bleu, ⚪️ Blanc or 🔴 Rouge. Checked every hour; RTE publishes tomorrow's colour around 11:00.</p>
        </SettingForm>
        <Panel title="Send the Tempo days to Nextcloud"><TempoCalendarSync /></Panel>
        <SettingForm title="Proxmox console" setting="proxmox" needs={["url"]} fields={[{ key: "url", label: "Proxmox URL", hint: "For example https://pve.lan:8006. Adds a noVNC console button." }]} />
        <Meross />
      </> },
      { id: "notifications", label: "Notifications", icon: BellIcon, description: "Channels say where a message goes, rules say what and when.", body: <NotificationSettings /> },
      { id: "security", label: "Security", icon: ShieldCheckIcon, description: "Your account, and what can reach this server without it.", body: <><AccountSettings /><PasskeySettings /><McpSettings /></> },
      { id: "updates", label: "Updates", icon: ArrowPathIcon, description: "The version of this server and its agents.", body: <SystemUpdates agents /> },
    ]} />
  )
}

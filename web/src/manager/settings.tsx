import { ArrowPathIcon, BellIcon, CircleStackIcon, Cog6ToothIcon, PuzzlePieceIcon, ShieldCheckIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Button, Mono, Panel } from "../ui/components"
import { api } from "../ui/lib"
import { AboutPanel, AccountSettings, AppearanceSettings, McpSettings, NotificationSettings, PasskeySettings, SettingForm, SettingsPage, SystemUpdates } from "../ui/settings"

const INVENTORY = ["hardware", "virtual_assets", "subnets", "ip_addresses", "routes", "deployments", "map_nodes", "map_links"]

/** These collections hold no secrets, so the file is safe to pass around. */
async function exportInventory() {
  const out: Record<string, unknown[]> = {}
  for (const c of INVENTORY) {
    out[c] = []
    for (let page = 1; ; page++) {
      const { items, totalItems } = await api(`/api/c/${c}?perPage=500&page=${page}`)
      out[c].push(...items)
      if (!items.length || out[c].length >= totalItems) break
    }
  }
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }))
  a.download = `nyx-inventory-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

function Sync() {
  const [note, setNote] = useState("")
  const run = async (f: () => Promise<string>) => {
    setNote("Working…")
    try { setNote(await f()) } catch (e) { setNote((e as Error).message) }
  }
  return (
    <Panel title="Synchronisation">
      <div className="flex flex-col gap-3">
        <p className="text-fg2">Nextcloud syncs every 30 seconds and the inventory every 5 minutes, without you doing anything.</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => run(async () => { const hosts = await api("/api/monitor/hosts"); return hosts ? `Connected: ${hosts.length} hosts.` : "No monitor linked." })}>Test the monitor link</Button>
          <Button onClick={() => run(async () => { await api("/api/sync", { method: "POST" }); return "Synchronised." })}>Sync now</Button>
          <span className="text-[13px] text-fg2">{note}</span>
        </div>
      </div>
    </Panel>
  )
}

function Data() {
  const [note, setNote] = useState("")
  const save = async () => { setNote(""); try { await exportInventory() } catch (e) { setNote((e as Error).message) } }
  return (
    <>
      <Panel title="Export the inventory">
        <div className="flex flex-col gap-3">
          <p className="text-fg2">Hardware, virtual assets, IPAM, deployments and the network map as one JSON file. Nothing secret is included. This is for reading or for another tool: restoring goes through a backup.</p>
          <div className="flex items-center gap-3"><Button onClick={save}>Download JSON</Button><span className="text-[13px] text-fg2">{note}</span></div>
        </div>
      </Panel>
      <Panel title="Backups">
        <p className="text-fg2">Everything durable is in the data directory: <Mono>/var/lib/nyx/manager</Mono> with packages, the <Mono>manager-data</Mono> volume with Docker. Stop the server before copying it, or use a tool that can copy a live SQLite database.</p>
      </Panel>
    </>
  )
}

export function Settings() {
  return (
    <SettingsPage sections={[
      { id: "general", label: "General", icon: Cog6ToothIcon, description: "This server, its look on this device, and when it reminds you.", body: <>
        <AboutPanel />
        <AppearanceSettings />
        <SettingForm title="Reminders" setting="reminders" fields={[
          { key: "task_days", label: "Remind tasks and planned deployments, days before", type: "number", hint: "1 by default. The reminder is one notification of type task." },
          { key: "warranty_days", label: "Show ending warranties, days before", type: "number", hint: "60 by default. They appear on the overview." }]} />
      </> },
      { id: "integrations", label: "Integrations", icon: PuzzlePieceIcon, description: "Optional links to the services around the manager.", body: <>
        <SettingForm title="Nyx Monitor" setting="link" needs={["url", "token"]} fields={[
          { key: "url", label: "Monitor URL", hint: "For example https://monitor.lan:8081." },
          { key: "token", label: "Link token", type: "password", hint: "Create it in the monitor, under Settings, Integrations." }]}>
          <p className="text-fg2">Fills the inventory and IPAM from agents, and deploys sites through them.</p>
        </SettingForm>
        <SettingForm title="Nextcloud tasks" setting="nextcloud" needs={["url", "user", "password", "calendar"]} fields={[
          { key: "url", label: "Nextcloud URL" }, { key: "user", label: "User" },
          { key: "password", label: "App password", type: "password" },
          { key: "calendar", label: "Calendar", hint: "The name in the calendar's link, for example personal." }]} />
        <SettingForm title="Proxmox console" setting="proxmox" needs={["url"]} fields={[{ key: "url", label: "Proxmox URL", hint: "For example https://pve.lan:8006. Adds a noVNC console button." }]} />
        <Sync />
      </> },
      { id: "notifications", label: "Notifications", icon: BellIcon, description: "Channels say where a message goes, rules say what and when.", body: <NotificationSettings /> },
      { id: "security", label: "Security", icon: ShieldCheckIcon, description: "Your account, and what can reach this server without it.", body: <><AccountSettings /><PasskeySettings /><McpSettings /></> },
      { id: "data", label: "Data", icon: CircleStackIcon, description: "Get your data out, and keep it safe.", body: <Data /> },
      { id: "updates", label: "Updates", icon: ArrowPathIcon, description: "The version of this server.", body: <SystemUpdates /> },
    ]} />
  )
}

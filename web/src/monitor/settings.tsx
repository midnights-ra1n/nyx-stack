import { ArchiveBoxIcon, ArrowPathIcon, BellIcon, ChartBarIcon, Cog6ToothIcon, PuzzlePieceIcon, ShieldCheckIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { TrashIcon } from "@heroicons/react/24/outline"
import { Button, Copy, ErrorNote, IconButton, Input, Mono, Panel, Status, TextArea } from "../ui/components"
import { api, useApi } from "../ui/lib"
import { AboutPanel, AccountSettings, BackupSettings, AppearanceSettings, McpSettings, NotificationSettings, PasskeySettings, ProxmoxSettings, SettingForm, SettingsPage, SystemUpdates } from "../ui/settings"
import { NextDnsSettings } from "../ui/nextdns"
import { t } from "../ui/i18n"

/** Host names come from the monitor, for the host filter of rules. */
function Notifications() {
  const hosts = useApi<any[]>("/api/hosts", { poll: false })
  return <NotificationSettings hosts={(hosts.data ?? []).map((h) => h.name)} />
}

interface Plug { name: string; ip: string; mac: string }
const MAC = /^([0-9a-f]{2}[:-]?){5}[0-9a-f]{2}$/i

function Meross() {
  const { data, reload } = useApi("/api/settings/meross", { poll: false })
  const power = useApi("/api/integrations/power", { poll: false })
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [plugs, setPlugs] = useState<Plug[]>()
  const [note, setNote] = useState("")
  const list: Plug[] = plugs ?? (data?.plugs ?? []).map((p: any) => ({ name: p.name ?? "", ip: p.ip ?? "", mac: p.mac ?? "" }))
  const edit = (i: number, k: keyof Plug, v: string) => setPlugs(list.map((p, j) => (j === i ? { ...p, [k]: v } : p)))
  const signIn = async () => {
    setNote("Signing in…")
    try { await api("/api/integrations/meross/login", { body: { email, password } }); setPassword(""); setNote("Signed in. The password was not kept."); reload() } catch (e) { setNote((e as Error).message) }
  }
  const save = async () => {
    const bad = list.find((p) => !p.name.trim() || !p.ip.trim() || !MAC.test(p.mac.trim()))
    if (bad) return setNote(t("Each plug needs a name, an IP address and a MAC address (12 hex digits): check {v0}.", { v0: bad.name || "the new line" }))
    try { await api("/api/settings/meross", { method: "PUT", body: { ...data, plugs: list.map((p) => ({ name: p.name.trim(), ip: p.ip.trim(), mac: p.mac.trim() })) } }); setPlugs(undefined); setNote("Saved."); reload() } catch (e) { setNote((e as Error).message) }
  }
  const signedIn = !!data?.key
  return (
    <Panel title={t("Meross plugs")} badge={<Status level={signedIn ? "ok" : "off"} label={signedIn ? (data.email ? t("Signed in as {email}", { email: data.email }) : t("Signed in")) : "Not signed in"} />}>
      <div className="flex flex-col gap-4">
        <p className="text-fg2">{t("Sign in with your Meross account once: it gives Nyx the key that signs requests to your plugs. The password is used for that call and not stored. After this, the plugs are read over your local network only.")}</p>
        <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          <Input label="Meross e-mail" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input label="Meross password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div><Button onClick={signIn} disabled={!email || !password}>{signedIn ? "Sign in again" : "Sign in"}</Button></div>
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-medium text-fg2">{t("Plugs")}</h3>
          {list.map((p, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2 max-sm:grid-cols-1">
              <Input label="Name" value={p.name} onChange={(e) => edit(i, "name", e.target.value)} />
              <Input label="IP address" className="font-mono" placeholder="192.168.10.50" value={p.ip} onChange={(e) => edit(i, "ip", e.target.value)} />
              <Input label="MAC address" className="font-mono" placeholder={t("48:e1:e9:00:11:22")} value={p.mac} onChange={(e) => edit(i, "mac", e.target.value)} />
              <IconButton label={t("Remove {name}", { name: p.name || t("plug") })} icon={TrashIcon} onClick={() => setPlugs(list.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div><Button onClick={() => setPlugs([...list, { name: "", ip: "", mac: "" }])}>{t("Add a plug")}</Button></div>
          <p className="text-[13px] text-fg3">{t("The MAC address is on the plug's label and in the Meross app. Nyx checks it on every reading, so a plug whose address changed is reported instead of mixed up with another device.")}</p>
        </div>
        {(power.data?.problems ?? []).map((p: any) => <ErrorNote key={p.name}>{`${p.name}: ${p.message}`}</ErrorNote>)}
        <div className="flex items-center gap-3"><Button onClick={save}>{t("Save plugs")}</Button><span className="text-[13px] text-fg2" role="status">{note}</span></div>
      </div>
    </Panel>
  )
}

/** Asks RTE right now, so a refused key shows here and not later on the dashboard. */
function TempoTest() {
  const [note, setNote] = useState("")
  const test = async () => {
    setNote(t("Asking RTE…"))
    try {
      const r = await api("/api/integrations/tempo")
      setNote(r.configured ? t("RTE answers. Today is {color}.", { color: t(r.today ?? "not published").toLowerCase() }) : t("Save a client ID and a client secret first."))
    } catch (e) { setNote((e as Error).message) }
  }
  return <div className="flex flex-wrap items-center gap-3"><Button onClick={test}>{t("Test the connection")}</Button><span role="status" className="text-[13px] text-fg2">{note}</span></div>
}

/** Sends the whole season again, so that this also repairs deleted events. */
function TempoCalendarSync() {
  const [note, setNote] = useState("")
  const sync = async () => {
    setNote("Sending the season to Nextcloud…")
    try { const r = await api("/api/integrations/tempo/calendar", { method: "POST" }); setNote(t("{sent} days are in the calendar.", { sent: r.sent })) } catch (e) { setNote((e as Error).message) }
  }
  return <div className="flex flex-wrap items-center gap-3"><Button onClick={sync}>{t("Sync now")}</Button><span role="status" className="text-[13px] text-fg2">{note}</span></div>
}

function ManagerLink() {
  const [token, setToken] = useState("")
  return (
    <Panel title={t("Manager link")}>
      <div className="flex flex-col gap-3">
        <p className="text-fg2">{t("Optional. Lets a Nyx Manager read the fleet and deploy Node.js sites through agents. Creating a token replaces the previous one.")}</p>
        <div><Button onClick={async () => setToken((await api("/api/link/token", { method: "POST" })).token)}>{t("Create link token")}</Button></div>
        {token && <Copy text={token} />}
      </div>
    </Panel>
  )
}

function Grafana() {
  const { data, reload } = useApi("/api/metrics", { poll: false })
  const [token, setToken] = useState("")
  const create = async () => { setToken((await api("/api/metrics/token", { method: "POST" })).token); reload() }
  const disable = async () => { await api("/api/metrics", { method: "DELETE" }); setToken(""); reload() }
  const url = new URL(data?.url ?? "http://monitor:8081/metrics")
  const env = `NYX_METRICS_TOKEN=${token || "<your token>"}\n# Only when Grafana runs apart from this monitor:\n#NYX_METRICS_HOST=${url.host}\n#NYX_METRICS_SCHEME=${url.protocol.replace(":", "")}`
  return (
    <Panel title={t("Grafana (Prometheus metrics)")}>
      <div className="flex flex-col gap-3">
        <p className="text-fg2">{t("Exposes every host, disk, SMART, container, guest, probe, pipeline, alert, power and Tempo figure at")} <Mono>{data?.url ?? "/metrics"}</Mono> {t("in the Prometheus format. The")} <Mono>{"grafana"}</Mono> {t("profile of the Docker setup runs Grafana with its dashboard: see the Grafana guide in the docs. Creating a token replaces the previous one.")}</p>
        <div className="flex gap-3">
          <Button onClick={create}>{data?.enabled ? "Replace token" : "Create token"}</Button>
          {data?.enabled && <Button variant="ghost" onClick={disable}>{t("Turn off")}</Button>}
        </div>
        {token && <><p className="text-fg2">{t("Copy this token now, it will not be shown again.")}</p><Copy text={token} /></>}
        {data?.enabled && <><p className="text-fg2">{t("Put these lines in")} <Mono>{".env"}</Mono>{t(", then run")} <Mono>{"docker compose --profile grafana up -d"}</Mono>:</p><Copy text={env} /></>}
      </div>
    </Panel>
  )
}

export function Settings() {
  return (
    <SettingsPage sections={[
      { id: "general", label: "General", icon: Cog6ToothIcon, description: "This server, and its look on this device.", body: <><AboutPanel /><AppearanceSettings /></> },
      { id: "monitoring", label: "Monitoring", icon: ChartBarIcon, description: "What counts as a problem, and how long history is kept.", body: <>
        <SettingForm title={t("Thresholds")} setting="thresholds" fields={[
          { key: "warn", label: "Warning from (%)", type: "number" }, { key: "crit", label: "Critical from (%)", type: "number" },
          { key: "temp_warn", label: "Temperature warning (°C)", type: "number" }, { key: "temp_crit", label: "Temperature critical (°C)", type: "number" }]} />
        <SettingForm title={t("Daily maintenance")} setting="maintenance" fields={[
          { key: "check_hour", label: "Update check hour", type: "number", hint: "Agents look for system updates once a day at this hour." },
          { key: "agent_auto_update", label: "Update agents automatically", type: "checkbox" },
          { key: "agent_beta", label: "Use beta agents", type: "checkbox", hint: "Agents take the newest release from GitHub rather than the version this server ships." },
          { key: "retention_days", label: "Keep history for (days)", type: "number", hint: "From 30 to 365. Past 7 days, history is stored hour by hour, so a year takes about 3 MB per host." }]} />
        <SettingForm title={t("DNS for probes")} setting="probe_dns" fields={[
          { key: "servers", label: "DNS servers", hint: "IP addresses separated by commas, for example 1.1.1.1, 9.9.9.9. Ping, website, certificate and DNS probes resolve names through them, which keeps them out of a local NextDNS or Pi-hole log. A probe's own DNS server still wins. Empty uses this server's resolver." }]} />
      </> },
      { id: "integrations", label: "Integrations", icon: PuzzlePieceIcon, description: "Optional links to the services around the monitor.", body: <>
        <ManagerLink />
        <Grafana />
        <SettingForm title={t("EDF Tempo (RTE)")} setting="tempo" needs={["client_id", "client_secret"]} fields={[{ key: "client_id", label: "Client ID" }, { key: "client_secret", label: "Client secret", type: "password" }]}>
          <p className="text-fg2">{t("Your application on data.rte-france.com must be subscribed to the Tempo Like Supply Contract API. The calls come from this server, so it works over plain HTTP too.")}</p>
        </SettingForm>
        <Panel title={t("Check EDF Tempo")}><TempoTest /></Panel>
        <SettingForm title={t("EDF Tempo in Nextcloud")} setting="tempo_calendar" needs={["url", "user", "password", "calendar"]} fields={[
          { key: "url", label: "Nextcloud URL" }, { key: "user", label: "User" },
          { key: "password", label: "App password", type: "password" },
          { key: "calendar", label: "Calendar", hint: "The name in the calendar's link, for example tempo. Create it in Nextcloud first." }]}>
          <p className="text-fg2">{t("Adds an all-day event for each day: 🔵 Bleu, ⚪️ Blanc or 🔴 Rouge. Checked every hour; RTE publishes tomorrow's colour around 11:00.")}</p>
        </SettingForm>
        <Panel title={t("Send the Tempo days to Nextcloud")}><TempoCalendarSync /></Panel>
        <ProxmoxSettings />
        <NextDnsSettings />
        <Meross />
      </> },
      { id: "notifications", label: "Notifications", icon: BellIcon, description: "Channels say where a message goes, rules say what and when.", body: <Notifications /> },
      { id: "security", label: "Security", icon: ShieldCheckIcon, description: "Your account, and what can reach this server without it.", body: <><AccountSettings /><PasskeySettings /><McpSettings /></> },
      { id: "backup", label: "Backup", icon: ArchiveBoxIcon, description: "Everything needed to rebuild this server elsewhere.", body: <BackupSettings /> },
      { id: "updates", label: "Updates", icon: ArrowPathIcon, description: "The version of this server and its agents.", body: <SystemUpdates agents /> },
    ]} />
  )
}

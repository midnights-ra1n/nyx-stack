import { useState } from "react"
import { Tabs } from "../ui/components"
import { McpSettings, NotificationSettings, PasskeySettings, SettingForm, SignOut, SystemUpdates } from "../ui/settings"
import { PageHeader, Section } from "../ui/shell"

const TABS = [{ id: "notifications", label: "Notifications" }, { id: "integrations", label: "Integrations" }, { id: "access", label: "Access" }]

export function Settings() {
  const [tab, setTab] = useState("integrations")
  return (
    <>
      <PageHeader title="Settings" actions={<SignOut />} variables={<Tabs tabs={TABS} value={tab} onChange={setTab} />} />
      <div className="max-w-5xl">
        <Section>
          {tab === "notifications" && <NotificationSettings />}
          {tab === "integrations" && <>
            <SettingForm title="Nyx Monitor" setting="link" fields={[
              { key: "url", label: "Monitor URL", hint: "For example https://monitor.lan:8081." },
              { key: "token", label: "Link token", type: "password", hint: "Create it in the monitor, under Settings, Access." }]}>
              <p className="text-fg2">Optional. Fills the inventory and IPAM from agents, and deploys sites through them.</p>
            </SettingForm>
            <SettingForm title="Nextcloud tasks" setting="nextcloud" fields={[
              { key: "url", label: "Nextcloud URL" }, { key: "user", label: "User" },
              { key: "password", label: "App password", type: "password" },
              { key: "calendar", label: "Calendar", hint: "The name in the calendar's link, for example personal." }]} />
            <SettingForm title="Proxmox console" setting="proxmox" fields={[{ key: "url", label: "Proxmox URL", hint: "For example https://pve.lan:8006. Adds a noVNC console button." }]} />
          </>}
          {tab === "access" && <><PasskeySettings /><McpSettings /><SystemUpdates /></>}
        </Section>
      </div>
    </>
  )
}

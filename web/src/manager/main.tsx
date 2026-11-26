import "../ui/tokens.css"
import { CalendarDaysIcon, CpuChipIcon, GlobeAltIcon, LockClosedIcon, MapIcon, RectangleStackIcon, ServerStackIcon, RocketLaunchIcon, ServerIcon, Squares2X2Icon, CodeBracketIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline"
import { t } from "../ui/i18n"
import { useApi } from "../ui/lib"
import { App, mount, type NavConfig } from "../ui/shell"
import { Components, Deployments, Hardware, HardwareRecord, SearchPage, Tasks, Virtual, VirtualRecord, Vpn } from "./inventory"
import { Ipam, SubnetPage } from "./ipam"
import { NetworkMap } from "./map"
import { Overview } from "./overview"
import { Racks } from "./racks"
import { Settings } from "./settings"
import { Sites } from "./sites"

function route(path: string) {
  if (path === "/") return <Overview />
  if (path === "/hardware") return <Hardware />
  if (path.startsWith("/hardware/")) return <HardwareRecord key={path} id={path.slice(10)} />
  if (path === "/components") return <Components />
  if (path === "/racks") return <Racks />
  if (path === "/virtual") return <Virtual />
  if (path.startsWith("/virtual/")) return <VirtualRecord key={path} id={path.slice(9)} />
  if (path === "/ipam") return <Ipam />
  if (path.startsWith("/ipam/subnet/")) return <SubnetPage id={path.slice(13)} />
  if (path === "/map") return <NetworkMap />
  if (path === "/vpn") return <Vpn />
  if (path === "/deployments") return <Deployments />
  if (path === "/sites") return <Sites />
  if (path === "/tasks") return <Tasks />
  if (path === "/settings") return <Settings />
  if (path === "/search") return <SearchPage />
  return <p className="text-fg2">{t("Page not found.")}</p>
}

function useNav(): NavConfig {
  const { data } = useApi("/api/overview")
  const conflicts = data?.conflicts.length ?? 0
  return {
    name: "Nyx",
    role: "Manager",
    tabs: ["/", "/hardware", "/ipam", "/tasks"],
    groups: [
      // GLPI's menus: the assets, the network they sit on, then the work done on them.
      { label: "Assets", items: [
        { to: "/", label: "Overview", icon: Squares2X2Icon },
        { to: "/hardware", label: "Inventory", icon: ServerIcon },
        { to: "/components", label: "Components", icon: CpuChipIcon },
        { to: "/racks", label: "Places", icon: ServerStackIcon },
        { to: "/virtual", label: "Virtual", icon: RectangleStackIcon },
      ] },
      { label: "Network", items: [
        { to: "/ipam", label: "IPAM", icon: GlobeAltIcon, badge: conflicts },
        { to: "/map", label: "Network map", icon: MapIcon },
        { to: "/vpn", label: "VPN links", icon: LockClosedIcon },
      ] },
      { label: "Management", items: [
        { to: "/tasks", label: "Tasks", icon: CalendarDaysIcon, badge: data?.open_tasks },
        { to: "/deployments", label: "Deployments", icon: RocketLaunchIcon },
        { to: "/sites", label: "Node.js sites", icon: CodeBracketIcon },
      ] },
    ],
    footer: data && (
      <div className={`flex items-center gap-2 text-xs ${conflicts ? "text-warn" : "text-fg3"}`}>
        {conflicts > 0 ? <ExclamationTriangleIcon className="size-4" aria-hidden /> : <CpuChipIcon className="size-4" aria-hidden />}
        {conflicts ? t(conflicts > 1 ? "{n} addressing conflicts" : "{n} addressing conflict", { n: conflicts }) : t(data.linked ? "Linked to monitoring" : "Standalone")}
      </div>
    ),
  }
}

mount(<App name="Nyx Manager" useNav={useNav} route={route} customizable />)

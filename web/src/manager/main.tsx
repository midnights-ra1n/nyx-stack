import "../ui/tokens.css"
import { CalendarDaysIcon, CpuChipIcon, GlobeAltIcon, MapIcon, RectangleStackIcon, RocketLaunchIcon, ServerIcon, Squares2X2Icon, CodeBracketIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline"
import { useApi } from "../ui/lib"
import { App, mount, type NavConfig } from "../ui/shell"
import { Deployments, Hardware, Ipam, SearchPage, Tasks, Virtual } from "./inventory"
import { NetworkMap } from "./map"
import { Overview } from "./overview"
import { Settings } from "./settings"
import { Sites } from "./sites"

function route(path: string) {
  if (path === "/") return <Overview />
  if (path === "/hardware") return <Hardware />
  if (path === "/virtual") return <Virtual />
  if (path === "/ipam") return <Ipam />
  if (path === "/map") return <NetworkMap />
  if (path === "/deployments") return <Deployments />
  if (path === "/sites") return <Sites />
  if (path === "/tasks") return <Tasks />
  if (path === "/settings") return <Settings />
  if (path === "/search") return <SearchPage />
  return <p className="text-fg2">Page not found.</p>
}

function useNav(): NavConfig {
  const { data } = useApi("/api/overview")
  const conflicts = data?.conflicts.length ?? 0
  return {
    name: "Nyx",
    tabs: ["/", "/hardware", "/ipam", "/tasks"],
    groups: [
      { label: "Inventory", items: [
        { to: "/", label: "Overview", icon: Squares2X2Icon },
        { to: "/hardware", label: "Hardware", icon: ServerIcon },
        { to: "/virtual", label: "Virtual", icon: RectangleStackIcon },
      ] },
      { label: "Network", items: [
        { to: "/ipam", label: "IPAM", icon: GlobeAltIcon, badge: conflicts },
        { to: "/map", label: "Network map", icon: MapIcon },
      ] },
      { label: "Operations", items: [
        { to: "/deployments", label: "Deployments", icon: RocketLaunchIcon },
        { to: "/sites", label: "Node.js sites", icon: CodeBracketIcon },
        { to: "/tasks", label: "Tasks", icon: CalendarDaysIcon, badge: data?.open_tasks },
      ] },
    ],
    footer: data && (
      <div className={`flex items-center gap-2 text-xs ${conflicts ? "text-warn" : "text-fg3"}`}>
        {conflicts > 0 ? <ExclamationTriangleIcon className="size-4" aria-hidden /> : <CpuChipIcon className="size-4" aria-hidden />}
        {conflicts ? `${conflicts} addressing ${conflicts > 1 ? "conflicts" : "conflict"}` : data.linked ? "Linked to monitoring" : "Standalone"}
      </div>
    ),
  }
}

mount(<App name="Nyx Manager" useNav={useNav} route={route} customizable />)

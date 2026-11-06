import "../ui/tokens.css"
import { BellIcon, CircleStackIcon, CommandLineIcon, CubeIcon, GlobeAltIcon, PresentationChartBarIcon, ServerStackIcon, Squares2X2Icon, ExclamationTriangleIcon } from "@heroicons/react/24/outline"
import { useApi } from "../ui/lib"
import { App, mount, type NavConfig } from "../ui/shell"
import { PageEditor, PagesList } from "./display/editor"
import { DisplayPage } from "./display/viewer"
import { Storage } from "./disks"
import { Logs } from "./logs"
import { Alerts, Containers, Network, SearchPage } from "./pages"
import { HostDetail, Hosts } from "./hosts"
import { Overview } from "./overview"
import { Settings } from "./settings"

function route(path: string) {
  if (path === "/") return <Overview />
  if (path === "/hosts") return <Hosts />
  if (path.startsWith("/hosts/")) return <HostDetail id={path.slice(7)} />
  if (path === "/containers") return <Containers />
  if (path === "/network") return <Network />
  if (path === "/storage") return <Storage />
  if (path === "/alerts") return <Alerts />
  if (path === "/logs") return <Logs />
  if (path === "/pages") return <PagesList />
  if (path.startsWith("/pages/")) return <PageEditor key={path} id={path.slice(7)} />
  if (path === "/settings") return <Settings />
  if (path === "/search") return <SearchPage />
  return <p className="text-fg2">Page not found.</p>
}

function useNav(): NavConfig {
  const { data } = useApi("/api/overview")
  const off = data ? data.hosts_total - data.hosts_online : 0
  return {
    name: "Nyx",
    tabs: ["/", "/hosts", "/containers", "/alerts"],
    groups: [
      { label: "Monitoring", items: [
        { to: "/", label: "Overview", icon: Squares2X2Icon },
        { to: "/hosts", label: "Hosts", icon: ServerStackIcon },
        { to: "/containers", label: "Containers", icon: CubeIcon },
        { to: "/network", label: "Network", icon: GlobeAltIcon },
        { to: "/storage", label: "Storage", icon: CircleStackIcon },
      ] },
      { label: "Operations", items: [
        { to: "/alerts", label: "Alerts", icon: BellIcon, badge: data?.alerts },
        { to: "/logs", label: "Logs", icon: CommandLineIcon },
        { to: "/pages", label: "Status pages", icon: PresentationChartBarIcon },
      ] },
    ],
    footer: data && (
      <div className={`flex items-center gap-2 text-xs ${off ? "text-warn" : "text-fg3"}`}>
        {off > 0 && <ExclamationTriangleIcon className="size-4" aria-hidden />}
        {data.hosts_online} of {data.hosts_total} agents online
      </div>
    ),
  }
}

// Status pages and wall displays are anonymous: they skip the sign-in gate entirely.
const display = location.pathname.match(/^\/(?:status|wall)\/([a-z0-9-]+)$/)
mount(display ? <DisplayPage slug={display[1]} /> : <App name="Nyx Monitor" useNav={useNav} route={route} customizable />)

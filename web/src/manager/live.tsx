import { DistroIcon, osName } from "../ui/brand-icons"
import { Meter, Panel, Status } from "../ui/components"
import { t } from "../ui/i18n"
import { fmt, type Level, useApi } from "../ui/lib"
import { TagList } from "../ui/tags"

const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/** The monitored host behind a record of the inventory: same name or hostname, or same address. */
export const findHost = (hosts: any[] | null | undefined, r: { name?: string; hostname?: string; ip?: string }) =>
  (hosts ?? []).find((h) => same(h.name, r.name) || same(h.hostname, r.name) || (r.hostname && same(h.hostname, r.hostname)) || (!!r.ip && h.ip === r.ip))

export const liveLevel = (h: any): Level => (["ok", "warn", "crit"].includes(h.status) ? h.status : "off")

/** Hosts of the linked monitor; null without one. */
export const useLiveHosts = () => useApi<any[] | null>("/api/monitor/hosts").data

/** A list cell: the state a linked monitor gives, or a dash. */
export function LiveCell({ hosts, row }: { hosts: any[] | null | undefined; row: any }) {
  const h = findHost(hosts, row)
  return h ? <Status cell level={liveLevel(h)} /> : <span className="text-fg3">—</span>
}

/** Beside a record: what the monitor measures on it right now. */
export function LivePanel({ hosts, row }: { hosts: any[] | null | undefined; row: any }) {
  if (!hosts) return null
  const h = findHost(hosts, row)
  const bar = (label: string, pct?: number | null) => (
    <><dt className="text-fg2">{t(label)}</dt><dd className="flex items-center gap-2">{pct == null ? "—" : <><span className="flex-1"><Meter pct={pct} /></span><span className="w-11 text-right tabular-nums">{fmt.pct(pct)}</span></>}</dd></>
  )
  return (
    <Panel title={t("Monitoring")}>
      {!h ? <p className="text-[13px] text-fg3">{t("No monitored host has this name or address.")}</p> : (
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-fg2">{t("State")}</dt><dd><Status cell level={liveLevel(h)} /></dd>
          {bar("CPU", h.status === "off" ? null : h.cpu)}
          {bar("Memory", h.status === "off" ? null : h.mem)}
          {bar("Fullest disk", h.status === "off" ? null : h.disk)}
          <dt className="text-fg2">{t("Up for")}</dt><dd>{fmt.uptime(h.uptime_s)}</dd>
          {h.os && <><dt className="text-fg2">{t("System")}</dt><dd className="flex min-w-0 items-center gap-1.5"><DistroIcon os={h.os} className="size-4 text-fg3" /><span className="truncate">{osName(h.os)}</span></dd></>}
          <dt className="text-fg2">{t("Updates")}</dt><dd className={h.security ? "text-crit" : ""}>{h.updates ? `${h.updates}${h.security ? ` · ${t("{n} security fixes", { n: h.security })}` : ""}` : t("Up to date")}{h.reboot_required ? ` · ${t("Restart needed")}` : ""}</dd>
          <dt className="text-fg2">{t("Tags")}</dt><dd><TagList tags={h.tags} /></dd>
        </dl>
      )}
    </Panel>
  )
}

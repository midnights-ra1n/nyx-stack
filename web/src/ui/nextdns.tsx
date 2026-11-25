import { useState } from "react"
import { Empty, ErrorNote, Mono, Panel, Stat, TimeSeries, Variable } from "./components"
import { useApi } from "./lib"
import { SettingForm } from "./settings"
import { t } from "./i18n"

export const PERIODS = [["1", "24 hours"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]].map(([value, label]) => ({ value, label }))

/** Round up to 1, 2 or 5 times a power of ten, so the axis reads well. */
export const niceMax = (v: number) => {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1)))
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v) ?? 10 * p
}

/** Queries, blocked queries and most blocked domains of the NextDNS profile, over a period the viewer picks. Follows the page refresh; the server caches answers for 5 minutes. */
export function NextDns() {
  const [days, setDays] = useState("7")
  const { data, error } = useApi(`/api/nextdns?days=${days}`)
  const times: number[] = data?.times ?? []
  const points = (vs: number[]) => times.map((at, i) => ({ t: at, v: vs[i] ?? 0 }))
  if (error) return <ErrorNote>{error}</ErrorNote>
  if (!data) return <Empty>{t("Loading…")}</Empty>
  if (!data.configured) return <Empty>{t("Add your NextDNS API key and profile ID in Settings.")}</Empty>
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end"><Variable label="Period" value={days} onChange={setDays} options={PERIODS} /></div>
      <div className="grid grid-cols-3 gap-4">
        <Stat label="Queries" value={data.total.toLocaleString()} />
        <Stat label="Blocked" value={data.blocked.toLocaleString()} level={data.blocked ? "warn" : "ok"} />
        <Stat label="Blocked share" value={`${data.total ? ((data.blocked / data.total) * 100).toFixed(1) : "0.0"} %`} />
      </div>
      <TimeSeries max={niceMax(Math.max(0, ...data.series_total))} unit="" series={[
        { name: "Queries", color: "var(--color-s1)", values: points(data.series_total) },
        { name: "Blocked", color: "var(--color-crit)", values: points(data.series_blocked) },
      ]} />
      <div>
        <h3 className="mb-1 text-[13px] text-fg2">{t("Most blocked domains")}</h3>
        {data.top_blocked?.length ? (
          <ol className="divide-y divide-line border-t border-line">
            {data.top_blocked.map((d: { domain: string; queries: number }) => (
              <li key={d.domain} className="flex justify-between gap-3 py-1.5 text-[13px]"><Mono className="truncate">{d.domain}</Mono><span className="text-fg2">{d.queries.toLocaleString()}</span></li>
            ))}
          </ol>
        ) : <Empty>{t("Nothing blocked over this period.")}</Empty>}
      </div>
    </div>
  )
}

export const NextDnsPanel = ({ edit }: { edit?: any }) => <Panel title={t("NextDNS")} edit={edit}><NextDns /></Panel>

export function NextDnsSettings() {
  return (
    <SettingForm title={t("NextDNS")} setting="nextdns" needs={["api_key", "profile"]} fields={[
      { key: "api_key", label: "API key", type: "password", hint: "On my.nextdns.io, under Account, API." },
      { key: "profile", label: "Profile ID", hint: "The code in the address of the profile, for example abc123." }]}>
      <p className="text-fg2">{t("Shows the queries, the blocked queries and the most blocked domains of the profile. The calls come from this server, never from your browser.")}</p>
    </SettingForm>
  )
}

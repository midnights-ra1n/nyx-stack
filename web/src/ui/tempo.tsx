import type { ReactNode } from "react"

const DAY: Record<string, [string, string]> = { BLUE: ["Blue", "text-info"], WHITE: ["White", "text-fg"], RED: ["Red", "text-crit"] }

function Tile({ label, wide, className, children }: { label: string; wide?: boolean; className: string; children: ReactNode }) {
  return (
    <section aria-label={label} className={`flex min-h-0 flex-col overflow-hidden rounded-panel border border-line bg-surface @3xl:col-span-1 ${wide ? "col-span-3" : "col-span-2"}`}>
      <h2 className="flex h-8 shrink-0 items-center truncate px-3 text-[13px] font-medium text-fg2">{label}</h2>
      <div className="fit flex min-h-0 flex-1 items-center justify-center px-2 pb-2">
        <span className={`font-medium whitespace-nowrap ${className}`} style={{ fontSize: "clamp(18px, min(52cqh, 24cqw), 160px)", lineHeight: 1 }}>{children}</span>
      </div>
    </section>
  )
}

const Day = ({ label, colour }: { label: string; colour?: string | null }) => {
  const [name, className] = (colour && DAY[colour]) || ["—", "text-fg3"]
  return <Tile wide label={label} className={className}>{name}</Tile>
}

/** The colours of today and tomorrow, then what the season has left, in the look of the big number panels. One row when there is room, otherwise the days above the counts. */
export function TempoTiles({ tempo, className }: { tempo: any; className: string }) {
  const left = tempo.remaining
  return (
    <div className="@container h-full">
      <div className={`grid grid-cols-6 gap-2 @3xl:grid-cols-5 ${className}`}>
        <Day label="Today" colour={tempo.today} />
        <Day label="Tomorrow" colour={tempo.tomorrow} />
        <Tile label="Blue left" className="text-info">{left.blue}</Tile>
        <Tile label="White left" className="text-fg">{left.white}</Tile>
        <Tile label="Red left" className="text-crit">{left.red}</Tile>
      </div>
    </div>
  )
}

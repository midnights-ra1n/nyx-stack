import { Mono, StateCell, Table, Td } from "../ui/components"
import { fmt } from "../ui/lib"
import { Link } from "../ui/shell"

/** Tunnels of one host, or of the fleet when the rows carry their `host`. */
export function VpnTable({ rows }: { rows: any[] }) {
  const fleet = rows.some((r) => r.host)
  return (
    <Table head={[...(fleet ? ["Host"] : []), "Interface", "Type", "Address", "Down", "Up", "State"]}>
      {rows.map((v) => (
        <tr key={`${v.host?.id}${v.iface}`}>
          {fleet && <Td className="font-medium"><Link to={`/hosts/${v.host.id}`} className="hover:text-accent">{v.host.name}</Link></Td>}
          <Td mono className={fleet ? "" : "font-medium"}>{v.iface}</Td>
          <Td className="text-fg2">{v.kind}</Td>
          <Td><Mono className="text-fg2">{v.ip || "—"}</Mono></Td>
          <Td className="text-fg2">{fmt.bps(v.rx_bps)}</Td>
          <Td className="text-fg2">{fmt.bps(v.tx_bps)}</Td>
          <StateCell level={v.up ? "ok" : "crit"} label={v.up ? "Up" : "Down"} />
        </tr>
      ))}
    </Table>
  )
}

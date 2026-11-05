// Equipment profiles. A profile is plain data read by the generic SNMP poller, so
// supporting a new device means adding entries here, or editing them in the probe.

export interface SnmpItem {
  oid: string
  label: string
  unit?: string
  walk?: boolean
  agg?: "sum" | "min" | "max" | "avg" | "count"
  matches?: number
  rate?: boolean
  scale?: number
  warn?: number
  crit?: number
  low?: boolean
  expect?: number
}

const sys: SnmpItem[] = [
  { oid: "1.3.6.1.2.1.1.5.0", label: "Name" },
  { oid: "1.3.6.1.2.1.1.3.0", label: "Uptime", unit: "d", scale: 1 / 8640000 },
]

const ports: SnmpItem[] = [
  { oid: "1.3.6.1.2.1.2.2.1.8", label: "Ports up", walk: true, agg: "count", matches: 1 },
  { oid: "1.3.6.1.2.1.31.1.1.1.6", label: "Traffic in", unit: "MB/s", walk: true, agg: "sum", rate: true, scale: 1e-6 },
  { oid: "1.3.6.1.2.1.31.1.1.1.10", label: "Traffic out", unit: "MB/s", walk: true, agg: "sum", rate: true, scale: 1e-6 },
  { oid: "1.3.6.1.2.1.2.2.1.14", label: "Errors in", unit: "/s", walk: true, agg: "sum", rate: true },
]

const hostResources: SnmpItem[] = [
  { oid: "1.3.6.1.2.1.25.3.3.1.2", label: "CPU", unit: "%", walk: true, agg: "avg", warn: 75, crit: 90 },
]

export const PRESETS: Record<string, SnmpItem[]> = {
  "Generic device": sys,
  "Switch or router": [...sys, ...ports],
  "Server (HOST-RESOURCES)": [...sys, ...hostResources, ...ports],
  "UPS (standard UPS-MIB)": [
    ...sys,
    { oid: "1.3.6.1.2.1.33.1.2.1.0", label: "Battery status", expect: 2 },
    { oid: "1.3.6.1.2.1.33.1.2.4.0", label: "Charge", unit: "%", low: true, warn: 50, crit: 20 },
    { oid: "1.3.6.1.2.1.33.1.2.3.0", label: "Runtime", unit: "min", low: true, warn: 15, crit: 5 },
    { oid: "1.3.6.1.2.1.33.1.4.4.1.5", label: "Load", unit: "%", walk: true, agg: "max", warn: 75, crit: 90 },
  ],
  "UPS (APC)": [
    ...sys,
    { oid: "1.3.6.1.4.1.318.1.1.1.4.1.1.0", label: "Output status", expect: 2 },
    { oid: "1.3.6.1.4.1.318.1.1.1.2.2.1.0", label: "Charge", unit: "%", low: true, warn: 50, crit: 20 },
    { oid: "1.3.6.1.4.1.318.1.1.1.2.2.3.0", label: "Runtime", unit: "min", scale: 1 / 6000, low: true, warn: 15, crit: 5 },
    { oid: "1.3.6.1.4.1.318.1.1.1.4.2.3.0", label: "Load", unit: "%", warn: 75, crit: 90 },
  ],
  Printer: [
    ...sys,
    { oid: "1.3.6.1.2.1.25.3.5.1.1", label: "Printer status", walk: true, agg: "max" },
    { oid: "1.3.6.1.2.1.43.11.1.1.9", label: "Lowest supply level", walk: true, agg: "min" },
    { oid: "1.3.6.1.2.1.43.10.2.1.4", label: "Pages printed", walk: true, agg: "sum" },
  ],
  "Synology NAS": [
    ...sys,
    { oid: "1.3.6.1.4.1.6574.1.1.0", label: "System status", expect: 1 },
    { oid: "1.3.6.1.4.1.6574.1.3.0", label: "Power status", expect: 1 },
    { oid: "1.3.6.1.4.1.6574.1.2.0", label: "Temperature", unit: "°C", warn: 60, crit: 70 },
    { oid: "1.3.6.1.4.1.6574.2.1.1.6", label: "Hottest disk", unit: "°C", walk: true, agg: "max", warn: 50, crit: 60 },
    { oid: "1.3.6.1.4.1.6574.3.1.1.3", label: "Worst RAID status", walk: true, agg: "max", warn: 2 },
  ],
  MikroTik: [
    ...sys,
    ...hostResources,
    ...ports,
    { oid: "1.3.6.1.4.1.14988.1.1.3.10.0", label: "Temperature", unit: "°C", scale: 0.1, warn: 70, crit: 85 },
  ],
  Custom: [{ oid: "1.3.6.1.2.1.1.5.0", label: "Name" }],
}

// Ready-made tabs of the monitor's dashboard. Each card is an ordinary card, editable once added.
import { chartCard as c, type TabPreset } from "../ui/dashboard"
import type { Card } from "../ui/widgets"
import { ALL, type MetricChart } from "./metric-chart"

/** A "Metrics over time" card over every host. */
const m = (title: string, chart: Partial<MetricChart>): Omit<Card, "id" | "tab"> => ({ type: "metrics", title, groups: [ALL], combine: "each", ...chart })

export const PRESETS: TabPreset[] = [
  {
    name: "Performance", icon: "cpu", hint: "CPU, memory and temperature of each host, and the load of the whole fleet, over the page's period.",
    cards: [
      m("CPU per host", { metrics: ["cpu"] }),
      m("Memory per host", { metrics: ["mem"] }),
      m("Fleet load", { metrics: ["cpu", "mem"], combine: "avg", look: "area" }),
      m("Temperature per host", { metrics: ["temp"] }),
    ],
  },
  {
    name: "Capacity", icon: "server", hint: "Storage used, and the hosts closest to running out of disk or memory.",
    cards: [
      c("Storage used", "gauge", { dataset: "storage", measures: [{ id: "A", fn: "sum", field: "used" }, { id: "B", fn: "sum", field: "total" }] }, { warn: 75, crit: 90 }),
      c("Fullest disk per host", "bar", { dataset: "hosts", group: "name", measures: [{ id: "A", fn: "max", field: "disk" }], sort: "desc", limit: 10 }, { warn: 75, crit: 90 }),
      c("Memory per host", "bar", { dataset: "hosts", group: "name", measures: [{ id: "A", fn: "max", field: "mem" }], sort: "desc", limit: 10 }, { warn: 75, crit: 90 }),
      c("Fullest file systems", "list", { dataset: "storage", columns: ["mount", "host", "pct", "used", "total"], order: "pct", desc: true, limit: 10 }),
    ],
  },
  {
    name: "Availability", icon: "bell", hint: "Probe uptime over 90 days, alerts per day and how long they take to clear, over 30 days.",
    cards: [
      c("Probes by state", "doughnut", { dataset: "probes", group: "state" }, { palette: "status" }),
      c("Time to recover", "number", { dataset: "alerts", range: "30d", where: [{ field: "open", op: "is", value: "false" }], measures: [{ id: "A", fn: "avg", field: "duration" }] }),
      c("Probe uptime, 90 days", "progress", { dataset: "probes", group: "name", measures: [{ id: "A", fn: "avg", field: "uptime_90d" }], sort: "asc", limit: 12 }, { max: 100, warn: 99, crit: 95, lowBad: true }),
      c("Alerts per day", "column", { dataset: "alerts", range: "30d", group: "created", bucket: "day", split: "severity" }, { stack: "stacked", palette: "status" }),
      c("Hosts with the most alerts", "bar", { dataset: "alerts", range: "30d", group: "host", sort: "desc", limit: 10 }),
    ],
  },
  {
    name: "Containers and services", icon: "cube", hint: "Docker containers by state and host, what they use, and failed systemd services.",
    cards: [
      c("Containers by state", "doughnut", { dataset: "containers", group: "state" }, { palette: "status" }),
      c("Containers per host", "bar", { dataset: "containers", group: "host", split: "state" }, { stack: "stacked", palette: "status" }),
      c("Memory per container", "bar", { dataset: "containers", group: "name", measures: [{ id: "A", fn: "sum", field: "mem_used" }], sort: "desc", limit: 10 }),
      c("Failed services", "list", { dataset: "services", where: [{ field: "active", op: "is", value: "failed" }], columns: ["name", "host", "sub", "result"], limit: 20 }),
    ],
  },
  {
    name: "Updates", icon: "updates", hint: "Updates waiting on each host, restarts required, and the systems and agent versions in use.",
    cards: [
      c("Pending updates", "number", { dataset: "hosts", measures: [{ id: "A", fn: "sum", field: "updates" }] }),
      c("Security updates", "number", { dataset: "hosts", measures: [{ id: "A", fn: "sum", field: "security" }] }, { warn: 1 }),
      c("Updates per host", "bar", { dataset: "hosts", where: [{ field: "updates", op: "gt", value: "0" }], group: "name", measures: [{ id: "A", fn: "sum", field: "updates" }, { id: "B", fn: "sum", field: "security" }], sort: "desc" }),
      c("Restart required", "list", { dataset: "hosts", where: [{ field: "reboot_required", op: "is", value: "true" }], columns: ["name", "os", "uptime_s"], limit: 20 }),
      c("Agent versions", "pie", { dataset: "hosts", group: "agent_version" }),
      c("Systems", "pie", { dataset: "hosts", group: "os" }),
    ],
  },
]

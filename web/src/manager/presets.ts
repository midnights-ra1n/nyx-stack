// Ready-made tabs of the manager's dashboard. Each card is an ordinary chart, editable once added.
import { chartCard as c, type TabPreset } from "../ui/dashboard"

export const PRESETS: TabPreset[] = [
  {
    name: "Hardware fleet", icon: "server", hint: "Devices by category, status and place, what they are worth and when they were bought.",
    cards: [
      c("Devices", "number", { dataset: "hardware" }),
      c("Value of the fleet", "number", { dataset: "hardware", measures: [{ id: "A", fn: "sum", field: "price" }] }, { decimals: 0 }),
      c("Devices by category", "doughnut", { dataset: "hardware", group: "category" }, { labels: "share" }),
      c("Devices by status", "pie", { dataset: "hardware", group: "status" }, { palette: "status" }),
      c("Devices by place", "bar", { dataset: "hardware", group: "location", sort: "desc" }),
      c("Purchases per year", "column", { dataset: "hardware", group: "purchased_at", bucket: "year" }),
    ],
  },
  {
    name: "Warranty and lifecycle", icon: "shield", hint: "Warranties ending soon or already over, for devices and their components.",
    cards: [
      c("Warranty ending within 90 days", "number", { dataset: "hardware", where: [{ field: "warranty_until", op: "next", value: "90" }] }, { warn: 1 }),
      c("Warranty over", "number", { dataset: "hardware", where: [{ field: "warranty_until", op: "past" }] }),
      c("Warranty ending soon", "list", { dataset: "hardware", where: [{ field: "warranty_until", op: "next", value: "180" }], columns: ["name", "category", "location", "warranty_until"], order: "warranty_until", limit: 15 }),
      c("Warranty ending per year", "column", { dataset: "hardware", group: "warranty_until", bucket: "year" }),
      c("Components out of warranty", "bar", { dataset: "components", where: [{ field: "warranty_until", op: "past" }], group: "type" }),
    ],
  },
  {
    name: "Virtualization", icon: "cube", hint: "Virtual machines and containers, and the vCPU and memory each host gives them.",
    cards: [
      c("Virtual assets", "number", { dataset: "virtual" }),
      c("vCPU allocated", "number", { dataset: "virtual", measures: [{ id: "A", fn: "sum", field: "vcpu" }] }),
      c("Virtual assets by type", "doughnut", { dataset: "virtual", group: "type" }, { labels: "share" }),
      c("Virtual assets by status", "pie", { dataset: "virtual", group: "status" }, { palette: "status" }),
      c("Memory given per host", "bar", { dataset: "virtual", group: "parent", measures: [{ id: "A", fn: "sum", field: "ram" }], sort: "desc" }),
      c("vCPU given per host", "bar", { dataset: "virtual", group: "parent", measures: [{ id: "A", fn: "sum", field: "vcpu" }], sort: "desc" }),
    ],
  },
  {
    name: "IP addressing", icon: "globe", hint: "How full each subnet is, the state of addresses and where they are used.",
    cards: [
      c("Subnet use", "progress", { dataset: "subnets", group: "name", measures: [{ id: "A", fn: "sum", field: "used" }, { id: "B", fn: "sum", field: "capacity" }], limit: 12 }, { warn: 80, crit: 95 }),
      c("Addresses by state", "doughnut", { dataset: "addresses", group: "state" }, { palette: "status", labels: "share" }),
      c("Addresses in use per place", "bar", { dataset: "subnets", group: "location", measures: [{ id: "A", fn: "sum", field: "used" }], sort: "desc" }),
      c("Subnets per section", "table", { dataset: "subnets", group: "section", measures: [{ id: "A", fn: "count" }, { id: "B", fn: "sum", field: "capacity" }, { id: "C", fn: "sum", field: "used" }] }),
    ],
  },
  {
    name: "Work", icon: "work", hint: "Tasks due or late, interventions and deployments over time.",
    cards: [
      c("Late tasks", "number", { dataset: "tasks", where: [{ field: "due", op: "past" }, { field: "done", op: "is", value: "false" }] }, { warn: 1 }),
      c("Tasks by state", "doughnut", { dataset: "tasks", group: "status" }, { palette: "status" }),
      c("Due within 14 days", "list", { dataset: "tasks", where: [{ field: "due", op: "next", value: "14" }, { field: "done", op: "is", value: "false" }], columns: ["title", "status", "due"], order: "due", limit: 15 }),
      c("Deployments per month", "column", { dataset: "deployments", group: "created", bucket: "month", split: "status" }, { stack: "stacked", palette: "status" }),
      c("Interventions by type", "doughnut", { dataset: "interventions", group: "type" }),
      c("Deployments by state", "pie", { dataset: "deployments", group: "status" }, { palette: "status" }),
    ],
  },
]

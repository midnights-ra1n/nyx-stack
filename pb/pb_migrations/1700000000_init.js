/// <reference path="../pb_data/types.d.ts" />
// Every collection is superuser-only (null API rules): browsers never talk to
// PocketBase, they go through nyx-monitor / nyx-manager which enforce sessions.
migrate((app) => {
  const email = $os.getenv("NYX_PB_EMAIL")
  const password = $os.getenv("NYX_PB_PASSWORD")
  if (email && password) {
    const su = new Record(app.findCollectionByNameOrId("_superusers"))
    su.set("email", email)
    su.set("password", password)
    app.save(su)
  }

  const s = app.settings()
  s.batch.enabled = true
  s.batch.maxRequests = 1000
  s.batch.timeout = 30
  app.save(s)

  const stamp = [
    { name: "created", type: "autodate", onCreate: true },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ]
  const text = (name, required = false) => ({ name, type: "text", required, max: 0 })
  const long = (name) => ({ name, type: "text", max: 2000000 })
  const num = (name) => ({ name, type: "number" })
  const bool = (name) => ({ name, type: "bool" })
  const date = (name) => ({ name, type: "date" })
  const json = (name) => ({ name, type: "json", maxSize: 5000000 })
  const coll = (name, fields, indexes = []) =>
    app.save(new Collection({ type: "base", name, fields: [...fields, ...stamp], indexes }))

  // Shared
  coll("settings", [text("key", true), json("value")], ["CREATE UNIQUE INDEX idx_settings_key ON settings (key)"])
  coll("passkeys", [text("user", true), text("name"), json("data")], ["CREATE INDEX idx_passkeys_user ON passkeys (user)"])
  coll("mcp_tokens", [text("name", true), text("token_hash", true), date("last_used")])
  coll("notif_channels", [text("name", true), long("url"), text("title_tpl"), long("body_tpl"), bool("html")])
  coll("notif_rules", [
    text("name"), text("channel", true), json("events"), num("min_gap_s"),
    text("schedule"), num("hour"), num("day"), date("last_sent"), text("last_error"),
  ])
  coll("notif_events", [text("type", true), text("severity"), text("title"), long("message"), text("host")],
    ["CREATE INDEX idx_notif_events_created ON notif_events (created)"])

  // Monitor
  coll("hosts", [
    text("name", true), text("kind"), text("token", true), text("key", true), text("parent"),
    bool("ct_autoinstall"), num("vmid"), text("hostname"), text("ip"), text("os"), text("kernel"), text("arch"),
    text("agent_version"), date("last_seen"), text("pve_node"),
  ], ["CREATE UNIQUE INDEX idx_hosts_token ON hosts (token)"])
  coll("rollups", [text("host", true), date("t", true), num("n"), num("cpu"), num("mem"), num("disk"), num("temp"), num("rx"), num("tx")],
    ["CREATE INDEX idx_rollups_host_t ON rollups (host, t)", "CREATE INDEX idx_rollups_t ON rollups (t)"])
  coll("alerts", [
    text("key", true), text("severity"), text("message"), text("host"), text("type"),
    date("resolved_at"), bool("open"),
  ], ["CREATE INDEX idx_alerts_open ON alerts (open)"])
  coll("probes", [
    text("name", true), text("type", true), text("target", true), num("interval_s"), bool("enabled"),
    text("dns_server"), num("warn_days"), num("expect_status"), json("snmp"),
  ])
  coll("probe_rollups", [text("probe", true), date("t", true), num("n"), num("up"), num("total"), num("latency_ms"), json("values")],
    ["CREATE INDEX idx_probe_rollups ON probe_rollups (probe, t)", "CREATE INDEX idx_probe_rollups_t ON probe_rollups (t)"])
  coll("power_samples", [text("plug", true), date("t", true), num("n"), num("watts")],
    ["CREATE INDEX idx_power_samples ON power_samples (plug, t)", "CREATE INDEX idx_power_samples_t ON power_samples (t)"])

  // Manager
  coll("hardware", [
    text("name", true), text("category"), text("manufacturer"), text("model"), text("serial"), text("location"),
    date("purchased_at"), date("warranty_until"), text("status"), long("notes"),
  ])
  coll("virtual_assets", [
    text("name", true), text("type"), text("parent"), text("hostname"), text("ip"), num("vcpu"), num("ram_mb"),
    num("disk_gb"), text("status"), text("source"), text("external_id"), text("pve_node"), num("vmid"), long("notes"),
  ])
  coll("subnets", [text("name", true), text("cidr", true), text("gateway"), num("vlan"), text("description")])
  coll("ip_addresses", [text("address", true), text("hostname"), text("mac"), text("device"), text("note")])
  coll("routes", [text("device", true), text("destination", true), text("next_hop"), num("metric")])
  coll("deployments", [
    text("name", true), text("target"), text("version"), text("status"), date("scheduled_at"), date("done_at"),
    text("owner"), long("notes"), text("command"), date("reminded_at"),
  ])
  coll("map_nodes", [text("name", true), text("type"), text("ip"), num("x"), num("y")])
  coll("map_links", [text("source", true), text("target", true), text("label")])
  coll("sites", [
    text("name", true), text("host", true), text("repo", true), text("branch"), text("path"), text("run_user"),
    text("install_cmd"), text("build_cmd"), text("start_cmd"), long("ssh_private_key"), text("ssh_public_key"),
    text("webhook_secret"), text("last_status"), long("last_output"), text("last_command"), date("last_deploy"),
  ])
  coll("tasks", [
    text("title", true), long("description"), date("due"), bool("done"), text("uid"), text("etag"), text("href"),
    text("kind"), date("reminded_at"),
  ], ["CREATE INDEX idx_tasks_uid ON tasks (uid)"])
}, (app) => {
  for (const name of ["settings", "passkeys", "mcp_tokens", "notif_channels", "notif_rules", "notif_events", "hosts",
    "rollups", "alerts", "probes", "probe_rollups", "power_samples", "hardware", "virtual_assets", "subnets",
    "ip_addresses", "routes", "deployments", "map_nodes", "map_links", "sites", "tasks"]) {
    app.delete(app.findCollectionByNameOrId(name))
  }
})

/// <reference path="../pb_data/types.d.ts" />
// What a host alerts on, and hosts and probes kept out of alerts or out of what the MCP
// server answers. Kept out of alerts, a probe still runs; paused, it does not.
migrate((app) => {
  const hosts = app.findCollectionByNameOrId("hosts")
  hosts.fields.add(new BoolField({ name: "mcp_hidden" }))
  hosts.fields.add(new JSONField({ name: "alerting" }))
  app.save(hosts)

  const probes = app.findCollectionByNameOrId("probes")
  probes.fields.add(new BoolField({ name: "muted" }))
  probes.fields.add(new BoolField({ name: "mcp_hidden" }))
  app.save(probes)
}, (app) => {
  const drop = (name, fields) => {
    const c = app.findCollectionByNameOrId(name)
    fields.forEach((f) => c.fields.removeByName(f))
    app.save(c)
  }
  drop("hosts", ["mcp_hidden", "alerting"])
  drop("probes", ["muted", "mcp_hidden"])
})

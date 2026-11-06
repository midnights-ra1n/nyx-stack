/// <reference path="../pb_data/types.d.ts" />
// VPN links, states and tags on tasks and deployments, and the existing service a site runs under.
migrate((app) => {
  app.save(new Collection({
    type: "base",
    name: "vpn_links",
    fields: [
      ...["name", "kind", "side_a", "side_b", "subnet", "endpoint", "status"].map((name) => ({ name, type: "text", required: name === "name" })),
      { name: "notes", type: "text", max: 2000000 },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  }))
  const add = (name, fields) => {
    const c = app.findCollectionByNameOrId(name)
    fields.forEach((f) => c.fields.add(new TextField({ name: f })))
    app.save(c)
  }
  add("tasks", ["status", "tags"])
  add("deployments", ["tags"])
  add("sites", ["service"])
}, (app) => {
  app.delete(app.findCollectionByNameOrId("vpn_links"))
  const drop = (name, fields) => {
    const c = app.findCollectionByNameOrId(name)
    fields.forEach((f) => c.fields.removeByName(f))
    app.save(c)
  }
  drop("tasks", ["status", "tags"])
  drop("deployments", ["tags"])
  drop("sites", ["service"])
})

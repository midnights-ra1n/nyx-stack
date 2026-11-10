/// <reference path="../pb_data/types.d.ts" />
// Specifications of hardware, shown in the form according to its category.
const TEXT = ["cpu", "ram", "storage", "ports", "wifi", "power", "firmware", "mgmt_ip"]
migrate((app) => {
  const c = app.findCollectionByNameOrId("hardware")
  TEXT.forEach((name) => c.fields.add(new TextField({ name })))
  c.fields.add(new DateField({ name: "battery_at" }))
  app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId("hardware")
  ;[...TEXT, "battery_at"].forEach((name) => c.fields.removeByName(name))
  app.save(c)
})

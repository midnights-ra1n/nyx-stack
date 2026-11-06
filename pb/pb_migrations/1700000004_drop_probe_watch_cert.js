/// <reference path="../pb_data/types.d.ts" />
// Every website probe on an https:// address now follows its certificate.
migrate((app) => {
  const probes = app.findCollectionByNameOrId("probes")
  probes.fields.removeByName("watch_cert")
  app.save(probes)
}, (app) => {
  const probes = app.findCollectionByNameOrId("probes")
  probes.fields.add(new BoolField({ name: "watch_cert" }))
  app.save(probes)
})

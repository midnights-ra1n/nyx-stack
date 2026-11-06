/// <reference path="../pb_data/types.d.ts" />
// A website probe can also watch the certificate of its HTTPS address.
migrate((app) => {
  const probes = app.findCollectionByNameOrId("probes")
  probes.fields.add(new BoolField({ name: "watch_cert" }))
  app.save(probes)
}, (app) => {
  const probes = app.findCollectionByNameOrId("probes")
  probes.fields.removeByName("watch_cert")
  app.save(probes)
})

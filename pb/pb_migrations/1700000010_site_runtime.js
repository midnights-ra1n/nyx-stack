/// <reference path="../pb_data/types.d.ts" />
// Node.js sites: environment variables of the service, and an HTTP health check with its last result.
migrate((app) => {
  const c = app.findCollectionByNameOrId("sites")
  c.fields.add(new TextField({ name: "env", max: 20000 }))
  c.fields.add(new TextField({ name: "health_url" }))
  c.fields.add(new TextField({ name: "health" }))
  c.fields.add(new DateField({ name: "health_at" }))
  app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId("sites")
  for (const n of ["env", "health_url", "health", "health_at"]) c.fields.removeByName(n)
  app.save(c)
})

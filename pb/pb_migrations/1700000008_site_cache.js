/// <reference path="../pb_data/types.d.ts" />
// HTTP cache lifetime a site's answers get, in seconds. Text so that empty (the app's own) differs from 0.
migrate((app) => {
  const c = app.findCollectionByNameOrId("sites")
  c.fields.add(new TextField({ name: "cache_max_age", pattern: "^[0-9]{0,8}$" }))
  app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId("sites")
  c.fields.removeByName("cache_max_age")
  app.save(c)
})

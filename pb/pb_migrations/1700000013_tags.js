/// <reference path="../pb_data/types.d.ts" />
// Tags on monitored hosts and on inventory records: comma-separated, as on tasks and
// deployments, to group, filter and chart by them.
const TAGGED = ["hosts", "hardware", "virtual_assets"]
migrate((app) => {
  for (const name of TAGGED) {
    const c = app.findCollectionByNameOrId(name)
    c.fields.add(new TextField({ name: "tags" }))
    app.save(c)
  }
}, (app) => {
  for (const name of TAGGED) {
    const c = app.findCollectionByNameOrId(name)
    c.fields.removeByName("tags")
    app.save(c)
  }
})

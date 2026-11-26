/// <reference path="../pb_data/types.d.ts" />
// Categories to sort the probes of the Network page into, in the order they are listed.
migrate((app) => {
  app.save(new Collection({
    type: "base",
    name: "probe_categories",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "position", type: "number" },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  }))
  const probes = app.findCollectionByNameOrId("probes")
  // The id of its category; empty for probes in none.
  probes.fields.add(new TextField({ name: "category" }))
  app.save(probes)
}, (app) => {
  const probes = app.findCollectionByNameOrId("probes")
  probes.fields.removeByName("category")
  app.save(probes)
  app.delete(app.findCollectionByNameOrId("probe_categories"))
})

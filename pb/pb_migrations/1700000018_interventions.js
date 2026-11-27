/// <reference path="../pb_data/types.d.ts" />
// Interventions: work on a device of the inventory (a repair, a part replaced, a check),
// planned, then reported once done, as GLPI keeps them.
migrate((app) => {
  app.save(new Collection({
    type: "base",
    name: "interventions",
    fields: [
      { name: "title", type: "text", required: true },
      // Maintenance, Repair, Upgrade, Installation or Check.
      { name: "type", type: "text" },
      // The name of a hardware or virtual record, as `parent` on virtual assets.
      { name: "asset", type: "text" },
      // todo, doing, done or cancelled, as tasks.
      { name: "status", type: "text" },
      { name: "scheduled_at", type: "date" },
      { name: "done_at", type: "date" },
      { name: "owner", type: "text" },
      { name: "tags", type: "text" },
      { name: "notes", type: "text", max: 2000000 },
      { name: "reminded_at", type: "date" },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  }))
}, (app) => {
  app.delete(app.findCollectionByNameOrId("interventions"))
})

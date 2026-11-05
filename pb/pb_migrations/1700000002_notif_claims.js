/// <reference path="../pb_data/types.d.ts" />
// On a shared database both servers run the notification loop. Creating a row here
// is what decides which of them sends a digest, so the unique index is the point.
migrate((app) => {
  app.save(new Collection({
    type: "base",
    name: "notif_claims",
    fields: [
      { name: "key", type: "text", required: true },
      { name: "created", type: "autodate", onCreate: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_notif_claims_key ON notif_claims (key)"],
  }))
}, (app) => {
  app.delete(app.findCollectionByNameOrId("notif_claims"))
})

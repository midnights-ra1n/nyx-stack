/// <reference path="../pb_data/types.d.ts" />
// Status pages and wall displays. Like every collection, superuser-only: anonymous
// visitors get a filtered copy from nyx-monitor, never this record.
migrate((app) => {
  app.save(new Collection({
    type: "base",
    name: "pages",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "slug", type: "text", required: true, pattern: "^[a-z0-9-]{1,64}$" },
      { name: "kind", type: "select", required: true, maxSelect: 1, values: ["status", "wall"] },
      { name: "published", type: "bool" },
      { name: "access_key", type: "text" },
      { name: "config", type: "json", maxSize: 2000000 },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_pages_slug ON pages (slug)"],
  }))
}, (app) => {
  app.delete(app.findCollectionByNameOrId("pages"))
})

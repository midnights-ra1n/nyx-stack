/// <reference path="../pb_data/types.d.ts" />
// The parts inside the hardware (disks, CPUs, memory…) with where they are and whether they
// are still used, and addresses shared on purpose (VRRP, CARP, anycast), which are no conflict.
migrate((app) => {
  app.save(new Collection({
    type: "base",
    name: "components",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "type", type: "text" },
      { name: "manufacturer", type: "text" },
      { name: "model", type: "text" },
      { name: "serial", type: "text" },
      { name: "capacity", type: "text" },
      // The id of the hardware it is fitted in; empty when it sits on a shelf.
      { name: "device", type: "text" },
      { name: "slot", type: "text" },
      // In service, Spare or Decommissioned.
      { name: "status", type: "text" },
      { name: "purchased_at", type: "date" },
      { name: "warranty_until", type: "date" },
      { name: "decommissioned_at", type: "date" },
      { name: "tags", type: "text" },
      { name: "notes", type: "text" },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  }))
  const ips = app.findCollectionByNameOrId("ip_addresses")
  ips.fields.add(new BoolField({ name: "shared" }))
  app.save(ips)
}, (app) => {
  const ips = app.findCollectionByNameOrId("ip_addresses")
  ips.fields.removeByName("shared")
  app.save(ips)
  app.delete(app.findCollectionByNameOrId("components"))
})

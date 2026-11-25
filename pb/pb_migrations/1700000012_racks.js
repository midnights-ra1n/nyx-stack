/// <reference path="../pb_data/types.d.ts" />
// Racks and where each device sits in one, and the kind of a hand-drawn map link
// (Ethernet, fibre, Wi-Fi, VLAN, VPN, virtual) so the map draws each its own way.
migrate((app) => {
  app.save(new Collection({
    type: "base",
    name: "racks",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "location", type: "text" },
      { name: "units", type: "number" },
      { name: "notes", type: "text", max: 2000000 },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  }))
  const hw = app.findCollectionByNameOrId("hardware")
  // The rack's id, the lowest unit the device fills (1 at the bottom) and its height in units.
  hw.fields.add(new TextField({ name: "rack" }))
  hw.fields.add(new NumberField({ name: "rack_u" }))
  hw.fields.add(new NumberField({ name: "rack_units" }))
  app.save(hw)
  const links = app.findCollectionByNameOrId("map_links")
  links.fields.add(new TextField({ name: "kind" }))
  app.save(links)
}, (app) => {
  app.delete(app.findCollectionByNameOrId("racks"))
  const hw = app.findCollectionByNameOrId("hardware")
  ;["rack", "rack_u", "rack_units"].forEach((name) => hw.fields.removeByName(name))
  app.save(hw)
  const links = app.findCollectionByNameOrId("map_links")
  links.fields.removeByName("kind")
  app.save(links)
})

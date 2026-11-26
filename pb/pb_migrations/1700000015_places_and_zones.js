/// <reference path="../pb_data/types.d.ts" />
// Furniture besides 19" racks (shelving units, desks, boxes), devices side by side on a
// rack unit or a shelf, and zones drawn behind the devices of the network map.
migrate((app) => {
  const racks = app.findCollectionByNameOrId("racks")
  // rack: `units` are rack units; shelf: `units` are levels; desk: one top to set devices on.
  racks.fields.add(new TextField({ name: "kind" }))
  racks.fields.add(new TextField({ name: "color" }))
  racks.fields.add(new NumberField({ name: "width_cm" }))
  app.save(racks)
  const hw = app.findCollectionByNameOrId("hardware")
  // The first of the 12 columns across a rack or a shelf the device takes, and how many (0: all).
  hw.fields.add(new NumberField({ name: "rack_x" }))
  hw.fields.add(new NumberField({ name: "rack_w" }))
  app.save(hw)
  app.save(new Collection({
    type: "base",
    name: "map_zones",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "color", type: "text" },
      { name: "x", type: "number" },
      { name: "y", type: "number" },
      { name: "w", type: "number" },
      { name: "h", type: "number" },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  }))
}, (app) => {
  app.delete(app.findCollectionByNameOrId("map_zones"))
  const racks = app.findCollectionByNameOrId("racks")
  ;["kind", "color", "width_cm"].forEach((name) => racks.fields.removeByName(name))
  app.save(racks)
  const hw = app.findCollectionByNameOrId("hardware")
  ;["rack_x", "rack_w"].forEach((name) => hw.fields.removeByName(name))
  app.save(hw)
})

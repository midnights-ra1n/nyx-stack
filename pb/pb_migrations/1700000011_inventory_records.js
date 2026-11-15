/// <reference path="../pb_data/types.d.ts" />
// GLPI-style records: purchase details of hardware, structured network ports
// cabled to each other, and the history of changes made from the web interface.
const PURCHASE = ["supplier", "order_number", "invoice_number"]
migrate((app) => {
  const hw = app.findCollectionByNameOrId("hardware")
  PURCHASE.forEach((name) => hw.fields.add(new TextField({ name })))
  hw.fields.add(new NumberField({ name: "price" }))
  hw.fields.add(new DateField({ name: "in_service_at" }))
  app.save(hw)
  const stamp = [
    { name: "created", type: "autodate", onCreate: true },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ]
  app.save(new Collection({
    type: "base",
    name: "ports",
    fields: [
      // The hardware record holding the port, and the port at the other end of its cable, on one side only.
      ...["device", "name", "mac", "vlan", "speed", "peer", "note"].map((name) => ({ name, type: "text", required: name === "device" || name === "name" })),
      ...stamp,
    ],
    indexes: ["CREATE INDEX idx_ports_device ON ports (device)"],
  }))
  app.save(new Collection({
    type: "base",
    name: "history",
    fields: [
      ...["coll", "record", "name", "action"].map((name) => ({ name, type: "text" })),
      { name: "changes", type: "json", maxSize: 200000 },
      { name: "created", type: "autodate", onCreate: true },
    ],
    indexes: ["CREATE INDEX idx_history_record ON history (coll, record)"],
  }))
}, (app) => {
  for (const name of ["ports", "history"]) app.delete(app.findCollectionByNameOrId(name))
  const hw = app.findCollectionByNameOrId("hardware")
  ;[...PURCHASE, "price", "in_service_at"].forEach((name) => hw.fields.removeByName(name))
  app.save(hw)
})

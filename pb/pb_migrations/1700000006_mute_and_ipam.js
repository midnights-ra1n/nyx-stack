/// <reference path="../pb_data/types.d.ts" />
// Hosts kept out of alerts, and the IPAM objects of a full address plan: sections, VRFs,
// VLANs, address states and the last time a scan saw an address.
migrate((app) => {
  const hosts = app.findCollectionByNameOrId("hosts")
  hosts.fields.add(new BoolField({ name: "muted" }))
  app.save(hosts)

  const subnets = app.findCollectionByNameOrId("subnets")
  ;["section", "vrf", "location"].forEach((name) => subnets.fields.add(new TextField({ name })))
  subnets.fields.add(new NumberField({ name: "threshold" }))
  app.save(subnets)

  const addresses = app.findCollectionByNameOrId("ip_addresses")
  ;["state", "owner"].forEach((name) => addresses.fields.add(new TextField({ name })))
  addresses.fields.add(new DateField({ name: "last_seen" }))
  app.save(addresses)

  const coll = (name, fields) => app.save(new Collection({
    type: "base",
    name,
    fields: [
      ...fields,
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  }))
  coll("vlans", [
    { name: "number", type: "number", required: true },
    ...["name", "domain", "description"].map((name) => ({ name, type: "text", required: name === "name" })),
  ])
  coll("vrfs", ["name", "rd", "description"].map((name) => ({ name, type: "text", required: name === "name" })))
}, (app) => {
  ;["vlans", "vrfs"].forEach((n) => app.delete(app.findCollectionByNameOrId(n)))
  const drop = (name, fields) => {
    const c = app.findCollectionByNameOrId(name)
    fields.forEach((f) => c.fields.removeByName(f))
    app.save(c)
  }
  drop("hosts", ["muted"])
  drop("subnets", ["section", "vrf", "location", "threshold"])
  drop("ip_addresses", ["state", "owner", "last_seen"])
})

/// <reference path="../pb_data/types.d.ts" />
// The Proxmox guest a VM with its own agent runs as, so that renaming it in Nyx does not
// list it twice. Then what a notification rule filters and holds back, and for a
// channel the language of its messages and the layout of the visual editor.
migrate((app) => {
  const hosts = app.findCollectionByNameOrId("hosts")
  hosts.fields.add(new NumberField({ name: "guest_vmid" }))
  app.save(hosts)

  const rules = app.findCollectionByNameOrId("notif_rules")
  rules.fields.add(new JSONField({ name: "severities" }))
  rules.fields.add(new TextField({ name: "hosts" }))
  ;["quiet_from", "quiet_to", "delay_s"].forEach((name) => rules.fields.add(new NumberField({ name })))
  ;["quiet_crit", "skip_resolved"].forEach((name) => rules.fields.add(new BoolField({ name })))
  app.save(rules)

  const channels = app.findCollectionByNameOrId("notif_channels")
  channels.fields.add(new TextField({ name: "lang" }))
  channels.fields.add(new JSONField({ name: "design" }))
  app.save(channels)
}, (app) => {
  const drop = (name, fields) => {
    const c = app.findCollectionByNameOrId(name)
    fields.forEach((f) => c.fields.removeByName(f))
    app.save(c)
  }
  drop("hosts", ["guest_vmid"])
  drop("notif_rules", ["severities", "hosts", "quiet_from", "quiet_to", "delay_s", "quiet_crit", "skip_resolved"])
  drop("notif_channels", ["lang", "design"])
})

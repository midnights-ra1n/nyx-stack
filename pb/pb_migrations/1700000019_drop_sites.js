/// <reference path="../pb_data/types.d.ts" />
// Node.js sites are gone from Nyx. The sites keep running on their hosts; each one leaves a
// deployment that says where it is and how it runs. Deploy keys, webhook secrets and the
// values of environment variables go with the collection.
migrate((app) => {
  let sites
  try { sites = app.findCollectionByNameOrId("sites") } catch { return }
  const deployments = app.findCollectionByNameOrId("deployments")
  for (const s of app.findAllRecords(sites)) {
    const name = s.getString("name")
    const service = s.getString("service") || `nyx-site-${name}.service`
    const envNames = s.getString("env").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split("=")[0])
    const lines = [
      "Node.js site deployed by Nyx 1.0. It keeps running on its host: manage it from the monitor's Services page.",
      `Service: ${service}`,
      `Repository: ${s.getString("repo")} (${s.getString("branch") || "main"})`,
      `Folder: ${s.getString("path")}`,
      `Runs as: ${s.getString("run_user") || "-"}`,
      `Install: ${s.getString("install_cmd") || "-"}`,
      `Build: ${s.getString("build_cmd") || "-"}`,
      `Start: ${s.getString("start_cmd") || "-"}`,
      `Environment file: /etc/nyx/env/${name}.env${envNames.length ? ` (${envNames.join(", ")})` : ""}`,
    ]
    const d = new Record(deployments)
    d.set("name", name)
    d.set("target", s.getString("host"))
    d.set("status", s.getString("last_status") === "failed" ? "failed" : "ok")
    d.set("done_at", s.getString("last_deploy"))
    d.set("tags", "nodejs")
    d.set("notes", lines.join("\n"))
    app.save(d)
  }
  app.delete(sites)
}, (app) => {
  const text = (name, required = false) => ({ name, type: "text", required, max: 0 })
  const long = (name) => ({ name, type: "text", max: 2000000 })
  const sites = new Collection({
    type: "base",
    name: "sites",
    fields: [
      text("name", true), text("host", true), text("repo", true), text("branch"), text("path"), text("run_user"),
      text("install_cmd"), text("build_cmd"), text("start_cmd"), long("ssh_private_key"), text("ssh_public_key"),
      text("webhook_secret"), text("last_status"), long("last_output"), text("last_command"), { name: "last_deploy", type: "date" },
      text("service"), { name: "cache_max_age", type: "text", pattern: "^[0-9]{0,8}$" }, { name: "env", type: "text", max: 20000 },
      text("health_url"), text("health"), { name: "health_at", type: "date" },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  })
  app.save(sites)
})

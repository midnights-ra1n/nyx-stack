/// <reference path="../pb_data/types.d.ts" />
// CI/CD pipelines followed on a Git forge: the latest run of one branch of one repository.
migrate((app) => {
  app.save(new Collection({
    type: "base",
    name: "pipelines",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "provider", type: "select", required: true, maxSelect: 1, values: ["github", "gitlab", "forgejo", "gitea"] },
      { name: "url", type: "text" },
      { name: "repo", type: "text", required: true },
      { name: "branch", type: "text" },
      { name: "token", type: "text" },
      { name: "enabled", type: "bool" },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  }))
}, (app) => {
  app.delete(app.findCollectionByNameOrId("pipelines"))
})

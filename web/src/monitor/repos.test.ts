import { describe, expect, it } from "vitest"
import { currentMirror, setMirror } from "./repos"

const list = { path: "/etc/apt/sources.list", content: [
  "deb http://deb.debian.org/debian bookworm main contrib",
  "# deb http://deb.debian.org/debian bookworm-backports main",
  "deb [arch=amd64] http://security.debian.org/debian-security bookworm-security main",
  "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable",
  "deb http://download.proxmox.com/debian/pve bookworm pve-no-subscription",
].join("\n") }
const sources = { path: "/etc/apt/sources.list.d/debian.sources", content: "Types: deb\nURIs: http://deb.debian.org/debian/\nSuites: trixie trixie-updates\nComponents: main non-free-firmware\n\nTypes: deb\nURIs: http://security.debian.org/debian-security\nSuites: trixie-security\nComponents: main\n" }

describe("Debian mirror", () => {
  it("finds the mirror in use", () => {
    expect(currentMirror([{ path: "/etc/apt/sources.list", content: "" }, sources])).toEqual({ mirror: "deb.debian.org/debian", scheme: "http" })
  })

  it("moves Debian sources only, security keeps its server", () => {
    const [l] = setMirror([list], "https://ftp.fr.debian.org/debian/", "https")
    expect(l.content.split("\n")).toEqual([
      "deb https://ftp.fr.debian.org/debian bookworm main contrib",
      "# deb http://deb.debian.org/debian bookworm-backports main",
      "deb [arch=amd64] https://security.debian.org/debian-security bookworm-security main",
      "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable",
      "deb http://download.proxmox.com/debian/pve bookworm pve-no-subscription",
    ])
  })

  it("rewrites deb822 stanzas and skips files that do not change", () => {
    const changed = setMirror([sources, { path: "/etc/apt/sources.list.d/x.list", content: "deb https://packages.sury.org/php/ bookworm main" }], "mirror.lan/debian", "https")
    expect(changed).toHaveLength(1)
    expect(changed[0].content).toBe(sources.content.replace("http://deb.debian.org/debian/", "https://mirror.lan/debian").replace("http://security", "https://security"))
    expect(setMirror(changed, "mirror.lan/debian", "https")).toEqual([])
  })
})

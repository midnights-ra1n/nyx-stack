import { describe, expect, it } from "vitest"
import { distroName, distroOf, osName } from "./brand-icons"

describe("distroOf", () => {
  it("reads what agents send and what Proxmox gives", () => {
    expect(distroOf("Linux (Debian GNU/Linux 13)")).toBe("debian")
    expect(distroOf("Linux (Ubuntu 24.04.1 LTS)")).toBe("ubuntu")
    expect(distroOf("Linux (AlmaLinux 10.1)")).toBe("almalinux")
    expect(distroOf("Linux (Red Hat Enterprise Linux 9.4 (Plow))")).toBe("redhat")
    expect(distroOf("archlinux")).toBe("archlinux")
    expect(distroOf("alpine")).toBe("alpinelinux")
    expect(distroName("debian")).toBe("Debian")
  })
  it("puts derivatives before the distribution they build on", () => {
    expect(distroOf("Linux (Linux Mint 22)")).toBe("linuxmint")
    expect(distroOf("Linux (Pop!_OS 22.04 LTS)")).toBe("popos")
    expect(distroOf("Linux (Kali GNU/Linux Rolling)")).toBe("kalilinux")
    expect(distroOf("Linux (Manjaro Linux)")).toBe("manjaro")
  })
  it("falls back to Tux for other Linux, and to nothing otherwise", () => {
    expect(distroOf("Linux (Oracle Linux Server 9.4)")).toBe("linux")
    expect(distroOf("l26")).toBe("linux")
    expect(distroOf("win11")).toBe("")
    expect(distroOf("")).toBe("")
    expect(distroOf("Linux (aarch64 box)")).toBe("linux")
  })
  it("drops the Linux wrapper", () => expect(osName("Linux (Debian GNU/Linux 13)")).toBe("Debian GNU/Linux 13"))
})

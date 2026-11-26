import { beforeAll, describe, expect, it, vi } from "vitest"

let tn: (text: string) => string
beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => "fr", setItem: () => {} })
  tn = (await import("./i18n")).tn
})

describe("text built by the server, in French", () => {
  it("finds the key a text was built from and translates its nested parts", () => {
    expect(tn("nas-01: /dev/sdb 8 bad sectors")).toBe("nas-01 : /dev/sdb 8 secteurs défectueux")
    expect(tn("Resolved: web: container nginx keeps restarting")).toBe("Résolu : web : le conteneur nginx redémarre en boucle")
    expect(tn("nas: /srv/data at 87%")).toBe("nas : /srv/data à 87 %")
    expect(tn("SMART /dev/sdb: 8 bad sectors")).toBe("SMART /dev/sdb : 8 secteurs défectueux")
  })
  it("keeps names, and text no key fits, as they are", () => {
    expect(tn("Blue is not responding")).toBe("Blue ne répond plus")
    expect(tn("connection refused")).toBe("connection refused")
  })
})

describe("Docker states, in French", () => {
  it("translates the state and the duration in it", () => {
    expect(tn("Up 4 days")).toBe("Actif depuis 4 jours")
    expect(tn("Up About an hour (healthy)")).toBe("Actif depuis environ une heure (sain)")
    expect(tn("Exited (137) 5 minutes ago")).toBe("Arrêté (137) il y a 5 minutes")
  })
})

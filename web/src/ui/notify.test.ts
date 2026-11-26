import { describe, expect, it } from "vitest"
import { DEFAULT_DESIGN, fresh, parseUrl, SERVICES } from "./notify"

const service = (id: string) => SERVICES.find((s) => s.id === id)!

describe("service forms", () => {
  it("keeps every character of a Matrix password and reads it back", () => {
    const pass = "p@ss:w/rd?#&%=é ok"
    const url = service("matrix").build({ host: "matrix.example.com:8448", user: "nyx", pass, rooms: "!abc:example.com,#ops:example.com", e2ee: "1" })
    expect(url).toBe("matrix://nyx:p%40ss%3Aw%2Frd%3F%23%26%25%3D%C3%A9%20ok@matrix.example.com:8448/?rooms=!abc%3Aexample.com%2C%23ops%3Aexample.com&e2ee=yes")
    const back = service("matrix").parse(parseUrl(url)!)!
    expect(back).toMatchObject({ host: "matrix.example.com:8448", user: "nyx", pass, rooms: "!abc:example.com,#ops:example.com", e2ee: "1", token: "" })
  })

  it("signs in to Matrix with an access token instead of a user", () => {
    const url = service("matrix").build({ host: "m.org", token: "1", user: "ignored", pass: "syt_abc", rooms: "!r:m.org" })
    expect(url).toBe("matrix://:syt_abc@m.org/?rooms=!r%3Am.org")
    expect(service("matrix").parse(parseUrl(url)!)).toMatchObject({ token: "1", pass: "syt_abc" })
  })

  it("turns a Discord webhook and a Telegram token into Shoutrrr URLs", () => {
    expect(service("discord").build({ hook: "https://discord.com/api/webhooks/123/abc-DEF_9" })).toBe("discord://abc-DEF_9@123")
    expect(service("discord").parse(parseUrl("discord://abc@123")!)).toEqual({ hook: "https://discord.com/api/webhooks/123/abc" })
    const tg = service("telegram").build({ token: "123456:ABC-def", chats: "@ops" })
    expect(tg).toBe("telegram://123456:ABC-def@telegram?chats=%40ops")
    expect(service("telegram").parse(parseUrl(tg)!)).toEqual({ token: "123456:ABC-def", chats: "@ops" })
  })

  it("reads back an email account", () => {
    const url = service("smtp").build({ host: "mail.example.com", port: "587", user: "me", pass: "a&b", from: "nyx@example.com", to: "a@x.fr, b@x.fr" })
    expect(service("smtp").parse(parseUrl(url)!)).toMatchObject({ host: "mail.example.com", port: "587", pass: "a&b", to: "a@x.fr,b@x.fr" })
  })
})

describe("visual message layout", () => {
  it("starts layouts saved before cards from the default parts", () => {
    expect(fresh({ ...DEFAULT_DESIGN, parts: [["icon", true], ["title", true]] }).parts).toEqual(DEFAULT_DESIGN.parts)
    const mine = { ...DEFAULT_DESIGN, parts: [["when", true], ["type", false]] as [string, boolean][] }
    expect(fresh(mine)).toBe(mine)
  })
})

import { describe, expect, it } from "vitest"
import { importKey, isPublic, open, pack, seal, unpack, type ResHead } from "./envelope"

const K = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
const bytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)))
const text = (s: string) => new TextEncoder().encode(s)

describe("relay envelope", () => {
  it("opens what the Rust side seals", async () => {
    // From nyx_proto::relay::Key::seal(b"aad", pack(ResHead { s: 200, h: [(x, y)] }, b"body")).
    const rust = bytes("1356309ba4a0faae5e4f2e0765924c6820273cccf79994c00ca221af08f4b21bd42fe65f8be999f43eafba4c3ebd04c750e7f764888e5241dab28dd11b")
    const out = unpack<ResHead>(await open(await importKey(K), text("aad"), rust))!
    expect(out.head).toEqual({ s: 200, h: [["x", "y"]] })
    expect(new TextDecoder().decode(out.body)).toBe("body")
  })

  it("round-trips and refuses another associated data", async () => {
    const k = await importKey(K)
    const s = await seal(k, text("a"), pack({ s: 204, h: [] }, text("")))
    expect(unpack<ResHead>(await open(k, text("a"), s))!.head.s).toBe(204)
    await expect(open(k, text("b"), s)).rejects.toThrow()
    expect(unpack(new Uint8Array([0, 0, 1, 0, 123]))).toBeUndefined()
    expect(() => importKey("abc")).toThrow()
  })

  it("lists only public files", () => {
    expect(isPublic("/install.sh") && isPublic("/agent/v1/binary/nyx-agent-linux-x86_64") && isPublic("/api/public/pages/home")).toBe(true)
    expect(isPublic("/agent/v1/report") || isPublic("/api/hosts") || isPublic("/agent/v1/binary/a/b")).toBe(false)
  })
})

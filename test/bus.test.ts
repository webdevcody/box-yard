import { describe, expect, it } from "vitest"
import { parseCursor, parseJsonl } from "../server/bus.js"

describe("parseJsonl", () => {
  it("keeps a partial last line for next time", () => {
    const a = JSON.stringify({ seq: 1, t: "a", ts: 1, turnId: null })
    const b = JSON.stringify({ seq: 2, t: "b", ts: 2, turnId: null })
    const chunk = `${a}\n${b.slice(0, 10)}`
    const { events, consumed } = parseJsonl(chunk)
    expect(events.map((e) => e.seq)).toEqual([1])
    expect(consumed).toBe(Buffer.byteLength(a + "\n"))
  })

  it("counts bytes, not characters, for multibyte text", () => {
    const line = JSON.stringify({ seq: 1, t: "assistant", text: "héllo 📦", ts: 1, turnId: null }) + "\n"
    expect(parseJsonl(line).consumed).toBe(Buffer.byteLength(line))
  })

  it("skips torn or foreign lines instead of stalling", () => {
    const good = JSON.stringify({ seq: 3, t: "x", ts: 1, turnId: null })
    const { events } = parseJsonl(`{"seq":1,"t":\nnot json\n{"foo":1}\n${good}\n`)
    expect(events.map((e) => e.seq)).toEqual([3])
  })
})

describe("cursor", () => {
  it("parses old or broken values safely", () => {
    expect(parseCursor(null)).toEqual({ seq: 0, offset: 0, rid: null })
    expect(parseCursor("garbage")).toEqual({ seq: 0, offset: 0, rid: null })
    expect(parseCursor(JSON.stringify({ seq: 4, offset: 10 }))).toEqual({ seq: 4, offset: 10, rid: null })
  })
})

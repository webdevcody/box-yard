import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { EventReader, emptyCursor, parseCursor, parseJsonl, type Cursor } from "../server/bus.js"
import { LocalProvider } from "../server/providers/local.js"
import { tmpDir } from "./helpers.js"

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
    expect(parseCursor(null)).toEqual({ seq: 0, offset: 0, rid: null, ino: null })
    expect(parseCursor("garbage")).toEqual({ seq: 0, offset: 0, rid: null, ino: null })
    expect(parseCursor(JSON.stringify({ seq: 4, offset: 10 }))).toEqual({ seq: 4, offset: 10, rid: null, ino: null })
  })
})

// events.jsonl changing under a running turn's reader: it starts over from the top, and seq numbers keep the
// events already applied from coming back.
describe("EventReader.readFile", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const setup = async () => {
    const root = tmpDir("box-yard-bus-")
    dirs.push(root)
    const provider = new LocalProvider(root)
    const boxId = await provider.create()
    const taskDir = path.join(provider.root(boxId), "tasks", "task_1")
    fs.mkdirSync(taskDir)
    const file = path.join(taskDir, "events.jsonl")
    const line = (seq: number) => JSON.stringify({ seq, ts: seq, turnId: "turn_1", t: "assistant", text: `event ${seq}` }) + "\n"
    const reader = new EventReader(provider, null)
    let cursor: Cursor = emptyCursor()
    const read = async () => {
      const out = await reader.readFile(boxId, taskDir, cursor)
      cursor = out.cursor
      return out.events.map((e) => e.seq)
    }
    return { file, line, read, cursor: () => cursor }
  }

  it("reads nothing before the file exists, then each new line once", async () => {
    const { file, line, read, cursor } = await setup()
    expect(await read()).toEqual([])
    expect(cursor()).toEqual(emptyCursor())
    fs.writeFileSync(file, line(1) + line(2))
    expect(await read()).toEqual([1, 2])
    fs.appendFileSync(file, line(3))
    expect(await read()).toEqual([3])
    expect(await read()).toEqual([])
    expect(cursor().offset).toBe(fs.statSync(file).size)
    expect(cursor().ino).toBe(String(fs.statSync(file).ino))
  })

  it("starts over when the file was truncated below its offset", async () => {
    const { file, line, read, cursor } = await setup()
    fs.writeFileSync(file, line(1) + line(2) + line(3))
    expect(await read()).toEqual([1, 2, 3])
    // Truncated mid-turn (someone cleared the log), then the turn writes on.
    fs.writeFileSync(file, line(4))
    expect(await read()).toEqual([4])
    expect(cursor().offset).toBe(fs.statSync(file).size)
    fs.appendFileSync(file, line(5))
    expect(await read()).toEqual([5])
  })

  it("starts over when the file was replaced by another one (rotated), past the old offset too", async () => {
    const { file, line, read } = await setup()
    fs.writeFileSync(file, line(1) + line(2))
    expect(await read()).toEqual([1, 2])
    // Rotated: moved aside and a new file written, already longer than the old offset.
    fs.renameSync(file, `${file}.1`)
    fs.writeFileSync(file, line(3) + line(4) + line(5) + line(6))
    expect(await read()).toEqual([3, 4, 5, 6])
  })
})

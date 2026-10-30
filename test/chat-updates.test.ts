// The Coordinator chat's update chips (web/src/lib/chatUpdates.ts): which notices fold into chips and groups, and
// which updates a Coordinator reply covers.
import { describe, expect, it } from "vitest"
import { chipView, coordinatorRows, noticeText, readByCoordinator, sourceLabels, stableRows, type CoordinatorRow } from "../web/src/lib/chatUpdates.js"
import type { ChatMessage } from "../shared/types.js"

let t = 0
const msg = (id: string, role: ChatMessage["role"], content: string, meta: Record<string, unknown> | null = null): ChatMessage => ({ id, role, content, meta, createdAt: ++t })
const captain = (id: string, text: string, project = "box-yard") => msg(id, "notice", `Captain for ${project} replied: ${text}`, { projectId: "prj_boxyard1", captain: true, replyTo: "cap_x" })
const done = (id: string, title = "Fix login") => msg(id, "notice", `✅ **${title}** is done: Fixed the redirect.`, { taskId: `task_${id}` })
const asks = (id: string) => msg(id, "notice", `🙋 **Pick a colour** needs you: Red or blue?`, { taskId: `task_${id}` })
const failed = (id: string) => msg(id, "notice", `❌ **Build** failed: tsc exited 2`, { taskId: `task_${id}` })
const merge = (id: string) => msg(id, "notice", `🚢 Cody asked **Fix login** to merge PR #12 (Merge button): https://github.com/o/r/pull/12`, { taskId: `task_${id}` })
const warning = (id: string) => msg(id, "notice", "⚠️ Boxes are busy. Retrying in 30s.")
const hook = (id: string) => msg(id, "notice", `🪝 **Fix login** hook "Auto-merge" (PR ready) messaged the Coordinator: Please merge`, { taskId: `task_${id}`, kind: "hook" })
const published = (id: string, task = "Zen mode") => msg(id, "notice", `📎 **${task}** published Shot ${id}: /artifacts/art_${id}/shot.png`, { taskId: "task_zen001" })
const reply = (id: string, text = "The Captain says it's done.") => msg(id, "assistant", text)
const user = (id: string) => msg(id, "user", "What's up?")
const tool = (id: string) => msg(id, "tool", "list_tasks", { input: {} })

/** Each row as a short string: "u:a", "g:a,b", "m:r" (with "<-a,b" for the updates a reply covers). */
const shape = (rows: CoordinatorRow[]) =>
  rows.map((r) =>
    r.type === "update" ? `u:${r.id}` : r.type === "updates" ? `g:${r.items.map((i) => i.id).join(",")}` : `m:${r.id}${r.sources ? `<-${r.sources.map((s) => s.id).join(",")}` : ""}`,
  )

describe("grouping updates", () => {
  it("one update is a chip; back-to-back ones are one group with its first update's id", () => {
    const rows = coordinatorRows([user("u1"), captain("c1", "On it"), reply("r1"), done("d1"), done("d2", "B"), captain("c2", "Merged")])
    expect(shape(rows)).toEqual(["m:u1", "u:c1", "m:r1<-c1", "g:d1,d2,c2"])
    expect(rows[3]!.id).toBe("d1")
  })

  it("a reply, Cody's message, a tool call or an error separates runs", () => {
    const rows = coordinatorRows([done("a"), reply("r"), done("b"), user("u"), done("c"), tool("t"), done("d"), msg("e", "error", "boom"), done("f")])
    expect(shape(rows).filter((s) => !s.startsWith("m:"))).toEqual(["u:a", "u:b", "u:c", "u:d", "u:f"])
  })

  it("a '(no update)' turn stores nothing, so the updates around it stay one group", () => {
    // The server never stores a "(no update)" reply (orchestrator.ts), so the thread is just the two updates.
    expect(shape(coordinatorRows([captain("c1", "Started"), captain("c2", "Done")]))).toEqual(["g:c1,c2"])
  })

  it("questions, failures and merge requests stay cards and split the updates around them", () => {
    const rows = coordinatorRows([done("a"), done("b"), asks("q"), done("c"), failed("f"), merge("m"), warning("w")])
    expect(shape(rows)).toEqual(["g:a,b", "m:q", "u:c", "m:f", "m:m", "u:w"])
  })

  it("Cody's message to a task from its card is Cody's own line, never a chip, and the Coordinator doesn't read it", () => {
    const sent = msg("s", "notice", "✉️ **Fix login** got a message from Cody: try the: new form\nand log in", { taskId: "task_s", sent: true })
    const rows = coordinatorRows([done("a"), sent, done("b"), reply("r")])
    expect(shape(rows)).toEqual(["u:a", "m:s", "u:b", "m:r"])
    expect(readByCoordinator(sent)).toBe(false)
    expect(noticeText(sent)).toEqual({ text: "try the: new form\nand log in", truncated: false })
    expect(noticeText(done("d")).text).toBe("Fixed the redirect.")
  })

  it("a task's back-to-back published files are one update", () => {
    const rows = coordinatorRows([published("p1"), published("p2"), done("d")])
    expect(shape(rows)).toEqual(["g:p1,d"])
    const group = rows[0] as Extract<CoordinatorRow, { type: "updates" }>
    expect(group.items[0]!.type).toBe("files")
  })

  it("keeps the order: every message appears once, where it was", () => {
    const messages = [user("u"), done("a"), asks("q"), captain("c", "x"), reply("r"), published("p"), tool("t"), done("b")]
    const rows = coordinatorRows(messages)
    const ids = rows.flatMap((r) => (r.type === "message" ? [r.id] : r.type === "update" ? (r.item.type === "files" ? r.item.group.messages.map((m) => m.id) : [r.id]) : r.items.flatMap((i) => (i.type === "files" ? i.group.messages.map((m) => m.id) : [i.id]))))
    expect(ids).toEqual(messages.map((m) => m.id))
  })
})

describe("which updates a reply covers", () => {
  it("the Coordinator-read updates since the previous reply", () => {
    const rows = coordinatorRows([captain("c1", "a"), reply("r1"), captain("c2", "b"), warning("w"), reply("r2"), reply("r3")])
    expect(shape(rows)).toEqual(["u:c1", "m:r1<-c1", "g:c2,w", "m:r2<-c2,w", "m:r3"])
  })

  it("names a source's group as its row, so the from: line can open the group", () => {
    const rows = coordinatorRows([captain("c1", "a"), captain("c2", "b"), reply("r")])
    const r = rows[1] as Extract<CoordinatorRow, { type: "message" }>
    expect(r.sources!.map((s) => [s.id, s.rowId, s.label])).toEqual([
      ["c1", "c1", "box-yard Captain"],
      ["c2", "c1", "box-yard Captain"],
    ])
    expect(sourceLabels(r.sources!, () => "?")).toEqual(["box-yard Captain"])
  })

  it("leaves out task notices the project's Captain handled, but keeps hook fires and merge requests", () => {
    expect(readByCoordinator(done("d"))).toBe(false)
    expect(readByCoordinator(asks("q"))).toBe(false)
    expect(readByCoordinator(hook("h"))).toBe(true)
    expect(readByCoordinator(merge("m"))).toBe(true)
    expect(readByCoordinator(warning("w"))).toBe(true)
    expect(readByCoordinator(msg("k", "notice", "Context compacted to 20k tokens (button).", { kind: "compaction" }))).toBe(false)
    const rows = coordinatorRows([done("d"), hook("h"), merge("m"), captain("c", "ok"), reply("r")])
    expect(shape(rows).at(-1)).toBe("m:r<-h,m,c")
  })

  it("an update that came in after the turn's first tool call waits for the next reply", () => {
    // Cody asks; the turn calls a tool; the Captain replies mid-turn; the turn's reply can't have read it.
    const rows = coordinatorRows([user("u"), tool("t1"), captain("c", "done"), tool("t2"), reply("r1"), reply("r2")])
    expect(shape(rows)).toEqual(["m:u", "m:t1", "u:c", "m:t2", "m:r1", "m:r2<-c"])
  })

  it("with no tool call it covers everything since the previous reply, even across Cody's message", () => {
    const rows = coordinatorRows([reply("r0"), captain("c", "x"), user("u"), reply("r1")])
    expect(shape(rows).at(-1)).toBe("m:r1<-c")
  })

  it("a failed turn's updates aren't carried to the next reply", () => {
    const rows = coordinatorRows([captain("c", "x"), msg("e", "error", "The orchestrator hit an error"), user("u"), reply("r")])
    expect(shape(rows).at(-1)).toBe("m:r")
  })

  describe("turns stamped with when they started (meta.turn)", () => {
    const at = (m: ChatMessage, turn: number) => ({ ...m, meta: { ...m.meta, turn } })

    it("a silent turn's updates aren't credited to the next turn's reply, and that reply covers its own", () => {
      // Turn 1 handles a hook with a tool call and says "(no update)" (never stored). Turn 2 reads the Captain's report.
      const rows = coordinatorRows([hook("h"), at(tool("t1"), 1), captain("c", "Merged"), at(tool("t2"), 2), at(reply("r"), 2)])
      expect(shape(rows).at(-1)).toBe("m:r<-c")
      // Unstamped (rows from before the stamp), the reply still gets the silent turn's updates.
      expect(shape(coordinatorRows([hook("h"), tool("t1"), captain("c", "Merged"), tool("t2"), reply("r")])).at(-1)).toBe("m:r<-h")
    })

    it("a turn that replies, then calls tools and replies again, reads once: what came in mid-turn waits", () => {
      const rows = coordinatorRows([captain("c1", "x"), at(reply("r1"), 1), captain("c2", "y"), at(tool("t"), 1), at(reply("r2"), 1), at(reply("r3"), 2)])
      expect(shape(rows).filter((s) => s.startsWith("m:"))).toEqual(["m:r1<-c1", "m:t", "m:r2", "m:r3<-c2"])
    })
  })
})

describe("chip text", () => {
  it("a Captain's reply: its project's Captain, linked to its tab, 'replied' and the text", () => {
    const v = chipView(captain("c", "I've sent **it** to `task_d1cc9971f403`."))
    expect(v).toMatchObject({ captain: true, source: { label: "box-yard Captain", href: "/projects/prj_boxyard1?tab=captain" }, verb: "replied", preview: "I've sent it to task_d1cc9971f403." })
    expect(chipView(msg("c2", "notice", "Captain for web: All quiet", { projectId: "prj_web0001", captain: true }))).toMatchObject({ verb: "reports", preview: "All quiet" })
  })

  it("a task notice: the task, linked, a short verb and the detail; links as their labels", () => {
    expect(chipView(done("d"))).toMatchObject({ kind: "done", source: { label: "Fix login", href: "/tasks/task_d" }, verb: "done", preview: "Fixed the redirect." })
    const pr = chipView(msg("p", "notice", "🔀 **Fix login** opened a pull request: https://github.com/o/r/pull/16", { taskId: "task_p" }))
    expect(pr).toMatchObject({ kind: "pr", verb: "opened PR #16", preview: "" })
  })

  it("a notice about no task keeps all its text as the preview", () => {
    expect(chipView(warning("w"))).toMatchObject({ kind: "warning", source: null, verb: "", preview: "Boxes are busy. Retrying in 30s." })
  })
})

describe("stable rows", () => {
  it("keeps every unchanged row's object, so memo'd rows skip; a row a message joined is new", () => {
    const base = [captain("c1", "a"), reply("r1"), done("d1")]
    const first = coordinatorRows(base)
    const d2 = done("d2", "B")
    const next = stableRows(first, coordinatorRows([...base, d2]))
    expect(next[0]).toBe(first[0])
    expect(next[1]).toBe(first[1])
    expect(next[2]).not.toBe(first[2])
    expect(shape(next)).toEqual(["u:c1", "m:r1<-c1", "g:d1,d2"])
    const again = stableRows(next, coordinatorRows([...base, d2, user("u")]))
    expect(again.slice(0, 3).every((r, i) => r === next[i])).toBe(true)
  })
})

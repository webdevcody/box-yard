import { describe, expect, it } from "vitest"
import { captainRows, captainToolView, groupLabel, isLongMessage, linkLabel, parseNotice, plainText, segments, splitNotice } from "../web/src/lib/captainTranscript"
import { stripTruncation } from "../web/src/lib/truncated"
import type { CaptainMessage } from "../shared/types"

let n = 0
const msg = (role: CaptainMessage["role"], content = "x", meta: Record<string, unknown> | null = null): CaptainMessage => ({
  id: `cap_test${String(n++).padStart(4, "0")}`,
  projectId: "prj_demo01",
  role,
  content,
  meta,
  createdAt: n,
})

describe("splitNotice", () => {
  it("splits a notice into its kind, the task title and the rest as markdown", () => {
    expect(splitNotice("✅ **Fix login** is done: Fixed the `redirect`.\n\n- one\n- two")).toEqual({ kind: "done", title: "Fix login", event: "is done: Fixed the `redirect`.\n\n- one\n- two", truncated: false })
    expect(splitNotice("📎 **Brief** published Recent PRs: briefing: https://yard.example.com/artifacts/art_1/b.md")).toEqual({
      kind: "artifact",
      title: "Brief",
      event: "published Recent PRs: briefing: https://yard.example.com/artifacts/art_1/b.md",
      truncated: false,
    })
  })

  it("shortens a PR notice's URL to a PR #N link", () => {
    expect(splitNotice("🔀 **Inbox** opened a pull request: https://github.com/o/r/pull/16")).toEqual({ kind: "pr", title: "Inbox", event: "opened [PR #16](https://github.com/o/r/pull/16)", truncated: false })
  })

  it("moves a merge request's task up to the title and links its PR", () => {
    expect(splitNotice("🚢 Cody asked **Fix login** to merge PR #12 (Merge button): https://github.com/o/r/pull/12")).toEqual({
      kind: "merge",
      title: "Fix login",
      event: "Cody asked it to merge [PR #12](https://github.com/o/r/pull/12) (Merge button)",
      truncated: false,
    })
    expect(splitNotice("🚢 The Captain asked **Fix login** to merge PR #12: https://github.com/o/r/pull/12").event).toBe("The Captain asked it to merge [PR #12](https://github.com/o/r/pull/12)")
  })

  it("keeps a hook's name with its colon, and a notice without a title whole", () => {
    expect(splitNotice('🪝 **Ship** hook "box-yard: auto-merge" (PR ready) sent to the agent: Please merge').event).toBe('hook "box-yard: auto-merge" (PR ready) sent to the agent: Please merge')
    expect(splitNotice("⚠️ Box box_1 is low on disk.")).toEqual({ kind: "warning", title: null, event: "Box box_1 is low on disk.", truncated: false })
    expect(splitNotice('Schedule "Nightly" started a run: task task_1.')).toEqual({ kind: "info", title: null, event: 'Schedule "Nightly" started a run: task task_1.', truncated: false })
  })
})

describe("truncated notices", () => {
  // What server/tasks.ts writes for a long reply (preview() in server/replies.ts): the hint is for the model.
  const long = "💬 **PR tracker** finished its turn: I opened the PR: https://github.com/o/r/pull/154. A 403 fro [truncated: 2821 more chars — full reply: call wait_for_tasks or get_task]"

  it("drops the model's marker from a notice card and says it was shortened", () => {
    const n = splitNotice(long)
    expect(n.truncated).toBe(true)
    expect(n.event).toBe("finished its turn: I opened the PR: https://github.com/o/r/pull/154. A 403 fro…")
    expect(n.event).not.toContain("truncated")
    expect(n.event).not.toContain("get_task")
  })

  it("drops it from a Captain notice row too", () => {
    const p = parseNotice(long)
    expect(p.truncated).toBe(true)
    expect(JSON.stringify(p.summary)).not.toContain("truncated")
    expect(p.summary.at(-1)).toEqual({ text: ". A 403 fro…" })
  })

  it("drops capReply's marker on its own line, and leaves other brackets alone", () => {
    expect(stripTruncation("abc\n[truncated: 12 more chars — call get_task with full_reply and offset=20000 to read the rest]")).toEqual({ text: "abc…", truncated: true })
    expect(stripTruncation("see [the docs] and [truncated] here")).toEqual({ text: "see [the docs] and [truncated] here", truncated: false })
  })
})

describe("parseNotice", () => {
  it("reads a done notice into kind, title and the plain summary", () => {
    const p = parseNotice("✅ **Brief the orchestrator** is done: Briefed on PRs **#35–#42**. Published /artifacts/art_8a9ea54f72fd/briefing.md. Main is green.", {
      taskId: "task_abc123",
    })
    expect(p.kind).toBe("done")
    expect(p.title).toBe("Brief the orchestrator")
    expect(p.summary).toEqual([
      { text: "Briefed on PRs #35–#42. Published " },
      { href: "/artifacts/art_8a9ea54f72fd/briefing.md", label: "briefing.md" },
      { text: ". Main is green." },
    ])
  })

  it("keeps the artifact title and links the file", () => {
    const p = parseNotice("📎 **Brief** published Recent PRs: briefing: https://yard.example.com/artifacts/art_1/b.md")
    expect(p.kind).toBe("artifact")
    expect(p.summary).toEqual([{ text: "Recent PRs: briefing " }, { href: "https://yard.example.com/artifacts/art_1/b.md", label: "b.md" }])
  })

  it("shows a PR notice as 'opened PR #N'", () => {
    const p = parseNotice("🔀 **Inbox** opened a pull request: https://github.com/o/r/pull/16")
    expect(p.kind).toBe("pr")
    expect(p.summary).toEqual([{ text: "opened " }, { href: "https://github.com/o/r/pull/16", label: "PR #16" }])
  })

  it("maps every notice emoji, including the ones with a variation selector", () => {
    expect(parseNotice("❌ **A** failed: boom").kind).toBe("failed")
    expect(parseNotice("🙋 **A** needs you: which one?").kind).toBe("needs_input")
    expect(parseNotice("💬 **A** says: hi").summary).toEqual([{ text: "hi" }])
    expect(parseNotice("💬 **A** finished its turn: did it").summary).toEqual([{ text: "did it" }])
    expect(parseNotice("⚠️ Box create failed. Retrying in a minute.").kind).toBe("warning")
    expect(parseNotice("⚠️ Box create failed. Retrying in a minute.").title).toBeNull()
  })

  it("reads the notes retro and the notes budget notice as notes, showing the retro's first line", () => {
    const retro = parseNotice(
      "📝 **Notes retro**: 1 finished task left 2 note suggestions to curate.\nNotes now: 3 of 25 notes, ~120 of 4k tokens.\n\n**[Fix login](/tasks/task_1)** (task_1) · done, no PR\n- `sug_1`: Use pnpm",
      { kind: "retro" },
    )
    expect(retro).toEqual({ kind: "notes", title: "Notes retro", summary: [{ text: "1 finished task left 2 note suggestions to curate." }], truncated: false })
    const prune = parseNotice("📝 Project notes are over budget (30 of 25 notes, ~3k of 4k tokens). Prune them.")
    expect(prune.kind).toBe("notes")
    expect(prune.title).toBeNull()
  })

  it("reads the Coordinator's update_settings notice as a settings change", () => {
    const n = parseNotice("⚙️ **Settings** changed by the Coordinator: maxBoxes 5 → 20, slotsPerBox 2 → 3. Reason: Cody asked for more boxes", { kind: "settings" })
    expect(n).toEqual({ kind: "settings", title: "Settings", summary: [{ text: "maxBoxes 5 → 20, slotsPerBox 2 → 3. Reason: Cody asked for more boxes" }], truncated: false })
  })

  it("drops an empty status detail instead of showing a dangling colon", () => {
    expect(parseNotice("✅ **A** is done: ").summary).toEqual([{ text: "is done" }])
  })

  it("reads compaction notices without the server-local file path", () => {
    const p = parseNotice("Context compacted from 142k to 18k tokens (button). Summary saved to /data/x.md.", { kind: "compaction" })
    expect(p.kind).toBe("compaction")
    expect(p.summary).toEqual([{ text: "Context compacted from 142k to 18k tokens (button)." }])
  })
})

describe("plainText and links", () => {
  it("strips markdown to one line", () => {
    expect(plainText("**bold** and [title](/tasks/task_1)\n`code`")).toBe("bold and title code")
  })
  it("labels links", () => {
    expect(linkLabel("/artifacts/art_1/my%20file.md")).toBe("my file.md")
    expect(linkLabel("https://example.com/docs")).toBe("example.com/docs")
  })
  it("trims sentence punctuation off URLs", () => {
    expect(segments("see https://x.dev/a.")).toEqual([{ text: "see " }, { href: "https://x.dev/a", label: "x.dev/a" }, { text: "." }])
  })
})

describe("captainRows", () => {
  it("groups runs of two or more notices and keeps single ones as rows", () => {
    const u = msg("user")
    const a = msg("notice", "a", { taskId: "task_1" })
    const b = msg("notice", "b", { taskId: "task_2" })
    const r = msg("assistant")
    const c = msg("notice", "c", { taskId: "task_1" })
    const t = msg("tool")
    const rows = captainRows([u, a, b, r, c, t])
    expect(rows.map((row) => row.type)).toEqual(["message", "notices", "message", "notice", "message"])
    expect(rows[1]).toMatchObject({ id: a.id, messages: [a, b] })
  })

  it("keeps a group's id stable as notices append to it", () => {
    const a = msg("notice")
    const b = msg("notice")
    const first = captainRows([a, b])
    const later = captainRows([a, b, msg("notice")])
    expect(later[0]!.id).toBe(first[0]!.id)
  })

  it("labels groups by whether they're all task updates", () => {
    expect(groupLabel([msg("notice", "", { taskId: "t" }), msg("notice", "", { taskId: "u" })])).toBe("2 task updates")
    expect(groupLabel([msg("notice", "", { taskId: "t" }), msg("notice", "", { kind: "compaction" })])).toBe("2 updates")
  })
})

describe("Captain tool lines", () => {
  const ref = { kind: "project" as const, id: "prj_demo01", href: "/projects/prj_demo01", label: "demo", hint: "demo" }
  const index = { byId: new Map([[ref.id, ref]]), byTitle: new Map(), byName: new Map([["project:demo", ref]]), pattern: /$^/g }

  it("find the project by result id or by the name the Coordinator used", () => {
    expect(captainToolView("send_to_captain", { input: { project: "demo", message: "go" } }, index)).toMatchObject({ href: "/projects/prj_demo01?tab=captain", message: "go", waits: false })
    expect(captainToolView("ask_captain", { input: { project: "x" }, captain: { projectId: "prj_demo01", reply: "ok", finished: true } }, index)).toMatchObject({
      href: "/projects/prj_demo01?tab=captain",
      waits: true,
      reply: "ok",
      finished: true,
    })
    expect(captainToolView("wait_for_captain", { input: { project: "gone" } }, index)).toMatchObject({ project: null, href: null, message: null, reply: null, finished: null })
  })

  it("fold long messages", () => {
    expect(isLongMessage("short")).toBe(false)
    expect(isLongMessage("x".repeat(701))).toBe(true)
    expect(isLongMessage(Array(13).fill("line").join("\n"))).toBe(true)
  })
})

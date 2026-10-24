import { describe, expect, it } from "vitest"
import { artifactPath, groupPublished, parsePublished, previewGallery, publishedLabel, runsOf, sameGroup, type NoticeLike } from "../web/src/lib/publishedNotices"
import { captainRows } from "../web/src/lib/captainTranscript"
import { batchNotices, updatesBlock } from "../server/noticeBatch"
import type { CaptainMessage } from "../shared/types"

let n = 0
const msg = (role: string, content = "x", meta: Record<string, unknown> | null = null): CaptainMessage => ({
  id: `cap_pub${String(n++).padStart(4, "0")}`,
  projectId: "prj_demo01",
  role: role as CaptainMessage["role"],
  content,
  meta,
  createdAt: n,
})
const pub = (task: string, title: string, file: string, taskId: string | null = `task_${task.toLowerCase().replace(/\W+/g, "")}`) =>
  msg("notice", `📎 **${task}** published ${title}: https://yard.example.com/artifacts/art_${file.replace(/\W/g, "")}/${file}`, taskId ? { taskId } : null)

const types = (rows: { type: string }[]) => rows.map((r) => r.type)

describe("parsePublished", () => {
  it("reads the task, the file title (which may contain ': ') and a same-origin path", () => {
    const p = parsePublished(pub("Zen mode", "Before: Coordinator panel (desktop 1440)", "before-desktop.png"))
    expect(p).toMatchObject({
      taskId: "task_zenmode",
      taskTitle: "Zen mode",
      file: { title: "Before: Coordinator panel (desktop 1440)", url: "/artifacts/art_beforedesktoppng/before-desktop.png", filename: "before-desktop.png", artifactId: "art_beforedesktoppng" },
    })
  })

  it("prefers the artifact id the notice carries and reads relative URLs", () => {
    const m = msg("notice", "📎 **T** published Report: /artifacts/art_x1/report.md", { taskId: "task_1", artifactId: "art_real01" })
    expect(parsePublished(m)?.file).toMatchObject({ url: "/artifacts/art_x1/report.md", artifactId: "art_real01", title: "Report" })
  })

  it("ignores other notices, other roles and links that aren't artifacts", () => {
    expect(parsePublished(msg("notice", "✅ **T** is done: shipped"))).toBeNull()
    expect(parsePublished(msg("assistant", "📎 **T** published X: /artifacts/art_1/x.png"))).toBeNull()
    expect(parsePublished(msg("notice", "📎 **T** published X: https://evil.example.com/x.png"))).toBeNull()
  })

  it("keeps other hosts' URLs as they are", () => {
    expect(artifactPath("https://yard.example.com/artifacts/art_1/a.png")).toBe("/artifacts/art_1/a.png")
    expect(artifactPath("https://example.com/docs")).toBe("https://example.com/docs")
  })
})

describe("groupPublished", () => {
  it("folds back-to-back files of one task into one row whose id is the first notice's", () => {
    const files = [1, 2, 3, 4, 5, 6].map((i) => pub("Zen mode", `Shot ${i}`, `shot-${i}.png`))
    const rows = groupPublished([msg("user"), ...files, msg("assistant")])
    expect(types(rows)).toEqual(["message", "files", "message"])
    const g = rows[1]!.type === "files" ? rows[1]!.group : null
    expect(g).toMatchObject({ id: files[0]!.id, taskId: "task_zenmode", taskTitle: "Zen mode" })
    expect(g!.files.map((f) => f.title)).toEqual(["Shot 1", "Shot 2", "Shot 3", "Shot 4", "Shot 5", "Shot 6"])
    expect(g!.messages).toEqual(files)
  })

  it("splits a run of several tasks into one row per task, in order of each task's first file", () => {
    const a1 = pub("A", "a1", "a1.png")
    const b1 = pub("B", "b1", "b1.png")
    const a2 = pub("A", "a2", "a2.png")
    const c1 = pub("C", "c1", "c1.md")
    const rows = groupPublished([a1, b1, a2, c1])
    expect(rows.map((r) => r.id)).toEqual([a1.id, b1.id, c1.id])
    expect(rows.map((r) => (r.type === "files" ? r.group.files.map((f) => f.title) : []))).toEqual([["a1", "a2"], ["b1"], ["c1"]])
  })

  it("starts a new group after any other message, even another notice", () => {
    const a1 = pub("A", "a1", "a1.png")
    const done = msg("notice", "✅ **A** is done: ok", { taskId: "task_a" })
    const a2 = pub("A", "a2", "a2.png")
    const reply = msg("assistant", "Here are the shots")
    const a3 = pub("A", "a3", "a3.png")
    const rows = groupPublished([a1, done, a2, reply, a3])
    expect(types(rows)).toEqual(["files", "message", "files", "message", "files"])
    expect(rows.map((r) => r.id)).toEqual([a1.id, done.id, a2.id, reply.id, a3.id])
  })

  it("groups by title when a notice has no task id", () => {
    const rows = groupPublished([pub("Old", "x", "x.png", null), pub("Old", "y", "y.png", null), pub("Other", "z", "z.png", null)])
    expect(rows.map((r) => (r.type === "files" ? r.group.files.length : 0))).toEqual([2, 1])
  })

  it("live append: a new file joins the last group in place; ids and order of every row stay the same", () => {
    const before: NoticeLike[] = [msg("user"), pub("A", "a1", "a1.png"), pub("B", "b1", "b1.png")]
    const first = groupPublished(before)
    const later = groupPublished([...before, pub("A", "a2", "a2.png"), pub("B", "b2", "b2.png")])
    expect(later.map((r) => r.id)).toEqual(first.map((r) => r.id))
    expect(later.map((r) => (r.type === "files" ? r.group.files.length : 1))).toEqual([1, 2, 2])
    // A row that nothing joined counts as unchanged, so its memo'd card skips the re-render.
    const g = (rows: typeof first, i: number) => (rows[i]!.type === "files" ? (rows[i] as { group: Parameters<typeof sameGroup>[0] }).group : null)!
    expect(sameGroup(g(first, 1), g(groupPublished(before), 1))).toBe(true)
    expect(sameGroup(g(first, 1), g(later, 1))).toBe(false)
  })

  it("labels the count and builds the gallery over every previewable file", () => {
    expect(publishedLabel(1)).toBe("published a file")
    expect(publishedLabel(6)).toBe("published 6 files")
    const rows = groupPublished([pub("A", "a", "a.png"), pub("A", "b", "b.md"), pub("A", "c", "c.bin")])
    const g = rows[0]!.type === "files" ? rows[0]!.group : null
    expect(previewGallery(g!.files).map((i) => i.name)).toEqual(["a.png", "b.md"])
  })
})

describe("runsOf", () => {
  it("collects consecutive members into arrays and leaves the rest single", () => {
    expect(runsOf([1, 2, 3, 5, 7, 8], (x) => x % 2 === 1)).toEqual([[1], 2, [3, 5, 7], 8])
  })
})

describe("captainRows with published files", () => {
  it("shows one task's back-to-back files as one row", () => {
    const files = [pub("A", "a1", "a1.png"), pub("A", "a2", "a2.png"), pub("A", "a3", "a3.png")]
    const rows = captainRows([msg("assistant"), ...files])
    expect(types(rows)).toEqual(["message", "files"])
    expect(rows[1]!.id).toBe(files[0]!.id)
  })

  it("counts a files row as one update in a run of notices, and keeps every notice in `messages`", () => {
    const done = msg("notice", "✅ **B** is done: ok", { taskId: "task_b" })
    const files = [pub("A", "a1", "a1.png"), pub("A", "a2", "a2.png")]
    const rows = captainRows([done, ...files])
    expect(types(rows)).toEqual(["notices"])
    const row = rows[0] as Extract<(typeof rows)[number], { type: "notices" }>
    expect(row.id).toBe(done.id)
    expect(row.items.map((i) => i.type)).toEqual(["notice", "files"])
    expect(row.messages).toEqual([done, ...files])
  })
})

describe("batchNotices (Coordinator and Captain prompts)", () => {
  const p = (task: string, title: string, url: string) => `📎 **${task}** published ${title}: ${url}`

  it("folds one task's back-to-back files into one line and leaves a single file as it was", () => {
    const out = batchNotices([
      "✅ **B** is done: ok",
      p("A", "Before: panel", "https://y/artifacts/art_1/a.png"),
      p("A", "After: zen", "https://y/artifacts/art_2/b.png"),
      p("C", "Report", "/artifacts/art_3/r.md"),
      "🔀 **A** opened a pull request: https://github.com/o/r/pull/1",
      p("A", "Late", "/artifacts/art_4/l.png"),
    ])
    expect(out).toEqual([
      "✅ **B** is done: ok",
      "📎 **A** published 2 files: Before: panel (https://y/artifacts/art_1/a.png); After: zen (https://y/artifacts/art_2/b.png)",
      p("C", "Report", "/artifacts/art_3/r.md"),
      "🔀 **A** opened a pull request: https://github.com/o/r/pull/1",
      p("A", "Late", "/artifacts/art_4/l.png"),
    ])
  })

  it("builds the bulleted block, empty when there's nothing", () => {
    expect(updatesBlock("Updates", [])).toBe("")
    expect(updatesBlock("Updates", [p("A", "x", "/artifacts/art_1/x.png"), p("A", "y", "/artifacts/art_2/y.png")])).toBe(
      "[Updates]\n- 📎 **A** published 2 files: x (/artifacts/art_1/x.png); y (/artifacts/art_2/y.png)",
    )
  })
})

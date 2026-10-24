import { describe, expect, it } from "vitest"
import { buildItems, pushRecent, recentKeyFor, type PaletteItem } from "../web/src/lib/palette.js"
import {
  FIELD_WEIGHT,
  bumpUsage,
  matchText,
  paletteRows,
  parseQuery,
  queryExtension,
  rankPalette,
  scoreItem,
  scoreText,
  targetsFile,
  type GroupKey,
  type PaletteGroup,
  type RankOptions,
} from "../web/src/lib/paletteRank.js"
import type { Artifact, BoxInfo, Project, Schedule, Task, TaskStatus } from "../shared/types.js"

let n = 0
function task(title: string, status: TaskStatus = "idle", over: Partial<Task> = {}): Task {
  n += 1
  return {
    id: `tsk_${n}`,
    projectId: "prj_yard",
    title,
    prompt: "Do the thing",
    status,
    boxId: null,
    sessionId: "s",
    branch: null,
    prUrl: null,
    previews: [],
    question: null,
    summary: null,
    error: null,
    turnCount: 0,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    contextTokens: null,
    contextWindow: null,
    compactPending: false,
    compacting: false,
    model: null,
    effort: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    routingRule: null,
    routingReason: null,
    createdAt: n,
    updatedAt: n,
    ...over,
  }
}

function project(id: string, name: string, repo: string | null = null): Project {
  return { id, name, description: "", repo, baseBranch: "main", envKeys: [], notes: [], createdAt: 1, updatedAt: 1 }
}

const projects = [project("prj_yard", "box-yard", "webdevcody/box-yard"), project("prj_notes", "Notes app")]
const schedules: Schedule[] = [
  {
    id: "sch_digest",
    target: "orchestrator",
    projectId: null,
    name: "Morning digest",
    cron: "0 9 * * *",
    timezone: "UTC",
    prompt: "summarize",
    enabled: true,
    catchUp: "once",
    allowOverlap: false,
    nextRunAt: null,
    lastRunAt: null,
    lastTaskId: null,
    lastSkipReason: null,
    runCount: 0,
    qstashId: null,
    createdAt: 1,
    updatedAt: 1,
  },
]
const artifact = (id: string, title: string, filename: string, createdAt = 1): Artifact => ({
  id,
  projectId: "prj_yard",
  taskId: null,
  title,
  filename,
  mime: "application/octet-stream",
  size: 1,
  url: `/artifacts/${id}/${filename}`,
  createdAt,
})
const artifacts: Artifact[] = [artifact("art_1", "Architecture diagram", "arch.html")]
const boxes: BoxInfo[] = [
  { id: "box_abc123", provider: "mock", status: "ready", slots: 2, runningTurns: 1, residentTasks: [], projects: ["box-yard"], createdAt: 1, lastUsedAt: 1 },
]

const NOW = 10 * 86_400_000
const titles = (g: PaletteGroup | undefined) => g?.items.map((i) => i.title) ?? []
const group = (groups: PaletteGroup[], key: GroupKey) => groups.find((g) => g.key === key)
const search = (items: PaletteItem[], raw: string, opts: RankOptions = {}) => rankPalette(items, parseQuery(raw), { now: NOW, ...opts })

describe("match tiers", () => {
  it("ranks exact over prefix over word start over substring over fuzzy", () => {
    expect(matchText("Inbox", "inbox")!.tier).toBe("exact")
    expect(matchText("Inbox zero", "inbox")!.tier).toBe("prefix")
    expect(matchText("Clean the inbox", "inbox")!.tier).toBe("word")
    expect(matchText("Sandboxing", "box")!.tier).toBe("substring")
    expect(matchText("command palette", "cmdpal")!.tier).toBe("fuzzy")
    const scores = [scoreText("Inbox", "inbox")!, scoreText("Inbox zero", "inbox")!, scoreText("Clean the inbox", "inbox")!, scoreText("Sandboxing", "box")!, scoreText("command palette", "cmdpal")!]
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
    expect(scores.at(-1)).toBeGreaterThan(0)
  })

  it("never lets a penalty drop a match into the tier below", () => {
    const longPrefix = scoreText(`inbox ${"x".repeat(200)}`, "inbox")!
    const earlyWord = scoreText("the inbox", "inbox")!
    const lateWord = scoreText(`${"x ".repeat(100)}inbox`, "inbox")!
    const earlySub = scoreText("sandbox", "box")!
    const bestFuzzy = scoreText("c-m-d", "cmd")!
    expect(longPrefix).toBeGreaterThan(earlyWord)
    expect(lateWord).toBeGreaterThan(earlySub)
    expect(scoreText(`x${"y".repeat(200)}box`, "box")!).toBeGreaterThan(bestFuzzy)
  })

  it("is case-insensitive and rejects scattered or missing letters", () => {
    expect(scoreText("Command Palette", "command")).not.toBeNull()
    expect(scoreText("abcdefghijklmnopqrstuvwxyz", "az")).toBeNull()
    expect(scoreText("Inbox", "outbox")).toBeNull()
    // Fuzzy hits have to start at a word.
    expect(scoreText("Deploy nebula", "dpl")).not.toBeNull()
    expect(scoreText("Command palette", "dpl")).toBeNull()
    expect(scoreText("Deploy nebula", "dpl", false)).toBeNull()
  })

  it("prefers a later word-start hit over an earlier mid-word one", () => {
    expect(matchText("sandbox box", "box")!.tier).toBe("word")
  })
})

describe("fields", () => {
  const item = (over: Partial<PaletteItem>): PaletteItem => ({ key: `task:${over.title}`, kind: "task", title: "Something else", ...over })
  const ctx = { now: NOW }

  it("weighs a title match over the same match in an id, project or summary", () => {
    const title = scoreItem(item({ title: "deploy" }), "deploy", ctx)!
    const id = scoreItem(item({ aliases: ["deploy"] }), "deploy", ctx)!
    const detail = scoreItem(item({ details: ["deploy"] }), "deploy", ctx)!
    expect(title).toBeGreaterThan(id)
    expect(id).toBeGreaterThan(detail)
    expect(FIELD_WEIGHT.title).toBeGreaterThan(FIELD_WEIGHT.alias)
    // A title prefix still beats an exact id.
    expect(scoreItem(item({ title: "deploy nebula" }), "deploy", ctx)!).toBeGreaterThan(id)
  })

  it("matches summaries by words, never by scattered letters", () => {
    expect(scoreItem(item({ details: ["Moved the palette scoring into a pure module"] }), "scoring", ctx)).not.toBeNull()
    expect(scoreItem(item({ details: ["Moved the palette scoring into a pure module"] }), "mtps", ctx)).toBeNull()
  })

  it("finds a task by its summary", () => {
    const items = buildItems({ tasks: [task("Palette work", "done", { summary: "Ranked tasks above files" })], projects })
    expect(titles(group(search(items, "above files"), "task"))).toEqual(["Palette work"])
  })
})

describe("files", () => {
  it("detects a file extension in the query", () => {
    expect(queryExtension(".png")).toBe("png")
    expect(queryExtension("logo.PNG")).toBe("png")
    expect(queryExtension("report.md")).toBe("md")
    for (const ext of ["jpg", "gif", "svg", "html", "csv", "json", "webm", "mp4", "txt", "pdf"]) expect(queryExtension(`x.${ext}`)).toBe(ext)
    expect(queryExtension("v1.2")).toBeNull()
    expect(queryExtension("box.yard")).toBeNull()
    expect(queryExtension("png")).toBeNull()
    expect(queryExtension(".png later")).toBeNull()
  })

  const files = [artifact("art_a", "Empty query desktop", "palette-empty.png", 5), artifact("art_b", "Palette notes", "notes.md", 4), artifact("art_c", "Old shot", "old.jpeg", 3)]
  const tasks = [task("Palette screenshots .png", "working", { updatedAt: NOW }), task("Palette ranking", "working", { updatedAt: NOW })]
  const items = buildItems({ tasks, projects, artifacts: files })

  it("targets files on an extension or a near-exact file name, not on a loose word", () => {
    expect(targetsFile(".png", items)).toBe(true)
    expect(targetsFile("notes", items)).toBe(true)
    expect(targetsFile("palette-empty", items)).toBe(true)
    expect(targetsFile("palette", items)).toBe(false)
    expect(targetsFile("no", items)).toBe(false)
  })

  it("puts files first for a .png query and lists every PNG", () => {
    const groups = search(items, ".png")
    expect(groups[0]!.key).toBe("artifact")
    expect(titles(groups[0])).toEqual(["Empty query desktop"])
    expect(titles(group(groups, "task"))).toEqual(["Palette screenshots .png"])
    expect(titles(search(items, ".jpg")[0])).toEqual(["Old shot"])
  })

  it("keeps tasks first when the query only shares a word with a file", () => {
    const groups = search(items, "palette")
    expect(groups[0]!.key).toBe("task")
    expect(group(groups, "artifact")).toBeDefined()
  })
})

describe("task boost", () => {
  it("lets a task win a tie against a file, a project and a command", () => {
    const items = buildItems({
      tasks: [task("Deploy", "done", { updatedAt: 0 })],
      projects: [project("prj_d", "Deploy")],
      artifacts: [artifact("art_d", "Deploy", "deploy-log.bin")],
    })
    const groups = search(items, "deploy")
    expect(groups.map((g) => g.key).slice(0, 2)).toEqual(["task", "project"])
    expect(groups.findIndex((g) => g.key === "artifact")).toBeGreaterThan(0)
  })

  it("adds small boosts for recent and active tasks that don't jump a match tier", () => {
    const ctx = { now: NOW }
    const [old, fresh, waiting] = buildItems({
      tasks: [task("Deploy staging", "done", { updatedAt: 0 }), task("Deploy staging", "done", { updatedAt: NOW }), task("Deploy staging", "needs_input", { updatedAt: 0 })],
    }).filter((i) => i.kind === "task")
    expect(scoreItem(fresh!, "deploy", ctx)!).toBeGreaterThan(scoreItem(old!, "deploy", ctx)!)
    expect(scoreItem(waiting!, "deploy", ctx)!).toBeGreaterThan(scoreItem(old!, "deploy", ctx)!)
    const [exactOld] = buildItems({ tasks: [task("deploy", "done", { updatedAt: 0 })] }).filter((i) => i.kind === "task")
    expect(scoreItem(exactOld!, "deploy", ctx)!).toBeGreaterThan(scoreItem(waiting!, "deploy", ctx)!)
  })
})

describe("stable order", () => {
  it("breaks equal scores the same way every time, newest then by key", () => {
    const tied = buildItems({
      tasks: [task("Bug b", "done", { id: "tsk_b", updatedAt: 1 }), task("Bug a", "done", { id: "tsk_a", updatedAt: 1 }), task("Bug c", "done", { id: "tsk_c", updatedAt: 1 })],
    })
    const order = titles(group(search(tied, "bug"), "task"))
    expect(order).toEqual(["Bug a", "Bug b", "Bug c"])
    expect(titles(group(search([...tied].reverse(), "bug"), "task"))).toEqual(order)
  })

  it("keeps the relative order of rows as the query grows", () => {
    const many = buildItems({ tasks: Array.from({ length: 8 }, (_, i) => task(`Deploy box ${i}`, "done", { id: `tsk_${i}`, updatedAt: 1 })) })
    const keys = (raw: string) => group(search(many, raw, { expanded: new Set(["task"]) }), "task")!.items.map((i) => i.key)
    expect(keys("dep")).toEqual(keys("deploy"))
    expect(keys("deploy")).toEqual(keys("deploy b"))
  })

  it("breaks score ties by recency", () => {
    const tied = buildItems({ tasks: [task("Deploy staging", "idle", { updatedAt: 1 }), task("Deploy prod", "idle", { updatedAt: 99 })] })
    expect(titles(group(search(tied, "deploy"), "task"))).toEqual(["Deploy prod", "Deploy staging"])
  })
})

describe("prefixes", () => {
  it("parses each prefix and leaves other text alone", () => {
    expect(parseQuery("  > New ")).toMatchObject({ scope: "command", query: "new" })
    expect(parseQuery("#78")).toMatchObject({ scope: "pr", query: "78" })
    expect(parseQuery("f:logo.png")).toMatchObject({ scope: "file", query: "logo.png" })
    expect(parseQuery("F: Logo")).toMatchObject({ scope: "file", query: "logo", rest: "Logo" })
    expect(parseQuery("p:yard")).toMatchObject({ scope: "project", query: "yard" })
    expect(parseQuery("@box")).toMatchObject({ scope: "box", query: "box" })
    expect(parseQuery(" Dark   Mode ")).toEqual({ scope: null, query: "dark mode", rest: " Dark   Mode " })
    expect(parseQuery("fix: p:")).toMatchObject({ scope: null })
  })

  const tasks = [
    task("Smarter palette", "pr_ready", { prUrl: "https://github.com/webdevcody/box-yard/pull/79", updatedAt: 3 }),
    task("Voice providers", "done", { prUrl: "https://github.com/webdevcody/box-yard/pull/78", prState: "merged", updatedAt: 2 }),
    task("No PR here", "working"),
  ]
  const items = buildItems({ tasks, projects, schedules, artifacts, boxes })

  it("> shows only commands and pages", () => {
    const groups = search(items, ">new task")
    expect(groups.map((g) => g.key)).toEqual(["command"])
    expect(titles(groups[0])).toEqual(["New task in box-yard…", "New task in Notes app…"])
    expect(search(items, ">settings")[0]!.items[0]!.command).toBe("settings")
    expect(search(items, ">")[0]!.total).toBeGreaterThan(5)
  })

  it("# finds PRs by number or title, open ones first", () => {
    expect(titles(search(items, "#79")[0])).toEqual(["Smarter palette"])
    expect(titles(search(items, "##78")[0])).toEqual(["Voice providers"])
    expect(titles(search(items, "#voice")[0])).toEqual(["Voice providers"])
    expect(titles(search(items, "#")[0])).toEqual(["Smarter palette", "Voice providers"])
    expect(search(items, "#")[0]!.items[0]!.externalUrl).toBe("https://github.com/webdevcody/box-yard/pull/79")
    // PR rows only show up behind the prefix; the task row covers them otherwise.
    expect(group(search(items, "smarter"), "pr")).toBeUndefined()
  })

  it("f: p: and @ narrow to files, projects and boxes", () => {
    expect(search(items, "f:arch").map((g) => g.key)).toEqual(["artifact"])
    expect(search(items, "f:").map((g) => g.key)).toEqual(["artifact"])
    // Same age: by key, so the order never shuffles.
    expect(titles(search(items, "p:")[0])).toEqual(["Notes app", "box-yard"])
    expect(search(items, "p:box").map((g) => g.key)).toEqual(["project"])
    expect(titles(search(items, "@abc")[0])).toEqual(["box_abc123"])
    expect(search(items, "@")[0]!.items[0]!.href).toBe("/boxes#box_abc123")
  })
})

describe("rankPalette", () => {
  const tasks = [
    task("Fix login redirect", "failed", { updatedAt: 50 }),
    task("Add dark mode", "working", { updatedAt: 90 }),
    task("Dark mode for the Inbox", "done", { updatedAt: 10 }),
    task("Write docs", "done", { projectId: "prj_notes", updatedAt: 5 }),
  ]
  const items = buildItems({ tasks, projects, schedules, artifacts, boxes })

  it("finds every kind of thing", () => {
    // A title prefix beats a later word start, even on a working task.
    expect(titles(group(search(items, "dark"), "task"))).toEqual(["Dark mode for the Inbox", "Add dark mode"])
    expect(titles(group(search(items, "notes"), "project"))).toEqual(["Notes app"])
    expect(titles(group(search(items, "webdevcody"), "project"))).toEqual(["box-yard"])
    expect(titles(group(search(items, "digest"), "schedule"))).toEqual(["Morning digest"])
    expect(titles(group(search(items, "architecture"), "artifact"))).toEqual(["Architecture diagram"])
    expect(titles(group(search(items, "abc123"), "box"))).toEqual(["box_abc123"])
    expect(titles(group(search(items, "sched"), "command"))).toEqual(["Schedules", "New schedule…"])
  })

  it("finds done tasks in every project", () => {
    expect(titles(group(search(items, "docs"), "task"))).toEqual(["Write docs"])
  })

  it("orders groups by their best match so exact hits come first", () => {
    const groups = search(items, "inbox")
    expect(groups[0]!.key).toBe("command")
    expect(titles(groups[0])[0]).toBe("Inbox")
    expect(titles(group(groups, "task"))).toEqual(["Dark mode for the Inbox"])
  })

  it("matches multi-word queries against project and status", () => {
    expect(titles(group(search(items, "box-yard failed"), "task"))).toEqual(["Fix login redirect"])
    expect(titles(group(search(items, "notes done"), "task"))).toEqual(["Write docs"])
  })

  it("shows schedule targets and cron meaning", () => {
    const s = group(search(items, "digest"), "schedule")!.items[0]!
    expect(s.subtitle).toMatch(/^Coordinator · /)
    expect(s.subtitle).toContain("9:00")
  })

  it("returns nothing when nothing matches", () => {
    expect(search(items, "zzzzqqq")).toEqual([])
  })
})

describe("group caps", () => {
  const many = buildItems({
    tasks: Array.from({ length: 12 }, (_, i) => task(`Bug ${i}`, "done", { updatedAt: i })),
    projects: Array.from({ length: 6 }, (_, i) => project(`prj_bug${i}`, `Bug tracker ${i}`)),
    artifacts: Array.from({ length: 7 }, (_, i) => artifact(`art_bug${i}`, `Bug report ${i}`, `bug-${i}.txt`)),
  })

  it("caps tasks at 5, files and projects at 3, and counts the rest", () => {
    const groups = search(many, "bug")
    expect(group(groups, "task")).toMatchObject({ total: 12 })
    expect(group(groups, "task")!.items).toHaveLength(5)
    expect(group(groups, "project")!.items).toHaveLength(3)
    expect(group(groups, "artifact")!.items).toHaveLength(3)
    expect(group(groups, "artifact")!.total).toBe(7)
  })

  it("expands a group in place and ends each capped group with a Show all row", () => {
    const rows = paletteRows(search(many, "bug"))
    expect(rows.filter((r) => r.type === "more" && r.group !== "command").map((r) => r.type === "more" && [r.group, r.total])).toEqual([
      ["task", 12],
      ["project", 6],
      ["artifact", 7],
    ])
    expect(rows[5]).toEqual({ type: "more", group: "task", total: 12 })
    const open = paletteRows(search(many, "bug", { expanded: new Set(["task"]) }))
    expect(open.filter((r) => r.group === "task")).toHaveLength(12)
    // The first row that was hidden takes the Show all row's place.
    expect(open[5]).toMatchObject({ type: "item", group: "task" })
    // Newest first: Bug 9 … Bug 5 were shown, Bug 4 is next.
    expect(open[5]!.type === "item" && open[5]!.item.title).toBe("Bug 4")
  })
})

describe("empty query", () => {
  const tasks = [
    task("Answer me", "needs_input", { updatedAt: 40 }),
    task("Review me", "pr_ready", { updatedAt: 50 }),
    task("Busy", "working", { updatedAt: 30 }),
    task("Booting", "starting", { updatedAt: 35 }),
    task("Finished", "done", { updatedAt: 60 }),
    task("Resting", "idle", { updatedAt: 70 }),
  ]
  const items = buildItems({ tasks, projects, schedules, artifacts, boxes })

  it("shows waiting tasks, working tasks, recently viewed and the most-used commands; no files", () => {
    const groups = search(items, "  ", {
      recent: [`task:${tasks[1]!.id}`, "project:prj_notes", "task:tsk_gone", `task:${tasks[5]!.id}`, "artifact:art_1"],
      usage: { "action:new-project": 4, "page:boxes": 2 },
    })
    expect(groups.map((g) => g.key)).toEqual(["waiting", "working", "recent", "command"])
    expect(groups[0]!.label).toBe("Waiting on Cody")
    expect(titles(groups[0])).toEqual(["Review me", "Answer me"])
    expect(titles(groups[1])).toEqual(["Booting", "Busy"])
    // Tasks already shown above, missing ones and files are left out.
    expect(titles(groups[2])).toEqual(["Notes app", "Resting"])
    expect(titles(groups[3]).slice(0, 3)).toEqual(["New project…", "Boxes", "Yard"])
    expect(groups.some((g) => g.items.some((i) => i.kind === "artifact"))).toBe(false)
  })

  it("leaves out empty sections but always offers commands", () => {
    const groups = search(buildItems({ tasks: [task("Finished", "done")] }), "")
    expect(groups.map((g) => g.key)).toEqual(["command"])
    expect(groups[0]!.items).toHaveLength(5)
  })
})

describe("helpers", () => {
  it("remembers task and project routes", () => {
    expect(recentKeyFor("/tasks/tsk_1")).toBe("task:tsk_1")
    expect(recentKeyFor("/projects/prj_a?tab=notes")).toBe("project:prj_a")
    expect(recentKeyFor("/inbox")).toBeNull()
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"])
    expect(pushRecent(["a", "b"], "c", 2)).toEqual(["c", "a"])
    expect(pushRecent(Array.from({ length: 30 }, (_, i) => `k${i}`), "new")).toHaveLength(20)
  })

  it("counts command use", () => {
    expect(bumpUsage(bumpUsage({}, "page:inbox"), "page:inbox")).toEqual({ "page:inbox": 2 })
  })
})

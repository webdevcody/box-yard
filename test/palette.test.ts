import { describe, expect, it } from "vitest"
import { buildItems, parseQuery, pushRecent, recentKeyFor, scoreText, searchPalette, type PaletteGroup } from "../web/src/lib/palette.js"
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
const artifacts: Artifact[] = [
  { id: "art_1", projectId: "prj_yard", taskId: null, title: "Architecture diagram", filename: "arch.html", mime: "text/html", size: 1, url: "/artifacts/art_1/arch.html", createdAt: 1 },
]
const boxes: BoxInfo[] = [
  { id: "box_abc123", provider: "mock", status: "ready", slots: 2, runningTurns: 1, residentTasks: [], projects: ["box-yard"], createdAt: 1, lastUsedAt: 1 },
]

const titles = (g: PaletteGroup | undefined) => g?.items.map((i) => i.title) ?? []
const group = (groups: PaletteGroup[], kind: PaletteGroup["kind"]) => groups.find((g) => g.kind === kind)

describe("scoreText", () => {
  it("ranks exact over prefix over word prefix over substring over fuzzy", () => {
    const exact = scoreText("Inbox", "inbox")!
    const prefix = scoreText("Inbox zero", "inbox")!
    const word = scoreText("Clean the inbox", "inbox")!
    const sub = scoreText("Sandboxing", "box")!
    const fuzzy = scoreText("command palette", "cmdpal")!
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(sub)
    expect(sub).toBeGreaterThan(fuzzy)
    expect(fuzzy).toBeGreaterThan(0)
  })

  it("is case-insensitive and rejects scattered or missing letters", () => {
    expect(scoreText("Command Palette", "command")).not.toBeNull()
    expect(scoreText("abcdefghijklmnopqrstuvwxyz", "az")).toBeNull()
    expect(scoreText("Inbox", "outbox")).toBeNull()
    // Fuzzy hits have to start at a word.
    expect(scoreText("Deploy nebula", "dpl")).not.toBeNull()
    expect(scoreText("Command palette", "dpl")).toBeNull()
  })

  it("prefers a later word-start hit over an earlier mid-word one", () => {
    expect(scoreText("sandbox box", "box")).toBe(scoreText("the box", "box")! - 0.4)
  })
})

describe("searchPalette", () => {
  const tasks = [
    task("Fix login redirect", "failed", { updatedAt: 50 }),
    task("Add dark mode", "working", { updatedAt: 90 }),
    task("Dark mode for the Inbox", "done", { updatedAt: 10 }),
    task("Write docs", "done", { projectId: "prj_notes", updatedAt: 5 }),
  ]
  const items = buildItems({ tasks, projects, schedules, artifacts, boxes })

  it("finds every kind of thing", () => {
    expect(titles(group(searchPalette(items, "dark"), "task"))).toEqual(["Dark mode for the Inbox", "Add dark mode"])
    expect(titles(group(searchPalette(items, "notes"), "project"))).toEqual(["Notes app"])
    expect(titles(group(searchPalette(items, "webdevcody"), "project"))).toEqual(["box-yard"])
    expect(titles(group(searchPalette(items, "digest"), "schedule"))).toEqual(["Morning digest"])
    expect(titles(group(searchPalette(items, "architecture"), "artifact"))).toEqual(["Architecture diagram"])
    expect(titles(group(searchPalette(items, "abc123"), "box"))).toEqual(["box_abc123"])
    expect(titles(group(searchPalette(items, "sched"), "page"))).toEqual(["Schedules"])
  })

  it("finds done tasks in every project", () => {
    expect(titles(group(searchPalette(items, "docs"), "task"))).toEqual(["Write docs"])
  })

  it("orders groups by their best match so exact hits come first", () => {
    const groups = searchPalette(items, "inbox")
    expect(groups[0]!.kind).toBe("page")
    expect(titles(groups[0])).toEqual(["Inbox"])
    expect(titles(group(groups, "task"))).toEqual(["Dark mode for the Inbox"])
  })

  it("breaks score ties by recency", () => {
    const tied = buildItems({ tasks: [task("Deploy staging", "idle", { updatedAt: 1 }), task("Deploy prod", "idle", { updatedAt: 99 })] })
    expect(titles(group(searchPalette(tied, "deploy"), "task"))).toEqual(["Deploy prod", "Deploy staging"])
  })

  it("matches multi-word queries against project and status", () => {
    expect(titles(group(searchPalette(items, "box-yard failed"), "task"))).toEqual(["Fix login redirect"])
    expect(titles(group(searchPalette(items, "notes done"), "task"))).toEqual(["Write docs"])
  })

  it("shows schedule targets and cron meaning", () => {
    const s = group(searchPalette(items, "digest"), "schedule")!.items[0]!
    expect(s.subtitle).toMatch(/^Coordinator · /)
    expect(s.subtitle).toContain("9:00")
  })

  it("limits each group", () => {
    const many = buildItems({ tasks: Array.from({ length: 20 }, (_, i) => task(`Bug ${i}`)) })
    expect(group(searchPalette(many, "bug", { limit: 5 }), "task")!.items).toHaveLength(5)
  })

  it("> shows only actions", () => {
    const groups = searchPalette(items, ">new task")
    expect(groups.map((g) => g.kind)).toEqual(["action"])
    expect(titles(groups[0])).toEqual(["New task in box-yard…", "New task in Notes app…"])
    expect(titles(searchPalette(items, ">")[0]).length).toBeGreaterThan(3)
    expect(searchPalette(items, ">settings")[0]!.items[0]!.command).toBe("settings")
  })

  it("with no query shows recently viewed, then recently active open tasks, then pages", () => {
    const groups = searchPalette(items, "  ", { recent: ["project:prj_notes", "task:tsk_gone", tasks[0]!.id && `task:${tasks[0]!.id}`] })
    expect(groups.map((g) => g.label)).toEqual(["Recently viewed", "Recently active", "Pages"])
    expect(titles(groups[0])).toEqual(["Notes app", "Fix login redirect"])
    // Done tasks and ones already in the recent list are left out.
    expect(titles(groups[1])).toEqual(["Add dark mode"])
  })

  it("returns nothing when nothing matches", () => {
    expect(searchPalette(items, "zzzzqqq")).toEqual([])
  })
})

describe("helpers", () => {
  it("parses the > prefix", () => {
    expect(parseQuery("  > New ")).toEqual({ query: "new", actionsOnly: true })
    expect(parseQuery(" Dark Mode ")).toEqual({ query: "dark mode", actionsOnly: false })
  })

  it("remembers task and project routes", () => {
    expect(recentKeyFor("/tasks/tsk_1")).toBe("task:tsk_1")
    expect(recentKeyFor("/projects/prj_a?tab=notes")).toBe("project:prj_a")
    expect(recentKeyFor("/inbox")).toBeNull()
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"])
    expect(pushRecent(["a", "b"], "c", 2)).toEqual(["c", "a"])
  })
})

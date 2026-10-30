import { describe, expect, it } from "vitest"
import { chatProvenance, messageRefs, recentProjects } from "../web/src/lib/chatProvenance.js"
import { coordinatorRows, sourceNames } from "../web/src/lib/chatUpdates.js"
import { buildEntityIndex } from "../web/src/lib/linkify.js"
import { barCounts, projectBarRows } from "../web/src/lib/projectBar.js"
import { buildTiles } from "../web/src/lib/taskTiles.js"
import type { ChatMessage, Project, Task, TaskStatus } from "../shared/types.js"

// The Coordinator chat's project bar: which projects each message is about (a Coordinator turn as one unit, a notice
// on its own), the projects talked about lately, and what each chip counts.

const project = (id: string, name: string, createdAt = 1, extra: Partial<Project> = {}) => ({ id, name, repo: null, createdAt, color: null, ...extra }) as Project
const task = (id: string, projectId: string, title: string, status: TaskStatus = "idle", extra: Partial<Task> = {}) => ({ id, projectId, title, status, createdAt: 1, ...extra }) as Task

const YARD = project("prj_yard0001", "box-yard", 1)
const MAP = project("prj_map00001", "Map 3", 2)
const NOTES = project("prj_notes001", "Notes", 3)
const PROJECTS = [YARD, MAP, NOTES]
const LOGIN = task("task_login001", YARD.id, "Fix login")
const CARDS = task("task_cards001", YARD.id, "Coordinator cards", "working")
const LEVEL = task("task_level001", MAP.id, "Level 7 terrain", "queued")
const TASKS = [LOGIN, CARDS, LEVEL]
const index = buildEntityIndex({ projects: PROJECTS, tasks: TASKS })

let seq = 0
const msg = (role: ChatMessage["role"], content: string, meta?: Record<string, unknown>, createdAt = ++seq): ChatMessage => ({ id: `chat_${String(++seq).padStart(4, "0")}`, role, content, meta, createdAt })
const user = (text: string) => msg("user", text)
const reply = (text: string) => msg("assistant", text)
const tool = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => msg("tool", name, { input, ...extra })
const notice = (taskId: string, projectId: string, text: string) => msg("notice", text, { taskId, projectId })

describe("messageRefs", () => {
  it("reads a notice's task and project", () => {
    expect(messageRefs(notice(LOGIN.id, YARD.id, "✅ **Fix login** is done"), index)).toEqual({ tasks: [LOGIN.id], projects: [YARD.id] })
  })

  it("reads a tool call's task, project (by name) and the task it created", () => {
    expect(messageRefs(tool("send_to_task", { task: LOGIN.id, message: "x" }), index).projects).toEqual([YARD.id])
    expect(messageRefs(tool("create_tasks", { project: "Map 3", tasks: [{ title: "a", prompt: "b" }] }), index).projects).toEqual([MAP.id])
    expect(messageRefs(tool("create_task", { project: "box-yard", title: "Coordinator cards" }, { resultId: CARDS.id }), index)).toEqual({ tasks: [CARDS.id], projects: [YARD.id] })
    expect(messageRefs(tool("send_to_captain", { project: "Notes", message: "x" }), index).projects).toEqual([NOTES.id])
  })

  it("reads task links, ids and bold titles in a reply", () => {
    expect(messageRefs(reply(`[Fix login](/tasks/${LOGIN.id}) is done, and **Level 7 terrain** is queued.`), index)).toEqual({ tasks: [LOGIN.id, LEVEL.id], projects: [YARD.id, MAP.id] })
    expect(messageRefs(reply(`See ${NOTES.id}.`), index).projects).toEqual([NOTES.id])
    expect(messageRefs(reply("**Nothing** here, and task_unknown123 isn't a task."), index)).toEqual({ tasks: [], projects: [] })
  })

  it("reads a Captain's report: its project and the tasks it names", () => {
    const m = msg("notice", `Captain for Map 3 replied: started ${LEVEL.id}`, { projectId: MAP.id, captain: true })
    expect(messageRefs(m, index)).toEqual({ tasks: [LEVEL.id], projects: [MAP.id] })
  })
})

describe("chatProvenance", () => {
  it("gives every message of a turn the projects any of them names", () => {
    const ask = user("Start the terrain work and check on login")
    const call = tool("create_task", { project: "Map 3", title: "Level 7 terrain" }, { resultId: LEVEL.id })
    const answer = reply(`Started it; [Fix login](/tasks/${LOGIN.id}) is still idle.`)
    const p = chatProvenance([ask, call, answer], index)
    for (const m of [ask, call, answer]) expect([...p.projects.get(m.id)!].sort()).toEqual([MAP.id, YARD.id].sort())
  })

  it("keeps a notice to its own project, even mid-turn", () => {
    const ask = user("Check box-yard")
    const mid = notice(LEVEL.id, MAP.id, "▶️ **Level 7 terrain** started")
    const answer = reply(`[Fix login](/tasks/${LOGIN.id}) is fine.`)
    const p = chatProvenance([ask, mid, answer], index)
    expect([...p.projects.get(mid.id)!]).toEqual([MAP.id])
    expect([...p.projects.get(ask.id)!]).toEqual([YARD.id])
  })

  it("a reply is also about the updates it read (its from: line)", () => {
    // A hook firing on a task is the Coordinator's to read (a task's other notices go to its Captain).
    const done = notice(LOGIN.id, YARD.id, "🪝 **Fix login** hook fired: Review")
    const captain = msg("notice", "Captain for Map 3 replied: all good", { projectId: MAP.id, captain: true })
    const answer = reply("Both are fine.")
    const all = [done, captain, answer]
    const rows = coordinatorRows(all)
    const p = chatProvenance(all, index, rows)
    expect([...p.projects.get(answer.id)!].sort()).toEqual([MAP.id, YARD.id].sort())
    // Without the rows, the reply names nothing.
    expect(chatProvenance(all, index).projects.get(answer.id)!.size).toBe(0)
  })

})

describe("recentProjects", () => {
  it("lists the projects talked about lately", () => {
    const old = { ...notice(LEVEL.id, MAP.id, "▶️ **Level 7 terrain** started"), createdAt: 0 }
    const now = { ...notice(LOGIN.id, YARD.id, "✅ **Fix login** is done"), createdAt: 100 }
    const msgs = [old, now]
    expect([...recentProjects(msgs, chatProvenance(msgs, index), 50)]).toEqual([YARD.id])
  })
})

describe("projectBarRows", () => {
  const tasks = [
    task("t1", YARD.id, "a", "working"),
    task("t2", YARD.id, "b", "needs_input"),
    task("t3", YARD.id, "c", "pr_ready"),
    task("t4", MAP.id, "d", "queued"),
    task("t5", MAP.id, "e", "starting"),
    task("t6", NOTES.id, "f", "done"),
  ]

  it("counts what each project's tasks are doing, in the sidebar's order", () => {
    const { rows, active } = projectBarRows(PROJECTS, tasks, new Set(), null)
    expect(rows.map((r) => r.name)).toEqual(["box-yard", "Map 3"])
    expect(rows[0]).toMatchObject({ needs: 1, running: 1, queued: 0, prReady: 1 })
    expect(rows[1]).toMatchObject({ needs: 0, running: 1, queued: 1, prReady: 0 })
    expect(active).toBe(4)
    expect(barCounts(rows[0]!).map((c) => `${c.n} ${c.label}`)).toEqual(["1 needs you", "1 running", "1 PR ready"])
  })

  it("keeps pinned projects on and unpinned ones off (but the filter, and +N for any asking you)", () => {
    const pins = { [NOTES.id]: "pinned", [YARD.id]: "unpinned", [MAP.id]: "unpinned" } as const
    const { rows, active, hidden } = projectBarRows(PROJECTS, tasks, new Set([YARD.id]), null, pins)
    expect(rows.map((r) => r.name)).toEqual(["Notes"])
    // All still counts every project's tasks.
    expect(active).toBe(4)
    // box-yard has a task asking; Map 3 is only busy.
    expect(hidden.map((r) => r.name)).toEqual(["box-yard"])
    expect(projectBarRows(PROJECTS, tasks, new Set(), MAP.id, pins).rows.map((r) => r.name)).toEqual(["Map 3", "Notes"])
  })

  it("shows a quiet project the chat talked about, and the one it's filtered to", () => {
    expect(projectBarRows(PROJECTS, tasks, new Set([NOTES.id]), null).rows.map((r) => r.name)).toEqual(["box-yard", "Map 3", "Notes"])
    expect(projectBarRows(PROJECTS, [], new Set(), NOTES.id).rows.map((r) => r.name)).toEqual(["Notes"])
  })
})

describe("tiles", () => {
  it("gives each task its icon and its project's colour", () => {
    const tiles = buildTiles([LOGIN, { ...LEVEL, icon: "rocket" }], [YARD, { ...MAP, color: "teal" }])
    expect(tiles.tasks.get(LOGIN.id)).toMatchObject({ icon: "bug", projectName: "box-yard", color: tiles.colors.get(YARD.id) })
    expect(tiles.tasks.get(LEVEL.id)).toMatchObject({ icon: "rocket", color: "teal" })
    expect(tiles.colors.get(YARD.id)).not.toBe("teal")
  })
})

describe("sourceNames", () => {
  it("names each source once, with its task", () => {
    const done = notice(LOGIN.id, YARD.id, "🪝 **Fix login** hook fired: Review")
    const again = notice(LOGIN.id, YARD.id, "🪝 **Fix login** hook fired: Lint")
    const captain = msg("notice", "Captain for Map 3 replied: ok", { projectId: MAP.id, captain: true })
    const answer = reply("ok")
    const rows = coordinatorRows([done, again, captain, answer])
    const r = rows.find((x) => x.type === "message")!
    expect(r.type === "message" && sourceNames(r.sources!, () => "?")).toEqual([
      { label: "Fix login", taskId: LOGIN.id },
      { label: "Map 3 Captain", taskId: null },
    ])
  })
})

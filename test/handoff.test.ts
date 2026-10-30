import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { NAMED_REPLY_CHARS, NAMED_TASKS_HEADING, namedProjects, namedState, namedTasks, type PrLookup } from "../server/handoff.js"
import type { Task } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

// Speed step 2, state up front: the tasks and projects a message names go with it, so the turn needs no lookup step.

function seed() {
  const store = new Store(openDb(tmpDir(), ":memory:"))
  const yard = store.createProject({ id: "prj_yard01", name: "box-yard" })
  const game = store.createProject({ id: "prj_game01", name: "survive-the-night" })
  const timing = store.createTask({ id: "task_timing01", projectId: yard.id, title: "Speed step 1: per-turn timing", prompt: "p" })
  store.updateTask(timing.id, { status: "idle", prUrl: "https://github.com/webdevcody/box-yard/pull/184", prState: "open" })
  const cache = store.createTask({ id: "task_cache001", projectId: yard.id, title: "Speed: 1-hour prompt cache", prompt: "p" })
  store.updateTask(cache.id, { status: "working" })
  const map = store.createTask({ id: "task_map0001", projectId: game.id, title: "Map 3: Dam Hamlet workers' camp", prompt: "p" })
  store.updateTask(map.id, { status: "done", prUrl: "https://github.com/webdevcody/survive-the-night/pull/184", prState: "merged" })
  const old = store.createTask({ id: "task_old00001", projectId: game.id, title: "Fix", prompt: "p" })
  store.updateTask(old.id, { status: "needs_input", question: "Which map first?" })
  return { store, yard, game, tasks: () => store.listTasks() }
}

const ids = (list: Task[]) => list.map((t) => t.id)

describe("namedTasks", () => {
  it("finds tasks by id, PR URL, \"PR #N\" and full title, in the order the text names them", () => {
    const { tasks } = seed()
    expect(ids(namedTasks("is task_cache001 done? and what about https://github.com/webdevcody/box-yard/pull/184", tasks()))).toEqual(["task_cache001", "task_timing01"])
    expect(ids(namedTasks("how's map 3: dam hamlet workers' camp going?", tasks()))).toEqual(["task_map0001"])
    // "PR #184" means a PR: every task whose PR has that number, whichever repo.
    expect(ids(namedTasks("did PR #184 merge?", tasks())).sort()).toEqual(["task_map0001", "task_timing01"])
    expect(ids(namedTasks("did pull request 184 merge?", tasks())).sort()).toEqual(["task_map0001", "task_timing01"])
  })

  it("ignores unknown ids, short titles, and a PR number inside a URL that names another repo", () => {
    const { tasks } = seed()
    expect(namedTasks("task_nothere01 and Fix it please", tasks())).toEqual([])
    expect(namedTasks("see https://github.com/someone/else/pull/184", tasks())).toEqual([])
    expect(namedTasks("", tasks())).toEqual([])
  })

  it("counts a bare #N only when it's unambiguous", () => {
    const { store, tasks } = seed()
    expect(ids(namedTasks("#184 looks good", tasks())).sort()).toEqual(["task_map0001", "task_timing01"])
    const third = store.createTask({ id: "task_third001", projectId: "prj_game01", title: "Another one", prompt: "p" })
    store.updateTask(third.id, { prUrl: "https://github.com/webdevcody/other/pull/184" })
    expect(namedTasks("#184 looks good", tasks())).toEqual([])
    expect(namedTasks("PR #184 looks good", tasks())).toHaveLength(3)
  })

  it("keeps at most `max`", () => {
    const { tasks } = seed()
    expect(namedTasks("task_timing01 task_cache001 task_map0001", tasks(), 2)).toHaveLength(2)
  })
})

describe("namedProjects", () => {
  it("finds projects by whole-word name or id", () => {
    const { store } = seed()
    const projects = store.listProjects()
    expect(namedProjects("what's open in survive-the-night and box-yard?", projects).map((p) => p.id)).toEqual(["prj_game01", "prj_yard01"])
    expect(namedProjects("prj_yard01 please", projects).map((p) => p.id)).toEqual(["prj_yard01"])
    // Part of a longer word doesn't count.
    expect(namedProjects("box-yard-2 is new", projects)).toEqual([])
  })
})

describe("namedState", () => {
  it("gives each named task's status, PR and the start of its last reply", async () => {
    const { store, tasks } = seed()
    store.addTaskMessage("task_timing01", "assistant", "First reply.")
    store.addTaskMessage("task_timing01", "assistant", `Done: PR #184 adds timings. ${"x".repeat(NAMED_REPLY_CHARS)}`)
    const block = (await namedState("where's task_timing01?", { tasks: tasks() }, { store }, NAMED_TASKS_HEADING))!
    expect(block.split("\n")[0]).toBe(NAMED_TASKS_HEADING)
    expect(block).toContain(`- task_timing01 "Speed step 1: per-turn timing" idle · PR #184 open (unconfirmed: GitHub hasn't answered yet) https://github.com/webdevcody/box-yard/pull/184`)
    expect(block).toMatch(/Last reply: Done: PR #184 adds timings\. x+… \[\d+ more chars: get_task has it in full\]/)
    expect(block).not.toContain("First reply.")
  })

  it("is null when the message names nothing", async () => {
    const { store, tasks } = seed()
    expect(await namedState("hello there", { tasks: tasks(), projects: store.listProjects() }, { store }, "H")).toBeNull()
  })

  it("asks GitHub about the named open PRs first and shows the state it got", async () => {
    const { store, tasks } = seed()
    const asked: string[][] = []
    const checks = new Map<string, number>()
    const prs: PrLookup = {
      async ensureFresh(taskIds) {
        asked.push(taskIds ?? [])
        store.updateTask("task_timing01", { prState: "merged" })
        checks.set("task_timing01", Date.now())
      },
      prCheck: (id) => ({ checkedAt: checks.get(id) ?? null, error: null }),
    }
    const block = (await namedState("task_timing01 and task_map0001", { tasks: tasks() }, { store, prs }, "H"))!
    // The merged PR is settled: only the open one is asked about.
    expect(asked).toEqual([["task_timing01"]])
    expect(block).toContain("PR #184 merged https://github.com/webdevcody/box-yard/pull/184")
    expect(block).toContain("PR #184 merged https://github.com/webdevcody/survive-the-night/pull/184")
  })

  it("says a PR's state is fresh when GitHub checked it lately, and starts without GitHub when it hangs", async () => {
    const { store, tasks } = seed()
    const prs: PrLookup = { ensureFresh: () => new Promise(() => {}), prCheck: () => ({ checkedAt: Date.now() - 30_000, error: null }) }
    const t0 = Date.now()
    const block = (await namedState("task_timing01", { tasks: tasks() }, { store, prs }, "H"))!
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(block).toContain("PR #184 open (GitHub checked 30s ago)")
  })

  it("shows a status-only task's status and PR, never its reply, question or error", async () => {
    const { store, tasks } = seed()
    store.addTaskMessage("task_old00001", "assistant", "secret content")
    const block = (await namedState("task_old00001", { tasks: tasks() }, { store, sealed: (t) => t.projectId === "prj_game01" }, "H"))!
    expect(block).toContain(`- task_old00001 "Fix" needs_input`)
    expect(block).toContain("status only")
    expect(block).not.toContain("secret content")
    expect(block).not.toContain("Which map first?")
    const open = (await namedState("task_old00001", { tasks: tasks() }, { store }, "H"))!
    expect(open).toContain("Asks: Which map first?")
    expect(open).toContain("Last reply: secret content")
  })

  it("lists a named project's open tasks, most recent first, with their project for the Coordinator", async () => {
    const { store, tasks } = seed()
    const block = (await namedState(
      "what's going on in box-yard? also task_map0001",
      { tasks: tasks(), projects: store.listProjects() },
      { store, projectNames: new Map(store.listProjects().map((p) => [p.id, p.name])) },
      "H",
    ))!
    expect(block).toContain(`- task_map0001 "Map 3: Dam Hamlet workers' camp" [survive-the-night] done`)
    expect(block).toContain("Projects it names (open tasks):")
    expect(block).toContain("- box-yard (prj_yard01): 2 open tasks")
    expect(block).toMatch(/task_cache001 "Speed: 1-hour prompt cache" working/)
    expect(block).toMatch(/task_timing01 "Speed step 1: per-turn timing" idle · PR #184 open/)
  })
})

describe("prompts", () => {
  it("tell the Coordinator to answer quick questions itself, and Captains to answer from the block", async () => {
    const { ORCHESTRATOR_PROMPT, captainPrompt, PR_FRESH_RULE } = await import("../server/prompts.js")
    expect(ORCHESTRATOR_PROMPT).toMatch(/Quick questions first: .*Answer these yourself, in this turn/)
    expect(ORCHESTRATOR_PROMPT).toMatch(/Name the tasks it's about by id/)
    expect(captainPrompt({ id: "prj_x00001", name: "x", repo: null, baseBranch: "main" } as never)).toContain(`"[Tasks this message names …]" block`)
    expect(PR_FRESH_RULE).toContain("block of named tasks")
  })
})

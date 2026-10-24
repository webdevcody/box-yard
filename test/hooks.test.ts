import { describe, expect, it } from "vitest"
import {
  SAMPLE_HOOK_VARS,
  hookMismatch,
  hookProblems,
  normalizeFilters,
  renderHookTemplate,
  unknownVariables,
  type Hook,
  type HookFilters,
  type HookSubject,
} from "../shared/hooks.js"
import { fireKey, taskSource } from "../server/hooks.js"

const hook = (over: Partial<Hook> = {}, filters: HookFilters = {}): Pick<Hook, "enabled" | "trigger" | "projectId" | "filters"> => ({
  enabled: true,
  trigger: "task.pr_ready",
  projectId: null,
  filters,
  ...over,
})

const subject = (over: Partial<HookSubject> = {}): HookSubject => ({
  trigger: "task.pr_ready",
  projectId: "prj_a",
  title: "Add dark mode",
  prompt: "Add a dark mode toggle to Settings",
  source: "cody",
  status: "pr_ready",
  prUrl: "https://github.com/acme/site/pull/7",
  prState: "open",
  prLabels: [],
  quiet: false,
  ...over,
})

describe("hook prompt templates", () => {
  it("fills in every variable and leaves unknown names alone", () => {
    const out = renderHookTemplate("Merge {pr_url} (#{pr_number}) on {branch} at {head_sha} for {task_title} [{task_id}] in {project}: {status}. {summary} {nope}", SAMPLE_HOOK_VARS)
    expect(out).toBe(
      `Merge ${SAMPLE_HOOK_VARS.pr_url} (#42) on ${SAMPLE_HOOK_VARS.branch} at ${SAMPLE_HOOK_VARS.head_sha} for Add a dark mode toggle [task_1a2b3c4d5e6f] in box-yard: pr_ready. ${SAMPLE_HOOK_VARS.summary} {nope}`,
    )
  })

  it("renders missing values as empty and names typos", () => {
    expect(renderHookTemplate("PR {pr_url}.", {})).toBe("PR .")
    expect(unknownVariables("{pr_url} {pr_nubmer} {x} {pr_nubmer}")).toEqual(["pr_nubmer", "x"])
  })
})

describe("hook matching", () => {
  it("matches its own trigger only, and only when enabled", () => {
    expect(hookMismatch(hook(), subject())).toBeNull()
    expect(hookMismatch(hook({ trigger: "task.failed" }), subject())).toMatch(/runs on task.failed/)
    expect(hookMismatch(hook({ enabled: false }), subject())).toMatch(/off/)
  })

  it("a project hook only sees its own project; a global hook's project filter narrows it", () => {
    expect(hookMismatch(hook({ projectId: "prj_a" }), subject())).toBeNull()
    expect(hookMismatch(hook({ projectId: "prj_b" }), subject())).toMatch(/another project/)
    expect(hookMismatch(hook({}, { projectId: "prj_b" }), subject())).toMatch(/another project/)
    expect(hookMismatch(hook({}, { projectId: "prj_a" }), subject())).toBeNull()
  })

  it("filters on title and prompt regexes, case-insensitively", () => {
    expect(hookMismatch(hook({}, { titleRegex: "dark\\s+MODE" }), subject())).toBeNull()
    expect(hookMismatch(hook({}, { titleRegex: "^fix" }), subject())).toMatch(/title/)
    expect(hookMismatch(hook({}, { promptRegex: "settings$" }), subject())).toBeNull()
    expect(hookMismatch(hook({}, { promptRegex: "billing" }), subject())).toMatch(/prompt/)
    // An invalid pattern never matches (the API rejects it on save).
    expect(hookMismatch(hook({}, { titleRegex: "(" }), subject())).toMatch(/title/)
  })

  it("filters on who started the task", () => {
    expect(hookMismatch(hook({}, { sources: ["cody", "schedule"] }), subject())).toBeNull()
    expect(hookMismatch(hook({}, { sources: ["captain"] }), subject())).toMatch(/someone else/)
    expect(hookMismatch(hook({}, { sources: ["captain"] }), subject({ source: "captain" }))).toBeNull()
    expect(hookMismatch(hook({}, { sources: ["cody"] }), subject({ source: null }))).toMatch(/someone else/)
    expect(hookMismatch(hook({}, { sources: ["cody"] }), subject({ source: "hook" }))).toMatch(/someone else/)
  })

  it("requires one of the labels, and skips excluded labels like no-automerge", () => {
    expect(hookMismatch(hook({}, { labels: ["automerge", "ship"] }), subject({ prLabels: ["Ship"] }))).toBeNull()
    expect(hookMismatch(hook({}, { labels: ["automerge"] }), subject({ prLabels: ["bug"] }))).toMatch(/required label/)
    expect(hookMismatch(hook({}, { labels: ["automerge"] }), subject({ prUrl: null, prState: null }))).toMatch(/no PR/)
    expect(hookMismatch(hook({}, { excludeLabels: ["no-automerge"] }), subject({ prLabels: ["No-Automerge", "bug"] }))).toMatch(/labelled no-automerge/)
    expect(hookMismatch(hook({}, { excludeLabels: ["no-automerge"] }), subject({ prLabels: ["bug"] }))).toBeNull()
  })

  it("skips draft PRs unless includeDrafts is on", () => {
    expect(hookMismatch(hook(), subject({ prState: "draft" }))).toMatch(/draft/)
    expect(hookMismatch(hook({}, { includeDrafts: true }), subject({ prState: "draft" }))).toBeNull()
    // Not a PR trigger and no label filter: the draft doesn't matter.
    expect(hookMismatch(hook({ trigger: "task.finished" }), subject({ trigger: "task.finished", prState: "draft" }))).toBeNull()
  })

  it("skips quiet no-op schedule runs unless includeQuiet is on", () => {
    const run = subject({ trigger: "schedule.run_finished", source: "schedule", quiet: true, prUrl: null, prState: null })
    expect(hookMismatch(hook({ trigger: "schedule.run_finished" }), run)).toMatch(/quiet/)
    expect(hookMismatch(hook({ trigger: "schedule.run_finished" }, { includeQuiet: true }), run)).toBeNull()
  })
})

describe("hook filter and field checks", () => {
  it("normalizes filters: trims, dedupes and drops empty ones", () => {
    expect(
      normalizeFilters({ titleRegex: "  ", labels: [" a ", "a", ""], excludeLabels: [], sources: ["cody", "nope" as never], includeDrafts: false, includeQuiet: true }),
    ).toEqual({ labels: ["a"], sources: ["cody"], includeQuiet: true })
  })

  it("names what would make a hook never work", () => {
    expect(hookProblems({ name: "x", prompt: "y", action: "send_to_task" })).toEqual([])
    expect(hookProblems({ name: " ", prompt: "", action: "create_task", taskTitle: "", filters: { titleRegex: "(" }, maxFiresPerTask: 0 })).toEqual([
      "Give the hook a name.",
      "Write the prompt the hook sends.",
      "A hook that creates tasks needs a task title.",
      "The title pattern isn't a valid regular expression.",
      "Fires per task must be a whole number from 1 to 50.",
    ])
  })
})

describe("fire keys and task sources", () => {
  const ev = (type: Parameters<typeof fireKey>[0]["type"], over: Partial<Parameters<typeof fireKey>[0]> = {}) => ({ type, taskId: "t", turnId: "turn1", originHookIds: [], ...over })

  it("keys pr_ready by head commit, so a new push fires again and the same commit doesn't", () => {
    expect(fireKey(ev("task.pr_ready"), { pr_head_sha: "abc1234", pr_url: "u" })).toBe("sha:abc1234")
    expect(fireKey(ev("task.pr_ready", { turnId: "turn2" }), { pr_head_sha: "abc1234", pr_url: "u" })).toBe("sha:abc1234")
    expect(fireKey(ev("task.pr_ready"), { pr_head_sha: "def5678", pr_url: "u" })).toBe("sha:def5678")
    // No known commit: only a turn that pushed counts, once.
    expect(fireKey(ev("task.pr_ready", { sawPr: true }), { pr_head_sha: null, pr_url: "u" })).toBe("turn:turn1")
    expect(fireKey(ev("task.pr_ready"), { pr_head_sha: null, pr_url: "u" })).toBeNull()
  })

  it("keys pr.merged by PR and the rest by the turn that ended", () => {
    expect(fireKey(ev("pr.merged"), { pr_head_sha: "abc", pr_url: "u" })).toBe("merged:u")
    expect(fireKey(ev("task.finished"), { pr_head_sha: null, pr_url: null })).toBe("turn:turn1")
  })

  it("reads who started a task from its source column", () => {
    expect(taskSource({ source: "cody", schedule_id: null })).toBe("cody")
    expect(taskSource({ source: "orchestrator", schedule_id: null })).toBe("coordinator")
    expect(taskSource({ source: "captain:prj_a", schedule_id: null })).toBe("captain")
    expect(taskSource({ source: "schedule", schedule_id: "sch_1" })).toBe("schedule")
    expect(taskSource({ source: null, schedule_id: "sch_1" })).toBe("schedule")
    expect(taskSource({ source: "hook:hook_1", schedule_id: null })).toBe("hook")
    expect(taskSource({ source: null, schedule_id: null })).toBeNull()
  })
})

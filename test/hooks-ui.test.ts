// @vitest-environment happy-dom
// The Hooks UI: the pure editor helpers, the panel (list, toggles, template card, Recent runs) and the
// editor Modal with its live preview.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Router } from "wouter"
import { memoryLocation } from "wouter/memory-location"
import { HooksPanel } from "../web/src/components/Hooks.js"
import { keys } from "../web/src/lib/queries.js"
import {
  draftFromHook,
  draftFromTemplate,
  draftProblems,
  draftToInput,
  draftWarnings,
  emptyDraft,
  filterChips,
  filterHooks,
  filterRuns,
  insertVariable,
  previewVars,
  runCounts,
} from "../web/src/lib/hookForm.js"
import { userMessageLabel } from "../shared/sender.js"
import { parseNotice } from "../web/src/lib/captainTranscript.js"
import { SAMPLE_HOOK_VARS, type HookRun, type HookTemplateView, type HookWithLastRun } from "../shared/hooks.js"
import type { Project, Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MERGE_PROMPT = "Merge your pull request #{pr_number}. Reply with the merge SHA or the error."

const template: HookTemplateView = {
  key: "pr_merge",
  description: "When an agent's PR is ready, send it the Merge PR button's standard merge request.",
  name: "On PR ready → merge",
  trigger: "task.pr_ready",
  action: "send_to_task",
  filters: { excludeLabels: ["no-automerge"] },
  prompt: MERGE_PROMPT,
  maxFiresPerTask: 3,
}

const hook = (over: Partial<HookWithLastRun> = {}): HookWithLastRun => ({
  id: "hook_aaaaaaaaaaaa",
  name: "Auto-merge",
  projectId: "prj_demo01",
  trigger: "task.pr_ready",
  filters: { excludeLabels: ["no-automerge"], sources: ["cody", "captain"] },
  action: "send_to_task",
  taskTitle: null,
  prompt: MERGE_PROMPT,
  enabled: true,
  allowSelfTrigger: false,
  maxFiresPerTask: 3,
  template: "pr_merge",
  createdBy: "Cody",
  createdAt: 1,
  updatedAt: 1,
  lastRun: null,
  ...over,
})

const run = (over: Partial<HookRun> = {}): HookRun => ({
  id: `hrun_${Math.random()}`,
  hookId: "hook_aaaaaaaaaaaa",
  hookName: "Auto-merge",
  hookProjectId: "prj_demo01",
  projectId: "prj_demo01",
  taskId: "task_aaaaaaaaaaaa",
  taskTitle: "Add dark mode",
  event: "task.pr_ready",
  headSha: "9f3c2e1a7b6d5c4e3f2a1b0c9d8e7f6a5b4c3d2e",
  action: "send_to_task",
  prompt: "Merge your pull request #42.",
  status: "fired",
  guard: null,
  result: "Asked the agent to merge (PR #42 at 9f3c2e1).",
  targetTaskId: "task_aaaaaaaaaaaa",
  createdAt: Date.now() - 60_000,
  ...over,
})

const task = { id: "task_aaaaaaaaaaaa", projectId: "prj_demo01", title: "Add dark mode", status: "pr_ready", prUrl: "https://github.com/acme/site/pull/42", branch: "boxyard/dark", summary: "Opened the PR.", updatedAt: 1 } as Task

describe("hook editor helpers", () => {
  it("round-trip a hook through the draft, and a template starts off", () => {
    const h = hook({ filters: { titleRegex: "^feat", labels: ["ship"], excludeLabels: ["no-automerge"], sources: ["cody"], includeDrafts: true } })
    const d = draftFromHook(h)
    expect(d.labels).toBe("ship")
    expect(draftToInput(d, "prj_demo01")).toEqual({
      projectId: "prj_demo01",
      name: "Auto-merge",
      trigger: "task.pr_ready",
      filters: { titleRegex: "^feat", labels: ["ship"], excludeLabels: ["no-automerge"], sources: ["cody"], includeDrafts: true },
      action: "send_to_task",
      taskTitle: null,
      prompt: MERGE_PROMPT,
      enabled: true,
      allowSelfTrigger: false,
      maxFiresPerTask: 3,
    })
    const t = draftFromTemplate(template)
    expect(t).toMatchObject({ name: "On PR ready → merge", enabled: false, template: "pr_merge", excludeLabels: "no-automerge", prompt: MERGE_PROMPT })
    // A project hook never sends a project filter; a global one does.
    expect(draftToInput({ ...emptyDraft(), name: "x", prompt: "y", projectFilter: "prj_b" }, "prj_a").filters).toEqual({})
    expect(draftToInput({ ...emptyDraft(), name: "x", prompt: "y", projectFilter: "prj_b" }, null).filters).toEqual({ projectId: "prj_b" })
  })

  it("say what blocks a save and warn about likely mistakes", () => {
    expect(draftProblems(emptyDraft())).toEqual(["Give the hook a name.", "Write the prompt the hook sends."])
    expect(draftProblems({ ...emptyDraft(), name: "x", prompt: "y", maxFiresPerTask: "" })).toEqual(["Fires per task must be a whole number from 1 to 50."])
    expect(draftWarnings({ ...emptyDraft(), trigger: "task.failed", prompt: "Look at {pr_url} {pr_nubmer}" })).toEqual([
      "{pr_nubmer} isn't a variable, so it's sent as written.",
      "This trigger can fire for tasks without a PR; PR variables are empty then.",
    ])
  })

  it("preview with a real task's values, or the samples", () => {
    expect(previewVars(null)).toBe(SAMPLE_HOOK_VARS)
    expect(previewVars(task, "site")).toMatchObject({ task_id: task.id, project: "site", pr_number: "42", pr_url: task.prUrl, branch: "boxyard/dark", status: "pr_ready" })
    expect(insertVariable("Merge  now", "pr_url", 6)).toEqual({ text: "Merge {pr_url} now", cursor: 14 })
  })

  it("describe filters as chips and filter hooks and runs", () => {
    expect(filterChips({ projectId: "prj_b", titleRegex: "^feat", sources: ["cody", "schedule"], labels: ["ship"], excludeLabels: ["no-automerge"], includeDrafts: true }, () => "beta")).toEqual([
      "Only beta",
      "Title ~ /^feat/",
      "Started by Cody or Schedule",
      "Label ship",
      "Not no-automerge",
      "Drafts too",
    ])
    expect(filterHooks([hook(), hook({ id: "h2", enabled: false })], "off").map((h) => h.id)).toEqual(["h2"])
    const runs = [run(), run({ status: "skipped", guard: "loop" }), run({ hookId: "h2", status: "failed" })]
    expect(runCounts(runs)).toEqual({ all: 3, fired: 1, skipped: 1, failed: 1 })
    expect(runCounts(runs, "h2")).toEqual({ all: 1, fired: 0, skipped: 0, failed: 1 })
    expect(filterRuns(runs, "skipped").map((r) => r.guard)).toEqual(["loop"])
  })

  it("label hook messages and notices", () => {
    expect(userMessageLabel({ source: "hook", hookName: "Auto-merge" })).toBe("Hook: Auto-merge")
    const n = parseNotice('🪝 **Add dark mode** hook "Auto-merge" (PR ready) sent to the agent (PR #42 at 9f3c2e1): Merge your pull request #42.', { taskId: "t" })
    expect(n.kind).toBe("hook")
    expect(n.title).toBe("Add dark mode")
    expect(n.summary.map((s) => ("text" in s ? s.text : s.label)).join("")).toBe('hook "Auto-merge" (PR ready) sent to the agent (PR #42 at 9f3c2e1): Merge your pull request #42.')
  })
})

describe("the Hooks panel", () => {
  let root: Root
  let host: HTMLElement
  let qc: QueryClient
  let requests: { url: string; method: string; body: any }[]
  let location: ReturnType<typeof memoryLocation>
  /** What the fake server holds; the panel's queries start from it too. */
  let server: HookWithLastRun[]
  const seed = (hooks: HookWithLastRun[]) => {
    server = hooks
    qc.setQueryData(keys.hooks("prj_demo01"), hooks)
  }

  beforeEach(() => {
    requests = []
    server = []
    // A tiny /api/hooks: lists, PATCH, create and create-from-template.
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET"
      const body = init.body ? JSON.parse(String(init.body)) : null
      requests.push({ url, method, body })
      let out: unknown = server
      if (url.startsWith("/api/hooks/runs")) out = qc.getQueryData(keys.hookRuns("prj_demo01"))
      else if (method === "PATCH") {
        server = server.map((h) => (url.endsWith(h.id) ? { ...h, ...body } : h))
        out = server.find((h) => url.endsWith(h.id))
      } else if (method === "POST") {
        const created = url.endsWith("from-template") ? hook({ id: "hook_new", name: template.name, enabled: false }) : hook({ ...body, id: "hook_new", lastRun: null })
        server = [...server, created]
        out = created
      }
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } })
    })
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(keys.projects, [{ id: "prj_demo01", name: "demo", notes: [] } as unknown as Project])
    qc.setQueryData(keys.tasks, [task])
    qc.setQueryData(keys.hookTemplates, [template])
    qc.setQueryData(keys.hookRuns("prj_demo01"), [run(), run({ status: "skipped", guard: "loop", result: "Skipped by the loop guard: this hook's own prompt started this work." })])
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    location = memoryLocation({ path: "/projects/prj_demo01?tab=hooks", record: true })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ""
    vi.unstubAllGlobals()
  })

  const render = (node: ReactNode) =>
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Router, { hook: location.hook, searchHook: location.searchHook }, node))))
  const click = (el: Element | null | undefined) => act(() => void el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
  const button = (text: string | RegExp, within: ParentNode = document) =>
    [...within.querySelectorAll("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")))
  const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))

  it("lists hooks with their trigger, action, filters and last run, and the template card says it's added", () => {
    seed([hook({ lastRun: run() }), hook({ id: "hook_b", name: "Docs", enabled: false, template: null, trigger: "task.finished", action: "create_task", taskTitle: "Docs for {task_title}", filters: {} })])
    render(createElement(HooksPanel, { projectId: "prj_demo01" }))
    const rows = host.querySelectorAll('[data-testid="hook-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain("PR ready → Send to the task")
    expect(rows[0]!.textContent).toContain("Not no-automerge")
    expect(rows[0]!.textContent).toContain("Started by Cody or Captain")
    expect(rows[0]!.textContent).toContain("Add dark mode")
    expect(rows[1]!.textContent).toContain("Task finished → Create a task")
    expect(rows[1]!.textContent).toContain("Hasn't fired yet")
    expect(host.querySelector('[data-testid="hook-template"]')!.textContent).toContain("Added · on")
    // Tabs and filters rather than one long list.
    click(button(/^Off/))
    expect(host.querySelectorAll('[data-testid="hook-row"]')).toHaveLength(1)
  })

  it("switches a hook on and off right away", async () => {
    seed([hook({ enabled: false })])
    render(createElement(HooksPanel, { projectId: "prj_demo01" }))
    const sw = host.querySelector('[role="switch"]')!
    expect(sw.getAttribute("aria-checked")).toBe("false")
    click(sw)
    await settle()
    expect(host.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true")
    expect(requests.find((r) => r.method === "PATCH")).toMatchObject({ url: "/api/hooks/hook_aaaaaaaaaaaa", body: { enabled: true } })
  })

  it("adds the merge template in one click, off", async () => {
    seed([])
    render(createElement(HooksPanel, { projectId: "prj_demo01" }))
    click(button(/Add \(starts off\)/))
    await settle()
    expect(requests.find((r) => r.url === "/api/hooks/from-template")).toMatchObject({ method: "POST", body: { projectId: "prj_demo01", template: "pr_merge" } })
    // Its editor opens so it can be reviewed and switched on.
    expect(document.querySelector('[data-testid="hook-editor"]')).not.toBeNull()
  })

  it("creates a hook from the template in the editor, with a live preview", async () => {
    seed([])
    render(createElement(HooksPanel, { projectId: "prj_demo01" }))
    click(button("New hook"))
    const editor = document.querySelector('[data-testid="hook-editor"]')!
    click(button("On PR ready → merge", editor))
    const preview = () => document.querySelector('[data-testid="hook-preview"]')!.textContent ?? ""
    // Sample values first, then a real task's.
    expect(preview()).toContain("Merge your pull request #42.")
    expect(preview()).toContain("Hook: On PR ready → merge")
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Preview with"]')!
    act(() => {
      select.value = task.id
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(preview()).toContain("Merge your pull request #42.")
    click(button("Create hook"))
    await settle()
    expect(requests.find((r) => r.url === "/api/hooks" && r.method === "POST")?.body).toMatchObject({
      projectId: "prj_demo01",
      name: "On PR ready → merge",
      trigger: "task.pr_ready",
      action: "send_to_task",
      prompt: MERGE_PROMPT,
      filters: { excludeLabels: ["no-automerge"] },
      enabled: false,
    })
  })

  it("shows recent runs with status filters", () => {
    seed([hook()])
    location = memoryLocation({ path: "/projects/prj_demo01?tab=hooks&hooks=runs", record: true })
    render(createElement(HooksPanel, { projectId: "prj_demo01" }))
    expect(host.querySelectorAll('[data-testid="hook-run"]')).toHaveLength(2)
    click(button(/^Skipped/))
    const runs = host.querySelectorAll('[data-testid="hook-run"]')
    expect(runs).toHaveLength(1)
    expect(runs[0]!.textContent).toContain("Skipped by the loop guard")
  })
})

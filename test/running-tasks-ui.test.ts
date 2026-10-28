// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Profiler, act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RunningTasksBadge } from "../web/src/components/RunningTasks.js"
import { keys } from "../web/src/lib/queries.js"
import type { Project, Task, TaskStatus } from "../shared/types"

// The Zen header's running-tasks badge: the count, live, and the dropdown listing every running task.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let n = 0
function task(status: TaskStatus, over: Partial<Task> = {}): Task {
  n += 1
  return {
    id: `task_t${n}`,
    projectId: "prj_a",
    title: `Task ${n}`,
    prompt: "",
    status,
    boxId: null,
    sessionId: "s",
    branch: null,
    prUrl: null,
    prState: null,
    prMergedAt: null,
    prMergedBy: null,
    previews: [],
    question: null,
    summary: null,
    error: null,
    waitReason: null,
    waitBoxSize: null,
    waitFor: [],
    turnCount: 0,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    outcome: null,
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
    runsOn: null,
    createdAt: n,
    updatedAt: Date.now() - 5 * 60_000,
    ...over,
  }
}

const projects = [{ id: "prj_a", name: "box-yard" }, { id: "prj_b", name: "nebula" }] as Project[]

let root: Root
let host: HTMLElement
let qc: QueryClient
let renders: number

function render(tasks: Task[]) {
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.tasks, tasks)
  qc.setQueryData(keys.projects, projects)
  renders = 0
  const badge = createElement(Profiler, { id: "badge", onRender: () => void (renders += 1) }, createElement(RunningTasksBadge))
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, badge)))
}

/** React Query notifies observers on a timer, so wait inside an async act. */
const update = (tasks: Task[]) => act(async () => {
  qc.setQueryData(keys.tasks, tasks)
  await new Promise((r) => setTimeout(r, 20))
})

const badge = () => host.querySelector<HTMLButtonElement>("[data-testid=running-badge]")!
const list = () => document.querySelector("[data-testid=running-list]")
const rows = () => [...document.querySelectorAll("[data-testid=running-row]")]
const titles = () => rows().map((r) => r.querySelector("a")!.textContent)

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

describe("RunningTasksBadge", () => {
  it("counts queued, starting and working tasks, and dims at 0", async () => {
    render([task("working"), task("starting"), task("queued"), task("needs_input"), task("idle"), task("done")])
    expect(badge().textContent).toBe("3")
    expect(badge().getAttribute("aria-label")).toBe("3 running tasks: show them")
    expect(badge().firstElementChild!.className).toContain("text-yard-400")

    await update([task("idle")])
    expect(badge().textContent).toBe("0")
    expect(badge().firstElementChild!.className).toContain("text-zinc-600")
  })

  it("updates live, and re-renders only when the count changes", async () => {
    const a = task("working")
    const b = task("idle")
    render([a, b])
    expect(badge().textContent).toBe("1")
    const before = renders

    // Activity on a running task and changes to tasks that aren't running don't touch the badge.
    await update([{ ...a, activity: "Reading files" }, { ...b, title: "Renamed" }])
    expect(renders).toBe(before)

    await update([a, { ...b, status: "queued" }])
    expect(badge().textContent).toBe("2")
    expect(renders).toBe(before + 1)
  })

  it("keeps one 44px button whatever the count, so the title never moves", async () => {
    render([])
    const cls = badge().className
    expect(cls).toContain("h-11")
    expect(cls).toContain("w-11")
    await update(Array.from({ length: 120 }, () => task("working")))
    expect(badge().textContent).toBe("99+")
    expect(badge().className).toBe(cls)
  })

  it("lists every running task with its project, status, place, time and PR", () => {
    render([
      task("working", { title: "Zen badge", turnStartedAt: Date.now() - 12 * 60_000, prUrl: "https://github.com/webdevcody/box-yard/pull/170", prState: "open" }),
      task("queued", { title: "Coastline", projectId: "prj_b", runsOn: "local" }),
      task("needs_input", { title: "Asks a question" }),
    ])
    expect(list()).toBeNull()
    act(() => badge().click())
    expect(badge().getAttribute("aria-expanded")).toBe("true")
    expect(titles()).toEqual(["Zen badge", "Coastline"])

    const [zen, coast] = rows()
    expect(zen!.querySelector("a")!.getAttribute("href")).toBe(`/tasks/task_t${n - 2}`)
    expect(zen!.textContent).toContain("box-yard")
    expect(zen!.textContent).toContain("Working")
    expect(zen!.querySelector("time")!.textContent).toBe("12m")
    expect(zen!.querySelector("[data-pr-state=open]")!.textContent).toContain("PR #170")
    expect(zen!.querySelector("[role=img]")!.getAttribute("aria-label")).toBe("Runs on: → Upstash")

    expect(coast!.textContent).toContain("nebula")
    expect(coast!.textContent).toContain("Queued")
    expect(coast!.querySelector("time")!.textContent).toBe("5m")
    expect(coast!.querySelector("[role=img]")!.getAttribute("aria-label")).toBe("Runs on: → This computer")
    expect(coast!.querySelector("[data-pr-state]")).toBeNull()
  })

  it("closes on Esc and on a press outside", () => {
    render([task("working")])
    act(() => badge().click())
    expect(list()).not.toBeNull()
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(list()).toBeNull()

    act(() => badge().click())
    act(() => void list()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
    expect(list()).not.toBeNull()
    act(() => void document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
    expect(list()).toBeNull()
  })

  it("holds its rows still as updates stream in", async () => {
    const a = task("working", { title: "A" })
    const b = task("queued", { title: "B" })
    const c = task("starting", { title: "C" })
    const d = task("idle", { title: "D" })
    render([a, b, c, d])
    act(() => badge().click())
    expect(titles()).toEqual(["A", "B", "C"])

    // B starts working, A finishes, D is queued: A dims in place, D waits behind the pill.
    await update([{ ...a, status: "pr_ready" }, { ...b, status: "working" }, c, { ...d, status: "queued" }])
    expect(titles()).toEqual(["A", "B", "C"])
    expect(rows()[0]!.className).toContain("opacity-50")
    expect(rows()[1]!.textContent).toContain("Working")
    expect(list()!.textContent).toContain("1 new")
    expect(list()!.textContent).toContain("3 running")
    expect(badge().textContent).toBe("3")
  })

  it("says so when nothing is running", () => {
    render([task("idle")])
    act(() => badge().click())
    expect(list()!.textContent).toContain("No tasks running.")
  })
})

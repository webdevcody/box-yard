// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BoxesView } from "../web/src/components/BoxesView.js"
import { keys } from "../web/src/lib/queries.js"
import { CLEANUP_STEPS } from "../shared/disk"
import type { BoxInfo, Health, Task } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MB = 1024 * 1024
const GB = 1024 * MB
const now = Date.now()

const box = (id: string, over: Partial<BoxInfo> = {}): BoxInfo => ({
  id,
  provider: "upstash",
  status: "ready",
  size: "small",
  keepAlive: false,
  slots: 2,
  runningTurns: 0,
  residentTasks: [],
  projects: [],
  activeMs: 3_600_000,
  uptimeMs: 86_400_000,
  diskBytes: GB,
  diskFreeBytes: 3 * GB,
  diskTotalBytes: 5 * GB,
  diskCheckedAt: now - 10_000,
  diskLow: false,
  cleanup: null,
  estimatedCostUsd: 0.25,
  usageSource: "estimated",
  createdAt: now - 86_400_000,
  lastUsedAt: now - 60_000,
  ...over,
})

const BOXES = [
  box("low-box", {
    runningTurns: 1,
    projects: ["survive-the-night"],
    diskFreeBytes: 542 * MB,
    diskLow: true,
    cleanup: {
      boxId: "low-box",
      reason: "low-disk",
      status: "done",
      startedAt: now - 420_000,
      finishedAt: now - 400_000,
      targetFreeBytes: GB,
      freeBefore: 541 * MB,
      freeAfter: 542 * MB,
      totalBytes: 5 * GB,
      freedBytes: MB,
      steps: CLEANUP_STEPS.map((s) => ({ key: s.key, label: s.label, freedBytes: s.key === "git" ? MB : 0, removed: [], skipped: s.key === "git" ? null : "nothing to remove" })),
      enough: false,
      error: null,
    },
  }),
  box("idle-box", { projects: ["workouts"] }),
  box("busy-box", { runningTurns: 2, projects: ["box-yard", "survive-the-night"] }),
]

const task = (id: string, title: string, status: Task["status"], boxId: string | null, createdAt: number) =>
  ({ id, title, status, boxId, projectId: "prj_a", createdAt, updatedAt: createdAt, previews: [], prUrl: null, prState: null, waitReason: null }) as unknown as Task

const TASKS = [
  task("task_lag", "Fix lag at dawn", "working", "low-box", 1),
  task("task_old", "Zombie waves", "done", "low-box", 2),
  task("task_two", "Boxes redesign", "working", "busy-box", 3),
  task("task_three", "Royale count", "working", "busy-box", 4),
]

let root: Root
let host: HTMLElement

function render(url = "/boxes") {
  history.replaceState(null, "", url)
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.boxes, BOXES)
  qc.setQueryData(keys.tasks, TASKS)
  qc.setQueryData(keys.projects, [{ id: "prj_a", name: "survive-the-night" }])
  qc.setQueryData(keys.health, { provider: "upstash", pool: { maxBoxes: 5, slotsPerBox: 2, maxAgents: 10, maxResidentPerBox: 3, boxIdleDeleteMinutes: 30 } } as Partial<Health>)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(BoxesView))))
}

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

const rows = () => [...host.querySelectorAll("[data-testid=box-row]")].map((r) => r.id.replace("box-", ""))
const dialog = () => document.querySelector("[role=dialog]")
const click = (el: Element, init: MouseEventInit = {}) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })))
const row = (id: string) => document.getElementById(`box-${id}`)!

describe("Boxes overview", () => {
  it("shows one compact row per box in server order, with the attention count and no per-box banners", () => {
    render()
    expect(rows()).toEqual(["low-box", "idle-box", "busy-box"])
    expect(host.querySelector("[data-testid=box-summary]")!.textContent).toContain("Needs attention1")
    expect(row("low-box").querySelector("[data-testid=box-attention]")!.getAttribute("title")).toBe("Low on disk: 542 MB free")
    expect(row("idle-box").querySelector("[data-testid=box-attention]")).toBeNull()
    expect(host.textContent).not.toContain("New tasks go to other boxes")
    expect(host.querySelector("[data-testid=cleanup-report]")).toBeNull()
    expect(row("busy-box").textContent).toContain("Boxes redesign+1")
    expect(row("idle-box").textContent).toContain("idle")
  })

  it("filters by ?filter= without reordering", () => {
    render("/boxes?filter=attention")
    expect(rows()).toEqual(["low-box"])
    render("/boxes?filter=busy")
    expect(rows()).toEqual(["low-box", "busy-box"])
    render("/boxes?filter=idle")
    expect(rows()).toEqual(["idle-box"])
  })

  it("opens a box's details in a modal on a plain click, starting on disk & cleanup when it's low", () => {
    render()
    click(row("low-box"))
    expect(window.location.hash).toBe("#low-box")
    act(() => void window.dispatchEvent(new HashChangeEvent("hashchange")))
    const d = dialog()!
    expect(d.textContent).toContain("low-box")
    expect(d.textContent).toContain("New tasks go to other boxes")
    expect(d.querySelector("[role=tab][aria-selected=true]")!.textContent).toBe("Disk & cleanup")
    const report = d.querySelector("[data-testid=cleanup-report]")!
    expect(report.textContent).toContain("Clean up now")
    expect(report.querySelectorAll("li")).toHaveLength(5)
    expect(report.textContent).toContain("freed 1 MB")

    click([...d.querySelectorAll("[role=tab]")].find((t) => t.textContent?.startsWith("Finished"))!)
    expect(d.querySelector("[role=tabpanel]")!.textContent).toContain("Zombie waves")
  })

  it("opens details straight from a /boxes#<id> link and drops the hash on close", () => {
    render("/boxes#idle-box")
    expect(dialog()!.textContent).toContain("idle-box")
    click(dialog()!.querySelector("button[aria-label=Close]")!)
    expect(window.location.hash).toBe("")
    expect(dialog()).toBeNull()
  })

  it("opens details in a new tab on Ctrl/Cmd-click", () => {
    const open = vi.fn()
    vi.stubGlobal("open", open)
    render()
    click(row("busy-box"), { ctrlKey: true })
    expect(open).toHaveBeenCalledWith("/boxes#busy-box", "_blank", "noopener")
    expect(dialog()).toBeNull()
  })

  it("keeps Clean up now and the running tasks in the ⋯ menu", () => {
    render()
    click(host.querySelector("button[aria-label='Actions for busy-box']")!)
    const menu = host.querySelector("[role=menu]")!
    expect([...menu.querySelectorAll("[role=menuitem]")].map((m) => m.textContent?.trim())).toEqual(["Details", "Clean up now", "Boxes redesign", "Royale count"])
    expect(dialog()).toBeNull()
  })
})

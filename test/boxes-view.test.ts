// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BoxesView } from "../web/src/components/BoxesView.js"
import { keys } from "../web/src/lib/queries.js"
import { CLEANUP_STEPS } from "../shared/disk"
import type { BoxContents, BoxInfo, Health, Task } from "../shared/types"

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
  operation: null,
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

const contentsFor = (boxId: string, running: number): BoxContents => ({
  boxId,
  tasks: TASKS.filter((t) => t.boxId === boxId).map((t) => ({ id: t.id, title: t.title, projectId: t.projectId, status: t.status, running: t.status === "working", uncommitted: t.status === "done" ? 3 : 0, archived: t.status === "done" })),
  running,
  diskUsedBytes: 4.5 * GB,
  diskBytes: 2.9 * GB,
})
const CONTENTS: Record<string, BoxContents> = { "low-box": contentsFor("low-box", 1), "idle-box": contentsFor("idle-box", 0), "busy-box": contentsFor("busy-box", 2) }
let REPLY: Record<string, unknown> = { ok: true }
const requests: { url: string; method: string }[] = []

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
  requests.length = 0
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method ?? "GET" })
    const contents = /\/api\/boxes\/([^/]+)\/contents$/.exec(url)
    if (contents) return new Response(JSON.stringify(CONTENTS[decodeURIComponent(contents[1]!)]), { status: 200 })
    if (url.endsWith("/clear") || init?.method === "DELETE") return new Response(JSON.stringify(REPLY), { status: REPLY.error ? 409 : 200 })
    return new Promise(() => {})
  })
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
    expect([...menu.querySelectorAll("[role=menuitem]")].map((m) => m.textContent?.trim())).toEqual(["Details", "Clean up now", "Clear box…", "Delete box…", "Boxes redesign", "Royale count"])
    expect(dialog()).toBeNull()
  })
})

const flush = async () => {
  for (let i = 0; i < 20; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 5))))
}
const menuItem = async (boxId: string, label: string) => {
  click(host.querySelector(`button[aria-label='Actions for ${boxId}']`)!)
  click([...host.querySelectorAll("[role=menuitem]")].find((m) => m.textContent?.trim() === label)!)
  await flush()
}
const confirmButton = () => document.querySelector<HTMLButtonElement>("[data-testid=box-action-confirm]")!
const submit = async () => {
  await act(async () => void confirmButton().closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  await flush()
}

describe("Clear box and Delete box", () => {
  beforeEach(() => {
    REPLY = { ok: true }
  })

  it("shows what's on the box, and clears an idle box in one confirm", async () => {
    render()
    await menuItem("idle-box", "Clear box…")
    const d = dialog()!
    expect(d.textContent).toContain("Clear box idle-box?")
    expect(d.querySelector("[data-testid=box-contents]")!.textContent).toContain("4.5 GB of disk in use")
    expect(d.querySelector("[data-testid=agents-running]")).toBeNull()
    expect(confirmButton().textContent).toBe("Clear box")
    REPLY = { boxId: "idle-box", reason: "clear", status: "done", steps: [] }
    await submit()
    expect(requests).toContainEqual({ url: "/api/boxes/idle-box/clear", method: "POST" })
    expect(dialog()).toBeNull()
  })

  it("lists tasks by status and uncommitted work, and asks a second time before stopping running agents", async () => {
    render()
    await menuItem("low-box", "Clear box…")
    const d = dialog()!
    const contents = d.querySelector("[data-testid=box-contents]")!.textContent!
    expect(contents).toContain("1 working")
    expect(contents).toContain("1 done")
    expect(contents).toContain("Zombie waves· 3 uncommitted files, archived first")
    expect(d.querySelector("[data-testid=agents-running]")!.textContent).toContain("1 agent is running: stop it first")
    expect(confirmButton().textContent).toBe("Stop agents and clear…")
    await submit()
    // The first press only asks again; nothing was sent.
    expect(requests.some((r) => r.url.endsWith("/clear"))).toBe(false)
    expect(d.querySelector("[data-testid=stop-confirm]")!.textContent).toContain("Stop 1 running agent first?")
    expect(confirmButton().textContent).toBe("Stop 1 agent and clear")
    REPLY = { boxId: "low-box", reason: "clear", status: "done", steps: [] }
    await submit()
    expect(requests.filter((r) => r.url.endsWith("/clear"))).toHaveLength(1)
  })

  it("deletes only after the box name is typed, and shows the server's refusal", async () => {
    render()
    await menuItem("idle-box", "Delete box…")
    expect(dialog()!.textContent).toContain("Delete box idle-box?")
    expect(confirmButton().disabled).toBe(true)
    const input = dialog()!.querySelector<HTMLInputElement>("input[aria-label='Box name']")!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      set.call(input, "idle-box")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(confirmButton().disabled).toBe(false)
    REPLY = { error: "Couldn't archive task_x, so idle-box was not deleted." }
    await submit()
    expect(requests).toContainEqual({ url: "/api/boxes/idle-box", method: "DELETE" })
    expect(dialog()!.querySelector("[role=alert]")!.textContent).toBe("Couldn't archive task_x, so idle-box was not deleted.")
  })

  it("disables the actions with a reason while an operation runs", () => {
    BOXES[1]!.operation = "clear"
    try {
      render()
      click(host.querySelector("button[aria-label='Actions for idle-box']")!)
      const items = [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
      for (const label of ["Clean up now", "Clear box…", "Delete box…"]) {
        const item = items.find((m) => m.textContent?.trim() === label)!
        expect(item.disabled).toBe(true)
        expect(item.title).toBe("This box is being cleared")
      }
    } finally {
      BOXES[1]!.operation = null
    }
  })
})

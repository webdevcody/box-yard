// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BoxesView } from "../web/src/components/BoxesView.js"
import { keys } from "../web/src/lib/queries.js"
import { CLEANUP_STEPS } from "../shared/disk"
import type { BoxContents, BoxInfo, BoxSize, Health, ResizePlan, Task } from "../shared/types"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"

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
  resize: null,
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
  kind: "box",
  label: boxId,
  tasks: TASKS.filter((t) => t.boxId === boxId).map((t) => ({
    id: t.id,
    title: t.title,
    projectId: t.projectId,
    status: t.status,
    running: t.status === "working",
    uncommitted: t.status === "done" ? 3 : 0,
    archived: t.status === "done",
    prState: null,
    ...(t.status === "working" ? { verdict: "running" as const, detail: "an agent is running on it" } : { verdict: "ok" as const, detail: "no repo, so its folder only lives on the box; its archive is up to date" }),
  })),
  running,
  diskUsedBytes: 4.5 * GB,
  diskBytes: 2.9 * GB,
  busy: null,
  refusals: [],
})
const CONTENTS: Record<string, BoxContents> = { "low-box": contentsFor("low-box", 1), "idle-box": contentsFor("idle-box", 0), "busy-box": contentsFor("busy-box", 2) }
let REPLY: Record<string, unknown> = { ok: true }
/** What GET /api/boxes/:id/resize answers. */
let PLAN = (boxId: string, to: BoxSize): ResizePlan => ({
  boxId,
  from: "small",
  to,
  mode: "migration",
  running: TASKS.filter((t) => t.boxId === boxId && t.status === "working").map((t) => ({ id: t.id, title: t.title })),
  tasks: TASKS.filter((t) => t.boxId === boxId).length,
  fit: null,
  refusal: null,
})
const requests: { url: string; method: string }[] = []

let root: Root
let host: HTMLElement

function render(url = "/boxes", boxes = BOXES) {
  history.replaceState(null, "", url)
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.boxes, boxes)
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
    const plan = /\/api\/boxes\/([^/]+)\/resize\?size=(\w+)$/.exec(url)
    if (plan) return new Response(JSON.stringify(PLAN(decodeURIComponent(plan[1]!), plan[2] as BoxSize)), { status: 200 })
    if (/\/resize$/.test(url) && init?.method === "POST") return new Response(JSON.stringify(REPLY), { status: REPLY.error ? 409 : 202 })
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
    expect(report.querySelectorAll("li")).toHaveLength(CLEANUP_STEPS.length)
    expect(report.textContent).toContain("freed 1 MB")

    click([...d.querySelectorAll("[role=tab]")].find((t) => t.textContent?.startsWith("Finished"))!)
    expect(d.querySelector("[role=tabpanel]")!.textContent).toContain("Zombie waves")
  })

  it("shows a low root disk (/tmp, home) and what the last sweep freed there", () => {
    const tmpBox = box("tmp-box", {
      rootFreeBytes: 380 * MB,
      rootTotalBytes: 5 * GB,
      cleanup: {
        boxId: "tmp-box",
        reason: "routine",
        status: "done",
        startedAt: now - 120_000,
        finishedAt: now - 100_000,
        targetFreeBytes: null,
        freeBefore: 3 * GB,
        freeAfter: 3 * GB,
        totalBytes: 5 * GB,
        rootFreeBefore: 200 * MB,
        rootFreeAfter: 380 * MB,
        rootTotalBytes: 5 * GB,
        freedBytes: 180 * MB,
        steps: [{ key: "tmp", label: "Stale temp folders on the root disk (/tmp)", freedBytes: 180 * MB, removed: ["3 stale temp folders (180 MB)"], skipped: null }],
        enough: true,
        error: null,
      },
    })
    render("/boxes#tmp-box", [...BOXES, tmpBox])
    expect(row("tmp-box").querySelector("[data-testid=box-attention]")!.getAttribute("aria-label")).toBe("Needs attention: Root disk low: 380 MB free")
    const d = dialog()!
    expect(d.querySelector("[role=tab][aria-selected=true]")!.textContent).toBe("Disk & cleanup")
    expect(d.querySelector("[data-testid=root-disk-use]")!.textContent).toBe("root disk 380 MB free")
    expect(d.querySelector("[data-testid=root-disk]")!.textContent).toContain("Root disk (/tmp, home) · 380 MB free of 5.0 GB")
    expect(d.querySelector("[data-testid=disk-breakdown]")!.textContent).toContain("Work disk · 3.0 GB free of 5.0 GB")
    const report = d.querySelector("[data-testid=cleanup-report]")!
    expect(report.textContent).toContain("Routine upkeep (stale temp folders): freed 180 MB (tmp 180 MB)")
    expect(report.querySelector("[data-testid=cleanup-root]")!.textContent).toBe("Root disk: 200 MB → 380 MB free")
    expect(report.textContent).toContain("3 stale temp folders (180 MB)")
  })

  it("leaves the root disk out when it's the work disk", () => {
    render("/boxes#idle-box")
    const d = dialog()!
    click([...d.querySelectorAll("[role=tab]")].find((t) => t.textContent === "Disk & cleanup")!)
    expect(d.querySelector("[data-testid=root-disk]")).toBeNull()
    expect(d.querySelector("[data-testid=root-disk-use]")).toBeNull()
    expect(d.querySelector("[data-testid=disk-breakdown]")!.textContent).not.toContain("Work disk")
  })

  it("shows memory and load next to disk on the row and in the details, as text with a title", () => {
    const memBox = box("mem-box", {
      runningTurns: 2,
      memUsedBytes: 3.5 * GB,
      memTotalBytes: 4 * GB,
      loadAvg: 1.25,
      cpuCount: 2,
      memoryPressure: "3.5 GB of 4.0 GB memory in use (88%), over 80%",
    })
    render("/boxes", [...BOXES, memBox])
    const cell = row("mem-box").querySelector("[data-testid=box-row-memory]")!
    expect(cell.textContent).toBe("88% mem")
    expect(cell.getAttribute("title")).toBe(
      "Memory: 3.5 GB of 4.0 GB memory in use (88%)\nload 1.25 on 2 CPUs\nNew agents go to other boxes while agents run here: 3.5 GB of 4.0 GB memory in use (88%), over 80%",
    )
    const meter = cell.querySelector("[role=meter]")!
    expect(meter.getAttribute("aria-label")).toBe("Memory used")
    expect(meter.getAttribute("aria-valuenow")).toBe(String(3.5 * GB))
    expect(row("mem-box").querySelector("[data-testid=box-attention]")!.getAttribute("title")).toBe("Busy: 88% mem, load 1.25 on 2 CPUs")
    // Not measured yet: a dash, still with a title.
    const idle = row("idle-box").querySelector("[data-testid=box-row-memory]")!
    expect(idle.textContent).toBe("mem —")
    expect(idle.getAttribute("title")).toBe("Memory not measured yet")

    click(row("mem-box"))
    act(() => void window.dispatchEvent(new HashChangeEvent("hashchange")))
    const use = dialog()!.querySelector("[data-testid=memory-use]")!
    expect(use.textContent).toContain("3.5 GB of 4.0 GB memory in use (88%)")
    expect(use.textContent).toContain("load 1.25 on 2 CPUs")
    expect(use.textContent).toContain("new tasks go elsewhere")
    expect(use.querySelector("[role=meter]")!.getAttribute("aria-label")).toBe("Memory used")
    expect(dialog()!.querySelector("[data-testid=box-attention-list]")!.textContent).toContain(
      "Busy: 3.5 GB of 4.0 GB memory in use (88%), over 80%. New agents go to other boxes (or wait) until it calms down",
    )
  })

  it("says when a project that needs the whole machine holds a box", () => {
    const shared = box("shared-box", { slots: 4, runningTurns: 1, projects: ["survive-the-night"], projectLimit: { slots: 1, project: "survive-the-night" } })
    render("/boxes", [...BOXES, shared])
    expect(row("shared-box").querySelector("[title*='tasks running at once']")!.getAttribute("title")).toBe("1 of 4 tasks running at once; survive-the-night needs the whole machine (1 of its tasks at once)")
    click(row("shared-box"))
    act(() => void window.dispatchEvent(new HashChangeEvent("hashchange")))
    expect(dialog()!.querySelector("[data-testid=box-project-limit]")!.textContent).toBe("survive-the-night needs the whole machine (1 of its tasks at once)")
    expect(row("idle-box").querySelector("[title*='tasks running at once']")!.getAttribute("title")).toBe("0 of 2 tasks running at once")
  })

  it("doesn't show a box that stopped answering as green, or its old numbers as fresh", () => {
    const stats = { memUsedBytes: 0.3 * GB, memTotalBytes: 4 * GB, loadAvg: 0.1, cpuCount: 2 }
    const gone = box("moved-possum-73248", { ...stats, diskCheckedAt: now - 9 * 60_000, unreachableSince: now - 4 * 60_000 })
    const old = box("old-box", { ...stats, diskCheckedAt: now - 40 * 60_000 })
    const fresh = box("fresh-box", stats)
    render("/boxes", [gone, old, fresh])

    const dot = (id: string) => row(id).querySelector("[role=img]")!
    expect(dot("fresh-box").getAttribute("aria-label")).toBe("Running")
    expect(dot("fresh-box").className).toContain("bg-emerald-400")
    expect(dot("moved-possum-73248").getAttribute("aria-label")).toBe("Not answering")
    expect(dot("moved-possum-73248").className).not.toContain("emerald")
    expect(row("moved-possum-73248").querySelector("[data-testid=box-attention]")!.getAttribute("title")).toBe("Not answering")
    expect(row("old-box").querySelector("[data-testid=box-attention]")).toBeNull()

    const mem = (id: string) => row(id).querySelector("[data-testid=box-row-memory]")!
    const disk = (id: string) => mem(id).previousElementSibling!
    for (const id of ["moved-possum-73248", "old-box"]) {
      expect(mem(id).querySelector("span")!.className).toContain("text-zinc-500")
      expect(disk(id).querySelector("span")!.className).toContain("text-zinc-500")
      expect(mem(id).querySelector("[role=meter] > div")!.className).toContain("bg-zinc-600")
    }
    expect(mem("fresh-box").querySelector("span")!.className).not.toContain("text-zinc-500")
    expect(mem("moved-possum-73248").getAttribute("title")).toContain("Not answering: from the last check that worked, measured 9m ago")
    expect(disk("old-box").getAttribute("title")).toContain("Stale: measured 40m ago")

    click(row("moved-possum-73248"))
    act(() => void window.dispatchEvent(new HashChangeEvent("hashchange")))
    expect(dialog()!.textContent).toContain("Not answering")
    expect(dialog()!.querySelector("[data-testid=box-attention-list]")!.textContent).toContain("Box Yard can't reach this box")
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
    expect([...menu.querySelectorAll("[role=menuitem]")].map((m) => m.textContent?.trim())).toEqual(["Details", "Clean up now", "Clear box…", "Resize…", "Delete box…", "Boxes redesign", "Royale count"])
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
    expect(d.textContent).toContain("Clear boxidle-box?")
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
    expect(d.querySelector("[data-testid=agents-running]")!.textContent).toContain("1 task is running: stop it first")
    expect(confirmButton().textContent).toBe("Stop tasks and clear…")
    await submit()
    // The first press only asks again; nothing was sent.
    expect(requests.some((r) => r.url.endsWith("/clear"))).toBe(false)
    expect(d.querySelector("[data-testid=stop-confirm]")!.textContent).toContain("Stop 1 running task first?")
    expect(confirmButton().textContent).toBe("Stop 1 agent and clear")
    REPLY = { boxId: "low-box", reason: "clear", status: "done", steps: [] }
    await submit()
    expect(requests.filter((r) => r.url.endsWith("/clear"))).toHaveLength(1)
  })

  it("deletes only after the box name is typed, and shows the server's refusal", async () => {
    render()
    await menuItem("idle-box", "Delete box…")
    expect(dialog()!.textContent).toContain("Delete boxidle-box?")
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

  it("shows each task's safety check, and asks before deleting past it", async () => {
    const before = CONTENTS["idle-box"]!
    CONTENTS["idle-box"] = {
      ...before,
      tasks: [
        { id: "task_ok", title: "Merged work", projectId: "prj_a", status: "done", running: false, uncommitted: 0, archived: false, prState: "merged", verdict: "ok", detail: "PR merged and nothing unpushed: needs no archive" },
        { id: "task_wip", title: "Half done", projectId: "prj_a", status: "done", running: false, uncommitted: 2, archived: false, prState: "open", verdict: "dirty", detail: "uncommitted changes (2 files) and its PR is open" },
      ],
      refusals: ['task_wip "Half done": uncommitted changes (2 files) and its PR is open'],
    }
    try {
      render()
      await menuItem("idle-box", "Delete box…")
      const d = dialog()!
      const checks = [...d.querySelectorAll("[data-testid=safety-check] li")].map((li) => [li.getAttribute("data-verdict"), li.textContent])
      expect(checks).toEqual([
        ["ok", "Merged work · done · PR merged and nothing unpushed: needs no archive"],
        ["dirty", "Half done · done · uncommitted changes (2 files) and its PR is open"],
      ])
      expect(d.querySelector("[data-testid=safety-failed]")!.textContent).toContain("Coordinator and Captains can't delete this box")
      const input = d.querySelector<HTMLInputElement>("input[aria-label='Box name']")!
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        set.call(input, "idle-box")
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
      expect(confirmButton().textContent).toBe("Delete anyway…")
      await submit()
      // The first press only lists what's at risk; nothing was sent.
      expect(requests.some((r) => r.method === "DELETE")).toBe(false)
      const risk = d.querySelector("[data-testid=risk-confirm]")!.textContent!
      expect(risk).toContain("Delete anyway? This task doesn't pass the safety check")
      expect(risk).toContain("Half done · uncommitted changes (2 files) and its PR is open")
      expect(risk).not.toContain("Merged work")
      expect(confirmButton().textContent).toBe("Delete anyway")
      await submit()
      expect(requests).toContainEqual({ url: "/api/boxes/idle-box?override=1", method: "DELETE" })
      expect(dialog()).toBeNull()
    } finally {
      CONTENTS["idle-box"] = before
      for (const t of currentToasts()) dismiss(t.id)
    }
  })

  it("disables the actions with a reason while an operation runs", () => {
    BOXES[1]!.operation = "clear"
    try {
      render()
      click(host.querySelector("button[aria-label='Actions for idle-box']")!)
      const items = [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
      for (const label of ["Clean up now", "Clear box…", "Resize…", "Delete box…"]) {
        const item = items.find((m) => m.textContent?.trim() === label)!
        expect(item.disabled).toBe(true)
        expect(item.title).toBe("This box is being cleared")
      }
    } finally {
      BOXES[1]!.operation = null
    }
  })
})

describe("Resize box", () => {
  const resizeButton = () => document.querySelector<HTMLButtonElement>("[data-testid=resize-confirm]")!
  const submitResize = async () => {
    await act(async () => void resizeButton().closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    await flush()
  }
  afterEach(() => {
    for (const t of currentToasts()) dismiss(t.id)
  })

  it("compares the sizes, says it's a migration, and resizes an idle box in one confirm with a progress toast", async () => {
    render()
    await menuItem("idle-box", "Resize…")
    const d = dialog()!
    expect(d.textContent).toContain("Resize boxidle-box")
    expect(d.querySelector("[role=radio][aria-checked=true]")!.textContent).toContain("Medium")
    expect(d.querySelector("[data-testid=size-small]")!.textContent).toContain("Current")
    expect(d.querySelector("[data-testid=size-large]")!.textContent).toBe("LargeCPU8 vCPURAM16 GBDisk30 GBPrice$0.40/hAgents4")
    expect(d.querySelector("[data-testid=resize-mode]")!.textContent).toBe("migration to a new box")
    expect(d.querySelector("[data-testid=resize-steps]")!.textContent).toContain("Creates a new medium box")
    expect(d.querySelector("[data-testid=agents-running]")).toBeNull()
    expect(resizeButton().textContent).toBe("Resize to medium")
    click(d.querySelector("[data-testid=size-large]")!)
    await flush()
    expect(resizeButton().textContent).toBe("Resize to large")
    REPLY = { id: "rsz_1", boxId: "idle-box", newBoxId: null, from: "small", to: "large", mode: "migration", status: "running", steps: [{ key: "create", label: "Create a large box", status: "running", detail: null }], movedTasks: [], by: { kind: "cody" }, reason: null, error: null, startedAt: now, finishedAt: null }
    await submitResize()
    expect(requests).toContainEqual({ url: "/api/boxes/idle-box/resize", method: "POST" })
    expect(dialog()).toBeNull()
    expect(currentToasts().map((t) => [t.title, t.body, t.progress])).toEqual([["Resizing idle-box: small → large", "Create a large box… (1 of 1)", true]])
  })

  it("lists running agents and asks a second time before stopping them", async () => {
    render()
    await menuItem("busy-box", "Resize…")
    const d = dialog()!
    expect(d.querySelector("[data-testid=agents-running]")!.textContent).toContain("2 tasks are running. Box Yard never interrupts them")
    expect(d.querySelector("[data-testid=agents-running]")!.textContent).toContain("Boxes redesign")
    expect(resizeButton().textContent).toBe("Stop tasks and resize…")
    await submitResize()
    expect(requests.some((r) => r.method === "POST")).toBe(false)
    expect(d.querySelector("[data-testid=stop-confirm]")!.textContent).toContain("Stop 2 running tasks first?")
    expect(resizeButton().textContent).toBe("Stop 2 agents and resize")
  })

  it("shows a scale-down that wouldn't fit and keeps the button off", async () => {
    const before = PLAN
    PLAN = (boxId, to) => ({
      ...before(boxId, to),
      from: "medium",
      fit: { ok: false, usedBytes: 4.6 * GB, capacityBytes: 5 * GB, headroomBytes: GB, reason: "4.6 GB is in use, and a small box has about 5.0 GB; it wouldn't fit." },
      refusal: "Can't scale idle-box down to small: it wouldn't fit.",
    })
    BOXES[1]!.size = "medium"
    try {
      render()
      await menuItem("idle-box", "Resize…")
      click(dialog()!.querySelector("[data-testid=size-small]")!)
      await flush()
      expect(dialog()!.querySelector("[data-testid=resize-fit]")!.textContent).toContain("it wouldn't fit")
      expect(resizeButton().disabled).toBe(true)
      expect(resizeButton().title).toBe("Can't scale idle-box down to small: it wouldn't fit.")
    } finally {
      PLAN = before
      BOXES[1]!.size = "small"
    }
  })
})

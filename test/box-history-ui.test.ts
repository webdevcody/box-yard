// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BoxesView } from "../web/src/components/BoxesView.js"
import { keys } from "../web/src/lib/queries.js"
import type { BoxEvent, BoxInfo, Health, Task } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const GB = 1024 ** 3

const live: BoxInfo = {
  id: "calm-otter",
  provider: "upstash",
  status: "ready",
  size: "small",
  keepAlive: false,
  slots: 2,
  runningTurns: 0,
  residentTasks: [],
  projects: ["alpha"],
  activeMs: 0,
  uptimeMs: 3_600_000,
  diskBytes: GB,
  diskFreeBytes: 3 * GB,
  diskTotalBytes: 5 * GB,
  diskCheckedAt: now,
  diskLow: false,
  cleanup: null,
  operation: null,
  resize: null,
  estimatedCostUsd: 0.1,
  usageSource: "estimated",
  createdAt: now - 3_600_000,
  lastUsedAt: now,
}

const ev = (id: number, over: Partial<BoxEvent>): BoxEvent => ({
  id,
  at: now - id * 60_000,
  boxId: "calm-otter",
  boxName: null,
  type: "created",
  actor: "scheduler",
  actorProjectId: null,
  reason: null,
  size: "small",
  fromSize: null,
  toSize: null,
  relatedBoxId: null,
  resizeId: null,
  projects: [{ id: "prj_alpha1", name: "alpha" }],
  taskIds: [],
  freedBytes: null,
  detail: null,
  ...over,
})

const EVENTS: BoxEvent[] = [
  ev(1, {
    boxId: "merry-albacore",
    type: "deleted",
    actor: "resize-cleanup",
    size: "large",
    fromSize: "small",
    toSize: "large",
    relatedBoxId: "calm-otter",
    reason: "Left empty by the failed resize of calm-otter (small → large) and never used since.",
  }),
  ev(2, { type: "resize_failed", actor: "captain", actorProjectId: "prj_alpha1", fromSize: "small", toSize: "large", relatedBoxId: "merry-albacore", reason: "bigger builds", detail: "archive step failed", taskIds: ["task_one111"] }),
  ev(3, { type: "cleared", actor: "owner", freedBytes: 2 * GB, detail: "freed 2.0 GB (archive 2.0 GB)", reason: "Clear box: every workspace archived and taken off the box." }),
]

const requests: string[] = []
let more = true
let root: Root
let host: HTMLElement

function render() {
  history.replaceState(null, "", "/boxes")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.boxes, [live])
  qc.setQueryData(keys.tasks, [{ id: "task_one111", title: "Bigger builds", projectId: "prj_alpha1", status: "idle", boxId: "calm-otter", previews: [] } as unknown as Task])
  qc.setQueryData(keys.projects, [{ id: "prj_alpha1", name: "alpha" }])
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Ada" } })
  qc.setQueryData(keys.health, { provider: "upstash", pool: { maxBoxes: 5, slotsPerBox: 2, maxAgents: 10, maxResidentPerBox: 3, boxIdleDeleteMinutes: 30 } } as Partial<Health>)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(BoxesView))))
}

beforeEach(() => {
  requests.length = 0
  more = true
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.startsWith("/api/box-history")) {
      requests.push(url)
      const q = new URL(url, "http://x").searchParams
      const events = EVENTS.filter((e) => (!q.get("boxId") || e.boxId === q.get("boxId") || e.relatedBoxId === q.get("boxId")) && (!q.get("type") || e.type === q.get("type")) && (!q.get("actor") || e.actor === q.get("actor")))
      return new Response(JSON.stringify({ events, more: more && !q.get("type"), boxIds: ["merry-albacore", "calm-otter"] }), { status: 200 })
    }
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

const section = () => host.querySelector("[data-testid=box-history]")!
const rows = () => [...section().querySelectorAll("[data-testid=box-event]")]
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))))
const pick = async (label: string, value: string) => {
  const select = section().querySelector<HTMLSelectElement>(`select[aria-label=${label}]`)!
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle()
}
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))

describe("Boxes page History", () => {
  it("lists events compactly, newest first, with who did it and deleted boxes marked gone in the box filter", async () => {
    render()
    await settle()
    expect(requests).toEqual(["/api/box-history?limit=30"])
    expect(rows().map((r) => r.getAttribute("data-type"))).toEqual(["deleted", "resize_failed", "cleared"])
    const [deleted, failed, cleared] = rows()
    expect(deleted!.textContent).toContain("merry-albacore")
    expect(deleted!.textContent).toContain("small → large")
    expect(deleted!.textContent).toContain("Failed-resize cleanup · Left empty by the failed resize of calm-otter")
    expect(failed!.textContent).toContain("The alpha Captain · bigger builds")
    // The owner's name from Settings, and the bytes a cleanup freed.
    expect(cleared!.textContent).toContain("Ada · freed 2.0 GB · Clear box")
    const boxOptions = [...section().querySelectorAll<HTMLOptionElement>("select[aria-label=Box] option")].map((o) => o.textContent)
    expect(boxOptions).toEqual(["All boxes", "merry-albacore (gone)", "calm-otter"])
    expect([...section().querySelectorAll<HTMLOptionElement>("select[aria-label=Who] option")].map((o) => o.textContent)).toContain("Ada")
    // No details until asked.
    expect(section().querySelector("[data-testid=box-event-details]")).toBeNull()
  })

  it("filters by box, event type and actor through the API", async () => {
    render()
    await settle()
    await pick("Box", "merry-albacore")
    expect(requests.at(-1)).toBe("/api/box-history?boxId=merry-albacore&limit=30")
    expect(rows().map((r) => r.getAttribute("data-type"))).toEqual(["deleted", "resize_failed"])
    await pick("Event", "deleted")
    expect(requests.at(-1)).toBe("/api/box-history?boxId=merry-albacore&type=deleted&limit=30")
    expect(rows().map((r) => r.getAttribute("data-type"))).toEqual(["deleted"])
    await pick("Who", "owner")
    expect(requests.at(-1)).toBe("/api/box-history?boxId=merry-albacore&type=deleted&actor=owner&limit=30")
    expect(rows()).toHaveLength(0)
    expect(section().querySelector("[data-testid=box-history-empty]")!.textContent).toBe("No events match these filters.")
  })

  it("opens a row for details: why, sizes, the other box, projects and task links", async () => {
    render()
    await settle()
    click(rows()[1]!.querySelector("button[aria-expanded]")!)
    const d = section().querySelector("[data-testid=box-event-details]")!
    expect(rows()[1]!.querySelector("button[aria-expanded]")!.getAttribute("aria-expanded")).toBe("true")
    expect(d.textContent).toContain("WhoThe alpha Captain")
    expect(d.textContent).toContain("Whybigger builds")
    expect(d.textContent).toContain("What happenedarchive step failed")
    expect(d.textContent).toContain("Sizesmall → large")
    expect(d.textContent).toContain("Other boxmerry-albacore (gone)")
    expect(d.textContent).toContain("Projectsalpha")
    expect(d.querySelector("a[href='/tasks/task_one111']")!.textContent).toBe("Bigger builds")
    // A live box opens its details.
    click(d.querySelector("button[title=\"Open this box's details\"]")!)
    expect(window.location.hash).toBe("#calm-otter")
    // Toggling closes it again.
    click(rows()[1]!.querySelector("button[aria-expanded]")!)
    expect(section().querySelector("[data-testid=box-event-details]")).toBeNull()
  })

  it("loads older rows on demand", async () => {
    render()
    await settle()
    const older = [...section().querySelectorAll("button")].find((b) => b.textContent === "Show older")!
    more = false
    await act(async () => void older.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    await settle()
    expect(requests.at(-1)).toBe("/api/box-history?limit=60")
    expect([...section().querySelectorAll("button")].some((b) => b.textContent === "Show older")).toBe(false)
  })
})

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { WaitFixButton } from "../web/src/components/WaitReason.js"
import { keys } from "../web/src/lib/queries.js"
import { ZEN_PATH } from "../web/src/lib/zen.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import type { CloudStatus, Settings, SettingsInfo, Task } from "../shared/types"

// Settings › Usage › Box spend in the header: the Coordinator's header (docked and Zen) shows the cloud meter only when
// it's on, and it's off by default since not everyone uses boxes. The Boxes page always has the meter, and the
// limit's "Raise today's limit" works either way. Like every Settings control, it's a draft until Save.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()

const CLOUD: CloudStatus = {
  spend: { todayUsd: 10.02, dailyLimitUsd: 10, raisedUsd: 0, raiseToUsd: 20.02, monthUsd: 10.02, monthlyLimitUsd: 0, state: "reached", blockedReason: "today's cloud spend is $10.02 of its $10 limit", source: "measured" },
  hourlyUsd: 0.42,
  boxes: { running: 1, idle: 0, creating: 0, total: 1 },
  ceiling: 50,
  idleDeleteMinutes: 30,
  list: [],
  gpu: null,
  fanout: { freePerHour: 15, wanted: 0, upToHourlyUsd: 0, allowedUntil: null },
}

const settingsInfo = (values: Partial<Settings> = {}): SettingsInfo => ({
  settings: { ...DEFAULT_SETTINGS, ...values },
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})

class FakeEventSource {
  onmessage: unknown = null
  onerror: unknown = null
  onopen: unknown = null
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

let root: Root
let host: HTMLElement
let requests: { method: string; url: string; body?: unknown }[]

function client(settings: SettingsInfo | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  if (settings) qc.setQueryData(keys.agentSettings, settings)
  qc.setQueryData(keys.health, { ok: true, provider: "upstash", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: null, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens: 10_000, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.projects, [])
  qc.setQueryData(keys.cloud, CLOUD)
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  return qc
}

/** The app at `path`, with the header setting as given (null: settings haven't loaded). */
function renderApp(path: string, settings: SettingsInfo | null) {
  history.replaceState(null, "", path)
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = client(settings)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
  return qc
}

beforeEach(() => {
  requests = []
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body })
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } })
    if (method === "PUT" && url === "/api/agent-settings") return json(settingsInfo(body))
    if (method === "POST" && url === "/api/cloud/raise") return json({ ...CLOUD, spend: { ...CLOUD.spend, dailyLimitUsd: 20.02, state: "ok" } })
    return new Promise(() => {})
  })
  vi.stubGlobal("EventSource", FakeEventSource)
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

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const header = () => document.querySelector("[data-testid=chat-panel] header")!
const headerMeters = () => header().querySelectorAll("[data-testid=cloud-meter], [data-testid=cloud-meter-strip]").length
const pageMeter = () => document.querySelector<HTMLButtonElement>("[data-testid=cloud-meter-page]")
const writes = () => requests.filter((r) => r.method !== "GET")
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)

describe("box spend in the header setting", () => {
  it("is off by default", () => {
    expect(DEFAULT_SETTINGS.showCloudMeter).toBe(false)
  })

  it("hides the meter from the Coordinator's header (docked and Zen) when off, and before settings load", () => {
    renderApp(ZEN_PATH, settingsInfo())
    expect(header()).not.toBeNull()
    expect(headerMeters()).toBe(0)
    renderApp("/", settingsInfo({ showCloudMeter: false }))
    expect(headerMeters()).toBe(0)
    renderApp(ZEN_PATH, null)
    expect(headerMeters()).toBe(0)
  })

  it("shows the meter (chip and phone strip) in the header when on", () => {
    renderApp(ZEN_PATH, settingsInfo({ showCloudMeter: true }))
    expect(header().querySelector("[data-testid=cloud-meter]")).not.toBeNull()
    expect(header().querySelector("[data-testid=cloud-meter-strip]")).not.toBeNull()
    renderApp("/", settingsInfo({ showCloudMeter: true }))
    expect(headerMeters()).toBe(2)
  })

  it("keeps today's spend and its sheet on the Boxes page with the header meter off", async () => {
    renderApp("/boxes", settingsInfo())
    expect(headerMeters()).toBe(0)
    expect(pageMeter()!.textContent).toBe("Today $10.02 of $10 · 1 box · $0.42/h")
    expect(pageMeter()!.dataset.state).toBe("reached")
    act(() => pageMeter()!.click())
    expect(document.querySelector("[data-testid=cloud-sheet]")).not.toBeNull()
    act(() => document.querySelector<HTMLButtonElement>("[data-testid=raise-cloud-limit]")!.click())
    await settle()
    expect(writes().map((r) => `${r.method} ${r.url}`)).toEqual(["POST /api/cloud/raise"])
  })

  it("a task the limit holds back still offers Raise today's limit with the meter hidden", async () => {
    const task = { id: "task_wait01", status: "queued", waitFix: "raise-cloud-limit" } as Task
    act(() => root.render(createElement(QueryClientProvider, { client: client(settingsInfo()) }, createElement(WaitFixButton, { task }))))
    act(() => button("Raise today's limit")!.click())
    await settle()
    expect(writes().map((r) => r.url)).toEqual(["/api/cloud/raise"])
  })

  it("is a draft until Save in Settings › Usage", async () => {
    act(() =>
      root.render(
        createElement(QueryClientProvider, { client: client(settingsInfo()) }, createElement(SettingsDialog, { section: "costs", onSection: () => {}, onClose: () => {} })),
      ),
    )
    const box = () => document.querySelector<HTMLInputElement>("[data-testid=show-cloud-meter]")!
    expect(box().checked).toBe(false)
    expect(box().closest("label")!.textContent).toContain("Off: only on the Boxes page")
    act(() => box().click())
    await settle()
    expect(box().checked).toBe(true)
    expect(writes()).toEqual([])
    for (const f of document.querySelectorAll("form")) f.noValidate = true
    const save = button("Save")!
    expect(save.disabled).toBe(false)
    act(() => save.click())
    await settle()
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({ method: "PUT", url: "/api/agent-settings", body: { showCloudMeter: true } })
    expect(button("Save")!.disabled).toBe(true)
  })
})

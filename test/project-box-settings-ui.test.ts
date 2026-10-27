// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ProjectView } from "../web/src/components/ProjectView.js"
import { keys } from "../web/src/lib/queries.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import type { Project, Settings, SettingSource, SettingsInfo } from "../shared/types"

// Project › Settings › Boxes: each of the project's box settings says the global value it uses ("Using global: …")
// or overrides, Use global clears an override, and Save sends null for a cleared one.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()

function info(values: Partial<Settings> = {}, from: Partial<Record<keyof Settings, SettingSource>> = {}): SettingsInfo {
  const sources = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, from[k as keyof Settings] ?? "default"])) as SettingsInfo["sources"]
  return { settings: { ...DEFAULT_SETTINGS, ...values }, sources, defaults: DEFAULT_SETTINGS }
}

const project = (over: Partial<Project> = {}) =>
  ({
    id: "prj_game",
    name: "survive-the-night",
    description: "",
    repo: "acme/survive",
    baseBranch: "main",
    envKeys: [],
    notes: [],
    runner: "box",
    boxSize: null,
    agentsPerBox: null,
    wholeMachine: false,
    tasksPerBox: null,
    maxBoxes: null,
    gpuMaxHourlyUsd: null,
    gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null },
    docker: { image: null, dockerfile: null },
    partialClone: null,
    pushAtTurnEnd: null,
    depCache: null,
    notesMaxCount: null,
    notesMaxTokens: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  }) as unknown as Project

let root: Root
let host: HTMLElement
let requests: { method: string; url: string; body?: Record<string, unknown> }[]

function render(p: Project, settings = info({ workerSize: "medium", maxBoxes: 6 })) {
  history.replaceState(null, "", `/projects/${p.id}?tab=settings`)
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.projects, [p])
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.agentSettings, settings)
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "~/boxyard-workspaces" })
  qc.setQueryData(keys.health, { provider: "upstash" })
  for (const k of [keys.artifacts, keys.schedules, keys.boxes]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ProjectView, { id: p.id }))))
}

beforeEach(() => {
  requests = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    requests.push({ method, url, body })
    if (method === "PATCH") return new Response(JSON.stringify({ ...project(), ...body }), { status: 200, headers: { "Content-Type": "application/json" } })
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

const $ = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid=${id}]`)
const source = (k: string) => $(`project-${k}-source`)!.textContent
const clear = (k: string) => $<HTMLButtonElement>(`project-${k}-clear`)
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))

describe("Project › Settings › Boxes", () => {
  it("says which global value each setting uses while it's not set, with no Use global", () => {
    render(project())
    expect(source("box-size")).toBe("Using global: medium (Worker size).")
    expect(source("agents-per-box")).toBe("Using global: each box's size default (small 1 · medium 2 · large 4).")
    expect(source("tasks-per-box")).toBe("Using global: each box's size default (small 3 · medium 8 · large 18).")
    expect(source("max-boxes")).toBe("Using global: 6 (the whole pool's Max boxes).")
    expect($<HTMLInputElement>("project-agents-per-box")!.placeholder).toBe("Global: by box size")
    expect($<HTMLInputElement>("project-max-boxes")!.placeholder).toBe("Global: 6")
    for (const k of ["box-size", "agents-per-box", "tasks-per-box", "max-boxes"]) expect(clear(k)).toBeNull()
    // The global number when Settings sets one for every box.
    act(() => root.unmount())
    root = createRoot(host)
    render(project(), info({ slotsPerBox: 3 }, { slotsPerBox: "ui" }))
    expect(source("agents-per-box")).toBe("Using global: 3.")
  })

  it("shows an override with Use global, which clears it, and saves null for a cleared one", async () => {
    render(project({ boxSize: "large", agentsPerBox: 1, tasksPerBox: 4 }))
    expect($<HTMLInputElement>("project-agents-per-box")!.value).toBe("1")
    expect(source("agents-per-box")).toBe("Overrides global: each box's size default (small 1 · medium 2 · large 4).")
    expect(source("box-size")).toBe("Overrides global: medium (Worker size).")

    click(clear("agents-per-box")!)
    expect($<HTMLInputElement>("project-agents-per-box")!.value).toBe("")
    expect(source("agents-per-box")).toMatch(/^Using global: /)
    expect(clear("agents-per-box")).toBeNull()
    click(clear("box-size")!)
    expect($<HTMLSelectElement>("project-box-size")!.value).toBe("")

    type($<HTMLInputElement>("project-max-boxes")!, "2")
    expect(source("max-boxes")).toBe("Overrides global: 6 (the whole pool's Max boxes).")
    expect(clear("max-boxes")).not.toBeNull()

    const form = $("project-boxes")!.closest("form")!
    act(() => void form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    await settle()
    const sent = requests.find((r) => r.method === "PATCH")!
    expect(sent.url).toBe("/api/projects/prj_game")
    expect(sent.body).toMatchObject({ boxSize: null, agentsPerBox: null, tasksPerBox: 4, maxBoxes: 2 })
    expect(sent.body).not.toHaveProperty("heavyTasks")
  })

  it("on this computer, says Agents at once still applies there", () => {
    render(project({ runner: "local" }))
    expect($("project-boxes")!.textContent).toContain("Tasks running at once also limits its tasks here, within Settings › Tasks running at once on this computer")
  })

  // Cody: it wasn't obvious that the setting held back every project. It now says it limits only this project's.
  it("says Agents at once limits only this project's agents, with what the value does as it stands", () => {
    render(project({ agentsPerBox: 1 }))
    const field = $("project-agents-per-box")!.closest("div.space-y-1\\.5")!
    expect(field.querySelector("label")!.textContent).toBe("Tasks running at once (this project)")
    expect(field.textContent).toContain("How many of this project's tasks can run at the same time on one box or this computer. Other projects' tasks never wait for it.")
    expect($("project-agents-per-box-effect")!.textContent).toBe("survive-the-night: 1 at a time; other projects unaffected.")
    type($<HTMLInputElement>("project-agents-per-box")!, "3")
    expect($("project-agents-per-box-effect")!.textContent).toBe("survive-the-night: 3 at a time; other projects unaffected.")
    type($<HTMLInputElement>("project-agents-per-box")!, "")
    expect($("project-agents-per-box-effect")!.textContent).toBe("survive-the-night: up to the box's limit; other projects unaffected.")
  })

  it("Needs the whole machine is off by default, says what it does, and saves", async () => {
    render(project({ agentsPerBox: 1 }))
    const box = $<HTMLInputElement>("project-whole-machine")!
    expect(box.checked).toBe(false)
    expect(box.closest("label")!.textContent).toContain("No other project's tasks run on the same box or this computer while one of its tasks runs")
    click(box)
    expect(box.checked).toBe(true)
    expect($("project-agents-per-box-effect")!.textContent).toBe("survive-the-night: 1 at a time; no other project's tasks run beside it.")
    const form = $("project-boxes")!.closest("form")!
    act(() => void form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    await settle()
    expect(requests.find((r) => r.method === "PATCH")!.body).toMatchObject({ agentsPerBox: 1, wholeMachine: true })
  })
})

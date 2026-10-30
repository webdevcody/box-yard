// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ProjectView } from "../web/src/components/ProjectView.js"
import { keys } from "../web/src/lib/queries.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { DEFAULT_IDENTITY_ID, type Identity } from "../shared/identities"
import type { Project, SettingsInfo, Task } from "../shared/types"

// Project › Settings › Identity: who the project acts as, saved with the rest of the form. The picker says (and Save
// waits) when the identity can't run on the project's runner, or a turn is running and would switch accounts halfway.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const identity = (id: string, name: string, extra: Partial<Identity> = {}) =>
  ({ id, name, color: "sky", isDefault: id === DEFAULT_IDENTITY_ID, githubLogin: null, owners: [], tokens: [], author: null, signing: null, claude: null, runners: null, projectIds: [], lastCheck: null, ...extra }) as unknown as Identity
const IDENTITIES = [identity(DEFAULT_IDENTITY_ID, "Default", { color: "slate", githubLogin: "octocat" }), identity("idn_acme", "Acme", { githubLogin: "octo-acme", coordinatorSees: "status" }), identity("idn_here", "Signed here", { githubLogin: "octo-here", runners: ["local"] })]

const project = (over: Partial<Project> = {}) =>
  ({
    id: "prj_app",
    name: "app",
    description: "",
    repo: "acme-corp/app",
    baseBranch: "main",
    envKeys: [],
    notes: [],
    runner: "box",
    identityId: DEFAULT_IDENTITY_ID,
    boxSize: null,
    gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null },
    gpuProvider: null,
    docker: { image: null, dockerfile: null },
    createdAt: now,
    updatedAt: now,
    ...over,
  }) as unknown as Project

const info = (): SettingsInfo => ({
  settings: DEFAULT_SETTINGS,
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})

let root: Root
let host: HTMLElement
let requests: { method: string; url: string; body?: Record<string, unknown> }[]

function render(p: Project, tasks: Partial<Task>[] = []) {
  history.replaceState(null, "", `/projects/${p.id}?tab=settings`)
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.projects, [p])
  qc.setQueryData(keys.tasks, tasks)
  qc.setQueryData(keys.identities, IDENTITIES)
  qc.setQueryData(keys.agentSettings, info())
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
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const pick = (value: string) => {
  const select = $<HTMLSelectElement>("project-identity")!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value)
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
}
const save = () => $<HTMLButtonElement>("project-settings-save")!
const submit = async () => {
  act(() => void save().closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  await settle()
}

describe("Project › Settings › Identity", () => {
  it("lists every identity with its account, and sends identityId only when it changed", async () => {
    render(project())
    const options = [...$<HTMLSelectElement>("project-identity")!.options].map((o) => o.textContent)
    expect(options).toEqual(["Default · octocat", "Acme · octo-acme", "Signed here · octo-here (not on Upstash box)"])
    expect(save().disabled).toBe(true)

    pick("idn_acme")
    expect(document.querySelector('[data-identity="Acme"]')).not.toBeNull()
    expect(save().disabled).toBe(false)
    await submit()
    expect(requests.find((r) => r.method === "PATCH")!.body).toMatchObject({ identityId: "idn_acme" })
  })

  it("leaves identityId out of a save that didn't touch it", async () => {
    render(project({ identityId: "idn_acme" }))
    const description = document.querySelector<HTMLTextAreaElement>("textarea")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(description, "d")
      description.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await submit()
    expect(requests.find((r) => r.method === "PATCH")!.body).not.toHaveProperty("identityId")
  })

  it("an identity that can't run on the project's runner says so, and Save waits", () => {
    render(project())
    pick("idn_here")
    expect($("identity-misfit")!.textContent).toBe("The Signed here identity runs only on this computer: pick another runner or identity.")
    expect(save().disabled).toBe(true)
    pick(DEFAULT_IDENTITY_ID)
    expect($("identity-misfit")).toBeNull()
  })

  it("an identity that shows the Coordinator status only says so", () => {
    render(project())
    expect($("identity-status-only")).toBeNull()
    pick("idn_acme")
    expect($("identity-status-only")!.textContent).toBe("The Acme identity shows the Coordinator this project's status only (titles, states, PRs). Its Captain sees everything.")
    expect(save().disabled).toBe(false)
  })

  it("a running turn keeps the identity until it rests", () => {
    render(project(), [{ id: "task_1", projectId: "prj_app", title: "busy", status: "working" }])
    expect($("identity-busy")).toBeNull()
    pick("idn_acme")
    expect($("identity-busy")!.textContent).toContain('"busy" is running.')
    expect(save().disabled).toBe(true)
  })
})

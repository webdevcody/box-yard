// @vitest-environment happy-dom
// Codex in the web UI: the Agent and Codex model settings (Coordinator, Captains, Box agents), the two Codex logins
// in Settings › Credentials, a project's Agent, the New task dialog's agent, and the "Codex" chip on tasks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { ProjectView } from "../web/src/components/ProjectView.js"
import { NewTaskDialog } from "../web/src/components/NewTask.js"
import { TaskCard } from "../web/src/components/TaskCard.js"
import { TaskHeader } from "../web/src/components/TaskHeader.js"
import { SetupCard } from "../web/src/components/Setup.js"
import { keys } from "../web/src/lib/queries.js"
import type { SettingsSection } from "../web/src/lib/settingsNav.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { CODEX_MODEL_SUGGESTIONS } from "../shared/agentCli.js"
import type { Project, Settings, SettingsInfo, Task } from "../shared/types"
import type { CredentialKey, CredentialStatus, SetupStatus } from "../shared/setup"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const info = (values: Partial<Settings> = {}): SettingsInfo => ({
  settings: { ...DEFAULT_SETTINGS, ...values },
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})

const unset: CredentialStatus = { state: "unset", source: null }
const saved: CredentialStatus = { state: "set", source: "saved" }
function setup(creds: Partial<Record<CredentialKey, CredentialStatus>> = {}, codexRequired = false): SetupStatus {
  const credentials = { upstashBoxApiKey: saved, claudeOauthToken: saved, anthropicApiKey: unset, codexAuthJson: unset, codexApiKey: unset, githubToken: unset, runpodApiKey: unset, ...creds }
  const auth = credentials.codexAuthJson.state === "set"
  const key = credentials.codexApiKey.state === "set"
  return {
    ready: true,
    missing: [],
    mock: false,
    credentials,
    boxes: { provider: "upstash", required: true },
    claude: { required: true, state: "set", using: "claudeOauthToken" },
    codex: { required: codexRequired, state: auth || key ? "set" : "unset", using: auth ? "codexAuthJson" : key ? "codexApiKey" : null },
    github: { state: "unset" },
    owner: { name: "Cody", source: "default" },
    runner: { choice: "box", default: "box" },
    upstash: { available: true },
    local: null,
    restart: [],
  }
}

const project = (over: Partial<Project> = {}) =>
  ({
    id: "prj_codex1",
    name: "codex-app",
    description: "",
    repo: "acme/app",
    baseBranch: "main",
    envKeys: [],
    notes: [],
    runner: "box",
    agentCli: null,
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

const task = (over: Partial<Task> = {}) =>
  ({
    id: "task_codex0001",
    projectId: "prj_codex1",
    title: "Port the parser",
    prompt: "",
    status: "working",
    boxId: null,
    sessionId: "",
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
    turnCount: 1,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    outcome: null,
    contextTokens: null,
    contextWindow: null,
    compactPending: false,
    compacting: false,
    agentCli: "claude",
    model: null,
    effort: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    routingRule: null,
    routingReason: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  }) as unknown as Task

let root: Root
let host: HTMLElement
let qc: QueryClient
let requests: { method: string; url: string; body?: Record<string, unknown> }[]
let section: SettingsSection

function show(el: ReturnType<typeof createElement>) {
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, el)))
}
function settings(s: SettingsSection) {
  section = s
  show(createElement(SettingsDialog, { section, onSection: (next: SettingsSection) => settings(next), onClose: () => {} }))
}

beforeEach(() => {
  requests = []
  history.replaceState(null, "", "/")
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.agentSettings, info())
  qc.setQueryData(keys.health, { provider: "upstash" })
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "~/boxyard-workspaces" })
  qc.setQueryData(keys.setup, setup())
  qc.setQueryData(keys.tasks, [])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes]) qc.setQueryData(k, [])
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    requests.push({ method, url, body })
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } })
    if (method === "PUT" && url === "/api/agent-settings") return json(info(body as Partial<Settings>))
    if (method === "PUT" && url === "/api/setup/credentials") return json(setup({ codexAuthJson: saved }))
    if (method === "POST" && url.startsWith("/api/setup/test/")) return json({ ok: true, message: "Codex answered", ms: 900 })
    if (method === "PATCH" && url.startsWith("/api/projects/")) return json({ ...project(), ...body })
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

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const $ = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid=${id}]`)
const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)
const choose = async (el: HTMLSelectElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle()
}
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
const saveSettings = async () => {
  for (const f of document.querySelectorAll("form")) f.noValidate = true
  act(() => button("Save")!.click())
  await settle()
}
const sent = (method: string, url: string) => requests.filter((r) => r.method === method && r.url === url).map((r) => r.body)

describe("Settings › Coordinator", () => {
  it("swaps the Claude model for a Codex model once Codex is picked, and saves both", async () => {
    settings("orchestrator")
    const cli = $<HTMLSelectElement>("orchestrator-cli")!
    expect(cli.value).toBe("claude")
    expect([...cli.options].map((o) => o.textContent)).toEqual(["Claude Code", "Codex"])
    expect($("orchestrator-codex-model")).toBeNull()
    expect(document.body.textContent).toContain("The Claude model the Coordinator chat runs on.")

    await choose(cli, "codex")
    const model = $<HTMLInputElement>("orchestrator-codex-model")!
    expect(model.placeholder).toBe("Codex's default")
    expect(model.getAttribute("list")).toBe("boxyard-codex-models")
    expect([...document.querySelectorAll("#boxyard-codex-models option")].map((o) => o.getAttribute("value"))).toEqual([...CODEX_MODEL_SUGGESTIONS])
    expect(document.body.textContent).not.toContain("The Claude model the Coordinator chat runs on.")

    // A Claude model can't run on Codex: the field says so before the server does.
    type(model, "opus")
    expect(model.getAttribute("aria-invalid")).toBe("true")
    expect(document.body.textContent).toContain("That's a Claude model: Codex runs OpenAI models.")
    type(model, "gpt-6.1-sol")
    expect(model.getAttribute("aria-invalid")).toBeNull()

    await saveSettings()
    expect(sent("PUT", "/api/agent-settings")[0]).toMatchObject({ orchestratorCli: "codex", orchestratorCodexModel: "gpt-6.1-sol", captainCli: "claude" })
  })

  it("lets the Captains run on their own agent", async () => {
    settings("orchestrator")
    expect($<HTMLSelectElement>("captain-cli")!.value).toBe("claude")
    await choose($<HTMLSelectElement>("captain-cli")!, "codex")
    expect($<HTMLInputElement>("captain-codex-model")!.placeholder).toBe("Codex's default")
    // The Coordinator's own model field is untouched.
    expect($("orchestrator-codex-model")).toBeNull()
    await saveSettings()
    expect(sent("PUT", "/api/agent-settings")[0]).toMatchObject({ orchestratorCli: "claude", captainCli: "codex", captainCodexModel: "" })
  })
})

describe("Settings › Box agents", () => {
  it("has an Agent and a Codex model next to the Claude model, since projects can pick either", async () => {
    settings("agents")
    const cli = $<HTMLSelectElement>("agent-cli")!
    expect(cli.value).toBe("claude")
    expect(document.body.textContent).toContain("a task keeps the agent it started on, and a task given a gpt-* model runs on Codex")
    expect($<HTMLInputElement>("agent-codex-model")!.placeholder).toBe("Codex's default")
    await choose(cli, "codex")
    type($<HTMLInputElement>("agent-codex-model")!, "gpt-6-luna")
    await saveSettings()
    expect(sent("PUT", "/api/agent-settings")[0]).toMatchObject({ agentCli: "codex", agentCodexModel: "gpt-6-luna" })
  })
})

describe("Settings › Credentials › Codex", () => {
  const field = (k: CredentialKey) => document.querySelector<HTMLElement>(`[data-credential=${k}]`)!

  it("takes the ChatGPT login as a pasted auth.json in a text box, and the API key in a password field", async () => {
    settings("credentials")
    const text = document.body.textContent!
    expect(text).toContain("Codex ChatGPT login")
    expect(text).toContain("OpenAI API key for Codex")
    expect(text).toContain("Only for agents set to run on Codex")
    expect(text).toContain("~/.codex/auth.json")
    expect(document.querySelector("[aria-label='Copy codex login']")).not.toBeNull()
    expect(field("codexApiKey").querySelector("input")!.type).toBe("password")

    const box = field("codexAuthJson").querySelector("textarea")!
    expect(box.placeholder).toContain("~/.codex/auth.json")
    const auth = '{\n  "auth_mode": "chatgpt",\n  "tokens": { "refresh_token": "rt" }\n}'
    type(box, auth)

    // Test checks what was typed, without saving it.
    act(() => button("Test", field("codexAuthJson"))!.click())
    await settle()
    expect(sent("POST", "/api/setup/test/codexAuthJson")).toEqual([{ value: auth }])
    expect(field("codexAuthJson").textContent).toContain("Codex answered")

    // In Settings the dialog's Save writes it, like any other draft.
    expect(sent("PUT", "/api/setup/credentials")).toEqual([])
    await saveSettings()
    expect(sent("PUT", "/api/setup/credentials")).toEqual([{ codexAuthJson: auth }])
    // Values never come back: once saved the field is masked.
    expect(field("codexAuthJson").querySelector("textarea")).toBeNull()
    expect(field("codexAuthJson").querySelector("[data-key-masked]")).not.toBeNull()
  })

  it("says the ChatGPT login wins when both are set, and when the Coordinator needs one", () => {
    qc.setQueryData(keys.setup, setup({ codexAuthJson: saved, codexApiKey: saved }, true))
    settings("credentials")
    expect($("codex-both")!.textContent).toBe("Both are set, so Codex uses the ChatGPT login.")
    expect($("codex-credentials-intro")!.textContent).toContain("The Coordinator runs on Codex")
  })
})

describe("the setup card", () => {
  const card = (status: SetupStatus) => show(createElement(SetupCard, { status }))
  const press = (el: Element, init: KeyboardEventInit) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init })))

  it("has no Codex step unless the Coordinator runs on Codex", () => {
    card(setup())
    expect(document.querySelector("[aria-label='How Codex signs in']")).toBeNull()
    expect(document.querySelector("[data-credential^=codex]")).toBeNull()
  })

  it("asks for a Codex login when the Coordinator runs on Codex; Enter is a new line in the auth.json box, ⌘/Ctrl+Enter saves it", async () => {
    card(setup({}, true))
    const group = document.querySelector("[aria-label='How Codex signs in']")!
    expect([...group.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["ChatGPT login", "API key"])
    const box = document.querySelector<HTMLTextAreaElement>("[data-credential=codexAuthJson] textarea")!
    type(box, '{"auth_mode":"chatgpt"}')
    press(box, {})
    await settle()
    expect(sent("PUT", "/api/setup/credentials")).toEqual([])
    press(box, { ctrlKey: true })
    await settle()
    expect(sent("PUT", "/api/setup/credentials")).toEqual([{ codexAuthJson: '{"auth_mode":"chatgpt"}' }])
    // The API key is the other way in.
    act(() => button("API key", group)!.click())
    expect(document.querySelector<HTMLInputElement>("[data-credential=codexApiKey] input")!.type).toBe("password")
  })
})

describe("Project › Settings › Agent", () => {
  const render = (p: Project, values: Partial<Settings> = {}) => {
    history.replaceState(null, "", `/projects/${p.id}?tab=settings`)
    qc.setQueryData(keys.projects, [p])
    qc.setQueryData(keys.agentSettings, info(values))
    show(createElement(ProjectView, { id: p.id }))
  }
  const submit = async () => {
    const form = $("project-agent-cli")!.closest("form")!
    act(() => void form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    await settle()
    return requests.find((r) => r.method === "PATCH")!.body
  }

  it("follows the Settings default until one is picked, and saves the pick", async () => {
    render(project(), { agentCli: "codex" })
    const select = $<HTMLSelectElement>("project-agent-cli")!
    expect(select.value).toBe("")
    expect([...select.options].map((o) => o.textContent)).toEqual(["Settings default (Codex)", "Claude Code", "Codex"])
    expect(document.body.textContent).toContain("Tasks it already has keep theirs.")
    await choose(select, "claude")
    expect(await submit()).toMatchObject({ agentCli: "claude" })
  })

  it("sends null to go back to the default, and nothing when it didn't change", async () => {
    render(project({ agentCli: "codex" }))
    expect($<HTMLSelectElement>("project-agent-cli")!.value).toBe("codex")
    await choose($<HTMLSelectElement>("project-agent-cli")!, "")
    expect(await submit()).toMatchObject({ agentCli: null })

    requests = []
    act(() => root.unmount())
    root = createRoot(host)
    render(project({ agentCli: "codex" }))
    type(document.querySelector<HTMLTextAreaElement>("form textarea")!, "A new description")
    expect(await submit()).not.toHaveProperty("agentCli")
  })

  it("points to Settings › Credentials while Codex has no login", () => {
    render(project({ agentCli: "codex" }))
    expect($("project-codex-login")!.textContent).toContain("Codex needs a login first.")
    act(() => root.unmount())
    root = createRoot(host)
    qc.setQueryData(keys.setup, setup({ codexApiKey: saved }))
    render(project({ agentCli: "codex" }))
    expect($("project-codex-login")).toBeNull()
  })
})

describe("New task › Agent", () => {
  it("starts on the project's agent, offers that agent's models, and sends only a different pick", async () => {
    qc.setQueryData(keys.projects, [project({ agentCli: "codex" })])
    show(createElement(NewTaskDialog, { projectId: "prj_codex1", initialPrompt: "Port the parser", onCancel: () => {}, onDone: () => {} }))
    const agent = $<HTMLSelectElement>("new-task-agent-cli")!
    expect(agent.options[0]!.textContent).toBe("Default (Codex)")
    const models = () => [...$<HTMLSelectElement>("new-task-model")!.options].map((o) => o.value)
    expect(models()).toEqual(["", ...CODEX_MODEL_SUGGESTIONS])
    await choose(agent, "claude")
    expect(models()).toContain("claude-opus-5-5")
    expect(models()).not.toContain("gpt-6.1-sol")
    act(() => button("Start agent")!.click())
    await settle()
    expect(sent("POST", "/api/tasks")[0]).toMatchObject({ projectId: "prj_codex1", agentCli: "claude" })
  })
})

describe("the Codex chip", () => {
  it("is on a Codex task's card and header, and never on a Claude task's", () => {
    show(createElement(TaskCard, { task: task({ agentCli: "codex" }) }))
    expect($("agent-cli-chip")!.textContent).toBe("Codex")
    show(createElement(TaskCard, { task: task() }))
    expect($("agent-cli-chip")).toBeNull()

    show(createElement(TaskHeader, { task: task({ agentCli: "codex" }), project: project(), schedule: null, files: [], showTools: false, onShowTools: () => {} }))
    const chip = $("task-meta")!.querySelector("[data-testid=agent-cli-chip]")!
    expect(chip.textContent).toBe("Codex")
    show(createElement(TaskHeader, { task: task(), project: project(), schedule: null, files: [], showTools: false, onShowTools: () => {} }))
    expect($("agent-cli-chip")).toBeNull()
  })
})

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { keys } from "../web/src/lib/queries.js"
import { ZEN_PATH } from "../web/src/lib/zen.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import type { ChatMessage, Project, Task } from "../shared/types"
import type { CredentialKey, CredentialStatus, SetupStatus } from "../shared/setup"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const PROJECTS = [{ id: "prj_demo01", name: "demo", repo: "acme/demo", description: "", notes: [], updatedAt: now }] as unknown as Project[]
const TASKS = [
  { id: "task_demo01", projectId: "prj_demo01", title: "A task", prompt: "", status: "done", previews: [], turnCount: 1, pendingCount: 0, createdAt: now, updatedAt: now },
] as unknown as Task[]

class FakeEventSource {
  onmessage: unknown = null
  onerror: unknown = null
  onopen: unknown = null
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const unset: CredentialStatus = { state: "unset", source: null }
const saved: CredentialStatus = { state: "set", source: "saved" }
function setup(creds: Partial<Record<CredentialKey, CredentialStatus>> = {}): SetupStatus {
  const credentials = { upstashBoxApiKey: unset, claudeOauthToken: unset, anthropicApiKey: unset, githubToken: unset, ...creds }
  const boxes = credentials.upstashBoxApiKey.state === "set"
  const claude = credentials.claudeOauthToken.state === "set" || credentials.anthropicApiKey.state === "set"
  const missing = [...(boxes ? [] : ["Upstash Box API key"]), ...(claude ? [] : ["Claude sign-in"])]
  return {
    ready: missing.length === 0,
    missing,
    mock: false,
    credentials,
    boxes: { provider: boxes ? "upstash" : "local", required: true },
    claude: { required: true, state: claude ? "set" : "unset", using: credentials.anthropicApiKey.state === "set" ? "anthropicApiKey" : claude ? "claudeOauthToken" : null },
    github: { state: credentials.githubToken.state },
    owner: { name: "Cody", source: "default" },
    restart: [],
  }
}

let root: Root
let host: HTMLElement
let qc: QueryClient
let calls: { url: string; method: string; body: unknown }[]
/** Answers for the API calls a test makes; anything else never resolves. */
let routes: Record<string, (body: unknown) => unknown>

function render(path: string, o: { newTab?: boolean; startInZen?: boolean | null; status?: SetupStatus; chat?: ChatMessage[] } = {}) {
  history.replaceState(null, "", path)
  if (!o.newTab) sessionStorage.setItem("box-yard:landed", "1")
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.health, { ok: true, provider: "local", mock: false, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens: 0, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  if (o.startInZen !== null) qc.setQueryData(keys.agentSettings, { settings: { startInZen: o.startInZen ?? true, ownerName: "Cody" }, sources: { ownerName: "default" }, defaults: {} })
  qc.setQueryData(keys.setup, o.status ?? setup({ upstashBoxApiKey: saved, claudeOauthToken: saved }))
  qc.setQueryData(keys.chat, o.chat ?? [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, TASKS)
  qc.setQueryData(keys.projects, PROJECTS)
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20 })
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

const inZen = () => Boolean(document.querySelector("[data-zen]"))
const chat = () => document.querySelector<HTMLElement>("[data-testid=chat-panel]")
const card = () => document.querySelector<HTMLElement>("[data-testid=setup-card]")
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)))
const byText = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  calls = []
  routes = {}
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, body })
      const route = routes[`${method} ${url}`]
      if (!route) return new Promise(() => {})
      return Promise.resolve(new Response(JSON.stringify(route(body)), { status: 200, headers: { "Content-Type": "application/json" } }))
    }),
  )
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  for (const t of currentToasts()) dismiss(t.id)
  vi.unstubAllGlobals()
})

describe("where Box Yard opens", () => {
  it("a new tab on / opens Zen when Start in Zen mode is on (the default), replacing / in history", () => {
    const before = history.length
    render("/", { newTab: true })
    expect(inZen()).toBe(true)
    expect(location.pathname).toBe(ZEN_PATH)
    expect(history.length).toBe(before)
  })

  it("a new tab on / opens the Yard when it's off, and the choice is remembered for the next tab", () => {
    render("/", { newTab: true, startInZen: false })
    expect(inZen()).toBe(false)
    expect(location.pathname).toBe("/")
    expect(localStorage.getItem("box-yard:start-in-zen")).toBe("0")
  })

  it("a new tab waits for the setting rather than guess: nothing renders, then Zen", async () => {
    render("/", { newTab: true, startInZen: null })
    expect(chat()).toBeNull()
    expect(document.querySelector("main")).toBeNull()
    act(() => qc.setQueryData(keys.agentSettings, { settings: { startInZen: true, ownerName: "Cody" }, sources: {}, defaults: {} }))
    await settle()
    expect(inZen()).toBe(true)
  })

  it("a remembered setting decides at once, before settings load", () => {
    localStorage.setItem("box-yard:start-in-zen", "0")
    render("/", { newTab: true, startInZen: null })
    expect(inZen()).toBe(false)
    expect(document.querySelector("main")).not.toBeNull()
  })

  it("a reload after leaving Zen stays on the Yard", async () => {
    render("/", { newTab: true })
    expect(inZen()).toBe(true)
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
    await settle()
    expect(location.pathname).toBe("/")
    act(() => root.unmount())
    root = createRoot(host)
    render("/", { newTab: false })
    expect(inZen()).toBe(false)
  })

  it.each(["/tasks/task_demo01", "/projects/prj_demo01", "/boxes", "/usage", "/inbox", "/schedules", "/compactions", "/?settings=limits", "/?q=1", "/#chat"])(
    "a deep link (%s) opens its own page, never Zen",
    (path) => {
      render(path, { newTab: true })
      expect(inZen()).toBe(false)
      expect(location.pathname + location.search + location.hash).toBe(path)
      // And it counts as landed: going to / later in this tab doesn't jump into Zen either.
      expect(sessionStorage.getItem("box-yard:landed")).toBe("1")
    },
  )

  it("/settings/<section> opens that settings section over the Yard", () => {
    render("/settings/credentials", { newTab: true })
    expect(inZen()).toBe(false)
    expect(location.pathname + location.search).toBe("/?settings=credentials")
    expect(document.querySelector("[role=dialog]")?.textContent).toContain("Credentials")
  })
})

describe("first-run setup", () => {
  it("Zen shows a setup card instead of the chat until the required keys are set", () => {
    render(ZEN_PATH, { status: setup() })
    expect(card()).not.toBeNull()
    // The chat is still mounted behind it (a draft survives), just hidden.
    const composer = chat()!.querySelector("textarea")!
    expect(composer.closest(".hidden")).not.toBeNull()
    const text = card()!.textContent!
    expect(text).toContain("Upstash Box API key")
    expect(text).toContain("Contents and Pull requests: read and write · Metadata: read")
    expect(text).toContain("Uses your Claude Pro or Max plan, with no per-call charges.")
    const links = [...card()!.querySelectorAll<HTMLAnchorElement>("a")].map((a) => [a.href, a.target])
    expect(links).toContainEqual(["https://console.upstash.com/", "_blank"])
    expect(links.some(([h]) => h!.startsWith("https://docs.github.com/"))).toBe(true)
    expect(links.some(([h]) => h!.includes("generate-a-long-lived-token"))).toBe(true)
    expect(card()!.querySelector("[aria-label='Copy claude setup-token']")).not.toBeNull()
    // The Claude choice: subscription token or pay-per-use API key, in a button group.
    const group = card()!.querySelector("[role=group]")!
    act(() => byText("API key", group)!.click())
    expect(card()!.textContent).toContain("Pay per use, billed to your Claude Console account.")
  })

  it("saves a key from the card; the typed value leaves the page and only set/unset comes back", async () => {
    routes["PUT /api/setup/credentials"] = () => setup({ upstashBoxApiKey: saved })
    render(ZEN_PATH, { status: setup() })
    const input = card()!.querySelector<HTMLInputElement>("[data-credential=upstashBoxApiKey] input")!
    expect(input.type).toBe("password")
    type(input, "box_key_typed_secret_123")
    act(() => byText("Save", card()!.querySelector("[data-credential=upstashBoxApiKey]")!)!.click())
    await settle()
    expect(calls.find((c) => c.method === "PUT")).toEqual({ url: "/api/setup/credentials", method: "PUT", body: { upstashBoxApiKey: "box_key_typed_secret_123" } })
    expect(document.body.innerHTML).not.toContain("box_key_typed_secret_123")
    const field = card()!.querySelector("[data-credential=upstashBoxApiKey]")!
    expect(field.querySelector("[data-key-masked]")).not.toBeNull()
    expect(byText("Replace", field)).toBeDefined()
    expect(byText("Remove", field)).toBeDefined()
  })

  it("Test checks the typed key without saving it and shows the server's answer", async () => {
    routes["POST /api/setup/test/upstashBoxApiKey"] = () => ({ ok: false, message: "Upstash rejected the key (HTTP 401): invalid API key [redacted]", ms: 12 })
    render(ZEN_PATH, { status: setup() })
    const field = card()!.querySelector<HTMLElement>("[data-credential=upstashBoxApiKey]")!
    type(field.querySelector("input")!, "wrong_key_1234567890")
    act(() => byText("Test", field)!.click())
    await settle()
    expect(calls.find((c) => c.method === "POST")).toEqual({ url: "/api/setup/test/upstashBoxApiKey", method: "POST", body: { value: "wrong_key_1234567890" } })
    expect(field.querySelector("[data-key-test=error]")?.textContent).toBe("Upstash rejected the key (HTTP 401): invalid API key [redacted]")
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
  })

  it("a key from the server's env is read-only: no input, Replace or Remove, just Test", () => {
    render(ZEN_PATH, { status: setup({ githubToken: { state: "set", source: "env" } }) })
    const field = card()!.querySelector<HTMLElement>("[data-credential=githubToken]")!
    expect(field.querySelector("input")).toBeNull()
    expect(field.textContent).toContain("from env")
    expect(field.textContent).toContain("GITHUB_TOKEN")
    expect(byText("Replace", field)).toBeUndefined()
    expect(byText("Remove", field)).toBeUndefined()
    expect(byText("Test", field)).toBeDefined()
  })

  it("once the required keys are set the card goes away: a welcome with two ways to start", async () => {
    routes["POST /api/chat"] = (body) => ({ id: "msg_1", role: "user", content: (body as { content: string }).content, meta: null, createdAt: now })
    render(ZEN_PATH, { status: setup() })
    expect(card()).not.toBeNull()
    act(() => qc.setQueryData(keys.setup, setup({ upstashBoxApiKey: saved, claudeOauthToken: saved })))
    await settle()
    expect(card()).toBeNull()
    const welcome = document.querySelector<HTMLElement>("[data-testid=zen-welcome]")!
    expect(welcome.textContent).toContain("Welcome to Box Yard")
    expect(byText("Create your first project from a GitHub repo", welcome)).toBeDefined()
    // No GitHub token yet: one quiet line points to it.
    expect(welcome.textContent).toContain("Agents need a GitHub token")
    act(() => byText("What can you do?", welcome)!.click())
    await settle()
    expect(calls.find((c) => c.url === "/api/chat" && c.method === "POST")?.body).toMatchObject({ content: "What can you do?" })
  })

  it("Skip for now shows the chat with a one-line reminder that brings the card back", () => {
    render(ZEN_PATH, { status: setup() })
    act(() => byText("Skip for now")!.click())
    expect(card()).toBeNull()
    const reminder = document.querySelector<HTMLElement>("[data-testid=setup-reminder]")!
    expect(reminder.textContent).toContain("Needs Upstash Box API key and Claude sign-in")
    expect(chat()!.querySelector("textarea")!.closest(".hidden")).toBeNull()
    act(() => byText("Finish setup", reminder)!.click())
    expect(card()).not.toBeNull()
  })

  it("outside Zen the panel shows the reminder, which opens Settings › Credentials", () => {
    render("/", { status: setup({ upstashBoxApiKey: saved }) })
    expect(card()).toBeNull()
    const reminder = chat()!.querySelector<HTMLElement>("[data-testid=setup-reminder]")!
    expect(reminder.textContent).toContain("Needs Claude sign-in")
    act(() => byText("Finish setup", reminder)!.click())
    expect(location.search).toBe("?settings=credentials")
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!
    expect(dialog.querySelectorAll("[data-credential]").length).toBe(4)
  })

  it("mock mode and a configured yard never show setup", () => {
    render(ZEN_PATH, { status: { ...setup(), ready: true, missing: [], mock: true } })
    expect(card()).toBeNull()
    expect(document.querySelector("[data-testid=setup-reminder]")).toBeNull()
  })
})

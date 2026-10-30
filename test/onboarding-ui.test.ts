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
  const credentials = { upstashBoxApiKey: unset, claudeOauthToken: unset, anthropicApiKey: unset, codexAuthJson: unset, codexApiKey: unset, githubToken: unset, runpodApiKey: unset, ...creds }
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
    codex: { required: false, state: "unset", using: null },
    github: { state: credentials.githubToken.state },
    owner: { name: "Cody", source: "default" },
    // These tests follow the Upstash path; the "This computer" path has its own (local-onboarding-ui.test.ts).
    runner: { choice: "box", default: "box" },
    upstash: { available: boxes },
    local: null,
    restart: [],
  }
}

let root: Root
let host: HTMLElement
let qc: QueryClient
let calls: { url: string; method: string; body: unknown }[]
/** Answers for the API calls a test makes; anything else never resolves. */
let routes: Record<string, (body: unknown) => unknown>

function render(path: string, o: { newTab?: boolean; startInZen?: boolean | null; status?: SetupStatus; chat?: ChatMessage[]; owner?: string } = {}) {
  history.replaceState(null, "", path)
  if (!o.newTab) sessionStorage.setItem("box-yard:landed", "1")
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.health, { ok: true, provider: "local", mock: false, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens: 0, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  if (o.startInZen !== null)
    qc.setQueryData(keys.agentSettings, { settings: { startInZen: o.startInZen ?? true, ownerName: o.owner ?? "Cody" }, sources: { ownerName: o.owner ? "ui" : "default" }, defaults: {} })
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
const tryFirst = () => document.querySelector<HTMLElement>("[data-testid=try-first]")
const prompts = () => [...tryFirst()!.querySelectorAll<HTMLButtonElement>(".grid > button")]
const textarea = () => chat()!.querySelector("textarea")!
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
    const group = card()!.querySelector("[role=group][aria-label='How Claude signs in']")!
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

  it("once the required keys are set the card switches to what to try first", async () => {
    render(ZEN_PATH, { status: setup() })
    expect(card()).not.toBeNull()
    act(() => qc.setQueryData(keys.setup, setup({ upstashBoxApiKey: saved, claudeOauthToken: saved })))
    await settle()
    expect(card()).toBeNull()
    const step = tryFirst()!
    expect(step.querySelector("h2")!.textContent).toBe("You're set. Just tell the Coordinator what you want.")
    expect(prompts().map((b) => b.textContent)).toEqual([
      "Add my <owner/repo> repo as a project and list its open GitHub issues",
      "Pick the easiest open issue in <owner/repo> and fix it in a PR",
      "Look through <owner/repo> and tell me the 3 riskiest parts of the code",
      "Every weekday at 9am, summarize what's waiting on me",
    ])
    expect(step.textContent).toContain("The Coordinator creates projects, starts agents on their own boxes, and reports back. Ask in plain English.")
    // No GitHub token yet: one quiet line points to it, and there are no repos to ask for.
    expect(step.textContent).toContain("Agents need a GitHub token")
    expect(step.querySelector("[aria-label='Your recent repos']")).toBeNull()
    expect(calls.some((c) => c.url === "/api/setup/repos")).toBe(false)
  })

  it("Skip for now shows the chat with a one-line reminder that brings the card back", () => {
    render(ZEN_PATH, { status: setup() })
    act(() => byText("Skip for now")!.click())
    expect(card()).toBeNull()
    // The examples still show, but nothing is set yet, so they don't say so.
    expect(tryFirst()!.querySelector("h2")!.textContent).toBe("Just tell the Coordinator what you want.")
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
    // Upstash, both Claude keys, GitHub, and the two Codex logins.
    expect(dialog.querySelectorAll("[data-credential]").length).toBe(6)
  })

  it("mock mode and a configured yard never show setup", () => {
    render(ZEN_PATH, { status: { ...setup(), ready: true, missing: [], mock: true } })
    expect(card()).toBeNull()
    expect(document.querySelector("[data-testid=setup-reminder]")).toBeNull()
  })
})

describe("first-run setup: This computer", () => {
  const NODE = { key: "node", found: true, version: "v22.0.0" } as const
  /** Setup once "This computer" is chosen: no Upstash key, this computer's tools and logins instead. */
  function onComputer(o: { claudeLogin?: boolean; gh?: boolean; upstash?: boolean } = {}): SetupStatus {
    const claude = o.claudeLogin ?? true
    const base = setup({ ...(o.gh !== false && { githubToken: { state: "set", source: "gh" } }), ...(o.upstash && { upstashBoxApiKey: saved }) })
    return {
      ...base,
      ready: claude,
      missing: claude ? [] : ["Claude sign-in"],
      boxes: { provider: "local", required: false },
      claude: { ...base.claude, state: claude ? "set" : "unset" },
      runner: { choice: "local", default: "local" },
      upstash: { available: Boolean(o.upstash) },
      local: {
        tools: [NODE, { key: "claude", found: true, version: "2.1.0 (Claude Code)" }, { key: "gh", found: true, version: "gh version 2.60.0" }, { key: "chrome", found: false, version: null }],
        claudeLogin: claude,
        ghLogin: o.gh !== false,
        checkedAt: now,
      },
    }
  }
  const FIRST = { ...setup(), runner: { choice: null, default: "box" }, missing: ["a choice of where agents run", "Claude sign-in"] } satisfies SetupStatus
  const choiceButton = (runner: string) => document.querySelector<HTMLButtonElement>(`[data-runner-choice=${runner}]`)!

  it("asks where agents run first, and picking This computer skips the Upstash key", async () => {
    routes["PUT /api/setup/runner"] = () => onComputer({ claudeLogin: false })
    render(ZEN_PATH, { status: FIRST })
    expect(card()!.textContent).toContain("Where agents run")
    expect(choiceButton("local").textContent).toContain("No account needed")
    expect(choiceButton("box").textContent).toContain("Needs an Upstash Box API key")
    // Nothing asks for the Upstash key before the choice.
    expect(card()!.querySelector("[data-credential=upstashBoxApiKey]")).toBeNull()
    act(() => choiceButton("local").click())
    await settle()
    expect(calls.find((c) => c.url === "/api/setup/runner")).toMatchObject({ method: "PUT", body: { runner: "local" } })
    expect(choiceButton("local").getAttribute("aria-pressed")).toBe("true")
    expect(card()!.querySelector("[data-testid=runner-choice-warning]")!.textContent).toContain("not sandboxed")
    expect(card()!.querySelector("[data-credential=upstashBoxApiKey]")).toBeNull()
    // This computer's prerequisites, each found or not; a missing optional one isn't a warning.
    const rows = [...card()!.querySelectorAll<HTMLElement>("[data-local-tool]")]
    expect(rows.map((r) => r.dataset.localTool)).toEqual(["node", "claude", "gh", "chrome"])
    expect(rows[1]!.textContent).toContain("not signed in")
    expect(rows[3]!.textContent).toContain("optional")
    expect(rows[3]!.textContent).toContain("Get Chrome")
    expect(rows[3]!.querySelector(".text-amber-300, .text-red-300")).toBeNull()
    expect(card()!.textContent).toContain("no Upstash account to set up")
    // gh's login stands in for the GitHub token.
    expect(card()!.querySelector("[data-credential=githubToken]")!.textContent).toContain("gh auth")
  })

  it("with this computer's claude signed in, setup is complete and the chat shows", () => {
    render(ZEN_PATH, { status: onComputer() })
    expect(card()).toBeNull()
    expect(document.querySelector("[data-testid=setup-reminder]")).toBeNull()
  })

  it("Settings › Credentials can switch later; the Upstash key is optional while agents run here", async () => {
    render("/?settings=credentials", { status: onComputer() })
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!
    expect(dialog.querySelector<HTMLElement>("[data-runner-choice=local]")!.getAttribute("aria-pressed")).toBe("true")
    expect(dialog.querySelector("[data-testid=local-prereqs]")).not.toBeNull()
    expect(dialog.textContent).toContain("Optional while agents run on this computer")
    expect(dialog.querySelector("[data-testid=upstash-ready]")).toBeNull()
    routes["PUT /api/setup/runner"] = () => ({ ...setup(), runner: { choice: "box", default: "box" } })
    act(() => dialog.querySelector<HTMLButtonElement>("[data-runner-choice=box]")!.click())
    await settle()
    // A draft until the dialog's Save.
    expect(dialog.querySelector<HTMLElement>("[data-runner-choice=box]")!.getAttribute("aria-pressed")).toBe("true")
    expect(calls.find((c) => c.url === "/api/setup/runner")).toBeUndefined()
    for (const f of dialog.querySelectorAll("form")) f.noValidate = true
    act(() => byText("Save", dialog)!.click())
    await settle()
    expect(calls.find((c) => c.url === "/api/setup/runner")).toMatchObject({ method: "PUT", body: { runner: "box" } })
    expect(dialog.querySelector("[data-testid=local-prereqs]")).toBeNull()
  })

  it("once a key is added, Settings says boxes are ready", () => {
    render("/?settings=credentials", { status: onComputer({ upstash: true }) })
    expect(document.querySelector("[data-testid=upstash-ready]")!.textContent).toContain("Upstash boxes are ready")
  })

  it("the Boxes page says agents run here instead of showing empty pool limits", () => {
    render("/boxes", { status: onComputer() })
    const main = document.querySelector("main")!
    expect(main.querySelector("[data-testid=boxes-on-computer]")!.textContent).toContain("add an Upstash Box API key later in Settings")
    expect(main.textContent).not.toContain("No boxes yet")
    act(() => byText("Add Upstash in Settings", main)!.click())
    expect(location.search).toBe("?settings=credentials")
  })

  it("the Boxes page is unchanged once Upstash is available", () => {
    render("/boxes", { status: onComputer({ upstash: true }) })
    expect(document.querySelector("[data-testid=boxes-on-computer]")).toBeNull()
    expect(document.querySelector("main")!.textContent).toContain("No boxes yet")
  })

  it("a new project runs where setup chose; Upstash box waits for a key", () => {
    render("/", { status: onComputer() })
    act(() => document.querySelector<HTMLButtonElement>("button[aria-label='New project']")!.click())
    const select = document.querySelector<HTMLSelectElement>("[data-testid=new-project-runner]")!
    expect(select.value).toBe("local")
    expect(select.querySelector<HTMLOptionElement>("option[value=box]")!.disabled).toBe(true)
  })
})

describe("what to try first", () => {
  const READY = setup({ upstashBoxApiKey: saved, claudeOauthToken: saved })
  const WITH_GITHUB = setup({ upstashBoxApiKey: saved, claudeOauthToken: saved, githubToken: saved })
  const chatPosts = () => calls.filter((c) => c.url === "/api/chat" && c.method === "POST")

  it("picking an example fills the Coordinator box without sending it, with the repo placeholder selected", () => {
    render(ZEN_PATH, { status: READY })
    act(() => prompts()[0]!.click())
    const box = textarea()
    expect(box.value).toBe("Add my <owner/repo> repo as a project and list its open GitHub issues")
    expect(document.activeElement).toBe(box)
    expect(box.value.slice(box.selectionStart, box.selectionEnd)).toBe("<owner/repo>")
    expect(chatPosts()).toEqual([])
    // Another one replaces the draft; with nothing to fill in, the caret goes to the end.
    act(() => prompts()[3]!.click())
    expect(box.value).toBe("Every weekday at 9am, summarize what's waiting on me")
    expect([box.selectionStart, box.selectionEnd]).toEqual([box.value.length, box.value.length])
    expect(chatPosts()).toEqual([])
    expect(tryFirst()).not.toBeNull()
  })

  it("with a GitHub token, the most recently pushed repos are chips that fill the prompts in", async () => {
    routes["GET /api/setup/repos"] = () => ({ repos: ["cody/box-yard", "acme/site", "cody/dotfiles"] })
    render(ZEN_PATH, { status: WITH_GITHUB })
    await settle()
    const chips = [...tryFirst()!.querySelectorAll<HTMLButtonElement>("[aria-label='Your recent repos'] button")]
    expect(chips.map((c) => c.textContent)).toEqual(["cody/box-yard", "acme/site", "cody/dotfiles"])
    expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"])
    expect(prompts()[0]!.textContent).toBe("Add my cody/box-yard repo as a project and list its open GitHub issues")
    expect(tryFirst()!.textContent).not.toContain("Agents need a GitHub token")

    act(() => chips[1]!.click())
    expect(chips[1]!.getAttribute("aria-pressed")).toBe("true")
    expect(prompts().slice(0, 3).every((b) => b.textContent!.includes("acme/site"))).toBe(true)
    act(() => prompts()[1]!.click())
    const box = textarea()
    expect(box.value).toBe("Pick the easiest open issue in acme/site and fix it in a PR")
    expect([box.selectionStart, box.selectionEnd]).toEqual([box.value.length, box.value.length])
    expect(chatPosts()).toEqual([])
  })

  it("no repos back (an error or an empty account) falls back to the placeholder", async () => {
    routes["GET /api/setup/repos"] = () => ({ repos: [] })
    render(ZEN_PATH, { status: WITH_GITHUB })
    await settle()
    expect(calls.some((c) => c.url === "/api/setup/repos")).toBe(true)
    expect(tryFirst()!.querySelector("[aria-label='Your recent repos']")).toBeNull()
    expect(prompts()[0]!.textContent).toContain("<owner/repo>")
  })

  it("a saved name is in the greeting; the built-in default isn't", () => {
    render(ZEN_PATH, { status: READY, owner: "Sam" })
    expect(tryFirst()!.querySelector("h2")!.textContent).toBe("You're set, Sam. Just tell the Coordinator what you want.")
  })

  it("sending the first message hides it for good", async () => {
    routes["POST /api/chat"] = (body) => ({ id: "msg_1", role: "user", content: (body as { content: string }).content, meta: null, createdAt: now })
    render(ZEN_PATH, { status: READY })
    act(() => prompts()[3]!.click())
    act(() => chat()!.querySelector<HTMLButtonElement>("button[aria-label=Send]")!.click())
    await settle()
    expect(chatPosts().map((c) => (c.body as { content: string }).content)).toEqual(["Every weekday at 9am, summarize what's waiting on me"])
    expect(tryFirst()).toBeNull()
    // Back to an empty thread later (a new tab, a cleared chat): still gone.
    act(() => root.unmount())
    root = createRoot(host)
    render(ZEN_PATH, { status: READY })
    expect(tryFirst()).toBeNull()
  })

  it("Hide these examples dismisses it in this browser", () => {
    render(ZEN_PATH, { status: READY })
    act(() => byText("Hide these examples", tryFirst()!)!.click())
    expect(tryFirst()).toBeNull()
    expect(chat()!.querySelector("textarea")).not.toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    render(ZEN_PATH, { status: READY })
    expect(tryFirst()).toBeNull()
  })

  it("never shows over an existing thread, or outside Zen", () => {
    render(ZEN_PATH, { status: READY, chat: [{ id: "msg_0", role: "user", content: "hi", meta: null, createdAt: now }] as ChatMessage[] })
    expect(tryFirst()).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    render("/", { status: READY })
    expect(chat()).not.toBeNull()
    expect(tryFirst()).toBeNull()
  })
})

describe("voice read-back on a fresh install", () => {
  class FakeUtterance {
    constructor(public text: string) {}
  }
  const fakeSynth = { speaking: false, pending: false, paused: false, speak() {}, cancel() {}, pause() {}, resume() {}, getVoices: () => [], addEventListener() {}, removeEventListener() {} }
  /** lib/speech caches the settings: a storage event for its key makes it read them again. */
  const reloadVoice = () => window.dispatchEvent(new StorageEvent("storage", { key: "boxyard:voice" }))
  const speaker = () => chat()!.querySelector<HTMLButtonElement>("button[aria-pressed][aria-label*='voice']")

  beforeEach(() => {
    vi.stubGlobal("speechSynthesis", fakeSynth)
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance)
  })

  it("with no saved voice setting, the Coordinator's speaker starts on", () => {
    reloadVoice()
    render(ZEN_PATH)
    expect(speaker()!.getAttribute("aria-pressed")).toBe("true")
    expect(speaker()!.getAttribute("aria-label")).toBe("Turn voice off")
  })

  it("a saved choice to keep it off is respected", () => {
    localStorage.setItem("boxyard:voice", JSON.stringify({ enabled: false }))
    reloadVoice()
    render(ZEN_PATH)
    expect(speaker()!.getAttribute("aria-pressed")).toBe("false")
    expect(speaker()!.getAttribute("aria-label")).toBe("Turn voice on")
  })
})

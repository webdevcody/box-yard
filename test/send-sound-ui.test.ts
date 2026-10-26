// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

// The cue itself is tested in send-sound.test.ts; here we only check who asks for it, and when.
const sound = vi.hoisted(() => ({ play: vi.fn((_cue?: string, _o?: unknown) => true), prime: vi.fn() }))
vi.mock("../web/src/lib/sendSound.js", async (load) => ({
  ...(await load<typeof import("../web/src/lib/sendSound.js")>()),
  playSendSound: sound.play,
  primeSendSound: sound.prime,
}))

import { Composer } from "../web/src/components/Composer.js"
import { NewTaskButton } from "../web/src/components/NewTask.js"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { keys, newClientId, useCreateTask, useSendCaptainMessage, useSendChat, useSendQueuedNow, useSendTaskMessage } from "../web/src/lib/queries.js"
import { SEND_SOUND_KEY, getSendSound, setSendSound } from "../web/src/lib/sendSound.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import type { Project, Settings, SettingsInfo } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
/** Pending answers by "METHOD url", resolved by the test. */
let pending: Map<string, (status: number, body: unknown) => void>

beforeEach(() => {
  sound.play.mockClear()
  sound.prime.mockClear()
  pending = new Map()
  localStorage.clear()
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${url}`
    return new Promise<Response>((resolve) => {
      pending.set(key, (status, body) => resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })))
    })
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

function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } })
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.settings, { maxUploadMb: 20 })
  return qc
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 10)))
/** Answer the request `key` once the mutation has sent it (it sends after an await). */
async function answer(key: string, status: number, body: unknown) {
  await vi.waitFor(() => expect([...pending.keys()]).toContain(key))
  const reply = pending.get(key)!
  pending.delete(key)
  await act(async () => reply(status, body))
  await settle()
}
const cues = () => sound.play.mock.calls.map(([cue]) => cue ?? "sent")

/** The Coordinator chat's wiring: Composer → useSendChat (ChatPanel does the same). */
function Chat() {
  const send = useSendChat()
  const panel = useRef<HTMLDivElement>(null)
  return createElement(
    "div",
    { ref: panel, className: "relative" },
    createElement(Composer, { panelRef: panel, placeholder: "Message", onSubmit: (content: string) => send.mutate({ id: newClientId("chat"), content, attachments: [] }) }),
  )
}

const textarea = () => host.querySelector("textarea")!
function typeAndEnter(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), text)
    textarea().dispatchEvent(new Event("input", { bubbles: true }))
  })
  act(() => void textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })))
}

describe("sound on send: the composer", () => {
  it("primes on Enter but plays only once the server accepts the message", async () => {
    act(() => root.render(createElement(QueryClientProvider, { client: client() }, createElement(Chat))))
    typeAndEnter("hello")
    expect(sound.prime).toHaveBeenCalledTimes(1)
    expect(sound.play).not.toHaveBeenCalled()
    await answer("POST /api/chat", 200, { id: "chat_x1y2z3", role: "user", content: "hello", meta: {}, createdAt: 1 })
    expect(cues()).toEqual(["sent"])
  })

  it("plays the failed cue, never the sent one, when the send is refused", async () => {
    act(() => root.render(createElement(QueryClientProvider, { client: client() }, createElement(Chat))))
    typeAndEnter("hello")
    await answer("POST /api/chat", 500, { error: "boom" })
    expect(cues()).toEqual(["failed"])
  })

  it("an empty box sends nothing and makes no sound", async () => {
    act(() => root.render(createElement(QueryClientProvider, { client: client() }, createElement(Chat))))
    typeAndEnter("   ")
    await settle()
    expect(sound.prime).not.toHaveBeenCalled()
    expect(sound.play).not.toHaveBeenCalled()
  })

  it("asks for a cue per accepted send; rapid ones are merged by the player", async () => {
    act(() => root.render(createElement(QueryClientProvider, { client: client() }, createElement(Chat))))
    typeAndEnter("one")
    await vi.waitFor(() => expect(pending.has("POST /api/chat")).toBe(true))
    const first = pending.get("POST /api/chat")!
    pending.delete("POST /api/chat")
    typeAndEnter("two")
    await answer("POST /api/chat", 200, { id: "chat_two222", role: "user", content: "two", meta: {}, createdAt: 2 })
    await act(async () => first(200, { id: "chat_one111", role: "user", content: "one", meta: {}, createdAt: 1 }))
    await settle()
    // Both ask; createSendSound's GAP_MS keeps a burst to one sound (send-sound.test.ts).
    expect(cues()).toEqual(["sent", "sent"])
  })
})

/** Calls `fire` with the hook's mutate, from a component (hooks need one). */
function runMutation<T>(use: () => { mutate: (v: T) => void }, value: T) {
  let mutate!: (v: T) => void
  function Harness() {
    mutate = use().mutate
    return null
  }
  act(() => root.render(createElement(QueryClientProvider, { client: client() }, createElement(Harness))))
  act(() => mutate(value))
}

describe("sound on send: every send path", () => {
  const TASK = { id: "task_abc123", status: "working" }

  it.each([
    ["a Captain message", () => runMutation(() => useSendCaptainMessage("prj_demo01"), { id: "chat_c1c1c1", content: "hi" }), "POST /api/projects/prj_demo01/captain/messages", { id: "chat_c1c1c1", projectId: "prj_demo01", role: "user", content: "hi", meta: {}, createdAt: 1 }],
    ["a task follow-up", () => runMutation(() => useSendTaskMessage("task_abc123"), { content: "more" }), "POST /api/tasks/task_abc123/messages", TASK],
    ["a new task", () => runMutation(useCreateTask, { id: "task_abc123", projectId: "prj_demo01", title: "t", prompt: "p" }), "POST /api/tasks", TASK],
    ["Send now", () => runMutation(() => useSendQueuedNow("task_abc123"), {}), "POST /api/tasks/task_abc123/queue/send-now", { task: TASK, delivery: "interrupted", queued: 1 }],
  ])("%s: sent on success, failed on error", async (_name, start, key, body) => {
    start()
    expect(sound.play).not.toHaveBeenCalled()
    await answer(key, 200, body)
    expect(cues()).toEqual(["sent"])

    sound.play.mockClear()
    act(() => root.unmount())
    root = createRoot(host)
    start()
    await answer(key, 409, { error: "nope" })
    expect(cues()).toEqual(["failed"])
  })

  it("the New task popover primes inside the Enter press", async () => {
    const qc = client()
    qc.setQueryData(keys.projects, [{ id: "prj_demo01", name: "demo", repo: null, description: "", envKeys: [], notes: [] }] as unknown as Project[])
    qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Ada" } } as unknown as SettingsInfo)
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(NewTaskButton, { projectId: "prj_demo01" }))))
    act(() => host.querySelector<HTMLButtonElement>("button[aria-haspopup=dialog]")!.click())
    const box = document.querySelector<HTMLTextAreaElement>("[role=dialog] textarea")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "fix it")
      box.dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => void box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })))
    expect(sound.prime).toHaveBeenCalledTimes(1)
    expect(sound.play).not.toHaveBeenCalled()
    await answer("POST /api/tasks", 200, { id: "task_abc123", status: "queued" })
    expect(cues()).toEqual(["sent"])
  })
})

describe("sound on send: Settings", () => {
  function info(): SettingsInfo {
    const sources = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])) as SettingsInfo["sources"]
    return { settings: { ...DEFAULT_SETTINGS } as Settings, sources, defaults: DEFAULT_SETTINGS }
  }
  function open() {
    const qc = client()
    qc.setQueryData(keys.agentSettings, info())
    qc.setQueryData(keys.health, { provider: "local" })
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(SettingsDialog, { section: "notifications", onSection: () => {}, onClose: () => {} }))))
  }
  const toggle = () => [...document.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent === "Sound on send")!.control as HTMLInputElement
  const volume = () => document.querySelector<HTMLInputElement>("input[type=range]")!
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!
  const setRange = (el: HTMLInputElement, v: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v)
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })

  it("is on by default", () => {
    setSendSound({ enabled: true, volume: 0.6 })
    open()
    expect(toggle().checked).toBe(true)
    expect(volume().value).toBe("0.6")
  })

  it("edits a draft: nothing is saved until Save", async () => {
    setSendSound({ enabled: true, volume: 0.6 })
    open()
    act(() => toggle().click())
    expect(toggle().checked).toBe(false)
    expect(getSendSound().enabled).toBe(true)
    expect(document.body.textContent).toContain("1 unsaved change")
    act(() => button("Save").click())
    await settle()
    expect(getSendSound()).toEqual({ enabled: false, volume: 0.6 })
    expect(JSON.parse(localStorage.getItem(SEND_SOUND_KEY)!)).toEqual({ enabled: false, volume: 0.6 })
    // Only a browser setting changed, so nothing went to the server.
    expect([...pending.keys()].filter((k) => !k.startsWith("GET"))).toEqual([])
  })

  it("Discard drops the draft", () => {
    setSendSound({ enabled: true, volume: 0.6 })
    open()
    setRange(volume(), "0.3")
    act(() => button("Discard").click())
    expect(volume().value).toBe("0.6")
    expect(getSendSound().volume).toBe(0.6)
  })

  it("the preview plays the draft volume before it's saved", () => {
    setSendSound({ enabled: true, volume: 0.6 })
    open()
    setRange(volume(), "0.3")
    act(() => button("Sent").click())
    expect(sound.prime).toHaveBeenCalled()
    expect(sound.play).toHaveBeenLastCalledWith("sent", { settings: { enabled: true, volume: 0.3 } })
    act(() => button("Failed").click())
    expect(sound.play).toHaveBeenLastCalledWith("failed", { settings: { enabled: true, volume: 0.3 } })
    expect(getSendSound().volume).toBe(0.6)
  })
})

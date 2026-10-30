// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { keys } from "../web/src/lib/queries.js"
import { currentConfirm, settleConfirm } from "../web/src/lib/confirm.js"
import { getVoiceSettings } from "../web/src/lib/speech.js"
import { VOICE_KEY } from "../web/src/lib/voice.js"
import { draftChanges } from "../web/src/lib/settingsDraft.js"
import type { SettingsSection } from "../web/src/lib/settingsNav.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { TTS_DEFAULTS, type TtsInfo } from "../shared/tts.js"
import type { Settings, SettingsInfo } from "../shared/types"
import type { HookWithLastRun } from "../shared/hooks"

// Cody's rule for Settings: no control saves on change. Every control (radios, checkboxes, switches, browser-only
// voice choices) edits a draft; Save lights up while something differs and writes it all; Discard reverts.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settingsInfo = (values: Partial<Settings> = {}): SettingsInfo => ({
  settings: { ...DEFAULT_SETTINGS, ...values },
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})
const ttsInfo = (provider: TtsInfo["settings"]["provider"] = "browser"): TtsInfo => ({
  settings: { ...TTS_DEFAULTS, provider },
  sources: { provider: "ui", elevenlabs: "default", openai: "default" },
  keys: { elevenlabs: { state: "set", source: "ui" }, openai: { state: "unset", source: "default" } },
  defaults: TTS_DEFAULTS,
})
const hook = (id: string, enabled: boolean) =>
  ({ id, name: `Hook ${id}`, enabled, trigger: "task.pr_ready", action: "send_to_task", prompt: "merge it", filters: {}, projectId: null, lastRun: null }) as unknown as HookWithLastRun

let root: Root
let host: HTMLElement
let qc: QueryClient
let requests: { method: string; url: string; body?: unknown }[]
let section: SettingsSection
let closed: number
let spoken: string[]
let played: number

function render() {
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(SettingsDialog, {
          section,
          onSection: (s: SettingsSection) => {
            section = s
            render()
          },
          onClose: () => closed++,
        }),
      ),
    ),
  )
}

beforeEach(() => {
  requests = []
  closed = 0
  spoken = []
  played = 0
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => {
    played++
    return Promise.resolve()
  })
  localStorage.clear()
  // A browser with speech, so the Voice controls are enabled.
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      constructor(readonly text = "") {}
    },
  )
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: { speak: (u: { text?: string }) => void spoken.push(u.text ?? ""), cancel() {}, pause() {}, resume() {}, speaking: false, paused: false, getVoices: () => [], addEventListener() {}, removeEventListener() {} },
  })
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.agentSettings, settingsInfo())
  qc.setQueryData(keys.health, { provider: "local" })
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "/tmp/agents" })
  qc.setQueryData(keys.tts, ttsInfo())
  qc.setQueryData(keys.hooks("global"), [hook("hk_one", false), hook("hk_two", true)])
  qc.setQueryData(keys.hookRuns("global"), [])
  qc.setQueryData(keys.hookTemplates, [])
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body })
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } })
    if (method === "PUT" && url === "/api/tts/settings") return json({ ...ttsInfo(body.provider ?? "browser") })
    if (method === "PUT" && url === "/api/agent-settings") return json(settingsInfo(body))
    if (method === "PATCH" && url.startsWith("/api/hooks/")) return json({ ...hook(url.split("/").at(-1)!, body.enabled) })
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
  vi.restoreAllMocks()
  while (currentConfirm()) settleConfirm(currentConfirm()!.id, false)
})

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)
// happy-dom misreads a range input's step (0.1) as a step mismatch, which would block the form's submit.
const saveButton = () => {
  for (const f of document.querySelectorAll("form")) f.noValidate = true
  return button("Save")!
}
const unsaved = () => document.querySelector("[data-testid=unsaved-count]")?.textContent ?? null
const radio = (p: string) => document.querySelector<HTMLButtonElement>(`[data-provider="${p}"]`)!
const navDot = (s: SettingsSection) => Boolean(document.querySelector(`[data-section=${s}] [title="Unsaved changes"]`))
const checkbox = (label: string) => [...document.querySelectorAll("label")].find((l) => l.textContent?.trim() === label)!.querySelector("input")!
const writes = () => requests.filter((r) => r.method !== "GET")
const click = async (el: Element | null | undefined) => {
  act(() => (el as HTMLElement).click())
  await settle()
}

describe("Settings drafts", () => {
  it("a radio change doesn't save until Save, and Save enables and disables with it", async () => {
    section = "voice"
    render()
    expect(saveButton().disabled).toBe(true)
    await click(radio("elevenlabs"))
    expect(radio("elevenlabs").getAttribute("aria-checked")).toBe("true")
    expect(writes()).toEqual([])
    expect(saveButton().disabled).toBe(false)
    expect(unsaved()).toBe("1 unsaved change")
    expect(navDot("voice")).toBe(true)
    expect(navDot("orchestrator")).toBe(false)

    // Back to the saved provider: nothing to save again.
    await click(radio("browser"))
    expect(saveButton().disabled).toBe(true)
    expect(unsaved()).toBeNull()
    expect(navDot("voice")).toBe(false)

    await click(radio("openai"))
    await click(saveButton())
    expect(writes()).toEqual([{ method: "PUT", url: "/api/tts/settings", body: { provider: "openai" } }])
    expect(radio("openai").getAttribute("aria-checked")).toBe("true")
    expect(saveButton().disabled).toBe(true)
    expect(document.body.textContent).toContain("Saved")
  })

  it("changing the provider never speaks or plays anything, in the draft or on Save; only Test voice does", async () => {
    expect(getVoiceSettings().enabled).toBe(true)
    section = "voice"
    render()
    for (const p of ["openai", "elevenlabs", "openai"]) await click(radio(p))
    await click(saveButton())
    await click(radio("browser"))
    await click(saveButton())
    expect(writes().filter((r) => r.url === "/api/tts/settings")).toHaveLength(2)
    // A silent unlock utterance ("") is fine; no line is read.
    expect(spoken.filter(Boolean)).toEqual([])
    expect(played).toBe(0)
    await click(button("Test voice"))
    expect(spoken.filter(Boolean)).toHaveLength(1)
  })

  it("browser-only voice choices stay out of localStorage until Save", async () => {
    section = "voice"
    render()
    const before = getVoiceSettings().orchestrator
    act(() => checkbox("Coordinator summaries").click())
    await settle()
    expect(checkbox("Coordinator summaries").checked).toBe(!before)
    expect(localStorage.getItem(VOICE_KEY)).toBeNull()
    expect(getVoiceSettings().orchestrator).toBe(before)
    expect(saveButton().disabled).toBe(false)
    await click(saveButton())
    expect(getVoiceSettings().orchestrator).toBe(!before)
    expect(JSON.parse(localStorage.getItem(VOICE_KEY)!).orchestrator).toBe(!before)
    expect(saveButton().disabled).toBe(true)
  })

  it("Discard reverts every draft", async () => {
    section = "voice"
    render()
    const before = getVoiceSettings().taskEvents
    await click(radio("elevenlabs"))
    act(() => checkbox("Task events").click())
    await settle()
    expect(unsaved()).toBe("2 unsaved changes")
    await click(button("Discard"))
    expect(radio("browser").getAttribute("aria-checked")).toBe("true")
    expect(checkbox("Task events").checked).toBe(before)
    expect(saveButton().disabled).toBe(true)
    expect(writes()).toEqual([])
    expect(localStorage.getItem(VOICE_KEY)).toBeNull()
  })

  it("closing with unsaved changes asks: Discard, or Keep editing", async () => {
    section = "voice"
    render()
    await click(radio("elevenlabs"))
    act(() => document.querySelector<HTMLButtonElement>("button[aria-label=Close]")!.click())
    await settle()
    const ask = currentConfirm()!
    expect(ask).toMatchObject({ confirmLabel: "Discard", cancelLabel: "Keep editing" })
    act(() => settleConfirm(ask.id, false))
    await settle()
    expect(closed).toBe(0)
    expect(radio("elevenlabs").getAttribute("aria-checked")).toBe("true")
  })

  it("drafts survive switching sections, and one Save writes them all", async () => {
    section = "voice"
    render()
    await click(radio("openai"))
    await click(document.querySelector("[data-section=orchestrator]"))
    act(() => (document.querySelector("[data-testid=notes-retro]") as HTMLInputElement).click())
    await settle()
    expect(unsaved()).toBe("2 unsaved changes")
    expect(navDot("voice")).toBe(true)
    expect(navDot("orchestrator")).toBe(true)
    await click(document.querySelector("[data-section=voice]"))
    expect(radio("openai").getAttribute("aria-checked")).toBe("true")
    expect(writes()).toEqual([])

    await click(saveButton())
    expect(writes().map((r) => `${r.method} ${r.url}`).sort()).toEqual(["PUT /api/agent-settings", "PUT /api/tts/settings"])
    expect(writes().find((r) => r.url === "/api/agent-settings")!.body).toMatchObject({ notesRetroEnabled: !DEFAULT_SETTINGS.notesRetroEnabled })
    expect(saveButton().disabled).toBe(true)
  })

  it("the Coordinator's task card settings (Idle after, Done when its PR merges) wait for Save", async () => {
    section = "orchestrator"
    render()
    const hours = document.querySelector<HTMLInputElement>("[data-testid=cards-idle-hours]")!
    const auto = document.querySelector<HTMLInputElement>("[data-testid=auto-done-on-merge]")!
    expect(hours.value).toBe("3")
    expect(auto.checked).toBe(true)
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    act(() => {
      set.call(hours, "8")
      hours.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await click(auto)
    expect(writes()).toEqual([])
    expect(unsaved()).toBe("2 unsaved changes")
    await click(saveButton())
    expect(writes()).toMatchObject([{ method: "PUT", url: "/api/agent-settings", body: { cardsIdleHours: 8, autoDoneOnMerge: false } }])
  })

  it("hook switches in Settings wait for Save", async () => {
    section = "hooks"
    render()
    const sw = () => document.querySelector<HTMLButtonElement>('[role=switch][aria-label="Turn on Hook hk_one"], [role=switch][aria-label="Turn off Hook hk_one"]')!
    await click(sw())
    expect(sw().getAttribute("aria-checked")).toBe("true")
    expect(writes()).toEqual([])
    expect(navDot("hooks")).toBe(true)
    await click(saveButton())
    expect(writes()).toEqual([{ method: "PATCH", url: "/api/hooks/hk_one", body: { enabled: true } }])
  })
})

describe("draftChanges", () => {
  it("counts changed fields of an object, else one", () => {
    expect(draftChanges({ a: 1, b: [1] }, { a: 1, b: [1] })).toBe(0)
    expect(draftChanges({ a: 2, b: [2] }, { a: 1, b: [1] })).toBe(2)
    expect(draftChanges("x", undefined)).toBe(1)
    expect(draftChanges(undefined, undefined)).toBe(0)
  })
})

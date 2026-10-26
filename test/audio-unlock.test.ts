// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TTS_DEFAULTS, type TtsInfo } from "../shared/tts.js"

/** An <audio> element with a phone's autoplay rule: play() only works inside a gesture until it has played once. */
class PhoneAudio {
  static gesture = false
  static all: PhoneAudio[] = []
  src = ""
  volume = 1
  preload = ""
  paused = true
  unlocked = false
  played: string[] = []
  onplaying: ((ev: any) => void) | null = null
  onended: ((ev: any) => void) | null = null
  onerror: ((ev: any) => void) | null = null
  constructor() {
    PhoneAudio.all.push(this)
  }
  setAttribute() {}
  play() {
    if (!this.unlocked && !PhoneAudio.gesture) return Promise.reject(Object.assign(new Error("not allowed"), { name: "NotAllowedError" }))
    this.unlocked = true
    this.paused = false
    this.played.push(this.src)
    queueMicrotask(() => this.onplaying?.({}))
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.resetModules()
  PhoneAudio.gesture = false
  PhoneAudio.all = []
  vi.stubGlobal("Audio", PhoneAudio)
})
afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe("isActivationEvent", () => {
  it("counts a touch's pointerup/touchend/click and a mouse's pointerdown, never a touch's pointerdown", async () => {
    const { isActivationEvent } = await import("../web/src/lib/audioUnlock.js")
    expect(isActivationEvent({ type: "pointerdown", pointerType: "touch" })).toBe(false)
    expect(isActivationEvent({ type: "touchstart" })).toBe(false)
    expect(isActivationEvent({ type: "pointerup", pointerType: "touch" })).toBe(true)
    expect(isActivationEvent({ type: "touchend" })).toBe(true)
    expect(isActivationEvent({ type: "click" })).toBe(true)
    expect(isActivationEvent({ type: "pointerdown", pointerType: "mouse" })).toBe(true)
    expect(isActivationEvent({ type: "pointerup", pointerType: "mouse" })).toBe(false)
    expect(isActivationEvent({ type: "keydown", key: "a" })).toBe(true)
    expect(isActivationEvent({ type: "keydown", key: "Escape" })).toBe(false)
  })
})

describe("unlockAudio", () => {
  it("primes the shared element with silence inside a gesture, once, and again after a refusal", async () => {
    const a = await import("../web/src/lib/audioUnlock.js")
    const unlocked = vi.fn()
    a.onAudioUnlocked(unlocked)
    // Outside a gesture (a touch's pointerdown): refused, so not unlocked.
    expect(a.unlockAudio()).toBe(false)
    expect(a.isAudioUnlocked()).toBe(false)
    PhoneAudio.gesture = true
    expect(a.unlockAudio()).toBe(true)
    expect(unlocked).toHaveBeenCalledOnce()
    const el = PhoneAudio.all[0]!
    expect(el.played).toHaveLength(1)
    expect(el.played[0]).toMatch(/^data:audio\/wav;base64,/)
    expect(el.volume).toBe(0)
    // Already unlocked: nothing more is played.
    a.unlockAudio()
    expect(el.played).toHaveLength(1)
    // iOS locked it again: the next gesture primes again.
    a.noteAudioBlocked()
    el.paused = true
    a.unlockAudio()
    expect(el.played).toHaveLength(2)
  })
})

const elevenlabs: TtsInfo = {
  settings: { ...TTS_DEFAULTS, provider: "elevenlabs", elevenlabs: { ...TTS_DEFAULTS.elevenlabs, voiceId: "A9evEp8yGjv4c3WsIKuY", voiceName: "Ralf Eisend" } },
  sources: { provider: "env", elevenlabs: "ui", openai: "default" },
  keys: { elevenlabs: { state: "set", source: "env" }, openai: { state: "unset", source: "default" } },
  defaults: TTS_DEFAULTS,
}

/** The live wiring as a phone sees it: speech.ts with real listeners, a stubbed server and speechSynthesis. */
async function phone() {
  const bodies: unknown[] = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/tts/settings") return new Response(JSON.stringify(elevenlabs), { status: 200 })
    bodies.push(JSON.parse(String(init?.body)))
    return new Response("MP3", { status: 200, headers: { "Content-Type": "audio/mpeg", "X-TTS-Voice": "A9evEp8yGjv4c3WsIKuY" } })
  })
  const spoken: string[] = []
  vi.stubGlobal("speechSynthesis", { speaking: false, paused: false, speak: (u: { text: string }) => spoken.push(u.text), cancel() {}, pause() {}, resume() {}, getVoices: () => [] })
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      constructor(readonly text: string) {}
    },
  )
  vi.spyOn(console, "info").mockImplementation(() => {})
  URL.createObjectURL ??= () => "blob:x"
  URL.revokeObjectURL ??= () => {}
  const speech = await import("../web/src/lib/speech.js")
  const tts = await import("../web/src/lib/tts.js")
  const tap = (type: string, pointerType?: string) => {
    PhoneAudio.gesture = type !== "pointerdown" || pointerType === "mouse"
    const e = new Event(type, { bubbles: true })
    if (pointerType) Object.defineProperty(e, "pointerType", { value: pointerType })
    document.body.dispatchEvent(e)
    PhoneAudio.gesture = false
  }
  return { speech, tts, bodies, spoken, tap }
}

describe("voice on a phone (live wiring)", () => {
  it("a reply that arrives before any tap waits for one, then plays in the server's voice; the browser voice never speaks", async () => {
    const { speech, tts, bodies, spoken, tap } = await phone()
    await tts.loadTtsInfo()
    speech.voiceChatMessage({ id: "m1", role: "assistant", content: "PR 30 merged.", createdAt: 1 } as never)
    speech.voiceChatTurn({ startedAt: 0, replyId: "m1" })
    await flush()
    await flush()
    // Blocked: one request (text only, so the server's saved voice speaks), nothing played, the chip shows.
    expect(bodies).toEqual([{ text: "PR 30 merged." }])
    const el = PhoneAudio.all[0]!
    expect(el.played).toEqual([])
    expect(tts.getVoiceLog().map((e) => [e.path, e.outcome])).toEqual([["elevenlabs", "blocked"]])

    // A touch's pointerdown isn't a gesture: still waiting.
    tap("pointerdown", "touch")
    await flush()
    expect(el.played).toEqual([])
    // Its pointerup is: the kept clip plays at once, inside the tap, with no second request.
    tap("pointerup", "touch")
    expect(el.played.filter((s) => s.startsWith("blob:"))).toHaveLength(1)
    expect(bodies).toHaveLength(1)
    await flush()
    // The rest of the tap (touchend, click) doesn't replay or say "Voice on.".
    tap("touchend")
    tap("click")
    await flush()
    expect(el.played.filter((s) => s.startsWith("blob:"))).toHaveLength(1)
    expect(spoken.filter(Boolean)).toEqual([])
    expect(tts.getVoiceLog().at(-1)).toMatchObject({ path: "elevenlabs", outcome: "played", voice: "A9evEp8yGjv4c3WsIKuY" })
  })

  it("a line before the settings have loaded waits for them instead of using the browser voice", async () => {
    const { speech, bodies, spoken, tap } = await phone()
    tap("pointerup", "touch")
    speech.speakNow("Voice on.")
    await flush()
    await flush()
    expect(bodies).toEqual([{ text: "Voice on." }])
    expect(spoken.filter(Boolean)).toEqual([])
  })
})

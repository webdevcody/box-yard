// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SpeechQueue, type SynthLike, type UtteranceLike } from "../web/src/lib/speech.js"
import { CloudSynth, activeProvider, fetchTts, reportFallback, resetFallbackToasts, type AudioLike, type CloudDeps } from "../web/src/lib/tts.js"
import { filterVoices, voiceMeta, voiceUnavailable } from "../web/src/lib/ttsVoices.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { keys } from "../web/src/lib/queries.js"
import { TtsSection } from "../web/src/components/TtsSettings.js"
import { TTS_DEFAULTS, type TtsInfo, type TtsProvider } from "../shared/tts.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTS = { rate: 1, pitch: 1, volume: 0.8 }
const utter = (text: string): UtteranceLike => ({ text, voice: null, lang: "", rate: 1, pitch: 1, volume: 1, onstart: null, onend: null, onerror: null })
const flush = () => new Promise((r) => setTimeout(r, 0))

/** window.speechSynthesis stand-in. */
class FakeOs implements SynthLike {
  spoken: UtteranceLike[] = []
  current: UtteranceLike | null = null
  paused = false
  cancels = 0
  get speaking() {
    return this.current !== null
  }
  speak(u: UtteranceLike) {
    this.current = u
    this.spoken.push(u)
    u.onstart?.({})
  }
  cancel() {
    this.cancels++
    this.current = null
  }
  pause() {}
  resume() {}
  end() {
    const u = this.current!
    this.current = null
    u.onend?.({})
  }
}

/** The shared <audio> element. */
class FakeAudio implements AudioLike {
  src = ""
  volume = 1
  paused = true
  played: string[] = []
  playError: { name: string; message?: string } | null = null
  onplaying: ((ev: any) => void) | null = null
  onended: ((ev: any) => void) | null = null
  onerror: ((ev: any) => void) | null = null
  play() {
    if (this.playError) return Promise.reject(this.playError)
    this.paused = false
    this.played.push(this.src)
    queueMicrotask(() => this.onplaying?.({}))
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
  finish() {
    this.paused = true
    this.onended?.({})
  }
}

function rig(provider: TtsProvider = "elevenlabs", fetchAudio?: CloudDeps["fetchAudio"]) {
  const os = new FakeOs()
  const audio = new FakeAudio()
  const requests: { text: string; signal: AbortSignal }[] = []
  const fallbacks: string[] = []
  let p = provider
  const synth = new CloudSynth({
    provider: () => p,
    os,
    osUtter: utter,
    audio: () => audio,
    fetchAudio:
      fetchAudio ??
      ((text, signal) => {
        requests.push({ text, signal })
        return Promise.resolve(new Blob([text]))
      }),
    objectUrl: { create: (b) => `blob:${(b as Blob).size}`, revoke: () => {} },
    onFallback: (prov, msg) => fallbacks.push(`${prov}: ${msg}`),
  })
  const onBlocked = vi.fn()
  const q = new SpeechQueue(synth, utter, globalThis, { onBlocked })
  return { os, audio, requests, fallbacks, synth, q, onBlocked, setProvider: (next: TtsProvider) => (p = next) }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const t of currentToasts()) dismiss(t.id)
  resetFallbackToasts()
})

describe("CloudSynth under the speech queue", () => {
  it("plays cloud lines one at a time through the shared audio element, in order", async () => {
    const r = rig()
    r.q.say("PR 30 merged.", OPTS)
    r.q.say("Task Login finished.", OPTS)
    await flush()
    expect(r.requests.map((x) => x.text)).toEqual(["PR 30 merged."])
    expect(r.audio.played).toHaveLength(1)
    expect(r.audio.volume).toBe(0.8)
    expect(r.q.speaking).toBe(true)
    r.audio.finish()
    await flush()
    expect(r.requests.map((x) => x.text)).toEqual(["PR 30 merged.", "Task Login finished."])
    r.audio.finish()
    expect(r.q.speaking).toBe(false)
    expect(r.os.spoken).toHaveLength(0)
  })

  it("sends whole lines to the cloud, but short chunks to the browser voice", async () => {
    const long = `${"word ".repeat(60)}end.`
    const r = rig()
    r.q.say(long, OPTS)
    await flush()
    expect(r.requests[0]!.text).toBe(long.trim())
    r.audio.finish()
    r.setProvider("browser")
    r.q.say(long, OPTS)
    expect(r.os.spoken[0]!.text.length).toBeLessThanOrEqual(160)
  })

  it("stop() (mute, voice off) cuts the audio off, aborts the request and drops the queue", async () => {
    const r = rig()
    r.q.say("one", OPTS)
    r.q.say("two", OPTS)
    await flush()
    expect(r.audio.paused).toBe(false)
    r.q.stop()
    expect(r.audio.paused).toBe(true)
    expect(r.requests[0]!.signal.aborted).toBe(true)
    r.audio.finish() // a late `ended` from the old clip is ignored
    await flush()
    expect(r.requests).toHaveLength(1)
    expect(r.q.speaking).toBe(false)
  })

  it("hold() (dictation) puts the line back and replays it on release", async () => {
    const r = rig()
    r.q.say("Held line.", OPTS)
    await flush()
    r.q.hold()
    expect(r.audio.paused).toBe(true)
    r.q.release()
    await flush()
    expect(r.requests.map((x) => x.text)).toEqual(["Held line.", "Held line."])
  })

  it("falls back to the browser voice with the provider's exact error, then carries on", async () => {
    let fail = true
    const r = rig("openai", (text) => (fail ? Promise.reject(new Error("OpenAI: You exceeded your current quota. (HTTP 429)")) : Promise.resolve(new Blob([text]))))
    r.q.say("Voice on.", OPTS)
    r.q.say("Next.", OPTS)
    await flush()
    expect(r.fallbacks).toEqual(["openai: OpenAI: You exceeded your current quota. (HTTP 429)"])
    expect(r.os.spoken.map((u) => u.text)).toEqual(["Voice on."])
    expect(r.os.spoken[0]!.volume).toBe(0.8)
    fail = false
    r.os.end()
    await flush()
    // The next line tries the cloud voice again.
    expect(r.audio.played).toHaveLength(1)
  })

  it("falls back when the audio can't be played", async () => {
    const r = rig()
    r.audio.playError = { name: "NotSupportedError", message: "no decoder" }
    r.q.say("Hi.", OPTS)
    await flush()
    expect(r.fallbacks).toEqual(["elevenlabs: no decoder"])
    expect(r.os.spoken.map((u) => u.text)).toEqual(["Hi."])
  })

  it("treats an autoplay block like speechSynthesis's not-allowed: stop and ask for a tap", async () => {
    const r = rig()
    r.audio.playError = { name: "NotAllowedError" }
    r.q.say("one", OPTS)
    r.q.say("two", OPTS)
    await flush()
    expect(r.onBlocked).toHaveBeenCalledOnce()
    expect(r.q.pending).toBe(0)
    expect(r.fallbacks).toEqual([])
  })

  it("speaks with the browser voice when the provider is Browser / OS", () => {
    const r = rig("browser")
    r.q.say("Hello.", OPTS)
    expect(r.os.spoken.map((u) => u.text)).toEqual(["Hello."])
    expect(r.requests).toHaveLength(0)
  })

  it("the watchdog waits for the network on cloud lines", async () => {
    vi.useFakeTimers()
    const r = rig("elevenlabs", () => new Promise(() => {}))
    r.q.say("Slow.", OPTS)
    vi.advanceTimersByTime(10_000)
    expect(r.q.speaking).toBe(true)
    vi.advanceTimersByTime(30_000)
    expect(r.q.speaking).toBe(false)
  })
})

describe("fallback toast", () => {
  it("shows each exact error once", () => {
    reportFallback("elevenlabs", "ElevenLabs: Invalid API key (HTTP 401)")
    reportFallback("elevenlabs", "ElevenLabs: Invalid API key (HTTP 401)")
    const toasts = currentToasts()
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ kind: "error", title: "ElevenLabs voice failed: using the browser voice", body: "ElevenLabs: Invalid API key (HTTP 401)" })
    expect(toasts[0]!.action?.label).toBe("Voice settings")
    reportFallback("elevenlabs", "Can't reach ElevenLabs: ENOTFOUND")
    expect(currentToasts()).toHaveLength(2)
  })
})

describe("fetchTts", () => {
  it("returns the audio, or throws the server's exact message", async () => {
    const calls: any[] = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return calls.length === 1
        ? new Response("MP3", { status: 200, headers: { "Content-Type": "audio/mpeg" } })
        : new Response(JSON.stringify({ error: "ElevenLabs: Invalid API key (HTTP 401)" }), { status: 502 })
    })
    expect(await (await fetchTts({ text: "Hi." })).text()).toBe("MP3")
    expect(calls[0]).toEqual({ url: "/api/tts", body: { text: "Hi." } })
    await expect(fetchTts({ text: "Hi.", provider: "openai", voice: "ash" })).rejects.toThrow("ElevenLabs: Invalid API key (HTTP 401)")
  })
})

const info = (patch: Partial<TtsInfo["settings"]> = {}, keys: Partial<TtsInfo["keys"]> = {}): TtsInfo => ({
  settings: { ...TTS_DEFAULTS, ...patch },
  sources: { provider: "ui", elevenlabs: "default", openai: "default" },
  keys: { elevenlabs: { state: "unset", source: "default" }, openai: { state: "unset", source: "default" }, ...keys },
  defaults: TTS_DEFAULTS,
})

describe("activeProvider", () => {
  it("uses a cloud provider only when it has a key", () => {
    expect(activeProvider(null)).toBe("browser")
    expect(activeProvider(info({ provider: "elevenlabs" }))).toBe("browser")
    expect(activeProvider(info({ provider: "elevenlabs" }, { elevenlabs: { state: "set", source: "env" } }))).toBe("elevenlabs")
    expect(activeProvider(info({ provider: "browser" }, { openai: { state: "set", source: "ui" } }))).toBe("browser")
  })
})

describe("voice picker helpers", () => {
  const george = { id: "g", name: "George", category: "premade", labels: { accent: "british", gender: "male", age: "middle_aged", use_case: "narration" } }
  const mine = { id: "m", name: "My voice", category: "cloned", labels: {} }
  it("describe and filter voices", () => {
    expect(voiceMeta(george)).toBe("british · male · middle aged")
    expect(voiceMeta(mine)).toBe("your clone")
    expect(filterVoices([george, mine], "brit").map((v) => v.id)).toEqual(["g"])
    expect(filterVoices([george, mine], "clone").map((v) => v.id)).toEqual(["m"])
    expect(filterVoices([george, mine], "").length).toBe(2)
  })
  it("mark OpenAI voices tts-1 can't use", () => {
    expect(voiceUnavailable({ id: "marin", name: "Marin", category: "built-in" }, "openai", "tts-1")).toBe("gpt-4o-mini-tts only")
    expect(voiceUnavailable({ id: "marin", name: "Marin", category: "built-in" }, "openai", "gpt-4o-mini-tts")).toBeNull()
    expect(voiceUnavailable({ id: "coral", name: "Coral", category: "built-in" }, "openai", "tts-1-hd")).toBeNull()
  })
})

describe("Settings › Voice provider section", () => {
  let root: Root
  let host: HTMLElement
  let qc: QueryClient
  const puts: unknown[] = []
  beforeEach(() => {
    puts.length = 0
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (url.startsWith("/api/tts/voices")) {
        return new Response(
          JSON.stringify({
            provider: "elevenlabs",
            fetchedAt: 1,
            voices: [
              { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", category: "premade", previewUrl: "https://storage.example/george.mp3", labels: { accent: "british" } },
              { id: "own1", name: "My clone", category: "cloned", previewUrl: null },
            ],
          }),
        )
      }
      if (url === "/api/tts/settings" && init.method === "PUT") {
        puts.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify(qc.getQueryData(keys.tts)))
      }
      return new Promise(() => {})
    })
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })
  const render = async (i: TtsInfo) => {
    qc.setQueryData(keys.tts, i)
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(TtsSection, { fid: (k: string) => `t-${k}` }))))
    await act(flush)
  }

  it("shows a set key masked with Replace / Remove / Test, and never the key itself", async () => {
    await render(info({ provider: "elevenlabs" }, { elevenlabs: { state: "set", source: "ui" } }))
    expect(host.querySelector("[data-key-masked]")?.textContent).toContain("••••")
    const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent?.trim())
    expect(buttons).toEqual(expect.arrayContaining(["Replace", "Remove", "Test"]))
    expect(host.querySelector('input[type="password"]')).toBeNull()
    expect(host.textContent).toContain("saved here")
    // The voice list, with a preview button per voice.
    expect(host.querySelector('[data-voice-picker="elevenlabs"]')?.textContent).toContain("George")
    expect(host.querySelectorAll('[aria-label^="Preview "]')).toHaveLength(2)
    expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("ElevenLabs")
  })

  it("an env key can be replaced but not removed; an unset key asks for one", async () => {
    await render(info({ provider: "openai" }, { openai: { state: "set", source: "env" } }))
    const labels = [...host.querySelectorAll("button")].map((b) => b.textContent?.trim())
    expect(labels).not.toContain("Remove")
    expect(host.textContent).toContain("OPENAI_API_KEY")
    await render(info({ provider: "openai" }))
    expect(host.querySelector('input[type="password"]')).not.toBeNull()
  })

  it("picking a provider or a voice saves it", async () => {
    await render(info({ provider: "browser" }, { elevenlabs: { state: "set", source: "ui" } }))
    await act(async () => void host.querySelector<HTMLButtonElement>('[data-provider="elevenlabs"]')!.click())
    await act(flush)
    expect(puts).toEqual([{ provider: "elevenlabs" }])
    await render(info({ provider: "elevenlabs" }, { elevenlabs: { state: "set", source: "ui" } }))
    const clone = [...host.querySelectorAll('[data-voice-picker] [role="radio"]')].find((b) => b.textContent?.includes("My clone"))!
    await act(async () => void (clone as HTMLButtonElement).click())
    await act(flush)
    expect(puts.at(-1)).toEqual({ elevenlabs: { voiceId: "own1", voiceName: "My clone" } })
  })
})

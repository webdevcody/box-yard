// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SpeechQueue, type SynthLike, type UtteranceLike } from "../web/src/lib/speech.js"
import { CloudSynth, activeProvider, fetchTts, reportFallback, resetFallbackToasts, type AudioLike, type CloudDeps } from "../web/src/lib/tts.js"
import { filterVoices, voiceMeta } from "../web/src/lib/ttsVoices.js"
import { PcmPlayer, pcm16ToFloat, pcmRate, pcmToWav, type AudioContextLike, type PcmCallbacks, type PcmPlayerLike, type PcmStream } from "../web/src/lib/pcm.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { keys } from "../web/src/lib/queries.js"
import { TtsSection } from "../web/src/components/TtsSettings.js"
import { OPENAI_SPEED, TTS_DEFAULTS, type TtsInfo, type TtsProvider } from "../shared/tts.js"

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

/** A PCM body the test feeds chunk by chunk. */
function pcmStream(sampleRate = 24_000) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start: (c) => void (ctl = c),
    cancel: () => void (cancelled = true),
  })
  return {
    pcm: { kind: "pcm", sampleRate, body } as PcmStream,
    push: (...bytes: number[]) => ctl.enqueue(new Uint8Array(bytes)),
    end: () => ctl.close(),
    fail: (msg: string) => ctl.error(new Error(msg)),
    get cancelled() {
      return cancelled
    },
  }
}

/** Stands in for PcmPlayer: records what it was asked to play and lets the test drive the callbacks. */
class FakePcm implements PcmPlayerLike {
  plays: { pcm: PcmStream; cb: PcmCallbacks; stopped: boolean }[] = []
  play(pcm: PcmStream, cb: PcmCallbacks) {
    const p = { pcm, cb, stopped: false }
    this.plays.push(p)
    queueMicrotask(() => cb.onstart())
    return { stop: () => void (p.stopped = true) }
  }
  get last() {
    return this.plays.at(-1)!
  }
}

function rig(provider: TtsProvider = "elevenlabs", fetchAudio?: CloudDeps["fetchAudio"], pcm?: PcmPlayerLike | null) {
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
    objectUrl: { create: (b) => `blob:${(b as Blob).type}:${(b as Blob).size}`, revoke: () => {} },
    pcm: () => pcm ?? null,
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

describe("CloudSynth with OpenAI's streamed PCM", () => {
  const pcmRig = (player: PcmPlayerLike | null = new FakePcm()) => {
    const streams: ReturnType<typeof pcmStream>[] = []
    const r = rig("openai", () => {
      const s = pcmStream()
      streams.push(s)
      return Promise.resolve(s.pcm)
    }, player)
    return { ...r, streams, player: player as FakePcm }
  }

  it("hands the stream to the PCM player (not the <audio> element) and moves on when it ends", async () => {
    const r = pcmRig()
    r.q.say("PR 30 merged.", OPTS)
    r.q.say("Task Login finished.", OPTS)
    await flush()
    expect(r.player.plays).toHaveLength(1)
    expect(r.player.last.pcm.sampleRate).toBe(24_000)
    expect(r.player.last.cb.volume).toBe(0.8)
    expect(r.audio.played).toHaveLength(0)
    expect(r.q.speaking).toBe(true)
    r.player.last.cb.onend()
    await flush()
    expect(r.player.plays).toHaveLength(2)
    r.player.last.cb.onend()
    expect(r.q.speaking).toBe(false)
    expect(r.os.spoken).toHaveLength(0)
  })

  it("stop() stops the playback; a stream error falls back to the browser voice", async () => {
    const r = pcmRig()
    r.q.say("one", OPTS)
    await flush()
    r.q.stop()
    expect(r.player.last.stopped).toBe(true)
    r.player.last.cb.onend() // late callbacks from the stopped clip are ignored
    r.player.last.cb.onerror("late")
    expect(r.fallbacks).toEqual([])

    r.q.say("two", OPTS)
    await flush()
    r.player.last.cb.onerror("network error")
    expect(r.fallbacks).toEqual(["openai: network error"])
    expect(r.os.spoken.map((u) => u.text)).toEqual(["two"])
  })

  it("an autoplay block stops the queue and asks for a tap", async () => {
    const r = pcmRig()
    r.q.say("one", OPTS)
    r.q.say("two", OPTS)
    await flush()
    r.player.last.cb.onblocked()
    expect(r.onBlocked).toHaveBeenCalledOnce()
    expect(r.q.pending).toBe(0)
    expect(r.fallbacks).toEqual([])
  })

  it("cancels a stream that arrives after the line was stopped", async () => {
    let resolve!: (p: PcmStream) => void
    const s = pcmStream()
    const r = rig("openai", () => new Promise((res) => (resolve = res)), new FakePcm())
    r.q.say("late", OPTS)
    r.q.stop()
    resolve(s.pcm)
    await flush()
    expect(s.cancelled).toBe(true)
  })

  it("without Web Audio, buffers the clip into a WAV for the <audio> element", async () => {
    const r = pcmRig(null)
    r.q.say("Hi.", OPTS)
    await flush()
    r.streams[0]!.push(1, 0, 2, 0)
    r.streams[0]!.end()
    await flush()
    await flush()
    expect(r.audio.played).toEqual(["blob:audio/wav:48"])
  })
})

/** Enough of AudioContext to watch the scheduling. */
class FakeContext implements AudioContextLike {
  currentTime = 10
  state = "running"
  destination = {}
  resumed = 0
  resumeResult: Promise<void> | null = null
  sources: { start: number; samples: Float32Array; duration: number; stopped: boolean; onended: (() => void) | null }[] = []
  gains: { gain: { value: number }; disconnected: boolean }[] = []
  resume() {
    this.resumed++
    return this.resumeResult ?? Promise.resolve().then(() => void (this.state = "running"))
  }
  createBuffer(_ch: number, length: number, rate: number) {
    const buf = { duration: length / rate, samples: new Float32Array(length), copyToChannel: (src: Float32Array) => buf.samples.set(src) }
    return buf
  }
  createBufferSource() {
    const ctx = this
    const src = {
      buffer: null as any,
      onended: null as (() => void) | null,
      connect: () => undefined,
      start(when: number) {
        ctx.sources.push(Object.assign(entry, { start: when, samples: src.buffer.samples, duration: src.buffer.duration }))
      },
      stop: () => void (entry.stopped = true),
    }
    const entry = { start: 0, samples: new Float32Array(), duration: 0, stopped: false, get onended() { return src.onended } }
    return src
  }
  createGain() {
    const g = { gain: { value: 1 }, disconnected: false, connect: () => undefined, disconnect: () => void (g.disconnected = true) }
    this.gains.push(g)
    return g
  }
}

describe("PcmPlayer", () => {
  const callbacks = () => {
    const seen: string[] = []
    const cb: PcmCallbacks = {
      volume: 0.5,
      onstart: () => seen.push("start"),
      onend: () => seen.push("end"),
      onblocked: () => seen.push("blocked"),
      onerror: (m) => seen.push(`error: ${m}`),
    }
    return { seen, cb }
  }

  it("starts at the first chunk and queues the rest back to back, across odd byte splits", async () => {
    const ctx = new FakeContext()
    const s = pcmStream(4)
    const { seen, cb } = callbacks()
    new PcmPlayer(() => ctx).play(s.pcm, cb)
    // 0x4000 = 0.5, then a sample split across two chunks: 0xC000 = -0.5.
    s.push(0x00, 0x40, 0x00)
    await flush()
    expect(seen).toEqual(["start"])
    expect(ctx.gains[0]!.gain.value).toBe(0.5)
    expect(ctx.sources).toHaveLength(1)
    expect([...ctx.sources[0]!.samples]).toEqual([0.5])
    expect(ctx.sources[0]!.start).toBeCloseTo(10.08)
    s.push(0xc0, 0xff, 0x7f)
    await flush()
    expect([...ctx.sources[1]!.samples]).toEqual([-0.5, 32767 / 32768])
    // Right after the first one (1 sample at 4 Hz = 0.25 s).
    expect(ctx.sources[1]!.start).toBeCloseTo(10.33)
    s.end()
    await flush()
    expect(seen).toEqual(["start"])
    ctx.sources[0]!.onended!()
    expect(seen).toEqual(["start"])
    ctx.sources[1]!.onended!()
    expect(seen).toEqual(["start", "end"])
    expect(ctx.gains[0]!.disconnected).toBe(true)
  })

  it("restarts a moment from now after running dry, rather than in the past", async () => {
    const ctx = new FakeContext()
    const s = pcmStream(4)
    new PcmPlayer(() => ctx).play(s.pcm, callbacks().cb)
    s.push(0, 0)
    await flush()
    ctx.currentTime = 20
    s.push(0, 0)
    await flush()
    expect(ctx.sources[1]!.start).toBeCloseTo(20.08)
  })

  it("stop() silences queued chunks and cancels the stream", async () => {
    const ctx = new FakeContext()
    const s = pcmStream()
    const { seen, cb } = callbacks()
    const playback = new PcmPlayer(() => ctx).play(s.pcm, cb)
    s.push(0, 0, 0, 0)
    await flush()
    playback.stop()
    await flush()
    expect(ctx.sources[0]!.stopped).toBe(true)
    expect(s.cancelled).toBe(true)
    expect(seen).toEqual(["start"])
  })

  it("reports a broken stream, an empty one, a blocked context and no Web Audio", async () => {
    const ctx = new FakeContext()
    let s = pcmStream()
    let c = callbacks()
    new PcmPlayer(() => ctx).play(s.pcm, c.cb)
    s.fail("network error")
    await flush()
    expect(c.seen).toEqual(["error: network error"])

    s = pcmStream()
    c = callbacks()
    new PcmPlayer(() => ctx).play(s.pcm, c.cb)
    s.end()
    await flush()
    expect(c.seen).toEqual(["error: The server sent no audio."])

    // Suspended, and resume() never settles without a tap.
    const locked = new FakeContext()
    locked.state = "suspended"
    locked.resumeResult = new Promise(() => {})
    c = callbacks()
    vi.useFakeTimers()
    new PcmPlayer(() => locked).play(pcmStream().pcm, c.cb)
    await vi.advanceTimersByTimeAsync(500)
    expect(c.seen).toEqual(["blocked"])
    vi.useRealTimers()

    // Suspended but resumable (an earlier tap): plays.
    const asleep = new FakeContext()
    asleep.state = "suspended"
    s = pcmStream()
    c = callbacks()
    new PcmPlayer(() => asleep).play(s.pcm, c.cb)
    await flush()
    s.push(0, 0)
    await flush()
    expect(asleep.resumed).toBe(1)
    expect(c.seen).toEqual(["start"])

    c = callbacks()
    new PcmPlayer(() => null).play(pcmStream().pcm, c.cb)
    await flush()
    expect(c.seen).toEqual(["error: This browser can't play streamed audio."])
  })

  it("PCM helpers: content type, sample conversion and the WAV wrapper", async () => {
    expect(pcmRate("audio/pcm;rate=24000")).toBe(24_000)
    expect(pcmRate("audio/pcm")).toBe(24_000)
    expect(pcmRate("audio/mpeg")).toBeNull()
    expect(pcmRate(null)).toBeNull()
    expect(pcm16ToFloat(new Uint8Array([0x00, 0x80, 0x01]), null)).toEqual({ samples: new Float32Array([-1]), carry: 1 })
    const s = pcmStream()
    s.push(1, 2, 3, 4)
    s.end()
    const wav = new Uint8Array(await (await pcmToWav(s.pcm)).arrayBuffer())
    const view = new DataView(wav.buffer)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF")
    expect(view.getUint32(24, true)).toBe(24_000)
    expect(view.getUint32(40, true)).toBe(4)
    expect([...wav.slice(44)]).toEqual([1, 2, 3, 4])
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
    expect(await ((await fetchTts({ text: "Hi." })) as Blob).text()).toBe("MP3")
    expect(calls[0]).toEqual({ url: "/api/tts", body: { text: "Hi." } })
    await expect(fetchTts({ text: "Hi.", provider: "openai", voice: "ash" })).rejects.toThrow("ElevenLabs: Invalid API key (HTTP 401)")
  })

  it("hands back OpenAI's PCM as a stream, as soon as the headers arrive", async () => {
    const s = pcmStream()
    vi.stubGlobal("fetch", async () => new Response(s.pcm.body, { status: 200, headers: { "Content-Type": "audio/pcm;rate=24000" } }))
    const clip = (await fetchTts({ text: "Hi." })) as PcmStream
    expect(clip.kind).toBe("pcm")
    expect(clip.sampleRate).toBe(24_000)
    const reader = clip.body.getReader()
    s.push(7, 8)
    expect([...(await reader.read()).value!]).toEqual([7, 8])
    s.end()
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

  it("OpenAI shows the Realtime model, its ten voices, instructions and the 1.5× speed cap", async () => {
    await render(info({ provider: "openai" }, { openai: { state: "set", source: "ui" } }))
    const model = host.querySelector<HTMLSelectElement>("#t-oa-model")!
    expect(model.value).toBe("gpt-realtime-2.1-mini")
    expect([...model.options].map((o) => o.textContent)).toEqual(["gpt-realtime-2.1-mini (default)", "gpt-realtime-2.1"])
    expect(host.textContent).toContain("OpenAI's replacement for its retired speech models")
    expect(host.textContent).not.toMatch(/tts-1|gpt-4o-mini-tts/)
    const voices = [...host.querySelectorAll('[data-voice-picker="openai"] [role="radio"]')].map((b) => b.textContent)
    expect(voices).toEqual(["Alloy", "Ash", "Ballad", "Coral", "Echo", "Sage", "Shimmer", "Verse", "Marin", "Cedar"])
    expect(host.querySelector('[data-voice-picker="openai"] [aria-checked="true"]')?.textContent).toBe("Marin")
    expect(host.querySelector<HTMLTextAreaElement>("#t-oa-instr")!.disabled).toBe(false)
    expect(host.querySelector<HTMLInputElement>("#t-oa-speed")!.max).toBe(String(OPENAI_SPEED.max))
    expect(OPENAI_SPEED.max).toBe(1.5)
    expect(host.textContent).toContain("0.25× to 1.5×")
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

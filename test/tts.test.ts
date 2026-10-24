import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { TtsSettingsStore } from "../server/settings.js"
import { AudioCache, READ_ALOUD_INSTRUCTIONS, TtsService, providerMessage } from "../server/tts.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { OPENAI_VOICES, PCM_CONTENT_TYPE, TTS_DEFAULTS, previewLine, type TtsInfo, type TtsVoiceList } from "../shared/tts.js"
import { fakeRealtime, gate, speak, type Behave } from "./fakeRealtime.js"
import { freePort, testConfig, tmpDir } from "./helpers.js"

const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const EL_KEY = "sk_eleven_secret_123456"
const OA_KEY = "sk-openai-secret-abcdef"

interface Seen {
  url: string
  headers: Record<string, string>
  body: any
}

/** A stand-in for both providers' HTTP APIs: records each call, answers from `reply`. */
function fakeProviders(reply: (url: string, seen: Seen) => Response | Promise<Response> = () => audio("MP3DATA")) {
  const calls: Seen[] = []
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const seen = { url, headers, body: typeof init.body === "string" ? JSON.parse(init.body) : null }
    calls.push(seen)
    const signal = init.signal
    if (signal?.aborted) throw signal.reason
    return await Promise.race([
      reply(url, seen),
      new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    ])
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const audio = (body: string) =>
  new Response(
    new ReadableStream({
      start(c) {
        // Two chunks, the way a streaming endpoint sends them.
        c.enqueue(new TextEncoder().encode(body.slice(0, 3)))
        c.enqueue(new TextEncoder().encode(body.slice(3)))
        c.close()
      },
    }),
    { status: 200, headers: { "Content-Type": "audio/mpeg" } },
  )

const voicesPage = (voices: object[], next: string | null = null) =>
  new Response(JSON.stringify({ voices, has_more: Boolean(next), next_page_token: next }), { status: 200, headers: { "Content-Type": "application/json" } })

describe("TTS settings", () => {
  it("default to the browser, with no keys", () => {
    const info = new TtsSettingsStore(memStore(), {}).info()
    expect(info.settings).toEqual(TTS_DEFAULTS)
    expect(info.settings.provider).toBe("browser")
    expect(info.settings.elevenlabs.model).toBe("eleven_flash_v2_5")
    expect(info.settings.openai.model).toBe("gpt-realtime-2.1-mini")
    expect(info.settings.openai.voice).toBe("marin")
    expect(info.keys).toEqual({ elevenlabs: { state: "unset", source: "default" }, openai: { state: "unset", source: "default" } })
    expect(info.sources.provider).toBe("default")
  })

  it("follow ui > env > default for the provider and each key", () => {
    const store = memStore()
    const tts = new TtsSettingsStore(store, { elevenlabsApiKey: "env-eleven-key-1", openaiApiKey: "", ttsProvider: "openai" })
    let info = tts.info()
    expect(info.settings.provider).toBe("openai")
    expect(info.sources.provider).toBe("env")
    expect(info.keys.elevenlabs).toEqual({ state: "set", source: "env" })
    expect(tts.apiKey("elevenlabs")).toBe("env-eleven-key-1")
    expect(tts.apiKey("openai")).toBe("")

    info = tts.update({ provider: "elevenlabs", elevenlabsApiKey: EL_KEY, openaiApiKey: OA_KEY, elevenlabs: { voiceId: "abc123", voiceName: "Rachel" } })
    expect(info.settings.provider).toBe("elevenlabs")
    expect(info.sources.provider).toBe("ui")
    expect(info.keys.elevenlabs).toEqual({ state: "set", source: "ui" })
    expect(info.keys.openai).toEqual({ state: "set", source: "ui" })
    expect(tts.apiKey("elevenlabs")).toBe(EL_KEY)
    expect(info.settings.elevenlabs).toEqual({ ...TTS_DEFAULTS.elevenlabs, voiceId: "abc123", voiceName: "Rachel" })
    expect(info.sources.elevenlabs).toBe("ui")

    // Partial updates keep the rest of a provider's choices.
    info = tts.update({ elevenlabs: { speed: 1.1 } })
    expect(info.settings.elevenlabs.voiceId).toBe("abc123")
    expect(info.settings.elevenlabs.speed).toBe(1.1)

    // Removing the saved key falls back to the env var again; resetting choices leaves keys alone.
    info = tts.update({ elevenlabsApiKey: null, openaiApiKey: null })
    expect(info.keys.elevenlabs).toEqual({ state: "set", source: "env" })
    expect(info.keys.openai).toEqual({ state: "unset", source: "default" })
    tts.update({ openaiApiKey: OA_KEY })
    info = tts.reset()
    expect(info.settings.provider).toBe("openai")
    expect(info.keys.openai.state).toBe("set")
  })

  it("reject bad values, and keys with spaces", () => {
    const tts = new TtsSettingsStore(memStore(), {})
    expect(() => tts.update({ provider: "polly" })).toThrow()
    expect(() => tts.update({ openaiApiKey: "has a space in it" })).toThrow()
    expect(() => tts.update({ openaiApiKey: "short" })).toThrow()
    expect(() => tts.update({ openai: { speed: 9 } })).toThrow()
    // The Realtime API tops out at 1.5×.
    expect(() => tts.update({ openai: { speed: 2 } })).toThrow()
    expect(() => tts.update({ elevenlabs: { voiceId: "../../v1/user" } })).toThrow()
    expect(() => tts.update({ secret: "x" })).toThrow()
  })

  it("move choices saved for the retired speech models to the Realtime model and its voices", () => {
    const store = memStore()
    const old = {
      provider: "openai",
      elevenlabs: { voiceId: "abc123", voiceName: "Rachel" },
      openai: { model: "tts-1-hd", voice: "nova", speed: 3, instructions: "Calm." },
    }
    store.setKv("tts_settings", JSON.stringify(old))
    const tts = new TtsSettingsStore(store, {})
    const info = tts.info()
    expect(info.settings.provider).toBe("openai")
    expect(info.settings.openai).toEqual({ model: "gpt-realtime-2.1-mini", voice: "coral", speed: 1.5, instructions: "Calm." })
    expect(info.settings.elevenlabs).toMatchObject({ voiceId: "abc123", voiceName: "Rachel" })
    // Written back once, so the saved row is current from now on.
    expect(JSON.parse(store.getKv("tts_settings")!).openai).toEqual({ model: "gpt-realtime-2.1-mini", voice: "coral", speed: 1.5, instructions: "Calm." })

    // Every retired voice has a Realtime counterpart; current ones stay put.
    for (const [from, to] of [["fable", "ballad"], ["onyx", "cedar"], ["nova", "coral"], ["ash", "ash"], ["marin", "marin"]]) {
      expect(tts.update({ openai: { voice: from, model: "gpt-4o-mini-tts-2025-12-15" } }).settings.openai).toMatchObject({ voice: to, model: "gpt-realtime-2.1-mini" })
      expect(OPENAI_VOICES.map((v) => v.id)).toContain(to)
    }
    expect(tts.update({ openai: { model: "gpt-realtime-2.1" } }).settings.openai.model).toBe("gpt-realtime-2.1")
  })

  it("preview lines use the owner's name", () => {
    expect(previewLine("Marin", undefined)).toBe("Hi Cody, this is Marin.")
    expect(previewLine("Marin", "Sam")).toBe("Hi Sam, this is Marin.")
  })
})

describe("TTS proxy (service)", () => {
  const fakes: { close(): Promise<void> }[] = []
  afterEach(async () => {
    await Promise.all(fakes.splice(0).map((f) => f.close()))
  })
  const service = (fetch: typeof globalThis.fetch, opts: { timeoutMs?: number; voicesTtlMs?: number; now?: () => number; openai?: string } = {}) => {
    const settings = new TtsSettingsStore(memStore(), {})
    settings.update({ elevenlabsApiKey: EL_KEY, openaiApiKey: OA_KEY })
    const { openai = "https://oa.test", ...rest } = opts
    return { settings, tts: new TtsService({ settings, baseUrls: { elevenlabs: "https://el.test", openai }, fetch, ...rest }) }
  }
  /** OpenAI on a fake Realtime server, the settings' provider set to it. */
  const realtime = async (behave?: Behave, reject?: Parameters<typeof fakeRealtime>[1], opts: { timeoutMs?: number } = {}) => {
    const rt = await fakeRealtime(behave, reject)
    fakes.push(rt)
    const p = fakeProviders()
    const { settings, tts } = service(p.fetch, { ...opts, openai: rt.baseUrl })
    settings.update({ provider: "openai" })
    return { rt, settings, tts, p }
  }
  const drain = async (it: AsyncIterable<Uint8Array>) => {
    const parts: Buffer[] = []
    for await (const c of it) parts.push(Buffer.from(c))
    return Buffer.concat(parts).toString()
  }

  it("calls ElevenLabs' streaming endpoint with the saved voice and model", async () => {
    const p = fakeProviders()
    const { settings, tts } = service(p.fetch)
    settings.update({ provider: "elevenlabs", elevenlabs: { voiceId: "voice42", speed: 1.1 } })
    const out = await tts.synthesize({ text: "  Task Login finished.  " })
    expect(out.cache).toBe("miss")
    expect(out.contentType).toBe("audio/mpeg")
    expect(await drain(out.chunks)).toBe("MP3DATA")
    const [call] = p.calls
    expect(call!.url).toBe("https://el.test/v1/text-to-speech/voice42/stream?output_format=mp3_44100_128")
    expect(call!.headers["xi-api-key"]).toBe(EL_KEY)
    expect(call!.body).toEqual({ text: "Task Login finished.", model_id: "eleven_flash_v2_5", voice_settings: { speed: 1.1 } })
  })

  it("speaks OpenAI lines over a Realtime socket: key in the header, read-aloud instructions, text in, PCM out", async () => {
    const { rt, settings, tts, p } = await realtime()
    settings.update({ openai: { voice: "coral", instructions: "Calm and quick.", speed: 1.25 } })
    const out = await tts.synthesize({ text: "  Hello.  " })
    expect(out.contentType).toBe(PCM_CONTENT_TYPE)
    expect(await drain(out.chunks)).toBe("PCM-AUDIO")
    expect(p.calls).toHaveLength(0)
    const [s] = rt.sessions
    expect(s!.url).toBe("/v1/realtime?model=gpt-realtime-2.1-mini")
    expect(s!.headers.authorization).toBe(`Bearer ${OA_KEY}`)
    expect(s!.url).not.toContain(OA_KEY)
    expect(s!.events.map((e) => e.type)).toEqual(["session.update", "conversation.item.create", "response.create"])
    expect(s!.events[0].session).toEqual({
      type: "realtime",
      output_modalities: ["audio"],
      instructions: `${READ_ALOUD_INSTRUCTIONS}\n\nVoice and delivery: Calm and quick.`,
      max_output_tokens: 4096,
      audio: { output: { format: { type: "audio/pcm", rate: 24000 }, voice: "coral", speed: 1.25 } },
    })
    expect(s!.events[1].item).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "Hello." }] })
    expect(s!.events[2].response).toEqual({ output_modalities: ["audio"] })
    // Done with the line: the socket is closed, not left open.
    await expect.poll(() => s!.closed).toBe(true)
  })

  it("maps a retired model or voice in a request (an old open tab) to the Realtime ones", async () => {
    const { rt, tts } = await realtime()
    await drain((await tts.synthesize({ text: "Hi.", model: "tts-1", voice: "onyx", speed: 4 })).chunks)
    expect(rt.sessions[0]!.url).toBe("/v1/realtime?model=gpt-realtime-2.1-mini")
    expect(rt.sessions[0]!.events[0].session.audio.output).toMatchObject({ voice: "cedar", speed: 1.5 })
    expect(rt.sessions[0]!.events[0].session.instructions).toBe(READ_ALOUD_INSTRUCTIONS)
  })

  it("streams each audio delta as it arrives, without waiting for the whole clip", async () => {
    const hold = gate()
    const { rt, tts } = await realtime(speak(["first", "-second"], { before: (i) => (i === 1 ? hold.wait : undefined) }))
    const out = await tts.synthesize({ text: "A longer line." })
    const it = out.chunks[Symbol.asyncIterator]()
    // The first chunk is out while OpenAI is still holding the rest back.
    expect(Buffer.from((await it.next()).value!).toString()).toBe("first")
    expect(rt.sessions[0]!.closed).toBe(false)
    hold.open()
    expect(Buffer.from((await it.next()).value!).toString()).toBe("-second")
    expect((await it.next()).done).toBe(true)
    // Complete, so it's cached for next time.
    expect((await tts.synthesize({ text: "A longer line." })).cache).toBe("hit")
  })

  it("serves a repeated line from the cache, keyed by provider, voice, model, settings and text", async () => {
    const { rt, tts, p } = await realtime()
    expect(await drain((await tts.synthesize({ text: "Voice on." })).chunks)).toBe("PCM-AUDIO")
    const again = await tts.synthesize({ text: "Voice on." })
    expect(again.cache).toBe("hit")
    expect(again.contentType).toBe(PCM_CONTENT_TYPE)
    expect(await drain(again.chunks)).toBe("PCM-AUDIO")
    expect(rt.sessions).toHaveLength(1)
    // Anything that changes the audio is a different entry.
    for (const req of [{ voice: "ash" }, { model: "gpt-realtime-2.1" }, { speed: 1.25 }, { instructions: "Whisper." }, { provider: "elevenlabs" as const }, { text: "Voice off." }]) {
      const out = await tts.synthesize({ text: "Voice on.", ...req })
      expect(out.cache).toBe("miss")
      await drain(out.chunks)
    }
    expect(rt.sessions).toHaveLength(6)
    expect(p.calls).toHaveLength(1)
    expect(tts.cache.hits).toBe(1)
  })

  it("doesn't cache a stream the browser walked away from, and hangs up on OpenAI", async () => {
    const hold = gate()
    const { rt, tts } = await realtime(speak(["one", "two"], { before: (i) => (i === 1 ? hold.wait : undefined) }))
    const out = await tts.synthesize({ text: "Cut short." })
    out.cancel()
    await expect.poll(() => rt.sessions[0]!.closed).toBe(true)
    hold.open()
    expect((await tts.synthesize({ text: "Cut short." })).cache).toBe("miss")

    // ElevenLabs too.
    const p = fakeProviders()
    const el = service(p.fetch)
    el.settings.update({ provider: "elevenlabs" })
    ;(await el.tts.synthesize({ text: "Cut short." })).cancel()
    expect((await el.tts.synthesize({ text: "Cut short." })).cache).toBe("miss")
  })

  it("passes the provider's error message through", async () => {
    const el = fakeProviders(() => new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }), { status: 401 }))
    const a = service(el.fetch)
    a.settings.update({ provider: "elevenlabs" })
    await expect(a.tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 502, upstreamStatus: 401, message: "ElevenLabs: Invalid API key (HTTP 401)" })


    expect(providerMessage(JSON.stringify({ detail: [{ msg: "text too long" }, { msg: "bad voice" }] }))).toBe("text too long; bad voice")
    expect(providerMessage("<html> Bad gateway </html>")).toBe("<html> Bad gateway </html>")
  })

  it("passes OpenAI's Realtime errors through: a refused handshake, an error event, a failed response, a cut-off stream", async () => {
    const refused = await realtime(undefined, () => ({ status: 401, body: { error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } } }))
    await expect(refused.tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 502, upstreamStatus: 401, provider: "openai", message: "OpenAI: Incorrect API key provided. (HTTP 401)" })

    const badVoice = await realtime((_s, send) => send({ type: "error", error: { type: "invalid_request_error", code: "invalid_value", message: "Invalid value: 'nova'." } }))
    await expect(badVoice.tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 502, message: "OpenAI: Invalid value: 'nova'." })
    await expect.poll(() => badVoice.rt.sessions[0]!.closed).toBe(true)

    const quota = await realtime((_s, send) =>
      send({ type: "response.done", response: { status: "failed", status_details: { type: "failed", error: { type: "insufficient_quota", message: "You exceeded your current quota." } } } }),
    )
    await expect(quota.tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 502, message: "OpenAI: You exceeded your current quota." })

    const cancelled = await realtime((_s, send) => send({ type: "response.done", response: { status: "cancelled", status_details: { type: "cancelled", reason: "client_cancelled" } } }))
    await expect(cancelled.tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ message: "OpenAI: the response was cancelled (client_cancelled)." })

    const silent = await realtime((_s, send) => send({ type: "response.done", response: { status: "completed", output: [] } }))
    await expect(silent.tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 502, message: "OpenAI sent no audio." })

    // After the first chunk the response is already streaming: the iterator throws, nothing is cached.
    const cut = await realtime(async (_s, send, ws) => {
      send({ type: "response.output_audio.delta", delta: Buffer.from("half").toString("base64") })
      await new Promise((r) => setTimeout(r, 20))
      ws.close(1011, "server error")
    })
    const out = await cut.tts.synthesize({ text: "Hi." })
    await expect(drain(out.chunks)).rejects.toMatchObject({ message: "OpenAI closed the connection before the audio finished (1011: server error)." })
    expect(cut.tts.cache.count).toBe(0)
  })

  it("times out, and reports network failures", async () => {
    const a = await realtime(() => {}, undefined, { timeoutMs: 50 })
    await expect(a.tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 504, message: "OpenAI didn't answer within 1 s." })
    await expect.poll(() => a.rt.sessions[0]!.closed).toBe(true)

    const port = await freePort()
    const off = service(fakeProviders().fetch, { openai: `http://127.0.0.1:${port}` })
    off.settings.update({ provider: "openai" })
    await expect(off.tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 502, message: "Can't reach OpenAI: ECONNREFUSED" })

    const slow = fakeProviders(() => new Promise<Response>(() => {}))
    const c = service(slow.fetch, { timeoutMs: 50 })
    c.settings.update({ provider: "elevenlabs" })
    await expect(c.tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 504, message: "ElevenLabs didn't answer within 1 s." })

    const down = fakeProviders(() => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })))
    const b = service(down.fetch)
    b.settings.update({ provider: "elevenlabs" })
    await expect(b.tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 502, message: "Can't reach ElevenLabs: ENOTFOUND" })
  })

  it("caps text length, and needs a provider and a key", async () => {
    const p = fakeProviders()
    const { settings, tts } = service(p.fetch)
    await expect(tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Browser / OS") })
    settings.update({ provider: "openai" })
    await expect(tts.synthesize({ text: "x".repeat(1001) })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("too long") })
    await expect(tts.synthesize({ text: "   " })).rejects.toMatchObject({ status: 400 })
    settings.update({ openaiApiKey: null })
    await expect(tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 400, message: "No OpenAI API key. Add one in Settings › Voice." })
    expect(p.calls).toHaveLength(0)
  })

  it("fetches ElevenLabs voices once (all pages), then reuses the list until it expires or is refreshed", async () => {
    let now = 1_000
    const p = fakeProviders((url) =>
      url.includes("next_page_token=p2")
        ? voicesPage([{ voice_id: "own1", name: "My clone", category: "cloned", preview_url: null }])
        : voicesPage(
            [
              { voice_id: "JBFqnCBsd6RMkjVDRZzb", name: "George", category: "premade", preview_url: "https://storage.example/george.mp3", labels: { accent: "british" } },
              { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", category: "premade", preview_url: "javascript:alert(1)" },
            ],
            "p2",
          ),
    )
    const { tts } = service(p.fetch, { voicesTtlMs: 60_000, now: () => now })
    const list = await tts.voices("elevenlabs")
    expect(list.voices.map((v) => v.name)).toEqual(["My clone", "George", "Sarah"])
    expect(list.voices[1]).toMatchObject({ id: "JBFqnCBsd6RMkjVDRZzb", previewUrl: "https://storage.example/george.mp3", labels: { accent: "british" } })
    expect(list.voices[2]!.previewUrl).toBeNull()
    expect(p.calls.map((c) => c.url)).toEqual(["https://el.test/v2/voices?page_size=100", "https://el.test/v2/voices?page_size=100&next_page_token=p2"])
    expect(p.calls[0]!.headers["xi-api-key"]).toBe(EL_KEY)

    await Promise.all([tts.voices("elevenlabs"), tts.voices("elevenlabs")])
    expect(p.calls).toHaveLength(2)
    now += 61_000
    await tts.voices("elevenlabs")
    expect(p.calls).toHaveLength(4)
    await tts.voices("elevenlabs", true)
    expect(p.calls).toHaveLength(6)

    // OpenAI's voices are the Realtime API's fixed list; nothing is fetched.
    const oa = await tts.voices("openai")
    expect(oa.voices.map((v) => v.id)).toEqual(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"])
    expect(p.calls).toHaveLength(6)
  })

  it("the audio cache is a byte-capped LRU", () => {
    const c = new AudioCache(10)
    c.set("a", Buffer.alloc(4))
    c.set("b", Buffer.alloc(4))
    expect(c.get("a")).toBeDefined() // a is now the most recent
    c.set("c", Buffer.alloc(4))
    expect(c.get("b")).toBeUndefined()
    expect(c.get("a")).toBeDefined()
    expect(c.get("c")).toBeDefined()
    expect(c.bytes).toBe(8)
    c.set("huge", Buffer.alloc(11))
    expect(c.count).toBe(2)
  })
})

describe("TTS HTTP routes", () => {
  let server: Server | null = null
  let yard: BoxYard | null = null
  afterEach(async () => {
    yard?.stop()
    if (server) await new Promise((res) => server!.close(() => res(null)))
    server = null
    yard = null
  })

  async function boot(fetch: typeof globalThis.fetch, env: { elevenlabsApiKey?: string; openaiBaseUrl?: string } = {}) {
    const port = await freePort()
    yard = createBoxYard(testConfig({ port, ...env }), { webDir: "/nonexistent", tts: { fetch } })
    server = await new Promise<Server>((resolve) => {
      const s = yard!.app.listen(port, "127.0.0.1", () => resolve(s))
    })
    const base = `http://127.0.0.1:${port}`
    return (method: string, p: string, body?: unknown) =>
      globalThis.fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  }

  it("never send a key to the browser: settings, server info and SSE only say set/unset", async () => {
    const p = fakeProviders()
    const call = await boot(p.fetch, { elevenlabsApiKey: "env-eleven-key-zzz" })
    const broadcasts: string[] = []
    const orig = yard!.hub.broadcast.bind(yard!.hub)
    yard!.hub.broadcast = (ev) => {
      broadcasts.push(JSON.stringify(ev))
      orig(ev)
    }
    const put = await call("PUT", "/api/tts/settings", { provider: "openai", openaiApiKey: OA_KEY })
    expect(put.status).toBe(200)
    const putText = await put.text()
    const texts = [
      putText,
      await (await call("GET", "/api/tts/settings")).text(),
      await (await call("GET", "/api/settings")).text(),
      await (await call("GET", "/api/agent-settings")).text(),
      ...broadcasts,
    ]
    for (const t of texts) {
      expect(t).not.toContain(OA_KEY)
      expect(t).not.toContain("env-eleven-key-zzz")
    }
    const info = JSON.parse(putText) as TtsInfo
    expect(info.keys).toEqual({ elevenlabs: { state: "set", source: "env" }, openai: { state: "set", source: "ui" } })
    expect(JSON.parse(texts[2]!).ttsKeys).toEqual(info.keys)
    expect(broadcasts.some((b) => b.includes('"type":"tts"'))).toBe(true)
  })

  it("POST /api/tts streams mp3 back, marks cache hits, and returns the provider's error as JSON", async () => {
    let fail = false
    const p = fakeProviders(() => (fail ? new Response(JSON.stringify({ detail: { message: "Quota exceeded" } }), { status: 401 }) : audio("ID3-AUDIO")))
    const call = await boot(p.fetch)
    await call("PUT", "/api/tts/settings", { provider: "elevenlabs", elevenlabsApiKey: EL_KEY })

    let res = await call("POST", "/api/tts", { text: "PR 30 merged." })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("audio/mpeg")
    expect(res.headers.get("x-tts-cache")).toBe("miss")
    expect(await res.text()).toBe("ID3-AUDIO")
    res = await call("POST", "/api/tts", { text: "PR 30 merged." })
    expect(res.headers.get("x-tts-cache")).toBe("hit")
    expect(await res.text()).toBe("ID3-AUDIO")
    expect(p.calls).toHaveLength(1)

    fail = true
    res = await call("POST", "/api/tts", { text: "Something new." })
    expect(res.status).toBe(502)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual({ error: "ElevenLabs: Quota exceeded (HTTP 401)", provider: "elevenlabs", upstreamStatus: 401 })

    res = await call("POST", "/api/tts", { text: "x".repeat(1001) })
    expect(res.status).toBe(400)
    res = await call("POST", "/api/tts", { text: "Hi.", provider: "polly" })
    expect(res.status).toBe(400)
  })

  it("POST /api/tts streams OpenAI's Realtime PCM as it arrives; errors are JSON; the key is never in a response", async () => {
    const hold = gate()
    let mode: "speak" | "refuse" | "error" = "speak"
    const rt = await fakeRealtime(
      (s, send) =>
        mode === "error"
          ? send({ type: "error", error: { message: "You do not have access to gpt-realtime-2.1-mini." } })
          : speak(["PCM-1", "PCM-2"], { before: (i) => (i === 1 && s.events[1].item.content[0].text === "Slow line." ? hold.wait : undefined) })(s, send, null as never),
      () => (mode === "refuse" ? { status: 401, body: { error: { message: `Incorrect API key provided: ${OA_KEY.slice(0, 6)}****` } } } : null),
    )
    try {
      const call = await boot(fakeProviders().fetch, { openaiBaseUrl: rt.baseUrl })
      await call("PUT", "/api/tts/settings", { provider: "openai", openaiApiKey: OA_KEY })

      // The first chunk reaches the browser while OpenAI is still holding the second.
      let res = await call("POST", "/api/tts", { text: "Slow line." })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("audio/pcm;rate=24000")
      expect(res.headers.get("x-tts-cache")).toBe("miss")
      const reader = res.body!.getReader()
      expect(Buffer.from((await reader.read()).value!).toString()).toBe("PCM-1")
      hold.open()
      let rest = ""
      for (let r = await reader.read(); !r.done; r = await reader.read()) rest += Buffer.from(r.value).toString()
      expect(rest).toBe("PCM-2")
      expect(rt.sessions[0]!.headers.authorization).toBe(`Bearer ${OA_KEY}`)

      res = await call("POST", "/api/tts", { text: "Slow line." })
      expect(res.headers.get("x-tts-cache")).toBe("hit")
      expect(await res.text()).toBe("PCM-1PCM-2")

      const texts: string[] = []
      mode = "refuse"
      res = await call("POST", "/api/tts", { text: "Refused." })
      expect(res.status).toBe(502)
      texts.push(JSON.stringify([...res.headers]), await res.text())
      expect(JSON.parse(texts[1]!)).toEqual({ error: "OpenAI: Incorrect API key provided: sk-ope**** (HTTP 401)", provider: "openai", upstreamStatus: 401 })
      mode = "error"
      res = await call("POST", "/api/tts", { text: "Bad voice.", voice: "nova" })
      texts.push(await res.text())
      expect(JSON.parse(texts[2]!)).toEqual({ error: "OpenAI: You do not have access to gpt-realtime-2.1-mini.", provider: "openai", upstreamStatus: null })
      // The old voice name was mapped before it went out.
      expect(rt.sessions.at(-1)!.events[0].session.audio.output.voice).toBe("coral")
      texts.push(await (await call("GET", "/api/tts/settings")).text(), await (await call("GET", "/api/tts/voices?provider=openai")).text())
      for (const t of texts) expect(t).not.toContain(OA_KEY)
      expect(JSON.parse(texts[3]!).settings.openai.model).toBe("gpt-realtime-2.1-mini")
    } finally {
      await rt.close()
    }
  })

  it("GET /api/tts/voices lists and caches voices", async () => {
    const p = fakeProviders(() => voicesPage([{ voice_id: "v1", name: "Aria", category: "premade", preview_url: "https://x.test/a.mp3" }]))
    const call = await boot(p.fetch)
    let res = await call("GET", "/api/tts/voices?provider=elevenlabs")
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("No ElevenLabs API key")
    await call("PUT", "/api/tts/settings", { elevenlabsApiKey: EL_KEY })
    res = await call("GET", "/api/tts/voices?provider=elevenlabs")
    const list = (await res.json()) as TtsVoiceList
    expect(list.voices).toEqual([{ id: "v1", name: "Aria", category: "premade", previewUrl: "https://x.test/a.mp3" }])
    await call("GET", "/api/tts/voices?provider=elevenlabs")
    expect(p.calls).toHaveLength(1)
    await call("GET", "/api/tts/voices?provider=elevenlabs&refresh=1")
    expect(p.calls).toHaveLength(2)
  })
})

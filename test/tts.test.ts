import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { TtsSettingsStore } from "../server/settings.js"
import { AudioCache, TtsService, providerMessage } from "../server/tts.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { TTS_DEFAULTS, previewLine, type TtsInfo, type TtsVoiceList } from "../shared/tts.js"
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
    expect(info.settings.openai.model).toBe("gpt-4o-mini-tts")
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
    expect(() => tts.update({ elevenlabs: { voiceId: "../../v1/user" } })).toThrow()
    expect(() => tts.update({ secret: "x" })).toThrow()
  })

  it("preview lines use the owner's name", () => {
    expect(previewLine("Marin", undefined)).toBe("Hi Cody, this is Marin.")
    expect(previewLine("Marin", "Sam")).toBe("Hi Sam, this is Marin.")
  })
})

describe("TTS proxy (service)", () => {
  const service = (fetch: typeof globalThis.fetch, opts: { timeoutMs?: number; voicesTtlMs?: number; now?: () => number } = {}) => {
    const settings = new TtsSettingsStore(memStore(), {})
    settings.update({ elevenlabsApiKey: EL_KEY, openaiApiKey: OA_KEY })
    return { settings, tts: new TtsService({ settings, baseUrls: { elevenlabs: "https://el.test", openai: "https://oa.test" }, fetch, ...opts }) }
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

  it("calls OpenAI's speech endpoint; instructions only for models that read them", async () => {
    const p = fakeProviders()
    const { settings, tts } = service(p.fetch)
    settings.update({ provider: "openai", openai: { voice: "coral", instructions: "Calm and quick." } })
    await drain((await tts.synthesize({ text: "Hello." })).chunks)
    expect(p.calls[0]!.url).toBe("https://oa.test/v1/audio/speech")
    expect(p.calls[0]!.headers.authorization).toBe(`Bearer ${OA_KEY}`)
    expect(p.calls[0]!.body).toEqual({ model: "gpt-4o-mini-tts", input: "Hello.", voice: "coral", response_format: "mp3", instructions: "Calm and quick." })
    await drain((await tts.synthesize({ text: "Hello.", model: "tts-1", speed: 1.5 })).chunks)
    expect(p.calls[1]!.body).toEqual({ model: "tts-1", input: "Hello.", voice: "coral", response_format: "mp3", speed: 1.5 })
  })

  it("serves a repeated line from the cache, keyed by provider, voice, model, settings and text", async () => {
    const p = fakeProviders()
    const { settings, tts } = service(p.fetch)
    settings.update({ provider: "openai" })
    expect(await drain((await tts.synthesize({ text: "Voice on." })).chunks)).toBe("MP3DATA")
    const again = await tts.synthesize({ text: "Voice on." })
    expect(again.cache).toBe("hit")
    expect(await drain(again.chunks)).toBe("MP3DATA")
    expect(p.calls).toHaveLength(1)
    // Anything that changes the audio is a different entry.
    for (const req of [{ voice: "ash" }, { model: "tts-1" }, { speed: 1.25 }, { instructions: "Whisper." }, { provider: "elevenlabs" as const }, { text: "Voice off." }]) {
      const out = await tts.synthesize({ text: "Voice on.", ...req })
      expect(out.cache).toBe("miss")
      await drain(out.chunks)
    }
    expect(p.calls).toHaveLength(7)
    expect(tts.cache.hits).toBe(1)
  })

  it("doesn't cache a stream the browser walked away from", async () => {
    const p = fakeProviders()
    const { settings, tts } = service(p.fetch)
    settings.update({ provider: "openai" })
    const out = await tts.synthesize({ text: "Cut short." })
    out.cancel()
    expect((await tts.synthesize({ text: "Cut short." })).cache).toBe("miss")
  })

  it("passes the provider's error message through", async () => {
    const el = fakeProviders(() => new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }), { status: 401 }))
    const a = service(el.fetch)
    a.settings.update({ provider: "elevenlabs" })
    await expect(a.tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 502, upstreamStatus: 401, message: "ElevenLabs: Invalid API key (HTTP 401)" })

    const oa = fakeProviders(() => new Response(JSON.stringify({ error: { message: "You exceeded your current quota.", type: "insufficient_quota" } }), { status: 429 }))
    const b = service(oa.fetch)
    b.settings.update({ provider: "openai" })
    await expect(b.tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 502, upstreamStatus: 429, message: "OpenAI: You exceeded your current quota. (HTTP 429)" })

    expect(providerMessage(JSON.stringify({ detail: [{ msg: "text too long" }, { msg: "bad voice" }] }))).toBe("text too long; bad voice")
    expect(providerMessage("<html> Bad gateway </html>")).toBe("<html> Bad gateway </html>")
  })

  it("times out, and reports network failures", async () => {
    const slow = fakeProviders(() => new Promise<Response>(() => {}))
    const a = service(slow.fetch, { timeoutMs: 50 })
    a.settings.update({ provider: "openai" })
    await expect(a.tts.synthesize({ text: "Hi." })).rejects.toMatchObject({ status: 504, message: "OpenAI didn't answer within 1 s." })

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

    // OpenAI's voices are a fixed list; nothing is fetched.
    const oa = await tts.voices("openai")
    expect(oa.voices.map((v) => v.id)).toContain("marin")
    expect(oa.voices.find((v) => v.id === "ballad")!.allModels).toBe(false)
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

  async function boot(fetch: typeof globalThis.fetch, env: { elevenlabsApiKey?: string } = {}) {
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

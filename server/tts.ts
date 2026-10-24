// The text-to-speech proxy behind POST /api/tts: calls ElevenLabs or OpenAI with the key saved in
// Settings (never the browser's), streams the mp3 back, and keeps recent results in a small LRU so
// a notice that repeats ("Voice on.", "3 tasks finished.") costs nothing the second time.
import { createHash } from "node:crypto"
import type { TtsSettingsStore } from "./settings.js"
import {
  CLOUD_PROVIDERS,
  ELEVENLABS_SPEED,
  MAX_INSTRUCTIONS,
  MAX_TTS_CHARS,
  OPENAI_SPEED,
  OPENAI_VOICES,
  TTS_PROVIDER_LABEL,
  openAiSupportsInstructions,
  type CloudProvider,
  type TtsRequest,
  type TtsVoice,
  type TtsVoiceList,
} from "../shared/tts.js"

/** A failed synthesis or voice lookup; `message` is what the browser shows in its fallback toast. */
export class TtsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly provider: CloudProvider | null = null,
    /** The provider's own HTTP status, when it answered. */
    readonly upstreamStatus: number | null = null,
  ) {
    super(message)
  }
}

export interface TtsAudio {
  contentType: string
  cache: "hit" | "miss"
  chunks: AsyncIterable<Uint8Array>
  /** The browser went away: stop the upstream request (nothing is cached). */
  cancel(): void
}

export interface TtsOptions {
  settings: TtsSettingsStore
  baseUrls: Record<CloudProvider, string>
  fetch?: typeof fetch
  /** Whole request, first byte to last. */
  timeoutMs?: number
  /** Audio kept in memory, in bytes. */
  cacheBytes?: number
  /** How long a fetched voice list is reused. */
  voicesTtlMs?: number
  now?: () => number
}

export const TTS_TIMEOUT_MS = 20_000
const CACHE_BYTES = 24 * 1024 * 1024
/** One clip bigger than this isn't worth a cache slot. */
const MAX_CACHED_CLIP = 2 * 1024 * 1024
const VOICES_TTL_MS = 10 * 60_000
const MP3 = "audio/mpeg"
/** 128 kbps mp3 works on the free tier and in every browser (Safari's opus support is patchy). */
const ELEVENLABS_FORMAT = "mp3_44100_128"

const sha = (s: string) => createHash("sha256").update(s).digest("hex")

/** Byte-capped LRU: Map order is recency order. */
export class AudioCache {
  private items = new Map<string, Buffer>()
  private size = 0
  hits = 0
  misses = 0

  constructor(private readonly maxBytes: number) {}

  get(key: string): Buffer | undefined {
    const v = this.items.get(key)
    if (!v) {
      this.misses++
      return undefined
    }
    this.hits++
    this.items.delete(key)
    this.items.set(key, v)
    return v
  }

  set(key: string, value: Buffer) {
    if (value.length > Math.min(MAX_CACHED_CLIP, this.maxBytes)) return
    const old = this.items.get(key)
    if (old) {
      this.size -= old.length
      this.items.delete(key)
    }
    this.items.set(key, value)
    this.size += value.length
    for (const [k, v] of this.items) {
      if (this.size <= this.maxBytes) break
      this.items.delete(k)
      this.size -= v.length
    }
  }

  get bytes() {
    return this.size
  }
  get count() {
    return this.items.size
  }
}

interface Call {
  provider: CloudProvider
  url: string
  init: RequestInit
  cacheKey: string
}

/** The provider's own error text: ElevenLabs `{detail: {message}}` / `{detail: [{msg}]}`, OpenAI `{error: {message}}`. */
export function providerMessage(body: string): string {
  let data: any
  try {
    data = JSON.parse(body)
  } catch {
    return body.replace(/\s+/g, " ").trim().slice(0, 300)
  }
  const d = data?.detail
  const msg =
    data?.error?.message ??
    (typeof data?.error === "string" ? data.error : undefined) ??
    d?.message ??
    (Array.isArray(d) ? d.map((x: any) => x?.msg).filter(Boolean).join("; ") : undefined) ??
    (typeof d === "string" ? d : undefined) ??
    data?.message
  return typeof msg === "string" && msg.trim() ? msg.trim().slice(0, 300) : body.slice(0, 300)
}

export class TtsService {
  readonly cache: AudioCache
  private voiceLists = new Map<string, TtsVoiceList>()
  private voiceFetches = new Map<string, Promise<TtsVoiceList>>()
  private readonly fetch: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(private readonly o: TtsOptions) {
    this.fetch = o.fetch ?? globalThis.fetch
    this.timeoutMs = o.timeoutMs ?? TTS_TIMEOUT_MS
    this.cache = new AudioCache(o.cacheBytes ?? CACHE_BYTES)
    this.now = o.now ?? Date.now
  }

  private key(provider: CloudProvider): string {
    const key = this.o.settings.apiKey(provider)
    if (!key) throw new TtsError(`No ${TTS_PROVIDER_LABEL[provider]} API key. Add one in Settings › Voice.`, 400, provider)
    return key
  }

  /** Validate a request against the saved settings and build the provider call. */
  plan(req: TtsRequest): Call {
    const text = typeof req.text === "string" ? req.text.trim() : ""
    if (!text) throw new TtsError("text is required", 400)
    if (text.length > MAX_TTS_CHARS) throw new TtsError(`text is too long (${text.length} characters, at most ${MAX_TTS_CHARS})`, 400)
    const s = this.o.settings.get()
    const provider = req.provider ?? (s.provider === "browser" ? null : s.provider)
    if (!provider || !CLOUD_PROVIDERS.includes(provider)) throw new TtsError("Text-to-speech is set to Browser / OS: the browser speaks for itself.", 400)
    const key = this.key(provider)
    const keyId = sha(key).slice(0, 16)
    const clamp = (v: number | undefined, fallback: number, r: { min: number; max: number }) =>
      typeof v === "number" && Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, v)) : fallback
    if (provider === "elevenlabs") {
      const voice = req.voice?.trim() || s.elevenlabs.voiceId
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(voice)) throw new TtsError("Not an ElevenLabs voice id", 400, provider)
      const model = req.model?.trim() || s.elevenlabs.model
      const speed = clamp(req.speed, s.elevenlabs.speed, ELEVENLABS_SPEED)
      const body: Record<string, unknown> = { text, model_id: model }
      // Only override the voice's own stored settings when we have to.
      if (speed !== 1) body.voice_settings = { speed }
      return {
        provider,
        url: `${this.o.baseUrls.elevenlabs}/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=${ELEVENLABS_FORMAT}`,
        init: { method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: MP3 }, body: JSON.stringify(body) },
        cacheKey: sha(JSON.stringify([provider, keyId, voice, model, speed, ELEVENLABS_FORMAT, text])),
      }
    }
    const voice = req.voice?.trim() || s.openai.voice
    if (!/^[a-z0-9_-]{1,64}$/.test(voice)) throw new TtsError("Not an OpenAI voice", 400, provider)
    const model = req.model?.trim() || s.openai.model
    const speed = clamp(req.speed, s.openai.speed, OPENAI_SPEED)
    const instructions = openAiSupportsInstructions(model) ? (req.instructions ?? s.openai.instructions).trim().slice(0, MAX_INSTRUCTIONS) : ""
    const body: Record<string, unknown> = { model, input: text, voice, response_format: "mp3" }
    if (speed !== 1) body.speed = speed
    if (instructions) body.instructions = instructions
    return {
      provider,
      url: `${this.o.baseUrls.openai}/v1/audio/speech`,
      init: { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
      cacheKey: sha(JSON.stringify([provider, keyId, voice, model, speed, instructions, "mp3", text])),
    }
  }

  /** Start a synthesis: a cached clip, or the provider's stream (cached once it completes). */
  async synthesize(req: TtsRequest): Promise<TtsAudio> {
    const call = this.plan(req)
    const hit = this.cache.get(call.cacheKey)
    if (hit) {
      return {
        contentType: MP3,
        cache: "hit",
        chunks: (async function* () {
          yield hit
        })(),
        cancel: () => {},
      }
    }
    const label = TTS_PROVIDER_LABEL[call.provider]
    const ctl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctl.abort()
    }, this.timeoutMs)
    const fail = (err: unknown): never => {
      clearTimeout(timer)
      if (err instanceof TtsError) throw err
      if (timedOut) throw new TtsError(`${label} didn't answer within ${Math.max(1, Math.round(this.timeoutMs / 1000))} s.`, 504, call.provider)
      const cause = (err as { cause?: { code?: string; message?: string } })?.cause
      throw new TtsError(`Can't reach ${label}: ${cause?.code ?? cause?.message ?? (err as Error)?.message ?? String(err)}`, 502, call.provider)
    }
    let res: Response
    try {
      res = await this.fetch(call.url, { ...call.init, signal: ctl.signal })
    } catch (err) {
      return fail(err)
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "")
      clearTimeout(timer)
      throw new TtsError(`${label}: ${providerMessage(body) || res.statusText || "request failed"} (HTTP ${res.status})`, 502, call.provider, res.status)
    }
    const reader = res.body.getReader()
    const cache = this.cache
    let cancelled = false
    async function* chunks() {
      const parts: Buffer[] = []
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const buf = Buffer.from(value)
          parts.push(buf)
          yield buf
        }
        clearTimeout(timer)
        const audio = Buffer.concat(parts)
        if (!cancelled && audio.length) cache.set(call.cacheKey, audio)
      } catch (err) {
        fail(err)
      } finally {
        clearTimeout(timer)
      }
    }
    return {
      contentType: res.headers.get("content-type")?.startsWith("audio/") ? res.headers.get("content-type")! : MP3,
      cache: "miss",
      chunks: chunks(),
      cancel: () => {
        cancelled = true
        clearTimeout(timer)
        ctl.abort()
      },
    }
  }

  /** A provider's voices. ElevenLabs' list (premade plus the account's own) is fetched once per key and reused. */
  async voices(provider: CloudProvider, refresh = false): Promise<TtsVoiceList> {
    if (provider === "openai") {
      return { provider, fetchedAt: 0, voices: OPENAI_VOICES.map((v) => ({ id: v.id, name: v.name, category: "built-in", allModels: v.allModels })) }
    }
    const key = this.key(provider)
    const id = `${provider}:${sha(key).slice(0, 16)}`
    const cached = this.voiceLists.get(id)
    if (cached && !refresh && this.now() - cached.fetchedAt < (this.o.voicesTtlMs ?? VOICES_TTL_MS)) return cached
    let pending = this.voiceFetches.get(id)
    if (!pending) {
      pending = this.fetchElevenLabsVoices(key).finally(() => this.voiceFetches.delete(id))
      this.voiceFetches.set(id, pending)
    }
    const list = await pending
    this.voiceLists.set(id, list)
    return list
  }

  /** GET /v2/voices (the docs' current list endpoint; /v1/voices now redirects to it), up to 500 voices. */
  private async fetchElevenLabsVoices(key: string): Promise<TtsVoiceList> {
    const voices: TtsVoice[] = []
    let token: string | null = null
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ page_size: "100" })
      if (token) q.set("next_page_token", token)
      let res: Response
      try {
        res = await this.fetch(`${this.o.baseUrls.elevenlabs}/v2/voices?${q}`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(this.timeoutMs) })
      } catch (err) {
        const name = (err as Error)?.name
        throw new TtsError(name === "TimeoutError" ? "ElevenLabs didn't answer in time." : `Can't reach ElevenLabs: ${(err as Error)?.message}`, 502, "elevenlabs")
      }
      const text = await res.text()
      if (!res.ok) throw new TtsError(`ElevenLabs: ${providerMessage(text)} (HTTP ${res.status})`, 502, "elevenlabs", res.status)
      const data = JSON.parse(text) as { voices?: any[]; has_more?: boolean; next_page_token?: string | null }
      for (const v of data.voices ?? []) {
        if (typeof v?.voice_id !== "string") continue
        voices.push({
          id: v.voice_id,
          name: String(v.name ?? v.voice_id),
          category: String(v.category ?? "premade"),
          description: typeof v.description === "string" ? v.description : undefined,
          previewUrl: typeof v.preview_url === "string" && /^https:\/\//.test(v.preview_url) ? v.preview_url : null,
          labels: v.labels && typeof v.labels === "object" ? v.labels : undefined,
        })
      }
      token = data.has_more && data.next_page_token ? data.next_page_token : null
      if (!token) break
    }
    // The account's own voices first, then the premade library, each by name.
    const own = (v: TtsVoice) => (v.category === "premade" ? 1 : 0)
    voices.sort((a, b) => own(a) - own(b) || a.name.localeCompare(b.name))
    return { provider: "elevenlabs", voices, fetchedAt: this.now() }
  }
}

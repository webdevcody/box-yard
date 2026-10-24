// Cloud text-to-speech in the browser: which provider the server is set to (GET /api/tts/settings,
// kept fresh by the `tts` event), and CloudSynth, a SynthLike that the existing SpeechQueue drives
// exactly like window.speechSynthesis. It fetches each line from POST /api/tts and plays it through
// one shared <audio> element; on any failure it says the line with the browser's own voice instead
// and shows the error once.
import { useEffect, useState, useSyncExternalStore } from "react"
import { TTS_PROVIDER_LABEL, type CloudProvider, type TtsInfo, type TtsProvider, type TtsRequest } from "../../../shared/tts"
import type { SynthLike, UtteranceLike } from "./speech"
import { toast } from "./toast"

const browser = typeof window !== "undefined"

// ------------------------------------------------------------------ settings store (server-side settings)

type Listener = () => void
const listeners = new Set<Listener>()
let info: TtsInfo | null = null
let loading: Promise<void> | null = null

export const getTtsInfo = () => info

export function setTtsInfo(next: TtsInfo | null) {
  info = next
  listeners.forEach((l) => l())
}

/** Fetch the settings once (again with `force`); failures leave the browser voice in charge. */
export function loadTtsInfo(force = false): Promise<void> {
  if (!browser || typeof fetch === "undefined") return Promise.resolve()
  if (loading && !force) return loading
  loading = fetch("/api/tts/settings", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => data && setTtsInfo(data as TtsInfo))
    .catch(() => {})
  return loading
}

export const subscribeTtsInfo = (l: Listener) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const useTtsInfo = () => useSyncExternalStore(subscribeTtsInfo, getTtsInfo, getTtsInfo)

/** The engine to speak with: a cloud provider only when it's chosen and has a key. */
export function activeProvider(i: TtsInfo | null = info): TtsProvider {
  const p = i?.settings.provider ?? "browser"
  return p !== "browser" && i?.keys[p].state === "set" ? p : "browser"
}

// ------------------------------------------------------------------ fetching audio

export class TtsFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Covers the server's own 20 s provider timeout plus the download. */
export const CLIENT_TIMEOUT_MS = 25_000

/** POST /api/tts → the mp3. Errors carry the server's (and so the provider's) exact message. */
export async function fetchTts(req: TtsRequest, signal?: AbortSignal): Promise<Blob> {
  const timeout = AbortSignal.timeout(CLIENT_TIMEOUT_MS)
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout
  let res: Response
  try {
    res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      credentials: "same-origin",
      signal: both,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    if (timeout.aborted) throw new TtsFetchError("Box Yard's text-to-speech didn't answer in time.", 0)
    throw new TtsFetchError("Can't reach the Box Yard server.", 0)
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new TtsFetchError(data?.error ?? `Text-to-speech failed (HTTP ${res.status})`, res.status)
  }
  return res.blob()
}

// ------------------------------------------------------------------ the shared audio element

export interface AudioLike {
  src: string
  volume: number
  readonly paused: boolean
  play(): Promise<void>
  pause(): void
  onplaying: ((ev: any) => void) | null
  onended: ((ev: any) => void) | null
  onerror: ((ev: any) => void) | null
}

let sharedAudio: HTMLAudioElement | null = null
/** One element for everything Box Yard plays, so unlocking it once (mobile, PWA) unlocks it for good. */
export function audioElement(): HTMLAudioElement | null {
  if (!browser || typeof Audio === "undefined") return null
  if (!sharedAudio) {
    sharedAudio = new Audio()
    sharedAudio.preload = "auto"
    sharedAudio.setAttribute("playsinline", "")
  }
  return sharedAudio
}

/** A 1-sample silent WAV: played inside a tap, it lets iOS Safari and PWAs play this element later. */
function silentWav(): string {
  const bytes = new Uint8Array(46)
  const view = new DataView(bytes.buffer)
  const str = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))
  str(0, "RIFF")
  view.setUint32(4, 38, true)
  str(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, 8000, true)
  view.setUint32(28, 16000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  str(36, "data")
  view.setUint32(40, 2, true)
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`
}

let primed = false
/** Call from inside a click or key press. Harmless to call again; only the first one plays. */
export function primeAudio() {
  if (primed) return
  const a = audioElement()
  if (!a) return
  primed = true
  // Already playing, so already allowed to: don't cut it off.
  if (!a.paused) return
  try {
    a.src = silentWav()
    a.volume = 0
    void a.play().catch(() => {
      primed = false
    })
  } catch {
    primed = false
  }
}

// ------------------------------------------------------------------ fallback toast

const shown = new Set<string>()

/** Tell Cody once per error (per page load) that the cloud voice failed and the browser voice took over. */
export function reportFallback(provider: CloudProvider, message: string) {
  const key = `${provider}:${message}`
  if (shown.has(key)) return
  shown.add(key)
  toast.error(`${TTS_PROVIDER_LABEL[provider]} voice failed: using the browser voice`, message, {
    duration: 12_000,
    action: {
      label: "Voice settings",
      onClick: () => {
        const u = new URL(window.location.href)
        u.searchParams.set("settings", "voice")
        window.history.pushState(null, "", u)
      },
    },
  })
}

/** Tests only. */
export const resetFallbackToasts = () => shown.clear()

// ------------------------------------------------------------------ CloudSynth

export interface CloudDeps {
  provider: () => TtsProvider
  /** The browser's speech engine: used when the provider is Browser / OS, and as the fallback. */
  os: SynthLike | null
  osUtter: (text: string) => UtteranceLike
  audio: () => AudioLike | null
  fetchAudio: (text: string, signal: AbortSignal) => Promise<Blob>
  objectUrl?: { create(b: Blob): string; revoke(url: string): void }
  onFallback: (provider: CloudProvider, message: string) => void
}

/**
 * window.speechSynthesis's shape over the cloud providers, so SpeechQueue keeps its queueing,
 * hold/release, stop and watchdog rules unchanged. One line plays at a time; cancel() cuts it off.
 */
export class CloudSynth implements SynthLike {
  private seq = 0
  private ctl: AbortController | null = null
  private url: string | null = null
  private playing = false
  private readonly urls: NonNullable<CloudDeps["objectUrl"]>

  constructor(private readonly d: CloudDeps) {
    this.urls = d.objectUrl ?? { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) }
  }

  private get cloud(): CloudProvider | null {
    const p = this.d.provider()
    return p !== "browser" && this.d.audio() ? p : null
  }

  get speaking() {
    return this.playing || Boolean(this.d.os?.speaking)
  }
  get paused() {
    return Boolean(this.d.os?.paused)
  }
  /** Cloud voices read a whole line at once (better phrasing, one request); the browser needs short chunks. */
  get chunkMax(): number | undefined {
    return this.cloud ? 600 : undefined
  }
  /** The watchdog waits for the request too. */
  get latencyMs(): number {
    return this.cloud ? CLIENT_TIMEOUT_MS : 0
  }

  speak(u: UtteranceLike) {
    const provider = this.cloud
    if (!provider) return this.speakOs(u)
    const audio = this.d.audio()!
    const id = ++this.seq
    const ctl = new AbortController()
    this.ctl = ctl
    this.playing = true
    const fallback = (message: string) => {
      if (id !== this.seq) return
      this.release()
      this.d.onFallback(provider, message)
      this.speakOs(u)
    }
    this.d.fetchAudio(u.text, ctl.signal).then(
      (blob) => {
        if (id !== this.seq) return
        this.revoke()
        this.url = this.urls.create(blob)
        audio.onplaying = () => id === this.seq && u.onstart?.({})
        audio.onended = () => {
          if (id !== this.seq) return
          this.release()
          u.onend?.({})
        }
        audio.onerror = () => fallback("This browser couldn't play the audio it got back.")
        audio.src = this.url
        audio.volume = u.volume
        audio.play().catch((err: { name?: string; message?: string }) => {
          if (id !== this.seq) return
          if (err?.name === "NotAllowedError") {
            // No tap yet: the queue stops and the "Click to enable voice" chip appears, as with speechSynthesis.
            this.release()
            u.onerror?.({ error: "not-allowed" })
            return
          }
          if (err?.name === "AbortError") return
          fallback(err?.message || "This browser couldn't play the audio it got back.")
        })
      },
      (err: Error) => {
        if (ctl.signal.aborted && id !== this.seq) return
        fallback(err?.message || String(err))
      },
    )
  }

  private speakOs(u: UtteranceLike) {
    const os = this.d.os
    if (!os) {
      u.onerror?.({ error: "synthesis-unavailable" })
      return
    }
    const real = this.d.osUtter(u.text)
    if (u.voice) real.voice = u.voice
    real.lang = u.lang
    real.rate = u.rate
    real.pitch = u.pitch
    real.volume = u.volume
    real.onstart = (e) => u.onstart?.(e)
    real.onend = (e) => u.onend?.(e)
    real.onerror = (e) => u.onerror?.(e)
    os.speak(real)
  }

  private revoke() {
    if (this.url) this.urls.revoke(this.url)
    this.url = null
  }

  private release() {
    this.playing = false
    this.ctl = null
  }

  cancel() {
    this.seq++
    this.ctl?.abort()
    this.release()
    const audio = this.d.audio()
    if (audio && !audio.paused) audio.pause()
    try {
      this.d.os?.cancel()
    } catch {}
  }

  pause() {
    this.d.os?.pause()
  }
  resume() {
    this.d.os?.resume()
  }
}

// ------------------------------------------------------------------ previews (Settings › Voice)

const previewListeners = new Set<Listener>()
let previewing: string | null = null
let previewSeq = 0
const setPreviewing = (id: string | null) => {
  previewing = id
  previewListeners.forEach((l) => l())
}

/** Which preview is playing (its id), for the picker's ▶ / ■ buttons. */
export const usePreviewing = () =>
  useSyncExternalStore(
    (l) => {
      previewListeners.add(l)
      return () => previewListeners.delete(l)
    },
    () => previewing,
    () => previewing,
  )

export function stopPreview() {
  previewSeq++
  const a = audioElement()
  if (a && !a.paused) a.pause()
  setPreviewing(null)
}

/**
 * Play a voice sample through the shared element: the provider's own sample URL, or a line
 * synthesized with the given (possibly unsaved) choices. Resolves when it ends; rejects with the
 * exact error. Starting another preview, or stopPreview(), ends this one quietly.
 */
export async function playPreview(id: string, source: { url: string } | { request: TtsRequest }, volume = 1): Promise<void> {
  const a = audioElement()
  if (!a) throw new Error("This browser can't play audio.")
  primeAudio()
  stopPreview()
  const seq = ++previewSeq
  setPreviewing(id)
  let url: string | null = null
  try {
    const src = "url" in source ? source.url : (url = URL.createObjectURL(await fetchTts(source.request)))
    if (seq !== previewSeq) return
    await new Promise<void>((resolve, reject) => {
      a.onplaying = null
      a.onended = () => resolve()
      a.onerror = () => reject(new Error("This browser couldn't play that sample."))
      a.src = src
      a.volume = volume
      a.play().catch((err) => (err?.name === "AbortError" ? resolve() : reject(err)))
    })
  } finally {
    if (url) URL.revokeObjectURL(url)
    if (seq === previewSeq) setPreviewing(null)
  }
}

// ------------------------------------------------------------------ voice lists

export interface VoiceListState<T> {
  data: T | null
  error: string | null
  loading: boolean
  refresh: () => void
}

/** GET /api/tts/voices for a provider, while `enabled` (the key is set). The server caches the list. */
export function useVoiceList<T>(provider: CloudProvider, enabled: boolean): VoiceListState<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!enabled) return setState({ data: null, error: null, loading: false })
    let live = true
    setState((s) => ({ ...s, loading: true, error: null }))
    fetch(`/api/tts/voices?provider=${provider}${nonce ? "&refresh=1" : ""}`, { credentials: "same-origin" })
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error ?? `Couldn't load voices (HTTP ${r.status})`)
        return body as T
      })
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((err: Error) => live && setState({ data: null, error: err.message, loading: false }))
    return () => {
      live = false
    }
  }, [provider, enabled, nonce])
  return { ...state, refresh: () => setNonce((n) => n + 1) }
}

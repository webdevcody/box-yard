// Cloud text-to-speech in the browser: which provider the server is set to (GET /api/tts/settings,
// kept fresh by the `tts` event), and CloudSynth, a SynthLike that the existing SpeechQueue drives
// exactly like window.speechSynthesis. It fetches each line from POST /api/tts and plays it: mp3
// (ElevenLabs) through one shared <audio> element, OpenAI's streamed PCM through Web Audio as it
// arrives (pcm.ts). The server's provider and voice are the only source of truth: a line never
// switches to the browser's own voice. When the browser blocks playback (no tap yet, as on phones)
// the line waits for the tap; when it really fails, the error shows once and the line is skipped.
import { useEffect, useState, useSyncExternalStore } from "react"
import { TTS_PROVIDER_LABEL, type CloudProvider, type TtsInfo, type TtsProvider, type TtsRequest } from "../../../shared/tts"
import type { SynthLike, UtteranceLike } from "./speech"
import { isPcm, pcmToWav, pcmRate, type PcmPlayback, type PcmPlayerLike, type PcmStream } from "./pcm"
import { audioElement, unlockAudio } from "./audioUnlock"
import { toast } from "./toast"

export { audioElement } from "./audioUnlock"

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

/** Fetch the settings once (again with `force`, or after a failure). Lines wait for them (CloudSynth). */
export function loadTtsInfo(force = false): Promise<void> {
  if (!browser || typeof fetch === "undefined") return Promise.resolve()
  if (loading && !force) return loading
  const load: Promise<void> = fetch("/api/tts/settings", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data) throw new Error("no settings")
      setTtsInfo(data as TtsInfo)
    })
    // Not loaded (offline, a phone waking up): the next call tries again.
    .catch(() => {
      if (loading === load) loading = null
    })
  loading = load
  return load
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

/** activeProvider(), or null while the server's settings haven't loaded: then nobody knows yet. */
export const knownProvider = (): TtsProvider | null => (info ? activeProvider(info) : null)

// ------------------------------------------------------------------ fetching audio

export class TtsFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The request never reached the server (offline, or a phone suspending the page): worth one retry. */
    readonly network = false,
  ) {
    super(message)
  }
}

/** Covers the server's own 20 s provider timeout plus the download. */
export const CLIENT_TIMEOUT_MS = 25_000

/** AbortSignal.any, which iOS Safari only has from 17.4 (and Chrome from 116). */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals)
  const ctl = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort(s.reason)
      break
    }
    s.addEventListener("abort", () => ctl.abort(s.reason), { once: true })
  }
  return ctl.signal
}

/** The voice id the server says it used (X-TTS-Voice), for the playback log. */
const clipVoices = new WeakMap<object, string>()
export const clipVoice = (clip: Blob | PcmStream): string | undefined => clipVoices.get(clip)

/**
 * POST /api/tts → the mp3, or OpenAI's PCM still streaming (resolves at the first bytes). Errors
 * carry the server's (and so the provider's) exact message. Announcements send only the text, so
 * the voice saved in Settings › Voice on the server is the one that speaks, on every device.
 */
export async function fetchTts(req: TtsRequest, signal?: AbortSignal): Promise<Blob | PcmStream> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), CLIENT_TIMEOUT_MS)
  const both = signal ? anySignal([signal, timeout.signal]) : timeout.signal
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
    clearTimeout(timer)
    if (signal?.aborted) throw err
    if (timeout.signal.aborted) throw new TtsFetchError("Box Yard's text-to-speech didn't answer in time.", 0)
    throw new TtsFetchError("Can't reach the Box Yard server.", 0, true)
  }
  if (!res.ok) {
    clearTimeout(timer)
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new TtsFetchError(data?.error ?? `Text-to-speech failed (HTTP ${res.status})`, res.status)
  }
  const voice = res.headers.get("x-tts-voice") ?? ""
  const rate = pcmRate(res.headers.get("content-type"))
  // A stream may outlast the timeout (a long line); the server stops it if OpenAI goes quiet.
  if (rate && res.body) {
    clearTimeout(timer)
    const pcm: PcmStream = { kind: "pcm", sampleRate: rate, body: res.body }
    if (voice) clipVoices.set(pcm, voice)
    return pcm
  }
  const blob = await res.blob().finally(() => clearTimeout(timer))
  if (voice) clipVoices.set(blob, voice)
  return blob
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

/** Call from inside a click or key press (audioUnlock.ts). Harmless to call again. */
export function primeAudio() {
  unlockAudio()
}

// ------------------------------------------------------------------ failure toast and playback log

const shown = new Set<string>()
const failureListeners = new Set<Listener>()
let lastFailure: { provider: CloudProvider; message: string; at: number } | null = null

/** The latest failure, for Settings › Voice (toasts sit under the settings dialog). */
export const useLastFailure = () =>
  useSyncExternalStore(
    (l) => {
      failureListeners.add(l)
      return () => failureListeners.delete(l)
    },
    () => lastFailure,
    () => lastFailure,
  )

/** Tell Cody once per error (per page load) that the cloud voice couldn't say a line. */
export function reportFailure(provider: CloudProvider, message: string) {
  lastFailure = { provider, message, at: Date.now() }
  failureListeners.forEach((l) => l())
  const key = `${provider}:${message}`
  if (shown.has(key)) return
  shown.add(key)
  toast.error(`${TTS_PROVIDER_LABEL[provider]} voice failed`, message, {
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

/** How each line was (or wasn't) spoken. */
export interface VoiceLogEntry {
  at: number
  /** The engine: a cloud provider, or the browser's own voice (only when the server is set to Browser / OS). */
  path: TtsProvider
  outcome: "played" | "blocked" | "failed" | "retrying"
  text: string
  /** The provider's voice id the server used. */
  voice?: string
  detail?: string
}

const LOG_MAX = 20
let voiceLog: VoiceLogEntry[] = []
const logListeners = new Set<Listener>()

/** Every line's path goes to the console as `[voice] …` and to the last few in Settings › Voice. */
export function logVoice(e: Omit<VoiceLogEntry, "at">) {
  voiceLog = [...voiceLog.slice(-(LOG_MAX - 1)), { ...e, at: Date.now() }]
  logListeners.forEach((l) => l())
  const extra = [e.voice && `voice ${e.voice}`, e.detail].filter(Boolean).join(", ")
  console.info(`[voice] ${e.path} ${e.outcome}: “${e.text.slice(0, 80)}”${extra ? ` (${extra})` : ""}`)
}

export const getVoiceLog = () => voiceLog
export const useVoiceLog = () =>
  useSyncExternalStore(
    (l) => {
      logListeners.add(l)
      return () => logListeners.delete(l)
    },
    () => voiceLog,
    () => voiceLog,
  )

/** Tests only. */
export const resetFailureToasts = () => {
  shown.clear()
  lastFailure = null
  voiceLog = []
}

// ------------------------------------------------------------------ CloudSynth

export interface CloudDeps {
  /** The server's provider, or null while its settings haven't loaded (a line then waits for `ready`). */
  provider: () => TtsProvider | null
  /** Loads the server's settings. */
  ready?: () => Promise<unknown>
  /** The browser's speech engine: used only when the server is set to Browser / OS. */
  os: SynthLike | null
  osUtter: (text: string) => UtteranceLike
  audio: () => AudioLike | null
  fetchAudio: (text: string, signal: AbortSignal) => Promise<Blob | PcmStream>
  /** Plays streamed PCM as it arrives; without one, PCM is buffered into a WAV for `audio`. */
  pcm?: () => PcmPlayerLike | null
  objectUrl?: { create(b: Blob): string; revoke(url: string): void }
  /** The cloud voice couldn't say a line (the line is skipped, never read by another voice). */
  onFailure: (provider: CloudProvider, message: string) => void
  log?: (entry: Omit<VoiceLogEntry, "at">) => void
  voiceOf?: (clip: Blob | PcmStream) => string | undefined
  /** Wait before the one retry of a request that never reached the server. */
  retryMs?: number
  /** The <audio> element played: it's unlocked for good (audioUnlock.ts). */
  onPlayed?: () => void
}

type Handlers = Pick<AudioLike, "onplaying" | "onended" | "onerror">

/**
 * window.speechSynthesis's shape over the cloud providers, so SpeechQueue keeps its queueing,
 * hold/release, stop and watchdog rules unchanged. One line plays at a time; cancel() cuts it off.
 * A line the browser refused to play (no tap yet) ends with `not-allowed`, like speechSynthesis; its
 * clip is kept, so when the queue says it again inside the tap it plays at once, without a request.
 */
export class CloudSynth implements SynthLike {
  private seq = 0
  private ctl: AbortController | null = null
  private url: string | null = null
  private stream: PcmPlayback | null = null
  private playing = false
  private handlers: Handlers | null = null
  private kept: { text: string; provider: CloudProvider; blob: Blob } | null = null
  private readonly urls: NonNullable<CloudDeps["objectUrl"]>

  constructor(private readonly d: CloudDeps) {
    this.urls = d.objectUrl ?? { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) }
  }

  private get cloud(): CloudProvider | null {
    const p = this.d.provider()
    return p && p !== "browser" && this.d.audio() ? p : null
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
  /** The watchdog waits for the request (or the settings) too. */
  get latencyMs(): number {
    return this.cloud || this.d.provider() === null ? CLIENT_TIMEOUT_MS : 0
  }

  private log(entry: Omit<VoiceLogEntry, "at">) {
    this.d.log?.(entry)
  }

  speak(u: UtteranceLike) {
    const p = this.d.provider()
    if (p === null) return this.whenReady(u)
    if (p === "browser") return this.speakOs(u)
    if (!this.d.audio()) {
      this.log({ path: p, outcome: "failed", text: u.text, detail: "This browser can't play audio." })
      u.onerror?.({ error: "audio-hardware" })
      return
    }
    this.speakCloud(u, p, 0)
  }

  /** The settings aren't here yet (the page just opened): wait for them rather than guess the browser voice. */
  private whenReady(u: UtteranceLike) {
    const id = ++this.seq
    this.playing = true
    const go = () => {
      if (id !== this.seq) return
      this.playing = false
      if (this.d.provider() !== null) return this.speak(u)
      this.log({ path: "browser", outcome: "failed", text: u.text, detail: "Couldn't load the voice settings from the server." })
      u.onerror?.({ error: "synthesis-failed" })
    }
    ;(this.d.ready?.() ?? Promise.resolve()).then(go, go)
  }

  private speakCloud(u: UtteranceLike, provider: CloudProvider, attempt: number) {
    const audio = this.d.audio()!
    const id = ++this.seq
    const ctl = new AbortController()
    this.ctl = ctl
    this.playing = true
    let voice: string | undefined
    const fail = (message: string) => {
      if (id !== this.seq) return
      this.release()
      this.log({ path: provider, outcome: "failed", text: u.text, voice, detail: message })
      this.d.onFailure(provider, message)
      u.onerror?.({ error: "synthesis-failed" })
    }
    // No tap yet: the queue keeps the line and the "Tap to enable voice" chip appears, as with speechSynthesis.
    const blocked = (blob?: Blob) => {
      if (id !== this.seq) return
      this.release()
      this.kept = blob ? { text: u.text, provider, blob } : null
      this.log({ path: provider, outcome: "blocked", text: u.text, voice, detail: "waiting for a tap" })
      u.onerror?.({ error: "not-allowed" })
    }
    const started = () => {
      if (id !== this.seq) return
      this.log({ path: provider, outcome: "played", text: u.text, voice })
      u.onstart?.({})
    }
    const ended = () => {
      if (id !== this.seq) return
      this.release()
      u.onend?.({})
    }
    const playBlob = (blob: Blob) => {
      if (id !== this.seq) return
      this.revoke()
      this.url = this.urls.create(blob)
      this.attach(audio, {
        onplaying: () => {
          if (id !== this.seq) return
          this.d.onPlayed?.()
          started()
        },
        onended: ended,
        onerror: () => fail("This browser couldn't play the audio it got back."),
      })
      audio.src = this.url
      audio.volume = u.volume
      audio.play().catch((err: { name?: string; message?: string }) => {
        if (id !== this.seq) return
        if (err?.name === "NotAllowedError") return blocked(blob)
        if (err?.name === "AbortError") return
        fail(err?.message || "This browser couldn't play the audio it got back.")
      })
    }
    const playPcm = (pcm: PcmStream, player: PcmPlayerLike) => {
      this.stream = player.play(pcm, {
        volume: u.volume,
        onstart: started,
        onend: ended,
        onblocked: () => blocked(),
        onerror: (message) => fail(message),
      })
    }

    const kept = this.kept
    if (kept && kept.text === u.text && kept.provider === provider) {
      // Said again inside the tap that unlocked audio: play the clip we already have, right now.
      this.kept = null
      voice = this.d.voiceOf?.(kept.blob)
      return playBlob(kept.blob)
    }
    this.d.fetchAudio(u.text, ctl.signal).then(
      (clip) => {
        if (id !== this.seq) {
          if (isPcm(clip)) void clip.body.cancel().catch(() => {})
          return
        }
        voice = this.d.voiceOf?.(clip)
        if (!isPcm(clip)) return playBlob(clip)
        const player = this.d.pcm?.()
        if (player) return playPcm(clip, player)
        pcmToWav(clip).then(playBlob, (err: Error) => fail(err?.message || String(err)))
      },
      (err: Error & { network?: boolean }) => {
        if (id !== this.seq) return
        // A phone waking up drops requests made while it slept: try once more before saying anything.
        if (err?.network && attempt === 0) {
          this.log({ path: provider, outcome: "retrying", text: u.text, detail: err.message })
          setTimeout(() => id === this.seq && this.speakCloud(u, provider, 1), this.d.retryMs ?? 1500)
          return
        }
        fail(err?.message || String(err))
      },
    )
  }

  /** Browser / OS: the server says the browser speaks for itself. */
  private speakOs(u: UtteranceLike) {
    const os = this.d.os
    if (!os) {
      this.log({ path: "browser", outcome: "failed", text: u.text, detail: "This browser has no speech engine." })
      u.onerror?.({ error: "synthesis-unavailable" })
      return
    }
    const real = this.d.osUtter(u.text)
    if (u.voice) real.voice = u.voice
    real.lang = u.lang
    real.rate = u.rate
    real.pitch = u.pitch
    real.volume = u.volume
    real.onstart = (e) => {
      this.log({ path: "browser", outcome: "played", text: u.text, voice: u.voice?.name })
      u.onstart?.(e)
    }
    real.onend = (e) => u.onend?.(e)
    real.onerror = (e) => {
      const error = (e as { error?: string } | undefined)?.error
      if (error !== "interrupted" && error !== "canceled")
        this.log({ path: "browser", outcome: error === "not-allowed" ? "blocked" : "failed", text: u.text, detail: error })
      u.onerror?.(e)
    }
    os.speak(real)
  }

  private attach(audio: AudioLike, h: Handlers) {
    this.detach()
    this.handlers = h
    audio.onplaying = h.onplaying
    audio.onended = h.onended
    audio.onerror = h.onerror
  }

  /** Our handlers off the shared element, so a late event (or a preview's) can't touch a finished line. */
  private detach() {
    const h = this.handlers
    const audio = h && this.d.audio()
    if (audio) {
      if (audio.onplaying === h.onplaying) audio.onplaying = null
      if (audio.onended === h.onended) audio.onended = null
      if (audio.onerror === h.onerror) audio.onerror = null
    }
    this.handlers = null
  }

  private revoke() {
    if (this.url) this.urls.revoke(this.url)
    this.url = null
  }

  private release() {
    this.playing = false
    this.ctl = null
    this.stream = null
    this.detach()
  }

  cancel() {
    this.seq++
    // The queue forgot the line (stop(), a new voice): a clip kept for the tap goes with it.
    this.kept = null
    this.ctl?.abort()
    this.stream?.stop()
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
    // A preview is one short line, so streamed PCM is simply buffered into a WAV for the element.
    const clip = "url" in source ? null : await fetchTts(source.request)
    const src = "url" in source ? source.url : (url = URL.createObjectURL(isPcm(clip) ? await pcmToWav(clip) : clip!))
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

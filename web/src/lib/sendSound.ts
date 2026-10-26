// The send sound: a short, soft two-tone cue once a send is accepted (Coordinator, Captains, task
// follow-ups, new tasks, Send now), so you hear that it went without looking. The send mutations in
// lib/queries.ts play it from onSuccess, never on the key press. A failed send gets its own cue: lower
// and falling, just as quiet. It's synthesised with Web Audio on the page's one shared AudioContext
// (lib/pcm.ts), so there is nothing to download and the first send isn't late. Saved per browser,
// like Voice: a phone and a desktop may want different answers.
import { useSyncExternalStore } from "react"
import { audioContext } from "./pcm"

// ------------------------------------------------------------------ settings (localStorage)

export interface SendSoundSettings {
  enabled: boolean
  /** 0–1, scales the cue's (already quiet) level. */
  volume: number
}

export const SEND_SOUND_KEY = "boxyard:send-sound"
export const DEFAULT_SEND_SOUND: SendSoundSettings = { enabled: true, volume: 0.6 }

export function parseSendSound(raw: string | null | undefined): SendSoundSettings {
  let v: Partial<SendSoundSettings> = {}
  try {
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === "object") v = parsed
  } catch {}
  const volume = typeof v.volume === "number" && Number.isFinite(v.volume) ? Math.min(1, Math.max(0, v.volume)) : DEFAULT_SEND_SOUND.volume
  return { enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_SEND_SOUND.enabled, volume }
}

const browser = typeof window !== "undefined"
type Listener = () => void
const listeners = new Set<Listener>()
let cache: SendSoundSettings | null = null

export function getSendSound(): SendSoundSettings {
  if (!cache) {
    let raw: string | null = null
    try {
      raw = browser ? localStorage.getItem(SEND_SOUND_KEY) : null
    } catch {}
    cache = parseSendSound(raw)
  }
  return cache
}

export function setSendSound(patch: Partial<SendSoundSettings>) {
  cache = parseSendSound(JSON.stringify({ ...getSendSound(), ...patch }))
  try {
    localStorage.setItem(SEND_SOUND_KEY, JSON.stringify(cache))
  } catch {}
  listeners.forEach((l) => l())
}

const subscribe = (l: Listener) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const useSendSound = () => useSyncExternalStore(subscribe, getSendSound, getSendSound)

if (browser) {
  window.addEventListener("storage", (e) => {
    if (e.key !== SEND_SOUND_KEY) return
    cache = null
    listeners.forEach((l) => l())
  })
}

// ------------------------------------------------------------------ the cues

export type Cue = "sent" | "failed"

export interface Tone {
  /** Start, in seconds from the cue's start. */
  at: number
  /** Hz at the start, gliding to `to` (if set) over the first half. */
  freq: number
  to?: number
  /** Seconds until the tone has faded out. */
  dur: number
  /** Peak gain at volume 1. Low tones sound quieter, so they get a little more. */
  peak: number
}

/**
 * Sine tones only: no harmonics, so nothing harsh up high. "sent" rises D5 → A5 (~155 ms), "failed" falls
 * G4 → D4 (~190 ms). Peaks around -19 dBFS at the default volume, well under a voice line.
 */
export const CUES: Record<Cue, Tone[]> = {
  sent: [
    { at: 0, freq: 587, dur: 0.07, peak: 0.18 },
    { at: 0.055, freq: 880, to: 900, dur: 0.1, peak: 0.13 },
  ],
  failed: [
    { at: 0, freq: 392, dur: 0.08, peak: 0.2 },
    { at: 0.07, freq: 311, to: 294, dur: 0.12, peak: 0.2 },
  ],
}

export const cueLength = (cue: Cue) => Math.max(...CUES[cue].map((t) => t.at + t.dur))

/** A cue within this long of the last one is dropped, so a burst of sends makes one sound, not a pile. */
export const GAP_MS = 250
/** While a voice line is playing, the cue is mixed in this much quieter instead of talking over it. */
export const UNDER_VOICE = 0.4
/** A send that resolves this long after the tap that primed a suspended context is too late to sound. */
const RESUME_GRACE_MS = 800

/** The parts of AudioContext the cue uses, so tests can fake it. */
export interface ToneContext {
  readonly currentTime: number
  readonly state: string
  readonly destination: unknown
  resume(): Promise<void>
  createOscillator(): {
    type: string
    frequency: { setValueAtTime(v: number, t: number): unknown; exponentialRampToValueAtTime(v: number, t: number): unknown }
    connect(node: unknown): unknown
    start(when: number): void
    stop(when: number): void
    onended: (() => void) | null
    disconnect(): void
  }
  createGain(): {
    gain: { setValueAtTime(v: number, t: number): unknown; linearRampToValueAtTime(v: number, t: number): unknown; exponentialRampToValueAtTime(v: number, t: number): unknown }
    connect(node: unknown): unknown
    disconnect(): void
  }
}

export interface SendSoundDeps {
  context(): ToneContext | null
  settings(): SendSoundSettings
  /** A voice line is being read out. */
  speaking(): boolean
  now(): number
  /** Android's light tap; missing where unsupported (iOS, desktops). */
  vibrate?: (ms: number) => void
}

export interface PlayOptions {
  /** Play with these settings instead of the saved ones (the Settings preview uses the draft). */
  settings?: SendSoundSettings
}

export function createSendSound(d: SendSoundDeps) {
  let last = -Infinity
  let primedAt = -Infinity
  let resuming: Promise<unknown> | null = null

  const schedule = (ctx: ToneContext, cue: Cue, level: number) => {
    const t0 = ctx.currentTime + 0.01
    for (const tone of CUES[cue]) {
      const start = t0 + tone.at
      const end = start + tone.dur
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "sine"
      osc.frequency.setValueAtTime(tone.freq, start)
      if (tone.to) osc.frequency.exponentialRampToValueAtTime(tone.to, start + tone.dur / 2)
      // A 6 ms attack (no click), then an exponential fade: a soft "pop", not a beep.
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.linearRampToValueAtTime(tone.peak * level, start + 0.006)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.onended = () => {
        osc.disconnect()
        gain.disconnect()
      }
      osc.start(start)
      osc.stop(end + 0.02)
    }
  }

  return {
    /**
     * Call inside the click or key press that sends: it starts (or resumes) the shared AudioContext while
     * the browser still counts it as a user gesture, so the cue may play when the server answers.
     */
    prime() {
      if (!d.settings().enabled) return
      const ctx = d.context()
      if (!ctx || ctx.state === "running") return
      primedAt = d.now()
      resuming = ctx.resume().catch(() => {})
    },

    /** Play `cue` now. Returns whether it played (off, no Web Audio, too soon after the last one: false). */
    play(cue: Cue, o: PlayOptions = {}): boolean {
      const s = o.settings ?? d.settings()
      if (!s.enabled || s.volume <= 0) return false
      const ctx = d.context()
      if (!ctx) return false
      const now = d.now()
      if (now - last < GAP_MS) return false
      const level = s.volume * (d.speaking() ? UNDER_VOICE : 1)
      if (ctx.state === "running") {
        last = now
        schedule(ctx, cue, level)
      } else if (resuming && now - primedAt < RESUME_GRACE_MS) {
        // The tap's resume() hasn't finished yet (a very fast server). Play when it does, unless that's late.
        last = now
        const wait = resuming
        void wait.then(() => {
          if (ctx.state === "running" && d.now() - now < RESUME_GRACE_MS) schedule(ctx, cue, level)
        })
      } else {
        // Never unlocked (a send with no tap, like dictation's auto-send before any click): a suspended
        // context would play it late, whenever something resumes it. Stay quiet instead.
        return false
      }
      if (cue === "sent") d.vibrate?.(10)
      return true
    },
  }
}

// ------------------------------------------------------------------ the page's instance

let speakingProbe: () => boolean = () => false
/** lib/speech.ts tells us whether a voice line is playing, without this module importing it. */
export function setSpeakingProbe(fn: () => boolean) {
  speakingProbe = fn
}

const canVibrate = browser && typeof navigator.vibrate === "function" && Boolean(window.matchMedia?.("(pointer: coarse)").matches)

const sendSound = createSendSound({
  context: () => audioContext() as unknown as ToneContext | null,
  settings: getSendSound,
  speaking: () => speakingProbe(),
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  vibrate: canVibrate
    ? (ms) => {
        try {
          navigator.vibrate(ms)
        } catch {}
      }
    : undefined,
})

export const primeSendSound = () => sendSound.prime()
export const playSendSound = (cue: Cue = "sent", o?: PlayOptions) => sendSound.play(cue, o)

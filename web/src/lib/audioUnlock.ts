// Phones only let a page make sound after a real tap, and only from inside that tap's handler.
// Box Yard plays everything through one shared <audio> element (ElevenLabs' mp3) and one shared
// AudioContext (OpenAI's streamed PCM, pcm.ts), so unlocking those two once, inside a gesture, lets
// later lines play when they arrive. The catch: a touch's pointerdown (and touchstart) is NOT a user
// activation in the HTML spec, WebKit or Chrome; its pointerup, touchend and click are. Unlocking on
// pointerdown, as Box Yard used to, works with a mouse and silently fails on an iPhone.
import { audioContext } from "./pcm"

const browser = typeof window !== "undefined"

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
export function silentWav(): string {
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

/**
 * Does this event grant user activation, so audio may start inside its handler? The HTML spec's list:
 * keydown (not Escape), mousedown, pointerdown from a mouse, pointerup from anything else, touchend.
 * click comes after those, and Safari treats it as a gesture too.
 */
export function isActivationEvent(e: Pick<Event, "type"> & { pointerType?: string; key?: string }): boolean {
  switch (e.type) {
    case "keydown":
      return e.key !== "Escape"
    case "mousedown":
    case "touchend":
    case "click":
      return true
    case "pointerdown":
      return e.pointerType === "mouse"
    case "pointerup":
      return e.pointerType !== "mouse"
    default:
      return false
  }
}

let unlocked = false
const unlockListeners = new Set<() => void>()

/** The shared <audio> element has played inside a gesture, so it may play from now on. */
export const isAudioUnlocked = () => unlocked

/** Runs once, when the element first unlocks. Returns an unsubscribe. */
export function onAudioUnlocked(fn: () => void): () => void {
  unlockListeners.add(fn)
  return () => unlockListeners.delete(fn)
}

function markUnlocked() {
  if (unlocked) return
  unlocked = true
  unlockListeners.forEach((l) => l())
}

/** Something played on this element (a cloud line, a preview): it's allowed, whatever primed it. */
export const noteAudioPlayed = markUnlocked

/** A play() was refused after all (iOS can lock the element again): prime it again on the next tap. */
export function noteAudioBlocked() {
  unlocked = false
}

/**
 * Call from inside a gesture (see isActivationEvent). Resumes the shared AudioContext with a silent
 * buffer and plays a silent clip on the shared element. Harmless to call on every gesture: once the
 * element is unlocked it does nothing more, and it never interrupts what's playing. Returns whether
 * the element is unlocked now (play() leaves `paused` false at once when it's allowed).
 */
export function unlockAudio(): boolean {
  const ctx = audioContext()
  if (ctx && ctx.state !== "running") {
    void ctx.resume().catch(() => {})
    // Older iOS only unlocks Web Audio when a buffer starts inside the tap.
    try {
      const src = ctx.createBufferSource()
      src.buffer = ctx.createBuffer(1, 1, 22_050)
      src.connect(ctx.destination)
      src.start(0)
    } catch {}
  }
  if (unlocked) return true
  const a = audioElement()
  if (!a) return false
  // Already playing, so already allowed to: don't cut it off.
  if (!a.paused) {
    markUnlocked()
    return true
  }
  try {
    a.src = silentWav()
    a.volume = 0
    const played = a.play()
    if (!a.paused) markUnlocked()
    void played?.catch?.((err: { name?: string }) => {
      if (err?.name === "NotAllowedError") unlocked = false
    })
  } catch {}
  return unlocked
}

/**
 * Listen for gestures that may start audio (capture phase, so this runs before the page's own
 * handlers). Each tap fires several (pointerup, touchend, click): `fn` runs for each.
 */
export function onActivation(fn: (e: Event) => void): () => void {
  if (!browser) return () => {}
  const types = ["pointerdown", "pointerup", "mousedown", "touchend", "click", "keydown"] as const
  const handler = (e: Event) => {
    if (isActivationEvent(e as Event & { pointerType?: string; key?: string })) fn(e)
  }
  for (const t of types) window.addEventListener(t, handler, true)
  return () => {
    for (const t of types) window.removeEventListener(t, handler, true)
  }
}

/** Tests only. */
export const resetAudioUnlock = () => {
  unlocked = false
  sharedAudio = null
}

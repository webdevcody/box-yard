// Dictation, the live side: browser support, the settings store, one DictationMachine per composer,
// and the push-to-talk chord, which goes to the focused composer (or the one used last).
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import {
  DICTATION_STORAGE_KEY,
  DictationMachine,
  isHotkeyDown,
  isHotkeyUp,
  isMacPlatform,
  parseDictationSettings,
  type DictationSettings,
  type RecognitionLike,
} from "./dictation"
import { holdSpeech } from "./speech"

const browser = typeof window !== "undefined"
const platform = () => (browser ? ((navigator as any).userAgentData?.platform ?? navigator.platform ?? "") : "")
export const isMac = () => isMacPlatform(platform())

type Ctor = new () => RecognitionLike
const recognitionCtor = (): Ctor | null => (browser ? ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null) : null)
export const dictationSupported = () => recognitionCtor() !== null

// ------------------------------------------------------------------ settings

type Listener = () => void
const listeners = new Set<Listener>()
let cache: DictationSettings | null = null

export function getDictationSettings(): DictationSettings {
  if (!cache) {
    let raw: string | null = null
    try {
      raw = browser ? localStorage.getItem(DICTATION_STORAGE_KEY) : null
    } catch {}
    cache = parseDictationSettings(raw, platform())
  }
  return cache
}

export function setDictationSettings(patch: Partial<DictationSettings>) {
  cache = { ...getDictationSettings(), ...patch }
  try {
    localStorage.setItem(DICTATION_STORAGE_KEY, JSON.stringify(cache))
  } catch {}
  if (!cache.enabled) stopAll()
  listeners.forEach((l) => l())
}

const subscribe = (l: Listener) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const useDictationSettings = () => useSyncExternalStore(subscribe, getDictationSettings, getDictationSettings)

export const dictationLang = () => getDictationSettings().lang || (browser ? navigator.language : "") || "en-US"

// ------------------------------------------------------------------ composers and the push-to-talk chord

interface Entry {
  machine: DictationMachine
  root: () => HTMLElement | null
  focus: () => void
}
const entries: Entry[] = []
let lastUsed: Entry | null = null
let chordTarget: Entry | null = null
let listening = 0

function stopAll() {
  for (const e of entries) e.machine.stop()
}

/** The composer the chord talks into: the focused one, else the one used last, else the first on screen. */
function target(): Entry | null {
  const active = document.activeElement
  const focused = entries.find((e) => active && e.root()?.contains(active))
  if (focused) return focused
  if (lastUsed && entries.includes(lastUsed) && lastUsed.root()?.isConnected) return lastUsed
  return entries.find((e) => e.root()?.offsetParent) ?? null
}

if (browser) {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && entries.some((x) => x.machine.active)) {
        stopAll()
        return
      }
      const s = getDictationSettings()
      if (!s.enabled || !dictationSupported() || !isHotkeyDown(e, s.key)) return
      // Also keeps Option+Space from typing a non-breaking space.
      e.preventDefault()
      if (e.repeat || chordTarget) return
      const t = target()
      if (!t) return
      chordTarget = t
      lastUsed = t
      t.focus()
      t.machine.press()
    },
    true,
  )
  window.addEventListener(
    "keyup",
    (e) => {
      if (!chordTarget || !isHotkeyUp(e, getDictationSettings().key)) return
      if (e.code === "Space") e.preventDefault()
      const t = chordTarget
      chordTarget = null
      t.machine.release()
    },
    true,
  )
  // A key let go in another window never sends keyup here.
  window.addEventListener("blur", () => {
    const t = chordTarget
    chordTarget = null
    t?.machine.release()
  })
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAll()
  })
  window.addEventListener("storage", (e) => {
    if (e.key !== DICTATION_STORAGE_KEY) return
    cache = null
    listeners.forEach((l) => l())
  })
}

/**
 * A dictation machine for one composer. `insert` puts final words into the draft; `send` sends it
 * (used by "send when I release"). Stops (and drops what's pending) when the composer unmounts.
 */
export function useDictation(opts: { root: () => HTMLElement | null; focus: () => void; insert: (text: string) => void; send: () => void }) {
  const ref = useRef(opts)
  ref.current = opts
  const machine = useMemo(
    () =>
      new DictationMachine({
        create: () => {
          const C = recognitionCtor()
          return C ? new C() : null
        },
        lang: dictationLang,
        onFinal: (text) => ref.current.insert(text),
        onSend: () => ref.current.send(),
        sendOnRelease: () => getDictationSettings().sendOnRelease,
        onActive: (active) => {
          listening = Math.max(0, listening + (active ? 1 : -1))
          // Don't let Box Yard's own announcements end up in the transcript.
          holdSpeech(listening > 0)
        },
      }),
    [],
  )
  useEffect(() => {
    const entry: Entry = { machine, root: () => ref.current.root(), focus: () => ref.current.focus() }
    entries.push(entry)
    const root = entry.root()
    const onFocus = () => (lastUsed = entry)
    root?.addEventListener("focusin", onFocus)
    return () => {
      root?.removeEventListener("focusin", onFocus)
      entries.splice(entries.indexOf(entry), 1)
      if (lastUsed === entry) lastUsed = null
      if (chordTarget === entry) chordTarget = null
      machine.abort()
    }
  }, [machine])
  return machine
}

export const useDictationState = (machine: DictationMachine) => useSyncExternalStore(machine.subscribe, machine.getState, machine.getState)

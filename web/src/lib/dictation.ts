// Push-to-talk dictation for the composers, over the browser's speech recognition
// (window.SpeechRecognition / webkitSpeechRecognition). The pure parts (settings, putting a transcript
// into the draft at the cursor, the hold-vs-tap state machine) are tested; the hooks at the bottom
// wire them to the page.

// ------------------------------------------------------------------ settings (localStorage)

export const DICTATION_KEYS = ["alt+space", "ctrl+space", "ctrl+shift+space", "off"] as const
export type DictationKey = (typeof DICTATION_KEYS)[number]

export interface DictationSettings {
  enabled: boolean
  /** A BCP 47 tag; "" = the browser's language (navigator.language). */
  lang: string
  /** The push-to-talk chord, held while the app is focused. */
  key: DictationKey
  /** Send the message when a held push-to-talk is released. */
  sendOnRelease: boolean
}

export const DICTATION_STORAGE_KEY = "boxyard:dictation"

export const isMacPlatform = (platform: string) => /mac|iphone|ipad/i.test(platform)

/** Option+Space on a Mac (Ctrl+Space switches input sources there), Ctrl+Space elsewhere (Alt+Space opens the window menu on Windows). */
export const defaultDictationKey = (platform: string): DictationKey => (isMacPlatform(platform) ? "alt+space" : "ctrl+space")

export function dictationDefaults(platform = ""): DictationSettings {
  return { enabled: true, lang: "", key: defaultDictationKey(platform), sendOnRelease: false }
}

export function parseDictationSettings(raw: string | null | undefined, platform = ""): DictationSettings {
  const d = dictationDefaults(platform)
  let v: Record<string, any> = {}
  try {
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === "object") v = parsed
  } catch {}
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    lang: typeof v.lang === "string" && /^([a-z]{2,3}(-[A-Za-z0-9]{2,8})*)?$/.test(v.lang) ? v.lang : d.lang,
    key: (DICTATION_KEYS as readonly string[]).includes(v.key) ? v.key : d.key,
    sendOnRelease: typeof v.sendOnRelease === "boolean" ? v.sendOnRelease : d.sendOnRelease,
  }
}

export function keyLabel(key: DictationKey, mac: boolean): string {
  if (key === "off") return "Off"
  const alt = mac ? "Option" : "Alt"
  return key
    .split("+")
    .map((k) => (k === "alt" ? alt : k === "ctrl" ? "Ctrl" : k === "shift" ? "Shift" : "Space"))
    .join("+")
}

type KeyLike = Pick<KeyboardEvent, "code" | "key" | "altKey" | "ctrlKey" | "shiftKey" | "metaKey">

/** Is this keydown the push-to-talk chord? */
export function isHotkeyDown(e: KeyLike, key: DictationKey): boolean {
  if (key === "off" || e.code !== "Space" || e.metaKey) return false
  const want = new Set(key.split("+"))
  return e.altKey === want.has("alt") && e.ctrlKey === want.has("ctrl") && e.shiftKey === want.has("shift")
}

/** Does this keyup end a held chord (Space or one of its modifiers let go)? */
export function isHotkeyUp(e: KeyLike, key: DictationKey): boolean {
  if (key === "off") return false
  if (e.code === "Space") return true
  const want = key.split("+")
  return (e.key === "Alt" && want.includes("alt")) || (e.key === "Control" && want.includes("ctrl")) || (e.key === "Shift" && want.includes("shift"))
}

// ------------------------------------------------------------------ transcript → draft

const SENTENCE_END = /(^|[.!?]\s*|\n\s*)$/

/**
 * Put `text` into `value` at the selection (replacing any selected text), with a space on either side
 * where the neighbours need one, and a capital letter at the start of a sentence. Returns the new value
 * and where the caret goes (right after the inserted words).
 */
export function insertTranscript(value: string, selStart: number, selEnd: number, text: string): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selStart, value.length))
  const end = Math.max(start, Math.min(selEnd, value.length))
  let words = text.replace(/\s+/g, " ").trim()
  if (!words) return { value, caret: end }
  const before = value.slice(0, start)
  const after = value.slice(end)
  if (SENTENCE_END.test(before)) words = words.charAt(0).toUpperCase() + words.slice(1)
  const lead = before && !/[\s(\["'“‘/-]$/.test(before) && !/^[,.;:!?)\]]/.test(words) ? " " : ""
  const trail = after && !/^[\s,.;:!?)\]"'”’]/.test(after) ? " " : ""
  const inserted = lead + words + trail
  return { value: before + inserted + after, caret: before.length + lead.length + words.length }
}

// ------------------------------------------------------------------ recognition state machine

/** The bits of SpeechRecognition we use; tests pass a fake. */
export interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((ev: { error: string; message?: string }) => void) | null
  onend: (() => void) | null
  onstart?: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

export type DictationError = "denied" | "no-mic" | "network" | "failed"
export type DictationPhase = "idle" | "listening" | "stopping"
export type DictationMode = "pending" | "hold" | "toggle"

export interface DictationState {
  phase: DictationPhase
  /** pending: pressed, not yet known whether it's a tap (toggle) or a hold. */
  mode: DictationMode | null
  interim: string
  error: DictationError | null
}

/** A press shorter than this is a tap: it toggles listening on (and the next tap turns it off). */
export const TAP_MS = 350

export const IDLE: DictationState = { phase: "idle", mode: null, interim: "", error: null }

export function errorKind(code: string): DictationError | null {
  if (code === "not-allowed" || code === "service-not-allowed") return "denied"
  if (code === "audio-capture") return "no-mic"
  if (code === "network") return "network"
  if (code === "no-speech" || code === "aborted") return null
  return "failed"
}

/**
 * Press-and-hold to talk, release to stop; a quick tap toggles instead (also what a keyboard click does).
 * Final results go to `onFinal` as they come; interim ones only update `state.interim`. A held press
 * that ends with `sendOnRelease` calls `onSend` once the last words are in.
 */
export class DictationMachine {
  state: DictationState = IDLE
  private rec: RecognitionLike | null = null
  private downAt = 0
  /** A press that turned a toggled session off: its release does nothing. */
  private swallowUp = false
  private sendAfterEnd = false
  private wantListening = false
  private restarts = 0
  private listeners = new Set<() => void>()

  constructor(
    private deps: {
      create: () => RecognitionLike | null
      lang: () => string
      onFinal: (text: string) => void
      onSend?: () => void
      sendOnRelease?: () => boolean
      onActive?: (active: boolean) => void
      now?: () => number
    },
  ) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getState = () => this.state

  get active() {
    return this.state.phase !== "idle"
  }

  private now() {
    return (this.deps.now ?? Date.now)()
  }

  private set(patch: Partial<DictationState>) {
    const next = { ...this.state, ...patch }
    if (next.phase === this.state.phase && next.mode === this.state.mode && next.interim === this.state.interim && next.error === this.state.error) return
    const wasActive = this.state.phase !== "idle"
    this.state = next
    if (wasActive !== (next.phase !== "idle")) this.deps.onActive?.(next.phase !== "idle")
    this.listeners.forEach((l) => l())
  }

  /** Pointer down on the mic, or the push-to-talk chord pressed. */
  press() {
    if (this.state.phase === "listening" && this.state.mode === "toggle") {
      this.swallowUp = true
      this.finish(false)
      return
    }
    if (this.state.phase !== "idle") return
    this.downAt = this.now()
    this.begin("pending")
  }

  /** Pointer up, or the chord released. */
  release() {
    if (this.swallowUp) {
      this.swallowUp = false
      return
    }
    if (this.state.mode !== "pending" && this.state.mode !== "hold") return
    if (this.state.mode === "pending" && this.now() - this.downAt < TAP_MS) {
      this.set({ mode: "toggle" })
      return
    }
    this.finish(Boolean(this.deps.sendOnRelease?.()))
  }

  /** A click from the keyboard or assistive tech: on/off. */
  toggle() {
    if (this.state.phase === "idle") this.begin("toggle")
    else this.finish(false)
  }

  /** Enter while listening: stop, wait for the last words, then send. */
  stopAndSend() {
    if (this.state.phase === "listening") this.finish(true)
  }

  /** Stop listening (unmount, tab hidden, Escape). Words already heard are kept. */
  stop() {
    if (this.state.phase !== "idle") this.finish(false)
  }

  clearError() {
    this.set({ error: null })
  }

  private begin(mode: DictationMode) {
    const rec = this.deps.create()
    if (!rec) return
    this.rec = rec
    this.wantListening = true
    this.sendAfterEnd = false
    this.restarts = 0
    rec.lang = this.deps.lang()
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (ev) => {
      if (this.rec !== rec) return
      let interim = ""
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i]!
        const text = r[0].transcript
        if (r.isFinal) this.deps.onFinal(text)
        else interim += text
      }
      this.set({ interim: interim.trim() })
    }
    rec.onerror = (ev) => {
      if (this.rec !== rec) return
      const kind = errorKind(ev.error)
      if (!kind) return
      this.wantListening = false
      this.sendAfterEnd = false
      this.set({ error: kind })
    }
    rec.onend = () => {
      if (this.rec !== rec) return
      // Chrome ends a session on its own after a pause; keep going while Cody still wants to talk.
      if (this.wantListening && this.restarts < 5) {
        this.restarts++
        try {
          rec.start()
          return
        } catch {}
      }
      this.end()
    }
    // A long hold turns "pending" into "hold" without needing a timer: release() checks the time.
    this.set({ phase: "listening", mode: mode === "pending" ? "pending" : mode, interim: "", error: null })
    try {
      rec.start()
    } catch {
      this.rec = null
      this.set({ ...IDLE, error: "failed" })
    }
  }

  private finish(send: boolean) {
    const rec = this.rec
    this.wantListening = false
    this.sendAfterEnd = send
    if (!rec) return this.end()
    this.set({ phase: "stopping" })
    try {
      rec.stop() // the last words arrive as final results, then onend
    } catch {
      this.end()
    }
  }

  private end() {
    const rec = this.rec
    this.rec = null
    if (rec) rec.onresult = rec.onerror = rec.onend = null
    // Words still interim when the session ended are kept rather than lost.
    if (this.state.interim) this.deps.onFinal(this.state.interim)
    const send = this.sendAfterEnd
    this.sendAfterEnd = false
    this.set({ phase: "idle", mode: null, interim: "" })
    if (send) this.deps.onSend?.()
  }

  /** Drop everything now, without waiting for the last results (unmount). */
  abort() {
    const rec = this.rec
    this.rec = null
    this.wantListening = false
    this.sendAfterEnd = false
    if (rec) {
      rec.onresult = rec.onerror = rec.onend = null
      try {
        rec.abort()
      } catch {}
    }
    this.set({ phase: "idle", mode: null, interim: "" })
  }
}

export const LANGUAGES: [string, string][] = [
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["en-AU", "English (Australia)"],
  ["en-CA", "English (Canada)"],
  ["en-IN", "English (India)"],
  ["es-ES", "Español (España)"],
  ["es-MX", "Español (México)"],
  ["fr-FR", "Français"],
  ["de-DE", "Deutsch"],
  ["it-IT", "Italiano"],
  ["pt-BR", "Português (Brasil)"],
  ["pt-PT", "Português (Portugal)"],
  ["nl-NL", "Nederlands"],
  ["sv-SE", "Svenska"],
  ["pl-PL", "Polski"],
  ["uk-UA", "Українська"],
  ["ru-RU", "Русский"],
  ["tr-TR", "Türkçe"],
  ["hi-IN", "हिन्दी"],
  ["ja-JP", "日本語"],
  ["ko-KR", "한국어"],
  ["zh-CN", "中文 (简体)"],
  ["zh-TW", "中文 (繁體)"],
]

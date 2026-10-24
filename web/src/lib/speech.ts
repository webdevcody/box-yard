// Voice announcements, the live side: a speech queue over window.speechSynthesis (or a cloud voice,
// see lib/tts.ts), the announcer that decides what to say for orchestrator turns and task
// notifications, and the small stores the UI reads (settings, lock state). Everything here runs
// outside React, so speaking never re-renders the chat.
import { useEffect, useState, useSyncExternalStore } from "react"
import type { AppNotification, ChatMessage } from "../../../shared/types"
import {
  VOICE_KEY,
  chunkForSpeech,
  eventsLine,
  parseVoiceSettings,
  pickVoice,
  speakableEvents,
  spokenSummary,
  voiceAllowed,
  type VoiceSettings,
} from "./voice"
import { CloudSynth, activeProvider, audioElement, fetchTts, primeAudio, reportFallback, subscribeTtsInfo } from "./tts"
import { PcmPlayer, audioContext } from "./pcm"

// ------------------------------------------------------------------ speech queue

export interface UtteranceLike {
  text: string
  voice: any
  lang: string
  rate: number
  pitch: number
  volume: number
  onstart: ((ev: any) => void) | null
  onend: ((ev: any) => void) | null
  onerror: ((ev: any) => void) | null
}

export interface SynthLike {
  speak(u: UtteranceLike): void
  cancel(): void
  pause(): void
  resume(): void
  readonly speaking: boolean
  readonly paused: boolean
  /** Longest chunk to hand over at once; unset, the queue's own (short, for Chrome) limit applies. */
  readonly chunkMax?: number
  /** Time an utterance may take before it starts (a network round trip), added to the watchdog. */
  readonly latencyMs?: number
}

export interface SpeakOptions {
  voice?: any
  lang?: string
  rate: number
  pitch: number
  volume: number
}

interface Timers {
  setTimeout: (fn: () => void, ms: number) => any
  clearTimeout: (t: any) => void
  setInterval: (fn: () => void, ms: number) => any
  clearInterval: (t: any) => void
}

/** Lines waiting behind the one being spoken. More than this drops the oldest. */
export const MAX_QUEUE = 3
/** Chrome drops `onend` now and then; give up on an utterance after its expected length plus this. */
const WATCHDOG_SLACK_MS = 4000

/**
 * One line at a time, never overlapping. Lines are split into short chunks (Chrome cuts long
 * utterances off after ~15 s), and a keep-alive resumes speech that Chrome paused in a background tab.
 */
export class SpeechQueue {
  private items: { chunks: string[]; opts: SpeakOptions }[] = []
  private current: { chunks: string[]; opts: SpeakOptions } | null = null
  /** The chunk being spoken, so hold() can put it back. */
  private chunk: string | null = null
  private held = false
  private token = 0
  private watchdog: any = null
  private keepAlive: any = null

  constructor(
    private synth: SynthLike,
    private utter: (text: string) => UtteranceLike,
    private timers: Timers = globalThis,
    private hooks: { onChange?: () => void; onBlocked?: () => void; onStart?: () => void } = {},
  ) {}

  get speaking() {
    return this.current !== null
  }
  get pending() {
    return this.items.length
  }

  say(text: string, opts: SpeakOptions) {
    // Slower speech fits fewer characters into Chrome's ~15 s limit.
    const chunks = chunkForSpeech(text, this.synth.chunkMax ?? Math.max(60, Math.round(160 * Math.min(1, opts.rate))))
    if (!chunks.length) return
    this.items.push({ chunks, opts })
    while (this.items.length > MAX_QUEUE) this.items.shift()
    if (!this.current && !this.held) this.next()
    else this.hooks.onChange?.()
  }

  /**
   * Go quiet without forgetting anything (while Cody dictates, so Box Yard doesn't transcribe itself):
   * the line being spoken is cut off and goes back to the front of the queue; new lines wait.
   */
  hold() {
    if (this.held) return
    this.held = true
    const cur = this.current
    if (!cur) return
    this.items.unshift({ chunks: this.chunk ? [this.chunk, ...cur.chunks] : cur.chunks, opts: cur.opts })
    while (this.items.length > MAX_QUEUE) this.items.pop()
    this.current = null
    this.chunk = null
    this.token++
    this.clearTimers()
    try {
      this.synth.cancel()
    } catch {}
    this.hooks.onChange?.()
  }

  /** Carry on after hold(). */
  release() {
    if (!this.held) return
    this.held = false
    if (!this.current) this.next()
  }

  /** Stop at once and forget everything queued. */
  stop() {
    this.items = []
    const was = this.current
    this.current = null
    this.token++
    this.clearTimers()
    try {
      this.synth.cancel()
    } catch {}
    if (was) this.hooks.onChange?.()
  }

  private next() {
    this.current = this.held ? null : (this.items.shift() ?? null)
    if (!this.current) {
      this.clearTimers()
      this.hooks.onChange?.()
      return
    }
    this.hooks.onChange?.()
    this.speakChunk()
  }

  private speakChunk() {
    const item = this.current
    if (!item) return
    const chunk = item.chunks.shift()
    this.chunk = chunk ?? null
    if (chunk === undefined) return this.next()
    const token = ++this.token
    const u = this.utter(chunk)
    const { voice, lang, rate, pitch, volume } = item.opts
    if (voice) u.voice = voice
    u.lang = voice?.lang ?? lang ?? "en-US"
    u.rate = rate
    u.pitch = pitch
    u.volume = volume
    const done = () => {
      if (token !== this.token) return
      this.timers.clearTimeout(this.watchdog)
      this.watchdog = null
      this.speakChunk()
    }
    u.onstart = () => {
      if (token === this.token) this.hooks.onStart?.()
    }
    u.onend = done
    u.onerror = (ev: { error?: string } | undefined) => {
      if (token !== this.token) return
      // No user gesture yet: everything else would fail too.
      if (ev?.error === "not-allowed") {
        this.stop()
        this.hooks.onBlocked?.()
        return
      }
      done()
    }
    this.timers.clearTimeout(this.watchdog)
    this.watchdog = this.timers.setTimeout(() => {
      if (token !== this.token) return
      // Stuck: clear it out so the next utterance doesn't queue behind it.
      try {
        this.synth.cancel()
      } catch {}
      done()
    }, (chunk.length * 90) / Math.max(0.5, rate) + WATCHDOG_SLACK_MS + (this.synth.latencyMs ?? 0))
    this.keepAlive ??= this.timers.setInterval(() => {
      // Chrome pauses (and sometimes never resumes) speech in background tabs.
      if (this.synth.paused) this.synth.resume()
    }, 5000)
    try {
      if (this.synth.paused) this.synth.resume()
      this.synth.speak(u)
    } catch {
      done()
    }
  }

  private clearTimers() {
    this.timers.clearTimeout(this.watchdog)
    this.timers.clearInterval(this.keepAlive)
    this.watchdog = null
    this.keepAlive = null
  }
}

// ------------------------------------------------------------------ announcer: what to say, when

/** Task notifications this close together become one line ("3 tasks finished"). */
export const EVENT_BATCH_MS = 1200
/** With orchestrator summaries on, task events wait this long for an orchestrator turn to cover them. */
export const HOLD_MS = 8000
/** ...but never longer than this, however long the orchestrator is busy. */
export const MAX_HOLD_MS = 3 * 60_000
/** The same line twice within this window is said once. */
export const DEDUPE_MS = 10_000

/** Sent by the server when an orchestrator turn ends: `replyId` is its final reply, if it said anything. */
export interface ChatTurn {
  startedAt: number
  replyId: string | null
}

/**
 * Picks what to say. Orchestrator turns speak a one-line summary of their final reply. Task
 * notifications are one batched line; when orchestrator summaries are on too, they're held until the
 * orchestrator turn that reports them: if it replied, its summary covered them, and only if it stayed
 * silent ("(no update)", or no turn came) are they spoken. So the same event is never said twice.
 */
export class Announcer {
  private replies = new Map<string, string>()
  private seen = new Set<string>()
  private recent = new Map<string, number>()
  private busy = false
  private held: AppNotification[] = []
  private holdTimer: any = null
  private maxTimer: any = null
  private batch: AppNotification[] = []
  private batchTimer: any = null

  constructor(
    private deps: {
      settings: () => VoiceSettings
      speak: (line: string, key: string) => void
      now?: () => number
      setTimeout?: (fn: () => void, ms: number) => any
      clearTimeout?: (t: any) => void
    },
  ) {}

  private now = () => (this.deps.now ?? Date.now)()
  private later = (fn: () => void, ms: number) => (this.deps.setTimeout ?? setTimeout)(fn, ms)
  private cancel = (t: any) => t !== null && (this.deps.clearTimeout ?? clearTimeout)(t)

  /** Every chat message from the event stream; assistant ones are kept until their turn ends. */
  chatMessage(m: ChatMessage) {
    if (m.role !== "assistant") return
    this.replies.set(m.id, m.content)
    if (this.replies.size > 30) this.replies.delete(this.replies.keys().next().value!)
  }

  chatBusy(busy: boolean) {
    this.busy = busy
    // The orchestrator went idle with events still held: give a follow-up turn a moment, then say them.
    if (!busy && this.held.length) this.armHold()
  }

  chatTurn(turn: ChatTurn) {
    const s = this.deps.settings()
    const text = turn.replyId ? this.replies.get(turn.replyId) : undefined
    const replied = Boolean(turn.replyId) && s.orchestrator
    if (replied && text !== undefined && s.enabled) {
      const line = spokenSummary(text)
      if (line) this.say(line, `chat:${turn.replyId}`)
    }
    // Events from before this turn started were in its prompt.
    const covered = this.held.filter((n) => n.createdAt <= turn.startedAt)
    if (!covered.length) return
    this.held = this.held.filter((n) => n.createdAt > turn.startedAt)
    if (!replied) this.sayEvents(covered)
    if (!this.held.length) this.clearHold()
  }

  notification(n: AppNotification) {
    const s = this.deps.settings()
    if (!s.enabled || !s.taskEvents || this.seen.has(n.id)) return
    this.seen.add(n.id)
    if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value!)
    if (!speakableEvents([n], s).length) return
    if (s.orchestrator) {
      this.held.push(n)
      if (this.holdTimer === null) this.armHold()
      this.maxTimer ??= this.later(() => this.flushHeld(), MAX_HOLD_MS)
      return
    }
    this.batch.push(n)
    this.batchTimer ??= this.later(() => {
      this.batchTimer = null
      const items = this.batch
      this.batch = []
      this.sayEvents(items)
    }, EVENT_BATCH_MS)
  }

  private armHold() {
    this.cancel(this.holdTimer)
    this.holdTimer = this.later(() => {
      this.holdTimer = null
      // A turn is running: it (or the next one in the same run) reports these; chatTurn decides.
      if (!this.busy) this.flushHeld()
    }, HOLD_MS)
  }

  private clearHold() {
    this.cancel(this.holdTimer)
    this.cancel(this.maxTimer)
    this.holdTimer = this.maxTimer = null
  }

  private flushHeld() {
    const items = this.held
    this.held = []
    this.clearHold()
    this.sayEvents(items)
  }

  private sayEvents(items: AppNotification[]) {
    const s = this.deps.settings()
    if (!s.enabled || !s.taskEvents) return
    const list = speakableEvents(items, s)
    const line = eventsLine(list)
    if (line) this.say(line, `ntf:${list.map((n) => n.id).join(",")}`)
  }

  private say(line: string, key: string) {
    const now = this.now()
    for (const [l, at] of this.recent) if (now - at > DEDUPE_MS) this.recent.delete(l)
    const norm = line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    if (this.recent.has(norm)) return
    this.recent.set(norm, now)
    this.deps.speak(line, key)
  }
}

// ------------------------------------------------------------------ live (browser) state

const browser = typeof window !== "undefined"
/** The browser's own engine: Browser / OS voices, and the fallback for cloud ones. */
const synth = (): (SynthLike & { getVoices(): SpeechSynthesisVoice[] }) | null =>
  browser && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined" ? window.speechSynthesis : null

/** Something can speak: the browser's engine, or a cloud voice played through an <audio> element. */
export const voiceSupported = () => synth() !== null || (activeProvider() !== "browser" && audioElement() !== null)

// Settings: one cached copy, shared by every component and kept in sync across tabs.
type Listener = () => void
const settingsListeners = new Set<Listener>()
let settingsCache: VoiceSettings | null = null

export function getVoiceSettings(): VoiceSettings {
  if (!settingsCache) {
    let raw: string | null = null
    try {
      raw = browser ? localStorage.getItem(VOICE_KEY) : null
    } catch {}
    settingsCache = parseVoiceSettings(raw)
  }
  return settingsCache
}

export function setVoiceSettings(patch: Partial<VoiceSettings>) {
  settingsCache = { ...getVoiceSettings(), ...patch }
  try {
    localStorage.setItem(VOICE_KEY, JSON.stringify(settingsCache))
  } catch {}
  if (!settingsCache.enabled) queue()?.stop()
  emit(settingsListeners)
}

const emit = (set: Set<Listener>) => set.forEach((l) => l())
const subscribeSettings = (l: Listener) => {
  settingsListeners.add(l)
  return () => settingsListeners.delete(l)
}

export const useVoiceSettings = () => useSyncExternalStore(subscribeSettings, getVoiceSettings, getVoiceSettings)

// Lock state: browsers refuse speech until the page has had a click or key press.
const statusListeners = new Set<Listener>()
let activated = browser && Boolean((navigator as any).userActivation?.hasBeenActive)
let blocked = false
let status = { locked: false, speaking: false }

function refreshStatus() {
  const s = getVoiceSettings()
  const q = queueInstance
  const next = { locked: s.enabled && voiceSupported() && (!activated || blocked), speaking: Boolean(q?.speaking) }
  if (next.locked === status.locked && next.speaking === status.speaking) return
  status = next
  emit(statusListeners)
}
settingsListeners.add(refreshStatus)
// Switching to or from a cloud voice changes whether this browser can speak at all.
subscribeTtsInfo(refreshStatus)

const subscribeStatus = (l: Listener) => {
  statusListeners.add(l)
  return () => statusListeners.delete(l)
}
const getStatus = () => status
export const useVoiceStatus = () => useSyncExternalStore(subscribeStatus, getStatus, getStatus)

let queueInstance: SpeechQueue | null = null
let cloudSynth: CloudSynth | null = null
let player: PcmPlayer | null = null
const pcmPlayer = () => (audioContext() ? (player ??= new PcmPlayer(audioContext)) : null)
function queue(): SpeechQueue | null {
  if (!voiceSupported()) return null
  const sy = synth()
  // One queue for every engine: CloudSynth plays cloud lines itself and hands the rest to speechSynthesis.
  cloudSynth ??= new CloudSynth({
    provider: () => activeProvider(),
    os: sy,
    osUtter: (text) => new SpeechSynthesisUtterance(text) as unknown as UtteranceLike,
    audio: audioElement,
    fetchAudio: (text, signal) => fetchTts({ text }, signal),
    pcm: pcmPlayer,
    onFallback: reportFallback,
  })
  const utter = (text: string): UtteranceLike => ({ text, voice: null, lang: "", rate: 1, pitch: 1, volume: 1, onstart: null, onend: null, onerror: null })
  queueInstance ??= new SpeechQueue(cloudSynth, utter, globalThis, {
    onChange: refreshStatus,
    onStart: () => {
      blocked = false
      refreshStatus()
    },
    onBlocked: () => {
      blocked = true
      activated = false
      refreshStatus()
    },
  })
  return queueInstance
}

function options(s: VoiceSettings): SpeakOptions {
  const sy = synth()
  const voice = sy ? pickVoice(sy.getVoices(), s.voiceURI, navigator.language) : undefined
  return { voice, lang: voice?.lang, rate: s.rate, pitch: s.pitch, volume: s.volume }
}

/**
 * Unlock speech from inside a user gesture: speaking anything (even silence) during a click lets the
 * page speak later. Safari needs this; Chrome only needs the click itself.
 */
export function unlockVoice() {
  activated = true
  blocked = false
  primeAudio()
  const sy = synth()
  if (sy && !sy.speaking) {
    try {
      const u = new SpeechSynthesisUtterance("")
      u.volume = 0
      sy.speak(u)
    } catch {}
  }
  refreshStatus()
}

if (browser) {
  // Any click or key press unlocks speech. This runs before the "Click to enable voice" chip's own
  // handler (which unmounts once unlocked), so the chip's "Voice on." is said from here.
  const onGesture = (e: Event) => {
    // Mobile browsers and PWAs only let an <audio> element play later if it played inside a tap.
    if (getVoiceSettings().enabled && activeProvider() !== "browser") primeAudio()
    if (activated && !blocked) return
    if (!getVoiceSettings().enabled) activated = true
    else if ((e.target as Element | null)?.closest?.("[data-voice-unlock]")) speakNow("Voice on.")
    else unlockVoice()
    refreshStatus()
  }
  window.addEventListener("pointerdown", onGesture, true)
  window.addEventListener("keydown", onGesture, true)
  window.addEventListener("storage", (e) => {
    if (e.key !== VOICE_KEY) return
    settingsCache = null
    if (!getVoiceSettings().enabled) queue()?.stop()
    emit(settingsListeners)
  })
  refreshStatus()
}

/** Say something now, ignoring background-only and quiet hours (the Test button, "Voice on"). */
export function speakNow(text: string) {
  const q = queue()
  if (!q) return
  unlockVoice()
  q.stop()
  q.say(text, options(getVoiceSettings()))
}

export function stopSpeech() {
  queueInstance?.stop()
}

/** Hold announcements while dictating (true), then carry on (false). */
export function holdSpeech(held: boolean) {
  const q = queue()
  if (held) q?.hold()
  else q?.release()
}

/** The header's speaker button and shortcut: stop talking and turn voice off, or turn it back on. */
export function toggleVoice() {
  const on = getVoiceSettings().enabled
  stopSpeech()
  setVoiceSettings({ enabled: !on })
  if (!on) speakNow("Voice on.")
}

// Several Box Yard tabs get the same events: the first to claim a line speaks it. A visible tab
// claims at once, hidden ones a moment later, so the tab Cody is looking at wins.
const CLAIM_KEY = "boxyard:voice:claims"
const CLAIM_TTL_MS = 60_000

function claim(key: string): boolean {
  try {
    const now = Date.now()
    const claims: Record<string, number> = JSON.parse(localStorage.getItem(CLAIM_KEY) ?? "{}")
    for (const k of Object.keys(claims)) if (now - claims[k]! > CLAIM_TTL_MS) delete claims[k]
    if (claims[key]) return false
    claims[key] = now
    localStorage.setItem(CLAIM_KEY, JSON.stringify(claims))
    return true
  } catch {
    return true
  }
}

function speakLive(line: string, key: string) {
  if (!voiceSupported()) return
  const hidden = document.visibilityState === "hidden"
  const go = () => {
    if (!claim(key)) return
    const s = getVoiceSettings()
    if (!voiceAllowed(s, new Date(), document.visibilityState === "hidden")) return
    queue()?.say(line, options(s))
  }
  if (hidden) setTimeout(go, 300 + Math.random() * 300)
  else go()
}

const announcer = new Announcer({ settings: getVoiceSettings, speak: speakLive })

// Called by the event stream (lib/stream.ts) and notifications (lib/notifications.ts).
export const voiceChatMessage = (m: ChatMessage) => announcer.chatMessage(m)
export const voiceChatBusy = (busy: boolean) => announcer.chatBusy(busy)
export const voiceChatTurn = (turn: ChatTurn) => announcer.chatTurn(turn)
export const voiceNotification = (n: AppNotification) => announcer.notification(n)

/** The browser's voices; they load async, so this updates on `voiceschanged`. */
export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => synth()?.getVoices() ?? [])
  useEffect(() => {
    const sy = synth() as (SynthLike & EventTarget & { getVoices(): SpeechSynthesisVoice[] }) | null
    if (!sy) return
    const update = () => setVoices(sy.getVoices())
    update()
    sy.addEventListener?.("voiceschanged", update)
    // Some browsers never fire voiceschanged; poll briefly as a fallback.
    const t = setInterval(() => sy.getVoices().length && (update(), clearInterval(t)), 250)
    const stopPoll = setTimeout(() => clearInterval(t), 5000)
    return () => {
      sy.removeEventListener?.("voiceschanged", update)
      clearInterval(t)
      clearTimeout(stopPoll)
    }
  }, [])
  return voices
}

// Voice announcements, the pure parts: per-browser settings, turning a reply or a burst of task
// notifications into one short spoken line, quiet hours, and the voice picker's default. The live
// side (speech queue, unlock, wiring to the event stream) is in lib/speech.ts.
import type { AppNotification } from "../../../shared/types"

// ------------------------------------------------------------------ settings (localStorage)

/** Task event kinds Cody can switch on and off. "merged" is a done notification for a merged PR. */
export const VOICE_EVENTS = ["done", "pr_ready", "merged", "needs_input", "failed"] as const
export type VoiceEvent = (typeof VOICE_EVENTS)[number]

export const VOICE_EVENT_LABEL: Record<VoiceEvent, string> = {
  done: "Done",
  pr_ready: "PR ready",
  merged: "Merged",
  needs_input: "Needs input",
  failed: "Failed",
}

export interface VoiceSettings {
  enabled: boolean
  /** Speak a one-sentence summary of each orchestrator reply. */
  orchestrator: boolean
  /** Speak task notifications (finished, needs input, PR merged...). */
  taskEvents: boolean
  events: Record<VoiceEvent, boolean>
  /** A SpeechSynthesisVoice.voiceURI; "" = the default (see pickVoice). */
  voiceURI: string
  rate: number
  pitch: number
  volume: number
  /** Only speak while no Box Yard tab is in front. */
  backgroundOnly: boolean
  quietHours: { enabled: boolean; start: string; end: string }
}

export const VOICE_DEFAULTS: VoiceSettings = {
  enabled: false,
  orchestrator: true,
  taskEvents: true,
  events: { done: true, pr_ready: true, merged: true, needs_input: true, failed: true },
  voiceURI: "",
  rate: 1,
  pitch: 1,
  volume: 1,
  backgroundOnly: false,
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
}

export const VOICE_KEY = "boxyard:voice"

const clamp = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback)
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback)
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const time = (v: unknown, fallback: string) => (typeof v === "string" && HHMM.test(v) ? v : fallback)

/** Stored JSON → settings. Anything missing or malformed falls back to its default. */
export function parseVoiceSettings(raw: string | null | undefined): VoiceSettings {
  let v: Record<string, any> = {}
  try {
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === "object") v = parsed
  } catch {
    // Corrupt value: start over from the defaults.
  }
  const d = VOICE_DEFAULTS
  const events = Object.fromEntries(VOICE_EVENTS.map((k) => [k, bool(v.events?.[k], d.events[k])])) as VoiceSettings["events"]
  return {
    enabled: bool(v.enabled, d.enabled),
    orchestrator: bool(v.orchestrator, d.orchestrator),
    taskEvents: bool(v.taskEvents, d.taskEvents),
    events,
    voiceURI: typeof v.voiceURI === "string" ? v.voiceURI : d.voiceURI,
    rate: clamp(v.rate, 0.5, 2, d.rate),
    pitch: clamp(v.pitch, 0, 2, d.pitch),
    volume: clamp(v.volume, 0, 1, d.volume),
    backgroundOnly: bool(v.backgroundOnly, d.backgroundOnly),
    quietHours: {
      enabled: bool(v.quietHours?.enabled, d.quietHours.enabled),
      start: time(v.quietHours?.start, d.quietHours.start),
      end: time(v.quietHours?.end, d.quietHours.end),
    },
  }
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** Is `now` inside start–end (local time)? The window may wrap past midnight; start === end means never. */
export function inQuietHours(q: VoiceSettings["quietHours"], now: Date): boolean {
  if (!q.enabled) return false
  const t = now.getHours() * 60 + now.getMinutes()
  const s = minutes(q.start)
  const e = minutes(q.end)
  if (s === e) return false
  return s < e ? t >= s && t < e : t >= s || t < e
}

/** Should anything be spoken right now? */
export function voiceAllowed(s: VoiceSettings, now: Date, hidden: boolean): boolean {
  return s.enabled && !inQuietHours(s.quietHours, now) && (!s.backgroundOnly || hidden)
}

// ------------------------------------------------------------------ text → speech

/** Longest line we speak. Chrome cuts long utterances off, and announcements should be glanceable. */
export const MAX_SPOKEN = 200
export const NO_UPDATE = "(no update)"

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu

/** Markdown → plain words a speech engine reads well. Keeps link text, drops code, URLs, ids and emoji. */
export function cleanForSpeech(md: string): string {
  let t = md
  t = t.replace(/```[\s\S]*?(```|$)/g, " ") // fenced code
  t = t.replace(/<[^>\n]+>/g, " ") // html tags and <autolinks>
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
  t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1") // [text][ref]
  t = t.replace(/`[^`\n]*`/g, " ") // inline code
  t = t.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ") // bare URLs
  t = t.replace(/(?:^|\s)\/(?:tasks|projects|schedules|boxes|artifacts)\/\S*/g, " ") // app paths
  t = t.replace(/\b(?:task|prj|sch|art|ntf|box|run|chat)_[A-Za-z0-9-]{4,}\b/g, " ") // ids
  t = t.replace(/\b[0-9a-f]{7,40}\b/g, (m) => (/[a-f]/.test(m) && /\d/.test(m) ? " " : m)) // commit shas
  t = t.replace(EMOJI, " ")
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
  t = t.replace(/^\s{0,3}>\s?/gm, "") // quotes
  t = t.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "") // list markers
  t = t.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ") // table rules
  t = t.replace(/\|/g, ", ")
  t = t.replace(/(\*\*|__|~~)(.+?)\1/g, "$2") // bold, strike
  t = t.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2") // italics
  t = t.replace(/[*_~]{2,}/g, " ")
  t = t.replace(/(^|[\s(])#(\d+)\b/g, "$1number $2") // #30 → number 30
  t = t.replace(/\(\s*[,.;:]?\s*\)/g, " ") // brackets left empty by removals
  t = t.replace(/\s+([,.;:!?])/g, "$1")
  t = t.replace(/([,;:])(?:\s*[,;:])+/g, "$1")
  t = t.replace(/\s+/g, " ").trim()
  t = t.replace(/^[,;:.\s-]+/, "").replace(/[,;:\s-]+$/, "")
  return t
}

/** At most `max` characters, cut at the last word boundary that fits. */
export function capWords(text: string, max = MAX_SPOKEN): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max + 1)
  const space = cut.lastIndexOf(" ")
  return (space > max * 0.5 ? cut.slice(0, space) : text.slice(0, max)).replace(/[,;:\s-]+$/, "")
}

/** The first sentence of plain text (or all of it, if it never ends one). */
export function firstSentence(text: string): string {
  const m = text.match(/^.+?[.!?](?=\s+["'(\[]?[A-Z0-9]|$)/)
  return (m ? m[0] : text).trim()
}

/**
 * What to say for an orchestrator reply: its first paragraph's first sentence, cleaned for speech and
 * capped. The orchestrator prompt asks for a plain-language opener, so this is a summary of the reply.
 * Null when there's nothing worth saying (empty, or exactly "(no update)").
 */
export function spokenSummary(reply: string): string | null {
  const raw = reply.trim()
  if (!raw || raw === NO_UPDATE) return null
  // The first line that still has words once markdown, code and links are gone. Headings and table
  // rules are skipped, and a line break ends a sentence, so a list isn't run together
  // ("Here's the yard:" is said, not every item after it).
  for (const src of raw.replace(/```[\s\S]*?(```|$)/g, "\n").split("\n")) {
    if (/^\s{0,3}#{1,6}\s/.test(src) || /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(src)) continue
    const text = cleanForSpeech(src)
    if (!/[\p{L}\p{N}]/u.test(text)) continue
    const line = capWords(firstSentence(text))
    return line === NO_UPDATE ? null : line
  }
  return null
}

// ------------------------------------------------------------------ task notifications → one line

/** "PR #23 merged by cody" (server/prs.ts) → 23. */
export function mergedPrNumber(n: Pick<AppNotification, "status" | "summary">): number | null {
  if (n.status !== "done") return null
  const m = n.summary?.match(/^PR #(\d+) merged\b/)
  return m ? Number(m[1]) : null
}

/** The voice setting a notification falls under, or null for ones we never speak (idle turns). */
export function voiceEvent(n: Pick<AppNotification, "status" | "summary">): VoiceEvent | null {
  if (mergedPrNumber(n) !== null) return "merged"
  return n.status === "idle" ? null : n.status
}

const TRAILING_FILLER = /\s+(?:a|an|and|the|for|of|to|in|on|with|via|from|by|or)$/i

/** A task title short enough to say: cleaned, no parentheses, cut at a colon or comma, at most 6 words. */
export function shortTitle(title: string): string {
  let t = cleanForSpeech(title).replace(/\s*\([^)]*\)/g, "")
  const cut = t.search(/[,;:]\s|\s[-–—]\s/)
  if (cut >= 12) t = t.slice(0, cut)
  t = t.split(" ").filter(Boolean).slice(0, 6).join(" ")
  while (TRAILING_FILLER.test(t)) t = t.replace(TRAILING_FILLER, "")
  return t.replace(/[,;:.\s-]+$/, "") || "A task"
}

const SINGLE: Record<VoiceEvent, (title: string, n: AppNotification) => string> = {
  done: (t) => (/^task\b/i.test(t) ? `${t} finished.` : `Task ${t} finished.`),
  pr_ready: (t) => `${t} has a PR ready.`,
  merged: (_t, n) => `PR ${mergedPrNumber(n)} merged.`,
  needs_input: (t) => `${t} needs your input.`,
  failed: (t) => `${t} failed.`,
}
/** Most urgent first, for "1 task failed, 2 tasks finished." */
const ORDER: VoiceEvent[] = ["failed", "needs_input", "pr_ready", "merged", "done"]
const COUNT: Record<VoiceEvent, (k: number) => string> = {
  failed: (k) => `${k} ${k === 1 ? "task" : "tasks"} failed`,
  needs_input: (k) => `${k} ${k === 1 ? "task needs" : "tasks need"} your input`,
  pr_ready: (k) => `${k} ${k === 1 ? "PR" : "PRs"} ready`,
  merged: (k) => `${k} ${k === 1 ? "PR" : "PRs"} merged`,
  done: (k) => `${k} ${k === 1 ? "task" : "tasks"} finished`,
}

/** The notifications in a burst that settings allow: newest per task. */
export function speakableEvents(burst: readonly AppNotification[], s: VoiceSettings): AppNotification[] {
  const latest = new Map<string, AppNotification>()
  for (const n of burst) {
    const ev = voiceEvent(n)
    if (!ev || !s.events[ev] || n.readAt) continue
    const prev = latest.get(n.taskId)
    if (!prev || n.createdAt >= prev.createdAt) latest.set(n.taskId, n)
  }
  return [...latest.values()].sort((a, b) => a.createdAt - b.createdAt)
}

/** One spoken line for a burst of notifications: "Task X finished." or "3 tasks finished." */
export function eventsLine(items: readonly AppNotification[]): string | null {
  if (!items.length) return null
  if (items.length === 1) {
    const n = items[0]!
    const ev = voiceEvent(n)
    return ev ? capWords(SINGLE[ev](shortTitle(n.title), n)) : null
  }
  const counts = ORDER.map((ev) => [ev, items.filter((n) => voiceEvent(n) === ev).length] as const).filter(([, k]) => k > 0)
  const line = counts.map(([ev, k]) => COUNT[ev](k)).join(", ")
  return capWords(line.charAt(0).toUpperCase() + line.slice(1) + ".")
}

// ------------------------------------------------------------------ voices

export interface VoiceLike {
  voiceURI: string
  name: string
  lang: string
  localService: boolean
  default: boolean
}

const isEnglish = (v: VoiceLike) => /^en\b/i.test(v.lang)

/**
 * The voice to use: the chosen one if this browser has it; otherwise the system default when it's a
 * local English voice, then a local English voice (the page language's region first), then the default.
 */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], uri: string, lang = "en-US"): V | undefined {
  if (uri) {
    const chosen = voices.find((v) => v.voiceURI === uri)
    if (chosen) return chosen
  }
  const def = voices.find((v) => v.default)
  if (def && def.localService && isEnglish(def)) return def
  const local = voices.filter((v) => v.localService && isEnglish(v))
  const region = lang.toLowerCase().replace("_", "-")
  return local.find((v) => v.lang.toLowerCase().replace("_", "-") === region) ?? local[0] ?? def ?? voices.find(isEnglish) ?? voices[0]
}

/** Split a line into chunks Chrome won't cut off, at sentence or word boundaries. */
export function chunkForSpeech(text: string, max = 160): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max + 1)
    const stop = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "), window.lastIndexOf(", "))
    const space = window.lastIndexOf(" ")
    const at = stop > max * 0.4 ? stop + 1 : space > 0 ? space : max
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest)
  return out
}

// Pure helpers for the Settings › Voice provider picker: filtering and describing voices.
import type { TtsVoice } from "../../../shared/tts"

/** "British · middle aged · narration": a voice's labels, short enough for one line. */
export function voiceMeta(v: TtsVoice): string {
  const labels = v.labels ?? {}
  const parts = [labels.accent, labels.gender, labels.age, labels.use_case ?? labels["use case"], labels.descriptive]
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .map((x) => x.replace(/_/g, " "))
  if (v.category && v.category !== "premade" && v.category !== "built-in") parts.unshift(v.category === "cloned" ? "your clone" : v.category)
  return [...new Set(parts)].slice(0, 3).join(" · ")
}

/** Voices whose name, labels or description contain every word of `query`. */
export function filterVoices(voices: readonly TtsVoice[], query: string): TtsVoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...voices]
  return voices.filter((v) => {
    const hay = [v.name, v.category, v.description ?? "", ...Object.values(v.labels ?? {})].join(" ").toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}


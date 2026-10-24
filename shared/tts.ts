// Text-to-speech providers: what the server proxy and the Voice settings share. Box Yard speaks with
// the browser's own voices by default; ElevenLabs and OpenAI are opt-in and need an API key that
// stays on the server (the browser only ever sees "set" or "unset").
import type { SettingSource } from "./types.js"
import { withOwner } from "./owner.js"

export const TTS_PROVIDERS = ["browser", "elevenlabs", "openai"] as const
export type TtsProvider = (typeof TTS_PROVIDERS)[number]
export type CloudProvider = Exclude<TtsProvider, "browser">
export const CLOUD_PROVIDERS: readonly CloudProvider[] = ["elevenlabs", "openai"]

export const TTS_PROVIDER_LABEL: Record<TtsProvider, string> = { browser: "Browser / OS", elevenlabs: "ElevenLabs", openai: "OpenAI" }

/** Longest text POST /api/tts accepts. Announcements are capped at 200 characters long before this. */
export const MAX_TTS_CHARS = 1000

// ------------------------------------------------------------------ ElevenLabs

export interface TtsModelOption {
  id: string
  label: string
  note: string
}

/** From https://elevenlabs.io/docs/models (checked 2026-10-24). The first one is the default. */
export const ELEVENLABS_MODELS: TtsModelOption[] = [
  { id: "eleven_flash_v2_5", label: "Flash v2.5", note: "Fastest (~75 ms) and half the price per character. 32 languages." },
  { id: "eleven_v4_turbo", label: "v4 Turbo", note: "Real-time (~100 ms) and more expressive. 90+ languages." },
  { id: "eleven_multilingual_v2", label: "Multilingual v2", note: "Previous generation, the most stable on long text. 29 languages." },
  { id: "eleven_v4", label: "v4", note: "Highest quality and most emotive, slower. 90+ languages." },
]

/** "George", the voice in ElevenLabs' own API examples; a premade voice every account has. */
export const ELEVENLABS_DEFAULT_VOICE = { id: "JBFqnCBsd6RMkjVDRZzb", name: "George" }
export const ELEVENLABS_SPEED = { min: 0.7, max: 1.2 }

export interface ElevenLabsTts {
  voiceId: string
  /** Shown while the voice list loads; the id is what's sent. */
  voiceName: string
  model: string
  speed: number
}

// ------------------------------------------------------------------ OpenAI

/**
 * OpenAI's speech models (tts-1, tts-1-hd, gpt-4o-mini-tts on /v1/audio/speech) shut down on
 * 2027-01-06, and its named replacement, gpt-realtime-2.1-mini, only runs on the Realtime API
 * (https://developers.openai.com/api/docs/deprecations, checked 2026-10-24). So OpenAI voice goes
 * over a server-side Realtime WebSocket: text in, 24 kHz PCM out. The first one is the default.
 */
export const OPENAI_TTS_MODELS: TtsModelOption[] = [
  { id: "gpt-realtime-2.1-mini", label: "gpt-realtime-2.1-mini", note: "OpenAI's replacement for its retired speech models. Follows voice instructions. 10 voices." },
  { id: "gpt-realtime-2.1", label: "gpt-realtime-2.1", note: "The larger Realtime model: about 3× the audio price, for little gain on read-aloud." },
]

/** Realtime's PCM output: 16-bit little-endian mono, and 24 kHz is the only rate it offers. */
export const OPENAI_PCM_RATE = 24_000
export const PCM_CONTENT_TYPE = `audio/pcm;rate=${OPENAI_PCM_RATE}`

export interface OpenAiVoice {
  id: string
  name: string
}

/** The Realtime API's built-in voices (https://developers.openai.com/api/docs/guides/realtime-conversations, checked 2026-10-24). */
const OPENAI_VOICE_IDS = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]
export const OPENAI_VOICES: OpenAiVoice[] = OPENAI_VOICE_IDS.map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }))

/** OpenAI recommends marin or cedar "for best quality". */
export const OPENAI_DEFAULT_VOICE = "marin"
export const OPENAI_SPEED = { min: 0.25, max: 1.5 }
export const MAX_INSTRUCTIONS = 500

/** Voices only the retired speech models had, and the nearest Realtime voice (same register and accent). */
export const RETIRED_OPENAI_VOICES: Record<string, string> = { fable: "ballad", nova: "coral", onyx: "cedar" }
/** tts-1, tts-1-hd, gpt-4o-mini-tts and their dated snapshots. */
export const isRetiredOpenAiModel = (model: string) => /^(tts-1|gpt-4o-mini-tts)/.test(model)

export interface OpenAiTts {
  voice: string
  model: string
  /** Tone, accent, pace; "" = none. */
  instructions: string
  speed: number
}

/** Move saved or requested choices off the retired speech models: model, voice and the speed range. */
export function migrateOpenAiTts<T extends Partial<OpenAiTts>>(o: T): T {
  const out = { ...o }
  if (typeof out.model === "string" && isRetiredOpenAiModel(out.model)) out.model = OPENAI_TTS_MODELS[0]!.id
  if (typeof out.voice === "string" && RETIRED_OPENAI_VOICES[out.voice]) out.voice = RETIRED_OPENAI_VOICES[out.voice]
  if (typeof out.speed === "number" && Number.isFinite(out.speed)) out.speed = Math.min(OPENAI_SPEED.max, Math.max(OPENAI_SPEED.min, out.speed))
  return out
}

// ------------------------------------------------------------------ settings

export interface TtsSettings {
  provider: TtsProvider
  elevenlabs: ElevenLabsTts
  openai: OpenAiTts
}

export const TTS_DEFAULTS: TtsSettings = {
  provider: "browser",
  elevenlabs: { voiceId: ELEVENLABS_DEFAULT_VOICE.id, voiceName: ELEVENLABS_DEFAULT_VOICE.name, model: ELEVENLABS_MODELS[0]!.id, speed: 1 },
  openai: { voice: OPENAI_DEFAULT_VOICE, model: OPENAI_TTS_MODELS[0]!.id, instructions: "", speed: 1 },
}

export interface KeyStatus {
  state: "set" | "unset"
  source: SettingSource
}

/** GET /api/tts/settings. Never contains a key, only whether one is set and where it comes from. */
export interface TtsInfo {
  settings: TtsSettings
  sources: Record<keyof TtsSettings, SettingSource>
  keys: Record<CloudProvider, KeyStatus>
  defaults: TtsSettings
}

/** Env vars for each key, shown next to "from env". */
export const TTS_KEY_ENV: Record<CloudProvider, string> = { elevenlabs: "ELEVENLABS_API_KEY", openai: "OPENAI_API_KEY" }

export interface TtsVoice {
  id: string
  name: string
  /** ElevenLabs: premade | cloned | generated | professional...; OpenAI: "built-in". */
  category: string
  description?: string
  /** A sample hosted by the provider; without one, the picker synthesizes previewLine(). */
  previewUrl?: string | null
  labels?: Record<string, string>
}

export interface TtsVoiceList {
  provider: CloudProvider
  voices: TtsVoice[]
  /** When the server fetched this list (it caches it). */
  fetchedAt: number
}

/** What a voice preview says when the provider has no sample of its own. */
export function previewLine(voiceName: string, owner: string | undefined): string {
  return withOwner(`Hi Cody, this is ${voiceName}.`, owner)
}

/** The provider and voice a POST /api/tts body may override (the Test and ▶ preview buttons try unsaved choices). */
export interface TtsRequest {
  text: string
  provider?: CloudProvider
  voice?: string
  model?: string
  speed?: number
  instructions?: string
}

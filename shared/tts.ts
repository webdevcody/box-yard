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

/** From https://developers.openai.com/api/docs/guides/text-to-speech (checked 2026-10-24). The first one is the default. */
export const OPENAI_TTS_MODELS: TtsModelOption[] = [
  { id: "gpt-4o-mini-tts", label: "gpt-4o-mini-tts", note: "Follows voice instructions (tone, accent, pace). All 13 voices." },
  { id: "tts-1", label: "tts-1", note: "Lowest latency, lower quality. 9 voices, no instructions." },
  { id: "tts-1-hd", label: "tts-1-hd", note: "Higher quality, slower. 9 voices, no instructions." },
]

export interface OpenAiVoice {
  id: string
  name: string
  /** tts-1 and tts-1-hd support only some voices. */
  allModels: boolean
}

const OPENAI_VOICE_IDS = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"]
const TTS1_VOICES = new Set(["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"])
export const OPENAI_VOICES: OpenAiVoice[] = OPENAI_VOICE_IDS.map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), allModels: TTS1_VOICES.has(id) }))

/** OpenAI recommends marin or cedar "for best quality"; coral is the fallback on tts-1. */
export const OPENAI_DEFAULT_VOICE = "marin"
export const OPENAI_SPEED = { min: 0.25, max: 4 }
export const MAX_INSTRUCTIONS = 500

export const openAiSupportsInstructions = (model: string) => !/^tts-1/.test(model)
export const openAiVoiceWorks = (voice: string, model: string) => !/^tts-1/.test(model) || TTS1_VOICES.has(voice)

export interface OpenAiTts {
  voice: string
  model: string
  /** Only gpt-4o-mini-tts reads these; "" = none. */
  instructions: string
  speed: number
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
  /** OpenAI voices tts-1 can't use. */
  allModels?: boolean
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

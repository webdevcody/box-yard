// Settings › Voice → text-to-speech provider: Browser / OS, ElevenLabs or OpenAI, each provider's
// key (kept on the server, shown masked), voice picker with ▶ previews, model and speed. These are
// server settings shared by every browser. Like everything in Settings they're a draft until the
// dialog's Save (useTtsDraft); previews and Test voice use the draft.
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { Check as CheckIcon, KeyRound, Play, RefreshCw, Search, Square, Undo2, X } from "lucide-react"
import { useOwnerName, useSaveTts, useTtsSettings } from "../lib/queries"
import { playPreview, stopPreview, usePreviewing, useVoiceList } from "../lib/tts"
import { filterVoices, voiceMeta } from "../lib/ttsVoices"
import { stopSpeech } from "../lib/speech"
import { draftChanges, useDraft } from "../lib/settingsDraft"
import {
  CLOUD_PROVIDERS,
  ELEVENLABS_MODELS,
  ELEVENLABS_SPEED,
  MAX_INSTRUCTIONS,
  OPENAI_SPEED,
  OPENAI_TTS_MODELS,
  OPENAI_VOICES,
  TTS_DEFAULTS,
  TTS_KEY_ENV,
  TTS_PROVIDERS,
  TTS_PROVIDER_LABEL,
  previewLine,
  type CloudProvider,
  type TtsInfo,
  type TtsRequest,
  type TtsSettings,
  type TtsVoice,
  type TtsVoiceList,
} from "../../../shared/tts"
import { Row, SourceHint } from "./SettingsDialog"
import { Slider } from "./VoiceSettings"
import { Button, NewTabLink, Select, cx, inputClass } from "./ui"

const KEY_PAGE: Record<CloudProvider, string> = {
  elevenlabs: "https://elevenlabs.io/app/settings/api-keys",
  openai: "https://platform.openai.com/api-keys",
}
const PROVIDER_NOTE: Record<(typeof TTS_PROVIDERS)[number], string> = {
  browser: "Free, works offline",
  elevenlabs: "Most natural, ~$0.04 per 1k characters",
  openai: "Natural, follows instructions",
}
export const KEY_TEST_LINE = "This is Box Yard. PR number 30 merged."

// ------------------------------------------------------------------ draft

/** A key typed in (string) or to forget (null), per provider, until Save. */
export type KeyEdits = Partial<Record<CloudProvider, string | null>>
export interface TtsEdit {
  settings: TtsSettings
  keys: KeyEdits
}
const NO_EDIT_KEYS: KeyEdits = {}

/** What Save sends: only the fields that changed, plus any key edits. */
export function ttsPatch(draft: TtsEdit, saved: TtsSettings): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (draft.settings.provider !== saved.provider) patch.provider = draft.settings.provider
  for (const p of CLOUD_PROVIDERS) {
    const next = draft.settings[p] as unknown as Record<string, unknown>
    const was = saved[p] as unknown as Record<string, unknown>
    const diff = Object.fromEntries(Object.entries(next).filter(([k, v]) => draftChanges(v, was[k]) > 0))
    if (Object.keys(diff).length) patch[p] = diff
  }
  for (const [p, v] of Object.entries(draft.keys)) if (v === null || v?.trim()) patch[`${p}ApiKey`] = v === null ? null : v.trim()
  return patch
}

const editCount = (draft: TtsEdit, saved: TtsEdit) => {
  const patch = ttsPatch(draft, saved.settings)
  return Object.values(patch).reduce<number>((n, v) => n + (v && typeof v === "object" ? Object.keys(v).length : 1), 0)
}

export interface TtsDraft {
  info: TtsInfo | undefined
  error: boolean
  /** The draft settings (the saved ones until something changes). */
  settings: TtsSettings
  keys: KeyEdits
  set: (patch: (s: TtsSettings) => TtsSettings) => void
  setKey: (provider: CloudProvider, value: string | null | undefined) => void
}

/** The voice provider settings and keys as a Settings draft: one PUT on the dialog's Save. */
export function useTtsDraft(): TtsDraft {
  const q = useTtsSettings()
  const save = useSaveTts()
  const info = q.data
  const saved = useSavedEdit(info)
  const [edit, setEdit] = useDraft<TtsEdit>("tts", "voice", saved, (d) => (info ? save.mutateAsync(ttsPatch(d, info.settings)) : undefined), editCount)
  return {
    info,
    error: q.isError,
    settings: edit.settings,
    keys: edit.keys,
    set: (patch) => setEdit((e) => ({ ...e, settings: patch(e.settings) })),
    setKey: (provider, value) =>
      setEdit((e) => {
        const keys = { ...e.keys }
        if (value === undefined) delete keys[provider]
        else keys[provider] = value
        return { ...e, keys }
      }),
  }
}

function useSavedEdit(info: TtsInfo | undefined): TtsEdit {
  const [memo, setMemo] = useState<{ info: TtsInfo | undefined; edit: TtsEdit }>(() => ({ info, edit: { settings: info?.settings ?? TTS_DEFAULTS, keys: NO_EDIT_KEYS } }))
  if (memo.info !== info) {
    const next = { info, edit: { settings: info?.settings ?? TTS_DEFAULTS, keys: NO_EDIT_KEYS } }
    setMemo(next)
    return next.edit
  }
  return memo.edit
}

/** The line Test voice and the voice previews synthesize with the draft's provider, voice, model and speed. */
export function draftRequest(s: TtsSettings, text: string, voice?: string): TtsRequest | null {
  if (s.provider === "elevenlabs") return { text, provider: "elevenlabs", voice: voice ?? s.elevenlabs.voiceId, model: s.elevenlabs.model, speed: s.elevenlabs.speed }
  if (s.provider === "openai") return { text, provider: "openai", voice: voice ?? s.openai.voice, model: s.openai.model, speed: s.openai.speed, instructions: s.openai.instructions }
  return null
}

/** The provider choice plus, for a cloud provider, its key, voice, model and speed. */
export function TtsSection({ fid, draft, volume }: { fid: (k: string) => string; draft: TtsDraft; volume: number }) {
  const { info, settings } = draft
  if (!info) {
    return (
      <Row label="Text-to-speech provider" help="Which engine reads announcements out loud.">
        <p className="text-sm text-zinc-500">{draft.error ? "Couldn't load the voice settings." : "Loading…"}</p>
      </Row>
    )
  }
  const provider = settings.provider
  return (
    <>
      <Row
        label="Text-to-speech provider"
        help={
          <>
            The browser's voices are free and work offline. ElevenLabs and OpenAI sound more natural; their keys stay on the Box Yard server. If one fails,
            the browser voice takes over and you'll see why once. Shared by every browser using this Box Yard.
          </>
        }
        hint={<SourceHint source={info.sources.provider} env="TTS_PROVIDER" changed={provider !== info.settings.provider} />}
      >
        <div role="radiogroup" aria-label="Text-to-speech provider" className="grid gap-1.5">
          {TTS_PROVIDERS.map((p) => {
            const on = p === provider
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={on}
                data-provider={p}
                onClick={() => draft.set((s) => ({ ...s, provider: p }))}
                className={cx(
                  "flex min-h-11 items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition sm:min-h-0",
                  on ? "border-yard-500/60 bg-yard-500/10" : "border-zinc-800 bg-zinc-900 hover:border-zinc-700",
                )}
              >
                <span className={cx("grid h-4 w-4 shrink-0 place-items-center rounded-full border", on ? "border-yard-400" : "border-zinc-600")}>
                  {on && <span className="h-2 w-2 rounded-full bg-yard-400" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm text-zinc-100">{TTS_PROVIDER_LABEL[p]}</span>
                  <span className="block truncate text-[11px] text-zinc-500">
                    {p !== "browser" && keyState(info, draft.keys, p) === "unset" ? "Needs an API key" : PROVIDER_NOTE[p]}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </Row>
      {provider === "elevenlabs" && <ElevenLabsSettings info={info} draft={draft} fid={fid} volume={volume} />}
      {provider === "openai" && <OpenAiSettings info={info} draft={draft} fid={fid} volume={volume} />}
    </>
  )
}

/** Whether a provider has a key once the draft is saved: a typed one counts, a removed one doesn't. */
function keyState(info: TtsInfo, keys: KeyEdits, p: CloudProvider): "set" | "unset" {
  const edit = keys[p]
  if (edit?.trim()) return "set"
  return edit === null ? "unset" : info.keys[p].state
}

// ------------------------------------------------------------------ key

/**
 * A set key shows only as dots (the browser never gets it), with Replace / Remove and a Test button. A typed key or a
 * Remove waits for Save like every other setting.
 */
function KeyRow({ provider, info, draft, fid, volume }: { provider: CloudProvider; info: TtsInfo; draft: TtsDraft; fid: (k: string) => string; volume: number }) {
  const status = info.keys[provider]
  const edit = draft.keys[provider]
  const [editing, setEditing] = useState(false)
  const [test, setTest] = useState<{ state: "running" | "ok" | "error"; text: string } | null>(null)
  const label = TTS_PROVIDER_LABEL[provider]
  const id = fid(`key-${provider}`)
  const removing = edit === null
  const showInput = !removing && (editing || typeof edit === "string" || status.state === "unset")

  // Saved (or changed elsewhere): back to the masked key.
  useEffect(() => setEditing(false), [status])

  const cancel = () => {
    setEditing(false)
    draft.setKey(provider, undefined)
  }
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape" && (editing || edit !== undefined)) {
      e.stopPropagation()
      cancel()
    }
  }
  const runTest = async () => {
    const started = performance.now()
    setTest({ state: "running", text: "Synthesizing a sample…" })
    stopSpeech()
    try {
      await playPreview(`test:${provider}`, { request: { text: KEY_TEST_LINE, provider } }, volume)
      setTest({ state: "ok", text: `Works: ${label} answered and played a sample (${((performance.now() - started) / 1000).toFixed(1)} s).` })
    } catch (err) {
      setTest({ state: "error", text: (err as Error).message })
    }
  }

  return (
    <Row
      id={id}
      label={`${label} API key`}
      help={
        <>
          Kept on the Box Yard server and never sent to the browser. Get one from <NewTabLink href={KEY_PAGE[provider]} className="text-yard-300 hover:underline">your {label} account</NewTabLink>
          , or set <code className="font-mono">{TTS_KEY_ENV[provider]}</code> on the server.
        </>
      }
      hint={
        removing || edit?.trim() ? (
          <SourceHint changed />
        ) : status.state === "set" ? (
          <SourceHint source={status.source} env={TTS_KEY_ENV[provider]} changed={false} />
        ) : undefined
      }
    >
      {showInput ? (
        <div className="space-y-2">
          <input
            id={id}
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
            placeholder={provider === "openai" ? "sk-…" : "sk_…"}
            value={edit ?? ""}
            onChange={(e) => draft.setKey(provider, e.target.value || undefined)}
            onKeyDown={onKey}
            aria-label={`${label} API key`}
          />
          {status.state === "set" && (
            <Button type="button" variant="ghost" size="sm" onClick={cancel}>
              Keep the saved key
            </Button>
          )}
        </div>
      ) : removing ? (
        <div className="space-y-2">
          <p className="text-xs text-amber-300" data-key-removing>
            Removed when you save.
          </p>
          <Button type="button" size="sm" variant="ghost" onClick={cancel}>
            <Undo2 className="h-3.5 w-3.5" /> Keep it
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-300" data-key-masked>
            <KeyRound className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <span className="font-mono tracking-widest text-zinc-400" aria-label="Key set (hidden)">
              ••••••••••••
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => setEditing(true)}>
              Replace
            </Button>
            {status.source === "ui" && (
              <Button
                type="button"
                size="sm"
                variant="danger"
                onClick={() => (draft.setKey(provider, null), setTest(null))}
                title={`Forget this key when you save${TTS_KEY_ENV[provider] ? `; ${TTS_KEY_ENV[provider]} applies again if set` : ""}`}
              >
                Remove
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" loading={test?.state === "running"} onClick={() => void runTest()}>
              <Play className="h-3.5 w-3.5" /> Test
            </Button>
          </div>
        </div>
      )}
      {test && test.state !== "running" && (
        <p
          role="status"
          className={cx("flex items-start gap-1.5 text-xs leading-relaxed wrap-anywhere", test.state === "ok" ? "text-emerald-400" : "text-red-300")}
          data-key-test={test.state}
        >
          {test.state === "ok" ? <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          {test.text}
        </p>
      )}
    </Row>
  )
}

// ------------------------------------------------------------------ voice picker

function VoicePicker({
  provider,
  voices,
  selected,
  onPick,
  preview,
  loading,
  error,
  onRefresh,
  disabled,
}: {
  provider: CloudProvider
  voices: TtsVoice[]
  selected: string
  onPick: (v: TtsVoice) => void
  preview: (v: TtsVoice) => Promise<void>
  loading?: boolean
  error?: string | null
  onRefresh?: () => void
  disabled?: boolean
}) {
  const [query, setQuery] = useState("")
  const [previewError, setPreviewError] = useState<string | null>(null)
  const playing = usePreviewing()
  const shown = filterVoices(voices, query)
  useEffect(() => () => stopPreview(), [])

  const toggle = async (v: TtsVoice) => {
    setPreviewError(null)
    if (playing === v.id) return stopPreview()
    stopSpeech()
    try {
      await preview(v)
    } catch (err) {
      setPreviewError(`${v.name}: ${(err as Error).message}`)
    }
  }

  return (
    <div className={cx("space-y-2", disabled && "pointer-events-none opacity-50")} data-voice-picker={provider}>
      {(voices.length > 8 || onRefresh) && (
        <div className="flex items-center gap-2">
          {voices.length > 8 && (
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <input
                type="search"
                className={cx(inputClass, "pl-8")}
                placeholder={`Search ${voices.length} voices`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
                aria-label="Search voices"
              />
            </div>
          )}
          {onRefresh && (
            <Button type="button" size="sm" variant="ghost" onClick={onRefresh} title="Fetch the voice list again" aria-label="Refresh voices" loading={loading}>
              {!loading && <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          )}
        </div>
      )}
      {error ? (
        <p className="text-xs text-red-300 wrap-anywhere" role="alert">
          {error}
        </p>
      ) : loading && !voices.length ? (
        <p className="text-sm text-zinc-500">Loading voices…</p>
      ) : (
        <ul role="radiogroup" aria-label="Voice" className="scroll-thin max-h-72 divide-y divide-zinc-900 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/40">
          {shown.map((v) => {
            const on = v.id === selected
            const meta = voiceMeta(v)
            return (
              <li key={v.id} className={cx("flex items-center gap-1", on && "bg-yard-500/10")}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => onPick(v)}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left sm:min-h-0"
                >
                  <span className={cx("grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border", on ? "border-yard-400" : "border-zinc-600")}>
                    {on && <span className="h-1.5 w-1.5 rounded-full bg-yard-400" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-zinc-100">{v.name}</span>
                    {meta && <span className="block truncate text-[11px] text-zinc-500">{meta}</span>}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void toggle(v)}
                  aria-label={playing === v.id ? `Stop the ${v.name} preview` : `Preview ${v.name}`}
                  title={playing === v.id ? "Stop" : v.previewUrl ? "Play the provider's sample" : "Hear this voice"}
                  className="mr-1 grid h-11 w-11 shrink-0 place-items-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 sm:h-7 sm:w-7"
                >
                  {playing === v.id ? <Square className="h-3.5 w-3.5 fill-current text-yard-300" /> : <Play className="h-3.5 w-3.5" />}
                </button>
              </li>
            )
          })}
          {!shown.length && <li className="px-3 py-2 text-sm text-zinc-500">No voices match “{query}”.</li>}
        </ul>
      )}
      {previewError && (
        <p className="text-xs text-red-300 wrap-anywhere" role="alert">
          {previewError}
        </p>
      )}
    </div>
  )
}

function ModelRow({ id, models, value, onChange }: { id: string; models: typeof ELEVENLABS_MODELS; value: string; onChange: (v: string) => void }) {
  const known = models.find((m) => m.id === value)
  return (
    <Row id={id} label="Model" help={known?.note ?? "A model set outside this list."}>
      <Select id={id} className="w-full" value={value} onChange={(e) => onChange(e.target.value)}>
        {!known && <option value={value}>{value}</option>}
        {models.map((m, i) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {i === 0 ? " (default)" : ""}
          </option>
        ))}
      </Select>
    </Row>
  )
}

// ------------------------------------------------------------------ providers

function ElevenLabsSettings({ info, draft, fid, volume }: { info: TtsInfo; draft: TtsDraft; fid: (k: string) => string; volume: number }) {
  const s = draft.settings.elevenlabs
  const set = (patch: Partial<TtsSettings["elevenlabs"]>) => draft.set((t) => ({ ...t, elevenlabs: { ...t.elevenlabs, ...patch } }))
  // The voice list needs the saved key; a typed one works after Save.
  const keySet = info.keys.elevenlabs.state === "set" && draft.keys.elevenlabs !== null
  const list = useVoiceList<TtsVoiceList>("elevenlabs", keySet)
  const owner = useOwnerName()
  const voices = list.data?.voices ?? []
  return (
    <>
      <KeyRow provider="elevenlabs" info={info} draft={draft} fid={fid} volume={volume} />
      <Row
        label="Voice"
        help={
          <>
            ElevenLabs' premade voices plus your own (clones, designed voices), listed by the server and cached for 10 minutes. ▶ plays ElevenLabs' own sample,
            or says “{previewLine("George", owner)}” in that voice.
          </>
        }
      >
        {keySet ? (
          <VoicePicker
            provider="elevenlabs"
            voices={voices}
            selected={s.voiceId}
            loading={list.loading}
            error={list.error}
            onRefresh={list.refresh}
            onPick={(v) => set({ voiceId: v.id, voiceName: v.name })}
            preview={(v) => playPreview(v.id, v.previewUrl ? { url: v.previewUrl } : { request: draftRequest(draft.settings, previewLine(v.name, owner), v.id)! }, volume)}
          />
        ) : (
          <p className="text-sm text-zinc-500">Save a key to choose a voice. Using {s.voiceName || s.voiceId}.</p>
        )}
      </Row>
      <ModelRow id={fid("el-model")} models={ELEVENLABS_MODELS} value={s.model} onChange={(model) => set({ model })} />
      <Row id={fid("el-speed")} label="Speed" help="ElevenLabs' own speed control (0.7× to 1.2×), applied when the audio is made.">
        <Slider id={fid("el-speed")} label="Speed" value={s.speed} min={ELEVENLABS_SPEED.min} max={ELEVENLABS_SPEED.max} step={0.05} onChange={(speed) => set({ speed })} format={(v) => `${v.toFixed(2)}×`} />
      </Row>
    </>
  )
}

function OpenAiSettings({ info, draft, fid, volume }: { info: TtsInfo; draft: TtsDraft; fid: (k: string) => string; volume: number }) {
  const s = draft.settings.openai
  const set = (patch: Partial<TtsSettings["openai"]>) => draft.set((t) => ({ ...t, openai: { ...t.openai, ...patch } }))
  const owner = useOwnerName()
  const keySet = info.keys.openai.state === "set" && draft.keys.openai !== null
  const voices: TtsVoice[] = OPENAI_VOICES.map((v) => ({ id: v.id, name: v.name, category: "built-in" }))
  return (
    <>
      <KeyRow provider="openai" info={info} draft={draft} fid={fid} volume={volume} />
      <Row label="Voice" help={<>OpenAI's built-in voices; it recommends Marin or Cedar for the best quality. ▶ says “{previewLine("Marin", owner)}” in that voice.</>}>
        <VoicePicker
          provider="openai"
          voices={voices}
          selected={s.voice}
          disabled={!keySet}
          onPick={(v) => set({ voice: v.id })}
          preview={(v) => playPreview(v.id, { request: draftRequest(draft.settings, previewLine(v.name, owner), v.id)! }, volume)}
        />
      </Row>
      <ModelRow id={fid("oa-model")} models={OPENAI_TTS_MODELS} value={s.model} onChange={(model) => set({ model })} />
      <Row
        id={fid("oa-instr")}
        label="Voice instructions"
        help="Optional: tone, accent, pace or emotion, e.g. “Calm and brisk, like a radio traffic update.”"
      >
        <textarea
          id={fid("oa-instr")}
          className={cx(inputClass, "min-h-20 resize-y")}
          maxLength={MAX_INSTRUCTIONS}
          placeholder="Calm and brisk."
          value={s.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
        />
      </Row>
      <Row id={fid("oa-speed")} label="Speed" help="OpenAI's speed setting (0.25× to 1.5×), applied when the audio is made.">
        <Slider id={fid("oa-speed")} label="Speed" value={s.speed} min={OPENAI_SPEED.min} max={OPENAI_SPEED.max} step={0.05} onChange={(speed) => set({ speed })} format={(v) => `${v.toFixed(2)}×`} />
      </Row>
    </>
  )
}

// Settings › Voice → text-to-speech provider: Browser / OS, ElevenLabs or OpenAI, each provider's
// key (kept on the server, shown masked), voice picker with ▶ previews, model and speed. These are
// server settings shared by every browser, and they save as soon as they change, like the rest of
// the Voice panel.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { Check as CheckIcon, KeyRound, Play, RefreshCw, Search, Square, X } from "lucide-react"
import { useOwnerName, useSaveTts, useTtsSettings } from "../lib/queries"
import { playPreview, stopPreview, usePreviewing, useVoiceList } from "../lib/tts"
import { filterVoices, voiceMeta } from "../lib/ttsVoices"
import { stopSpeech, useVoiceSettings } from "../lib/speech"
import {
  ELEVENLABS_MODELS,
  ELEVENLABS_SPEED,
  MAX_INSTRUCTIONS,
  OPENAI_SPEED,
  OPENAI_TTS_MODELS,
  OPENAI_VOICES,
  TTS_KEY_ENV,
  TTS_PROVIDERS,
  TTS_PROVIDER_LABEL,
  previewLine,
  type CloudProvider,
  type TtsInfo,
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

/** Save a value a moment after the last change (sliders, text), not on every tick. */
function useDebounced<T>(value: T, commit: (v: T) => void, ms = 500) {
  const [local, setLocal] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(commit)
  latest.current = commit
  useEffect(() => setLocal(value), [value])
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  const set = (v: T) => {
    setLocal(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => latest.current(v), ms)
  }
  return [local, set] as const
}

/** The provider choice plus, for a cloud provider, its key, voice, model and speed. */
export function TtsSection({ fid }: { fid: (k: string) => string }) {
  const q = useTtsSettings()
  const save = useSaveTts()
  const info = q.data
  if (!info) {
    return (
      <Row label="Text-to-speech provider" help="Which engine reads announcements out loud.">
        <p className="text-sm text-zinc-500">{q.isError ? "Couldn't load the voice settings." : "Loading…"}</p>
      </Row>
    )
  }
  const provider = info.settings.provider
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
        hint={<SourceHint source={info.sources.provider} env="TTS_PROVIDER" changed={false} />}
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
                onClick={() => !on && save.mutate({ provider: p })}
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
                    {p !== "browser" && info.keys[p].state === "unset" ? "Needs an API key" : PROVIDER_NOTE[p]}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </Row>
      {provider === "elevenlabs" && <ElevenLabsSettings info={info} fid={fid} save={(patch) => save.mutate(patch)} />}
      {provider === "openai" && <OpenAiSettings info={info} fid={fid} save={(patch) => save.mutate(patch)} />}
    </>
  )
}

type Save = (patch: Record<string, unknown>) => void

// ------------------------------------------------------------------ key

/** A set key shows only as dots (the browser never gets it), with Replace / Remove and a Test button. */
function KeyRow({ provider, info, fid }: { provider: CloudProvider; info: TtsInfo; fid: (k: string) => string }) {
  const save = useSaveTts()
  const status = info.keys[provider]
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState("")
  const [test, setTest] = useState<{ state: "running" | "ok" | "error"; text: string } | null>(null)
  const label = TTS_PROVIDER_LABEL[provider]
  const volume = useVoiceSettings().volume
  const id = fid(`key-${provider}`)
  const field = `${provider}ApiKey`
  const showInput = editing || status.state === "unset"

  const submit = () => {
    const key = value.trim()
    if (!key) return
    save.mutate(
      { [field]: key },
      {
        onSuccess: () => {
          setValue("")
          setEditing(false)
          setTest(null)
        },
      },
    )
  }
  const onKey = (e: ReactKeyboardEvent) => {
    // Enter saves the key, not the whole Settings form around it.
    if (e.key === "Enter") {
      e.preventDefault()
      submit()
    }
    if (e.key === "Escape" && editing) {
      e.stopPropagation()
      setEditing(false)
      setValue("")
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
      hint={status.state === "set" ? <SourceHint source={status.source} env={TTS_KEY_ENV[provider]} changed={false} /> : undefined}
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
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKey}
            aria-label={`${label} API key`}
          />
          <div className="flex gap-2">
            <Button type="button" variant="primary" size="sm" loading={save.isPending} disabled={!value.trim()} onClick={submit}>
              Save key
            </Button>
            {editing && (
              <Button type="button" variant="ghost" size="sm" onClick={() => (setEditing(false), setValue(""))}>
                Cancel
              </Button>
            )}
          </div>
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
                loading={save.isPending}
                onClick={() => save.mutate({ [field]: null }, { onSuccess: () => setTest(null) })}
                title={info.keys[provider].source === "ui" ? `Forget this key${TTS_KEY_ENV[provider] ? `; ${TTS_KEY_ENV[provider]} applies again if set` : ""}` : undefined}
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

function ElevenLabsSettings({ info, fid, save }: { info: TtsInfo; fid: (k: string) => string; save: Save }) {
  const s = info.settings.elevenlabs
  const keySet = info.keys.elevenlabs.state === "set"
  const list = useVoiceList<TtsVoiceList>("elevenlabs", keySet)
  const owner = useOwnerName()
  const volume = useVoiceSettings().volume
  const [speed, setSpeed] = useDebounced(s.speed, (v) => save({ elevenlabs: { speed: v } }))
  const voices = list.data?.voices ?? []
  return (
    <>
      <KeyRow provider="elevenlabs" info={info} fid={fid} />
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
            onPick={(v) => save({ elevenlabs: { voiceId: v.id, voiceName: v.name } })}
            preview={(v) =>
              playPreview(
                v.id,
                v.previewUrl ? { url: v.previewUrl } : { request: { text: previewLine(v.name, owner), provider: "elevenlabs", voice: v.id, model: s.model } },
                volume,
              )
            }
          />
        ) : (
          <p className="text-sm text-zinc-500">Add a key to choose a voice. Using {s.voiceName || s.voiceId}.</p>
        )}
      </Row>
      <ModelRow id={fid("el-model")} models={ELEVENLABS_MODELS} value={s.model} onChange={(model) => save({ elevenlabs: { model } })} />
      <Row id={fid("el-speed")} label="Speed" help="ElevenLabs' own speed control (0.7× to 1.2×), applied when the audio is made.">
        <Slider id={fid("el-speed")} label="Speed" value={speed} min={ELEVENLABS_SPEED.min} max={ELEVENLABS_SPEED.max} step={0.05} onChange={setSpeed} format={(v) => `${v.toFixed(2)}×`} />
      </Row>
    </>
  )
}

function OpenAiSettings({ info, fid, save }: { info: TtsInfo; fid: (k: string) => string; save: Save }) {
  const s = info.settings.openai
  const owner = useOwnerName()
  const volume = useVoiceSettings().volume
  const keySet = info.keys.openai.state === "set"
  const [speed, setSpeed] = useDebounced(s.speed, (v) => save({ openai: { speed: v } }))
  const [instructions, setInstructions] = useDebounced(s.instructions, (v) => save({ openai: { instructions: v } }), 800)
  const voices: TtsVoice[] = OPENAI_VOICES.map((v) => ({ id: v.id, name: v.name, category: "built-in" }))
  return (
    <>
      <KeyRow provider="openai" info={info} fid={fid} />
      <Row label="Voice" help={<>OpenAI's built-in voices; it recommends Marin or Cedar for the best quality. ▶ says “{previewLine("Marin", owner)}” in that voice.</>}>
        <VoicePicker
          provider="openai"
          voices={voices}
          selected={s.voice}
          disabled={!keySet}
          onPick={(v) => save({ openai: { voice: v.id } })}
          preview={(v) =>
            playPreview(
              v.id,
              {
                request: {
                  text: previewLine(v.name, owner),
                  provider: "openai",
                  voice: v.id,
                  model: s.model,
                  instructions,
                  speed,
                },
              },
              volume,
            )
          }
        />
      </Row>
      <ModelRow
        id={fid("oa-model")}
        models={OPENAI_TTS_MODELS}
        value={s.model}
        onChange={(model) => save({ openai: { model } })}
      />
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
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </Row>
      <Row id={fid("oa-speed")} label="Speed" help="OpenAI's speed setting (0.25× to 1.5×), applied when the audio is made.">
        <Slider id={fid("oa-speed")} label="Speed" value={speed} min={OPENAI_SPEED.min} max={OPENAI_SPEED.max} step={0.05} onChange={setSpeed} format={(v) => `${v.toFixed(2)}×`} />
      </Row>
    </>
  )
}

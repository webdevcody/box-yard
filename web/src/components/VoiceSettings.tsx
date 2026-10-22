import type { ReactNode } from "react"
import { Mic, Volume2 } from "lucide-react"
import { setVoiceSettings, speakNow, useVoiceSettings, useVoices, voiceSupported } from "../lib/speech"
import { VOICE_EVENTS, VOICE_EVENT_LABEL, pickVoice, type VoiceSettings } from "../lib/voice"
import { DICTATION_KEYS, LANGUAGES, keyLabel, type DictationKey } from "../lib/dictation"
import { dictationSupported, isMac, setDictationSettings, useDictationSettings } from "../lib/useDictation"
import { Panel, Row } from "./SettingsDialog"
import { Button, Select, cx, inputClass } from "./ui"

const TEST_LINE = "This is Box Yard. PR number 30 merged, and task cards now have equal heights."

function Check({ checked, disabled, onChange, children, id }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; children: ReactNode; id?: string }) {
  return (
    <label className={cx("flex items-center gap-2 text-sm text-zinc-200", disabled && "opacity-50")}>
      <input id={id} type="checkbox" disabled={disabled} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

function Slider({ id, label, value, min, max, step, disabled, onChange, format }: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean
  onChange: (v: number) => void
  format: (v: number) => string
}) {
  return (
    <div className={cx("flex items-center gap-3", disabled && "opacity-50")}>
      <label htmlFor={id} className="w-12 shrink-0 text-xs text-zinc-400">
        {label}
      </label>
      <input
        id={id}
        type="range"
        className="min-w-0 flex-1 accent-yard-500"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-10 shrink-0 text-right text-xs text-zinc-400 tabular-nums">{format(value)}</span>
    </div>
  )
}

/** Settings → Voice. Saved per browser (localStorage), applied at once: they're about this device. */
export function VoicePanel({ fid }: { fid: (k: string) => string }) {
  const s = useVoiceSettings()
  const voices = useVoices()
  const supported = voiceSupported()
  const set = (patch: Partial<VoiceSettings>) => setVoiceSettings(patch)
  const off = !supported || !s.enabled
  const auto = pickVoice(voices, "", typeof navigator !== "undefined" ? navigator.language : "en-US")
  const sorted = [...voices].sort((a, b) => Number(/^en\b/i.test(b.lang)) - Number(/^en\b/i.test(a.lang)) || a.name.localeCompare(b.name))
  const x = (v: number) => `${v.toFixed(1)}×`

  return (
    <Panel section="voice">
      {!supported && (
        <p className="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200" role="status">
          Voice isn't supported in this browser.
        </p>
      )}
      <Row id={fid("ve")} label="Voice announcements" help="Box Yard says short updates out loud: a one-line summary of each orchestrator reply, and task events. Off by default.">
        <Check
          id={fid("ve")}
          disabled={!supported}
          checked={s.enabled}
          onChange={(enabled) => {
            set({ enabled })
            if (enabled) speakNow("Voice on.")
          }}
        >
          {s.enabled ? "On" : "Off"}
        </Check>
      </Row>
      <Row
        label="What to speak"
        help="Task events are said only when the orchestrator doesn't report them itself, so nothing is said twice. Several at once become one line, like “3 tasks finished”."
      >
        <div className="space-y-2">
          <Check disabled={off} checked={s.orchestrator} onChange={(orchestrator) => set({ orchestrator })}>
            Orchestrator summaries
          </Check>
          <Check disabled={off} checked={s.taskEvents} onChange={(taskEvents) => set({ taskEvents })}>
            Task events
          </Check>
          <div className="ml-6 grid grid-cols-2 gap-x-3 gap-y-1.5">
            {VOICE_EVENTS.map((ev) => (
              <Check key={ev} disabled={off || !s.taskEvents} checked={s.events[ev]} onChange={(v) => set({ events: { ...s.events, [ev]: v } })}>
                <span className="text-xs">{VOICE_EVENT_LABEL[ev]}</span>
              </Check>
            ))}
          </div>
        </div>
      </Row>
      <Row id={fid("vv")} label="Voice" help="The browser's voices. Local voices work offline and sound the same every time.">
        <Select id={fid("vv")} className="w-full" disabled={off} value={s.voiceURI} onChange={(e) => set({ voiceURI: e.target.value })}>
          <option value="">Default{auto ? ` (${auto.name})` : ""}</option>
          {sorted.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name} · {v.lang}
              {v.localService ? "" : " · online"}
            </option>
          ))}
        </Select>
      </Row>
      <Row id={fid("vr")} label="Rate, pitch and volume" help="How fast, how high and how loud.">
        <div className="space-y-2">
          <Slider id={fid("vr")} label="Rate" value={s.rate} min={0.5} max={2} step={0.1} disabled={off} onChange={(rate) => set({ rate })} format={x} />
          <Slider label="Pitch" id={fid("vp")} value={s.pitch} min={0} max={2} step={0.1} disabled={off} onChange={(pitch) => set({ pitch })} format={x} />
          <Slider
            label="Volume"
            id={fid("vo")}
            value={s.volume}
            min={0}
            max={1}
            step={0.05}
            disabled={off}
            onChange={(volume) => set({ volume })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </div>
      </Row>
      <Row id={fid("vb")} label="Only in the background" help="Stay quiet while a Box Yard tab is in front, and speak only when you're elsewhere.">
        <Check id={fid("vb")} disabled={off} checked={s.backgroundOnly} onChange={(backgroundOnly) => set({ backgroundOnly })}>
          Only when the Box Yard tab is in the background
        </Check>
      </Row>
      <Row id={fid("vq")} label="Quiet hours" help="No announcements between these times (this computer's clock). The window may run past midnight.">
        <div className="space-y-2">
          <Check id={fid("vq")} disabled={off} checked={s.quietHours.enabled} onChange={(enabled) => set({ quietHours: { ...s.quietHours, enabled } })}>
            Enabled
          </Check>
          <div className="flex items-center gap-2">
            <input
              type="time"
              className={cx(inputClass, "min-w-0 flex-1 disabled:opacity-50")}
              disabled={off || !s.quietHours.enabled}
              value={s.quietHours.start}
              aria-label="Quiet hours start"
              onChange={(e) => e.target.value && set({ quietHours: { ...s.quietHours, start: e.target.value } })}
            />
            <span className="text-xs text-zinc-500">to</span>
            <input
              type="time"
              className={cx(inputClass, "min-w-0 flex-1 disabled:opacity-50")}
              disabled={off || !s.quietHours.enabled}
              value={s.quietHours.end}
              aria-label="Quiet hours end"
              onChange={(e) => e.target.value && set({ quietHours: { ...s.quietHours, end: e.target.value } })}
            />
          </div>
        </div>
      </Row>
      <Row label="Test" help="Say a sample line with these settings. This also unlocks audio, which browsers block until you click.">
        <Button type="button" variant="subtle" disabled={!supported} onClick={() => speakNow(TEST_LINE)}>
          <Volume2 className="h-4 w-4" /> Test voice
        </Button>
      </Row>
      <p className="mt-2 text-xs text-zinc-500">
        Saved in this browser only. Toggle voice from the speaker in the orchestrator header, or press <kbd className="rounded bg-zinc-800 px-1">Alt</kbd>+
        <kbd className="rounded bg-zinc-800 px-1">Shift</kbd>+<kbd className="rounded bg-zinc-800 px-1">V</kbd>.
      </p>
      <DictationSection fid={fid} />
    </Panel>
  )
}

const OS_DICTATION_TIP = "You can also use your OS dictation in any text box (macOS: press Fn twice; Windows: Win+H)."

/** Settings → Voice → Dictation: the composers' push-to-talk mic. */
function DictationSection({ fid }: { fid: (k: string) => string }) {
  const d = useDictationSettings()
  const supported = dictationSupported()
  const mac = isMac()
  const browserLang = typeof navigator !== "undefined" ? navigator.language : "en-US"
  const languages = LANGUAGES.some(([tag]) => tag === browserLang) ? LANGUAGES : [[browserLang, browserLang] as [string, string], ...LANGUAGES]
  const off = !d.enabled
  return (
    <section className="mt-8 border-t border-zinc-800 pt-6" aria-labelledby={fid("dict")}>
      <h4 id={fid("dict")} className="flex items-center gap-2 text-sm font-semibold text-zinc-50">
        <Mic className="h-4 w-4 text-yard-400" /> Dictation
      </h4>
      <p className="mt-1 mb-5 text-sm text-zinc-500">Talk instead of typing: a mic in the chat and task message boxes. Words go in at the cursor; nothing is sent until you say so.</p>
      {!supported ? (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300" role="status">
          This browser doesn't support speech recognition, so the mic is hidden. Use your OS dictation instead: it works in any text box (macOS: press
          Fn twice; Windows: Win+H).
        </p>
      ) : (
        <>
          <Row id={fid("de")} label="Dictation" help="Show the mic in message boxes. Press and hold it to talk, or click it to start and stop.">
            <Check id={fid("de")} checked={d.enabled} onChange={(enabled) => setDictationSettings({ enabled })}>
              {d.enabled ? "On" : "Off"}
            </Check>
          </Row>
          <Row id={fid("dl")} label="Language" help="What you'll speak. Defaults to the browser's language.">
            <Select id={fid("dl")} className="w-full" disabled={off} value={d.lang} onChange={(e) => setDictationSettings({ lang: e.target.value })}>
              <option value="">Browser default ({browserLang})</option>
              {languages.map(([tag, name]) => (
                <option key={tag} value={tag}>
                  {name} · {tag}
                </option>
              ))}
            </Select>
          </Row>
          <Row id={fid("dk")} label="Push-to-talk key" help="Hold it anywhere in Box Yard to talk into the focused (or last used) message box; let go to stop. A quick tap toggles.">
            <Select id={fid("dk")} className="w-full" disabled={off} value={d.key} onChange={(e) => setDictationSettings({ key: e.target.value as DictationKey })}>
              {DICTATION_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k === "off" ? "None" : `Hold ${keyLabel(k, mac)}`}
                </option>
              ))}
            </Select>
          </Row>
          <Row id={fid("ds")} label="Send when I release" help="Send the message as soon as you let go of a held mic or key. Off: review it, then press Enter.">
            <Check id={fid("ds")} disabled={off} checked={d.sendOnRelease} onChange={(sendOnRelease) => setDictationSettings({ sendOnRelease })}>
              Send when I release
            </Check>
          </Row>
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">
            Uses your browser's speech recognition. In Chrome, audio is sent to Google's servers; in Safari it's processed by Apple. {OS_DICTATION_TIP} Spoken
            announcements pause while you dictate.
          </p>
        </>
      )}
    </section>
  )
}

import { Mic, X } from "lucide-react"
import { keyLabel, type DictationError, type DictationMachine } from "../lib/dictation"
import { dictationSupported, isMac, useDictationSettings, useDictationState } from "../lib/useDictation"
import { Button, cx } from "./ui"

const ERROR_TEXT: Record<DictationError, string> = {
  denied:
    "Microphone access is blocked for this site. Click the lock or microphone icon in the address bar, allow the microphone, then try again.",
  "no-mic": "No microphone was found. Plug one in or pick one in your system's sound settings, then try again.",
  network: "Speech recognition couldn't reach its service. Check your connection and try again.",
  failed: "Dictation stopped unexpectedly. Try again.",
}

/** The composer's mic: press and hold to talk, release to stop; a click (or Enter/Space on it) toggles. */
export function MicButton({ machine }: { machine: DictationMachine }) {
  const settings = useDictationSettings()
  const state = useDictationState(machine)
  if (!settings.enabled || !dictationSupported()) return null
  const on = state.phase !== "idle"
  const chord = settings.key === "off" ? "" : ` (hold ${keyLabel(settings.key, isMac())})`
  const label = on ? "Stop dictation" : `Dictate: hold to talk, click to toggle${chord}`
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cx("h-8 w-8 touch-none !p-0 select-none", on && "bg-red-500/15 !text-red-400 hover:bg-red-500/25")}
      title={label}
      aria-label={label}
      aria-pressed={on}
      data-testid="mic"
      // Keep focus (and the caret) in the textarea.
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        machine.press()
      }}
      onPointerUp={() => machine.release()}
      onPointerCancel={() => machine.release()}
      onClick={(e) => {
        // Pointer clicks are handled by down/up; detail 0 is a keyboard or assistive-tech click.
        if (e.detail === 0) machine.toggle()
      }}
    >
      <Mic className={cx("h-4 w-4", on && "animate-pulse")} />
    </Button>
  )
}

/** "Listening…" with the words heard so far (gray until final), or why dictation stopped. */
export function DictationStatus({ machine }: { machine: DictationMachine }) {
  const state = useDictationState(machine)
  if (state.error)
    return (
      <div role="alert" className="flex items-start gap-2 px-2 pb-2 text-xs text-amber-300">
        <Mic className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{ERROR_TEXT[state.error]}</span>
        <button type="button" className="rounded p-0.5 text-zinc-500 hover:text-zinc-200" aria-label="Dismiss" onClick={() => machine.clearError()}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  if (state.phase === "idle") return null
  return (
    <div className="flex items-baseline gap-2 px-2 pb-1.5 text-xs" role="status" aria-live="polite">
      <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-red-400">
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
        {state.phase === "stopping" ? "Finishing…" : "Listening…"}
      </span>
      <span className="min-w-0 truncate text-zinc-500 italic" data-testid="interim">
        {state.interim}
      </span>
    </div>
  )
}

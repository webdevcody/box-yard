import { useEffect } from "react"
import { Volume2, VolumeX } from "lucide-react"
import { toggleVoice, unlockVoice, useVoiceSettings, useVoiceStatus, voiceSupported } from "../lib/speech"
import { Button, cx } from "./ui"

/** Alt+Shift+V (by key position, so it works on any layout and on macOS where Option changes the letter). */
const isVoiceShortcut = (e: KeyboardEvent) => e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === "KeyV"

/** Phones and tablets say "Tap"; a mouse says "Click". */
const touch = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches

/**
 * The orchestrator header's speaker: stops speech at once and toggles voice. While the browser still
 * blocks audio (no click yet), a chip offers to unlock it. Subscribes on its own, so speaking never
 * re-renders the chat.
 */
export function VoiceControl() {
  const s = useVoiceSettings()
  const status = useVoiceStatus()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isVoiceShortcut(e) || e.repeat) return
      e.preventDefault()
      toggleVoice()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  if (!voiceSupported()) return null
  const unlock = `${touch() ? "Tap" : "Click"} to enable voice`
  const label = s.enabled ? (status.speaking ? "Stop speaking and turn voice off" : "Turn voice off") : "Turn voice on"
  return (
    <>
      {s.enabled && status.locked && (
        <button
          type="button"
          data-voice-unlock
          title={unlock}
          aria-label={unlock}
          // The window-level gesture listener in lib/speech.ts has already unlocked by now (and said "Voice on."
          // or the lines that waited for the tap); this only covers a click it somehow missed.
          onClick={() => unlockVoice()}
          // In a narrow header (a phone, the 320 px side panel) it's just the speaker, so the title keeps its room.
          className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-full border border-yard-500/40 bg-yard-500/10 px-2 text-[11px] font-medium text-yard-300 hover:bg-yard-500/20 @max-[30rem]:px-0"
        >
          <span aria-hidden>🔊</span>
          <span className="@max-[30rem]:hidden">{unlock}</span>
        </button>
      )}
      <Button size="sm" variant="ghost" title={`${label} (Alt+Shift+V)`} aria-label={label} aria-pressed={s.enabled} onClick={toggleVoice}>
        {s.enabled ? (
          <Volume2 className={cx("h-3.5 w-3.5", status.speaking ? "animate-pulse text-yard-400" : "text-zinc-300")} />
        ) : (
          <VolumeX className="h-3.5 w-3.5" />
        )}
      </Button>
    </>
  )
}

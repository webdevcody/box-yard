import { Play } from "lucide-react"
import { playSendSound, primeSendSound, type Cue, type SendSoundSettings } from "../lib/sendSound"
import { Row } from "./SettingsDialog"
import { Slider } from "./VoiceSettings"
import { Button } from "./ui"

/**
 * Settings › Notifications › Sound on send. Edits the dialog's draft (`value`/`onChange`); Save keeps it in
 * this browser. The preview buttons play the draft, so you hear a volume before saving it.
 */
export function SendSoundRow({ fid, value, onChange }: { fid: (k: string) => string; value: SendSoundSettings; onChange: (v: SendSoundSettings) => void }) {
  const preview = (cue: Cue) => {
    primeSendSound()
    playSendSound(cue, { settings: value })
  }
  const off = !value.enabled
  return (
    <Row
      id={fid("ss")}
      label="Sound on send"
      help="A short, soft two-note sound once a message or new task is accepted, so you know it went. A failed send plays a lower one instead. Under a voice line it plays quieter. On phones that support it, a light tap too."
    >
      <label className="flex items-center gap-2 text-sm text-zinc-200">
        <input id={fid("ss")} type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
        {value.enabled ? "On" : "Off"}
      </label>
      <Slider
        id={fid("ssv")}
        label="Volume"
        value={value.volume}
        min={0.05}
        max={1}
        step={0.05}
        disabled={off}
        onChange={(volume) => onChange({ ...value, volume })}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <div className="flex gap-1.5">
        <Button type="button" size="sm" variant="ghost" disabled={off} onClick={() => preview("sent")} title="Play the sound for a send that went through">
          <Play className="h-3.5 w-3.5" /> Sent
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={off} onClick={() => preview("failed")} title="Play the sound for a send that failed">
          <Play className="h-3.5 w-3.5" /> Failed
        </Button>
      </div>
    </Row>
  )
}

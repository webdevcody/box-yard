import { useState } from "react"
import { X } from "lucide-react"
import { useAgentSettings, useHealth, useResetSettings, useSaveSettings } from "../lib/queries"
import { Button, Field, Select, cx, inputClass } from "./ui"
import {
  AUTOCOMPACT_MAX_TOKENS,
  AUTOCOMPACT_MIN_TOKENS,
  EFFORTS,
  UPSTASH_FREE_CONCURRENT_BOXES,
  type AgentEffort,
  type AutoCompact,
  type Settings,
  type SettingSource,
} from "../../../shared/types"

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]
const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" }

const POOL_KEYS = ["maxBoxes", "slotsPerBox", "maxAgents"] as const

const SOURCE_LABEL: Record<SettingSource, string> = { ui: "saved here", env: "from env var", default: "default" }

function Source({ source }: { source: SettingSource }) {
  return (
    <span className={cx("ml-1.5 rounded px-1 py-px text-[10px] font-normal tracking-normal normal-case", source === "ui" ? "bg-yard-500/15 text-yard-300" : "bg-zinc-800 text-zinc-500")}>
      {SOURCE_LABEL[source]}
    </span>
  )
}

function AutoCompactField({ label, hint, value, onChange }: { label: string; hint: string; value: AutoCompact; onChange: (v: AutoCompact) => void }) {
  const percent = value.unit === "percent"
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-sm text-zinc-200">
        <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
        {label}
      </label>
      <div className="flex items-center gap-2 pl-6">
        <input
          type="number"
          className={cx(inputClass, "w-28")}
          disabled={!value.enabled}
          value={value.value}
          min={percent ? 10 : AUTOCOMPACT_MIN_TOKENS}
          max={percent ? 95 : AUTOCOMPACT_MAX_TOKENS}
          step={percent ? 5 : 10_000}
          onChange={(e) => onChange({ ...value, value: Number(e.target.value) })}
          aria-label={`${label} threshold`}
        />
        <Select
          className="w-36"
          disabled={!value.enabled}
          value={value.unit}
          onChange={(e) => {
            const unit = e.target.value as AutoCompact["unit"]
            onChange({ ...value, unit, value: unit === "percent" ? 80 : 800_000 })
          }}
        >
          <option value="percent">% of window</option>
          <option value="tokens">tokens</option>
        </Select>
      </div>
      <p className="pl-6 text-xs text-zinc-500">{hint}</p>
    </div>
  )
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const info = useAgentSettings()
  const save = useSaveSettings()
  const reset = useResetSettings()
  const health = useHealth()
  const [draft, setDraft] = useState<Settings | null>(null)

  const current = info.data
  const s = draft ?? current?.settings
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => s && setDraft({ ...s, [k]: v })
  const src = (k: keyof Settings) => (current ? <Source source={current.sources[k]} /> : null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!s) return
    // Pool limits are sent only when edited, so an untouched form doesn't pin them over env changes.
    const patch: Partial<Settings> = { ...s }
    for (const k of POOL_KEYS) if (current && s[k] === current.settings[k]) delete patch[k]
    save.mutate(patch, { onSuccess: onClose })
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <form
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="scroll-thin max-h-full w-full max-w-lg space-y-5 overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl"
        aria-label="Orchestrator settings"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-50">Settings</h2>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-200" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="-mt-3 text-xs text-zinc-500">Changes apply from the next turn. Values shown are the ones in effect.</p>

        {!s ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <>
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-200">Orchestrator</h3>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Model">
                  <input className={inputClass} list="boxyard-models" value={s.orchestratorModel} onChange={(e) => set("orchestratorModel", e.target.value)} />
                  {src("orchestratorModel")}
                </Field>
                <Field label="Effort">
                  <Select className="w-full" value={s.orchestratorEffort} onChange={(e) => set("orchestratorEffort", e.target.value as Settings["orchestratorEffort"])}>
                    {EFFORTS.map((x) => (
                      <option key={x} value={x}>
                        {EFFORT_LABEL[x]}
                      </option>
                    ))}
                  </Select>
                  {src("orchestratorEffort")}
                </Field>
              </div>
              <AutoCompactField
                label="Auto-compact"
                hint="Compacts between turns once context usage passes this. A summary is saved to the compaction log first. Off: only the CLI's own last-resort compaction near the window limit."
                value={s.orchestratorAutoCompact}
                onChange={(v) => set("orchestratorAutoCompact", v)}
              />
            </section>

            <section className="space-y-3 border-t border-zinc-900 pt-4">
              <h3 className="text-sm font-semibold text-zinc-200">Box agents</h3>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Model">
                  <input className={inputClass} list="boxyard-models" value={s.agentModel} onChange={(e) => set("agentModel", e.target.value)} />
                  {src("agentModel")}
                </Field>
                <Field label="Effort">
                  <Select className="w-full" value={s.agentEffort} onChange={(e) => set("agentEffort", e.target.value as AgentEffort)}>
                    <option value="orchestrator">Let the orchestrator decide</option>
                    {EFFORTS.map((x) => (
                      <option key={x} value={x}>
                        {EFFORT_LABEL[x]}
                      </option>
                    ))}
                  </Select>
                  {src("agentEffort")}
                </Field>
              </div>
              {s.agentEffort === "orchestrator" && (
                <p className="text-xs text-zinc-500">The orchestrator picks an effort in create_task and send_to_task: low for one-command chores, high for real coding.</p>
              )}
              <AutoCompactField
                label="Custom auto-compact threshold"
                hint="Passed to each agent's CLI as its auto-compact window (100k–1M tokens). Off: the CLI's own default."
                value={s.agentAutoCompact}
                onChange={(v) => set("agentAutoCompact", v)}
              />
            </section>
            <section className="space-y-3 border-t border-zinc-900 pt-4">
              <h3 className="text-sm font-semibold text-zinc-200">Box limits</h3>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Max boxes">
                  <input type="number" min={1} max={100} className={inputClass} value={s.maxBoxes} onChange={(e) => set("maxBoxes", Math.trunc(Number(e.target.value)))} />
                  {src("maxBoxes")}
                </Field>
                <Field label="Agents per box">
                  <input type="number" min={1} max={20} className={inputClass} value={s.slotsPerBox} onChange={(e) => set("slotsPerBox", Math.trunc(Number(e.target.value)))} />
                  {src("slotsPerBox")}
                </Field>
                <Field label="Max agents">
                  <input type="number" min={0} max={1000} className={inputClass} value={s.maxAgents} onChange={(e) => set("maxAgents", Math.trunc(Number(e.target.value)))} />
                  {src("maxAgents")}
                </Field>
              </div>
              <p className="text-xs text-zinc-500">
                Max agents is a cap across all boxes (0 = boxes × agents per box). Changes apply right away. Lowering a limit never stops running boxes or agents: no new work is placed until usage drops.
              </p>
              {health.data?.provider === "upstash" && (
                <p className="text-xs text-zinc-500">
                  Free plan: up to {UPSTASH_FREE_CONCURRENT_BOXES} concurrent boxes (
                  <a className="text-sky-400 hover:underline" href="https://upstash.com/pricing/box" target="_blank" rel="noreferrer">
                    Upstash Box pricing
                  </a>
                  ).
                </p>
              )}
            </section>
            <datalist id="boxyard-models">
              {MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={reset.isPending}
            onClick={() => reset.mutate(undefined, { onSuccess: () => setDraft(null) })}
            title="Forget saved values: env vars and defaults apply again"
          >
            Reset to defaults
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!s}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}

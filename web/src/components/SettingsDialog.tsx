import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { useSearchParams } from "wouter"
import { Bell, Bot, Boxes, Check, Cpu, DollarSign, ExternalLink, Info, KeyRound, Network, Volume2, Webhook, type LucideIcon } from "lucide-react"
import { useAgentSettings, useHealth, useResetSettings, useSaveSettings, useSettings } from "../lib/queries"
import {
  SETTINGS_PARAM,
  SETTINGS_SECTIONS,
  SETTING_ENV,
  changedKeys,
  changedSections,
  parseSection,
  savePatch,
  stepSection,
  type SettingsSection,
} from "../lib/settingsNav"
import { SettingsDraftContext, updateParts, useDraft, type DraftPart, type DraftRegistry } from "../lib/settingsDraft"
import { LEGACY_POOL_DEFAULTS, sizeCapacities } from "../lib/capacity"
import { browserNotificationsOn, browserNotificationsSupported, setBrowserNotifications } from "../lib/notifications"
import { withParam } from "./TaskFilters"
import { VoicePanel } from "./VoiceSettings"
import { SendSoundRow } from "./SendSoundSettings"
import { setSendSound, useSendSound } from "../lib/sendSound"
import { HooksPanel } from "./Hooks"
import { CredentialsPanel } from "./Setup"
import { RunPodPanel } from "./RunPodSettings"
import { Modal } from "./Modal"
import { confirmDialog } from "../lib/confirm"
import { EFFORT_LABEL, MODELS } from "../lib/models"
import { Button, NewTabLink, Select, cx, inputClass } from "./ui"
import { BOX_SIZE_SPECS } from "../../../shared/boxSizes"
import { NOTE_BUDGET_LIMITS } from "../../../shared/notes"
import { LOCAL_AGENTS_LIMITS, LOCAL_UNSANDBOXED } from "../../../shared/runner"
import {
  AUTOCOMPACT_MAX_TOKENS,
  AUTOCOMPACT_MIN_TOKENS,
  BOX_CREATE_CONCURRENCY,
  BOX_SIZES,
  DEFAULT_AUTOCOMPACT_TOKENS,
  EFFORTS,
  SIZE_DEFAULTS,
  UPSTASH_FREE_CONCURRENT_BOXES,
  WORKER_SIZES,
  agentCapacity,
  type AgentEffort,
  type AutoCompact,
  type BoxSize,
  type Settings,
  type SettingSource,
  type WorkerSize,
} from "../../../shared/types"


const SECTION_ICON: Record<SettingsSection, LucideIcon> = { orchestrator: Network, agents: Bot, credentials: KeyRound, runpod: Cpu, hooks: Webhook, limits: Boxes, costs: DollarSign, notifications: Bell, voice: Volume2, about: Info }

/** Sections whose controls keep their own drafts (useDraft). They stay mounted once opened, so the drafts survive. */
const DRAFT_SECTIONS: SettingsSection[] = ["credentials", "runpod", "hooks", "notifications", "voice"]

// ------------------------------------------------------------------ open state (URL)

/** Opens the settings dialog at a section by setting `?settings=<section>` on the current page. */
export function useOpenSettings() {
  const [, setParams] = useSearchParams()
  return (section: SettingsSection = "orchestrator") => setParams((p) => withParam(p, SETTINGS_PARAM, section), { replace: true })
}

/** Mounted once in the app: shows the dialog while the URL has `?settings=`. */
export function SettingsHost() {
  const [params, setParams] = useSearchParams()
  const value = params.get(SETTINGS_PARAM)
  if (value === null) return null
  return (
    <SettingsDialog
      section={parseSection(value)}
      onSection={(s) => setParams((p) => withParam(p, SETTINGS_PARAM, s), { replace: true })}
      onClose={() => setParams((p) => withParam(p, SETTINGS_PARAM, null), { replace: true })}
    />
  )
}

// ------------------------------------------------------------------ building blocks

const SOURCE_LABEL: Record<SettingSource, string> = { ui: "saved here", env: "from env", default: "default" }

export function SourceHint({ source, env, changed }: { source?: SettingSource; env?: string; changed: boolean }) {
  if (changed) return <span className="rounded bg-amber-500/15 px-1.5 py-px text-[11px] text-amber-300">unsaved</span>
  if (!source) return null
  return (
    <span
      className={cx("rounded px-1.5 py-px text-[11px]", source === "ui" ? "bg-yard-500/15 text-yard-300" : "bg-zinc-800 text-zinc-400")}
      title={source === "env" && env ? `Set by the ${env} env var. Saving here overrides it.` : undefined}
    >
      {SOURCE_LABEL[source]}
      {source === "env" && env && <span className="ml-1 font-mono text-zinc-500">{env}</span>}
    </span>
  )
}

/** One setting: label and help text on the left, the control and where its value comes from on the right. */
export function Row({ id, label, help, hint, children }: { id?: string; label: string; help: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-x-8 gap-y-2 border-t border-zinc-900 py-4 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(0,1fr)_17rem]">
      <div>
        <label htmlFor={id} className="text-sm font-medium text-zinc-200">
          {label}
        </label>
        <div className="mt-1 text-xs leading-relaxed text-zinc-500">{help}</div>
      </div>
      <div className="space-y-1.5">
        {children}
        {hint && <div className="flex flex-wrap gap-1">{hint}</div>}
      </div>
    </div>
  )
}

export function Panel({ section, children }: { section: SettingsSection; children: ReactNode }) {
  const info = SETTINGS_SECTIONS.find((s) => s.key === section)!
  return (
    <div>
      <h3 className="text-base font-semibold text-zinc-50">{info.label}</h3>
      <p className="mt-1 text-sm text-zinc-500">{info.description}</p>
      <div className="mt-6">{children}</div>
    </div>
  )
}

function AutoCompactControl({
  id,
  label,
  value,
  onChange,
  tokens = 800_000,
}: {
  id: string
  label: string
  value: AutoCompact
  onChange: (v: AutoCompact) => void
  /** The token count a switch to "tokens" starts from. */
  tokens?: number
}) {
  const percent = value.unit === "percent"
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input id={id} type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
        Enabled
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="number"
          className={cx(inputClass, "min-w-0 flex-1 disabled:opacity-50")}
          disabled={!value.enabled}
          value={value.value}
          min={percent ? 10 : AUTOCOMPACT_MIN_TOKENS}
          max={percent ? 95 : AUTOCOMPACT_MAX_TOKENS}
          step={percent ? 5 : 10_000}
          onChange={(e) => onChange({ ...value, value: Number(e.target.value) })}
          aria-label={`${label} threshold`}
        />
        <Select
          className="w-full shrink-0 sm:w-36"
          disabled={!value.enabled}
          value={value.unit}
          aria-label={`${label} unit`}
          onChange={(e) => {
            const unit = e.target.value as AutoCompact["unit"]
            onChange({ ...value, unit, value: unit === "percent" ? 80 : tokens })
          }}
        >
          <option value="percent">% of window</option>
          <option value="tokens">tokens</option>
        </Select>
      </div>
    </div>
  )
}

function EffortOptions() {
  return EFFORTS.map((x) => (
    <option key={x} value={x}>
      {EFFORT_LABEL[x]}
    </option>
  ))
}

// ------------------------------------------------------------------ dialog

export function SettingsDialog({
  section,
  onSection,
  onClose,
}: {
  section: SettingsSection
  onSection: (s: SettingsSection) => void
  onClose: () => void
}) {
  const info = useAgentSettings()
  const save = useSaveSettings()
  const reset = useResetSettings()
  const resetFields = useResetSettings()
  const [draft, setDraft] = useState<Settings | null>(null)
  // Box limits typed in while the size defaults apply: saved even when the number matches the default.
  const [pinned, setPinned] = useState<(keyof Settings)[]>([])
  // Saved values to forget on Save ("Use size default").
  const [resets, setResets] = useState<(keyof Settings)[]>([])
  // Drafts of the parts that aren't plain Settings fields (voice, keys, RunPod, hooks...), registered by useDraft.
  const [parts, setParts] = useState<Record<string, DraftPart>>({})
  const registry = useMemo<DraftRegistry>(() => ({ update: (id, part) => setParts((p) => updateParts(p, id, part)) }), [])
  // Sections opened so far stay mounted (hidden), so their drafts survive switching sections.
  const [visited, setVisited] = useState<SettingsSection[]>([section])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const ids = useId()
  const navRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const current = info.data
  const s = draft ?? current?.settings
  const changed = [...new Set([...(draft ? [...changedKeys(draft, current?.settings), ...pinned] : []), ...resets])]
  const partList = Object.values(parts)
  const changeCount = changed.length + partList.reduce((n, p) => n + p.count, 0)
  const dirty = changeCount > 0
  const dirtySections = new Set([...changedSections(changed), ...partList.map((p) => p.section)])

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    if (!s) return
    setDraft({ ...s, [k]: v })
    setResets((r) => (r.includes(k) ? r.filter((x) => x !== k) : r))
  }
  const pin = (k: keyof Settings, on: boolean) => setPinned((p) => (on ? (p.includes(k) ? p : [...p, k]) : p.filter((x) => x !== k)))
  // Forget just these saved values on Save; until then the field shows the size defaults, marked unsaved.
  const resetKeys = (keys: (keyof Settings)[]) => {
    setResets((r) => [...new Set([...r, ...keys])])
    setPinned((p) => p.filter((k) => !keys.includes(k)))
    setDraft((d) => d && { ...d, ...Object.fromEntries(keys.map((k) => [k, current?.settings[k]])) })
  }
  const hint = (k: keyof Settings) => <SourceHint source={current?.sources[k]} env={SETTING_ENV[k]} changed={changed.includes(k)} />
  const fid = (k: string) => `${ids}-${k}`

  const discard = () => {
    setDraft(null)
    setPinned([])
    setResets([])
    setSaveError(null)
    for (const p of partList) p.discard()
  }

  const close = async () => {
    if (
      dirty &&
      !(await confirmDialog({
        title: "Discard unsaved changes?",
        body: `${changeCount === 1 ? "1 change" : `${changeCount} changes`} to settings haven't been saved.`,
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        danger: true,
      }))
    )
      return
    onClose()
  }

  useEffect(() => {
    setVisited((v) => (v.includes(section) ? v : [...v, section]))
  }, [section])

  // Start keyboard focus on the selected category, so ↑/↓ work right away.
  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>("[aria-selected=true]")?.focus()
  }, [])

  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 })
  }, [section])

  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(0), 2500)
    return () => clearTimeout(t)
  }, [savedAt])

  const onNavKey = (e: ReactKeyboardEvent) => {
    const delta = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]
    let next: SettingsSection | null = delta ? stepSection(section, delta) : null
    if (e.key === "Home") next = SETTINGS_SECTIONS[0]!.key
    if (e.key === "End") next = SETTINGS_SECTIONS.at(-1)!.key
    if (!next) return
    e.preventDefault()
    onSection(next)
    navRef.current?.querySelector<HTMLElement>(`[data-section=${next}]`)?.focus()
  }

  const saveCore = async () => {
    if (draft && (changedKeys(draft, current?.settings).length || pinned.length)) {
      const patch = savePatch(draft, current?.settings, pinned)
      for (const k of resets) delete patch[k]
      await save.mutateAsync(patch)
    }
    if (resets.length) await resetFields.mutateAsync(resets)
    setDraft(null)
    setPinned([])
    setResets([])
  }

  // One Save writes every draft. Each part starts inside the click, so a browser permission prompt still works.
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!dirty || saving) return
    setSaving(true)
    setSaveError(null)
    const jobs = [...(changed.length ? [saveCore()] : []), ...partList.map((p) => p.save())]
    const failed = (await Promise.allSettled(jobs)).filter((r): r is PromiseRejectedResult => r.status === "rejected")
    setSaving(false)
    if (failed.length) setSaveError((failed[0]!.reason as Error)?.message || "Couldn't save")
    else setSavedAt(Date.now())
  }

  return (
    <Modal
      size="xl"
      title="Settings"
      description="Changes apply from the next turn. Values shown are the ones in effect."
      dirty={dirty}
      onClose={() => void close()}
      onSubmit={submit}
      className="sm:h-[min(80vh,52rem)]"
      bodyClassName="flex min-h-0 flex-1 flex-col sm:flex-row"
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={reset.isPending}
            onClick={() => {
              void confirmDialog({
                title: "Reset settings to defaults?",
                body: "Forget every value saved here? Env vars and defaults apply again.",
                confirmLabel: "Reset",
                danger: true,
              }).then((ok) => ok && reset.mutate(undefined, {
                    onSuccess: () => {
                      setDraft(null)
                      setPinned([])
                      setResets([])
                    },
                  }))
            }}
            title="Forget saved values: env vars and defaults apply again"
          >
            Reset to defaults
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row sm:items-center sm:gap-3">
            {saveError ? (
              <span className="text-xs text-red-300 wrap-anywhere" role="alert">
                Couldn't save: {saveError}
              </span>
            ) : dirty ? (
              <span className="text-xs text-amber-300" role="status" data-testid="unsaved-count">
                {changeCount === 1 ? "1 unsaved change" : `${changeCount} unsaved changes`}
              </span>
            ) : savedAt ? (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-400" role="status">
                <Check className="h-3.5 w-3.5" /> Saved
              </span>
            ) : null}
            {dirty && (
              <Button type="button" variant="ghost" onClick={discard}>
                Discard
              </Button>
            )}
            {!dirty && (
              <Button type="button" variant="ghost" onClick={onClose}>
                Close
              </Button>
            )}
            <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
              Save
            </Button>
          </div>
        </>
      }
    >
      <div
        ref={navRef}
        role="tablist"
        aria-label="Settings categories"
        aria-orientation="vertical"
        onKeyDown={onNavKey}
        className="scroll-thin flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-900 p-2 sm:w-52 sm:flex-col sm:overflow-x-visible sm:border-r sm:border-b-0 sm:p-3"
      >
        {SETTINGS_SECTIONS.map((sec) => {
          const Icon = SECTION_ICON[sec.key]
          const on = sec.key === section
          return (
            <button
              key={sec.key}
              type="button"
              role="tab"
              id={fid(`tab-${sec.key}`)}
              data-section={sec.key}
              aria-selected={on}
              aria-controls={fid("panel")}
              tabIndex={on ? 0 : -1}
              onClick={() => onSection(sec.key)}
              className={cx(
                "flex min-h-11 shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap transition focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none sm:min-h-0",
                on ? "bg-zinc-800/80 font-medium text-zinc-50" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
              )}
            >
              <Icon className={cx("h-4 w-4 shrink-0", on ? "text-yard-400" : "text-zinc-500")} />
              {sec.label}
              {dirtySections.has(sec.key) && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />}
            </button>
          )
        })}
      </div>

      <div
        ref={panelRef}
        role="tabpanel"
        id={fid("panel")}
        aria-labelledby={fid(`tab-${section}`)}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-6"
      >
        <SettingsDraftContext.Provider value={registry}>
          {DRAFT_SECTIONS.filter((k) => visited.includes(k)).map((k) => (
            <div key={k} hidden={k !== section} data-settings-section={k}>
              {k === "notifications" ? (
                <NotificationsPanel fid={fid} />
              ) : k === "voice" ? (
                <VoicePanel fid={fid} />
              ) : k === "credentials" ? (
                <CredentialsPanel fid={fid} />
              ) : k === "runpod" ? (
                <RunPodPanel fid={fid} active={section === "runpod"} />
              ) : (
                <Panel section="hooks">
                  <HooksPanel projectId={null} intro={false} />
                </Panel>
              )}
            </div>
          ))}
        </SettingsDraftContext.Provider>
        {DRAFT_SECTIONS.includes(section) ? null : section === "about" ? (
          <AboutPanel />
        ) : !s ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : section === "orchestrator" ? (
          <Panel section="orchestrator">
            <Row
              id={fid("siz")}
              label="Start in Zen mode"
              help="A new tab or window opened on Box Yard's home page starts in Zen: just this chat, full screen. Reloading keeps you where you are, and a link to any page always opens that page."
              hint={hint("startInZen")}
            >
              <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
                <input id={fid("siz")} type="checkbox" checked={s.startInZen} onChange={(e) => set("startInZen", e.target.checked)} data-testid="start-in-zen" />
                {s.startInZen ? "On: new tabs open in Zen" : "Off: new tabs open the Yard"}
              </label>
            </Row>
            <Row
              id={fid("om")}
              label="Model"
              help="The Claude model the Coordinator chat runs on. Type any model id, or pick one."
              hint={hint("orchestratorModel")}
            >
              <input
                id={fid("om")}
                className={inputClass}
                list="boxyard-models"
                value={s.orchestratorModel}
                onChange={(e) => set("orchestratorModel", e.target.value)}
              />
            </Row>
            <Row id={fid("oe")} label="Effort" help="How hard it thinks before answering. Higher is slower and costs more." hint={hint("orchestratorEffort")}>
              <Select
                id={fid("oe")}
                className="w-full"
                value={s.orchestratorEffort}
                onChange={(e) => set("orchestratorEffort", e.target.value as Settings["orchestratorEffort"])}
              >
                <EffortOptions />
              </Select>
            </Row>
            <Row
              id={fid("oac")}
              label="Auto-compact"
              help={`Compacts the Coordinator and every Captain between turns once context usage passes this. A summary is saved to the compaction log first and shown again after the compaction. Default: ${DEFAULT_AUTOCOMPACT_TOKENS / 1000}k tokens; every turn re-sends the whole context, so a lower threshold makes turns cheaper. Off: only the CLI's own last-resort compaction near the window limit.`}
              hint={hint("orchestratorAutoCompact")}
            >
              <AutoCompactControl
                id={fid("oac")}
                label="Coordinator auto-compact"
                value={s.orchestratorAutoCompact}
                onChange={(v) => set("orchestratorAutoCompact", v)}
                tokens={DEFAULT_AUTOCOMPACT_TOKENS}
              />
            </Row>
            <h4 className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">Project Captains</h4>
            <p className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">
              Each project's Captain wakes on its task events, so it runs far more often than the Coordinator. Set its model and effort separately to tune that cost. Captains
              share the auto-compact threshold above.
            </p>
            <Row
              id={fid("cm")}
              label="Captain model"
              help="The Claude model every project Captain runs on. Type any model id, or pick one."
              hint={hint("captainModel")}
            >
              <input id={fid("cm")} className={inputClass} list="boxyard-models" value={s.captainModel} onChange={(e) => set("captainModel", e.target.value)} />
            </Row>
            <Row id={fid("ce")} label="Captain effort" help="How hard Captains think before answering. Lower is faster and cheaper." hint={hint("captainEffort")}>
              <Select id={fid("ce")} className="w-full" value={s.captainEffort} onChange={(e) => set("captainEffort", e.target.value as Settings["captainEffort"])}>
                <EffortOptions />
              </Select>
            </Row>
            <h4 className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">Project notes</h4>
            <p className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">
              Every agent in a project starts with its notes. Agents only suggest notes; each project's Captain curates them into a small set of lasting rules, and you can edit
              them on the project's Notes tab.
            </p>
            <Row
              id={fid("nre")}
              label="Notes retro"
              help="When a task's PR merges, or a task without a PR ends done, its project's Captain decides on each note suggestion the agent left: it accepts, merges or rejects it, with a one-line reason. Nobody needs to approve them; the Notes tab shows what was decided."
              hint={hint("notesRetroEnabled")}
            >
              <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
                <input id={fid("nre")} type="checkbox" checked={s.notesRetroEnabled} onChange={(e) => set("notesRetroEnabled", e.target.checked)} data-testid="notes-retro" />
                {s.notesRetroEnabled ? "On: Captains curate suggestions" : "Off: suggestions stay pending until it's on again"}
              </label>
            </Row>
            <Row
              id={fid("nmc")}
              label="Max notes"
              help="Most notes an agent's first prompt gets; Captains keep their project under it. Over it, agents get the newest notes that fit, their prompt says how many were left out, and the Captain is asked to prune. A project can set its own on its Settings tab."
              hint={hint("notesMaxCount")}
            >
              <input
                id={fid("nmc")}
                type="number"
                min={NOTE_BUDGET_LIMITS.maxNotes.min}
                max={NOTE_BUDGET_LIMITS.maxNotes.max}
                className={inputClass}
                value={s.notesMaxCount}
                onChange={(e) => set("notesMaxCount", Math.trunc(Number(e.target.value)))}
              />
            </Row>
            <Row id={fid("nmt")} label="Max note tokens" help="About how many tokens all the notes may take in that prompt, next to Max notes (4 characters is about 1 token)." hint={hint("notesMaxTokens")}>
              <input
                id={fid("nmt")}
                type="number"
                min={NOTE_BUDGET_LIMITS.maxTokens.min}
                max={NOTE_BUDGET_LIMITS.maxTokens.max}
                step={100}
                className={inputClass}
                value={s.notesMaxTokens}
                onChange={(e) => set("notesMaxTokens", Math.trunc(Number(e.target.value)))}
              />
            </Row>
          </Panel>
        ) : section === "agents" ? (
          <Panel section="agents">
            <Row
              id={fid("on")}
              label="Your name"
              help="What the Coordinator, Captains and agents call you in their prompts and labels."
              hint={hint("ownerName")}
            >
              <input id={fid("on")} className={inputClass} value={s.ownerName} maxLength={40} onChange={(e) => set("ownerName", e.target.value)} />
            </Row>
            <Row id={fid("am")} label="Model" help="The Claude model each task's agent runs on, unless the task or its project's Routing YAML entry picks one. Once saved here or set by an env var, it wins over the YAML's defaults and fallback." hint={hint("agentModel")}>
              <input id={fid("am")} className={inputClass} list="boxyard-models" value={s.agentModel} onChange={(e) => set("agentModel", e.target.value)} />
            </Row>
            <Row
              id={fid("ae")}
              label="Effort"
              help={
                s.agentEffort === "orchestrator"
                  ? "The Coordinator picks an effort in create_task and send_to_task: low for one-command chores, high for real coding. Without one, Routing YAML or high applies."
                  : "Every agent turn uses this effort, unless the task or its project's Routing YAML entry picks one. Once saved here or set by an env var, it wins over the YAML's defaults and fallback."
              }
              hint={hint("agentEffort")}
            >
              <Select id={fid("ae")} className="w-full" value={s.agentEffort} onChange={(e) => set("agentEffort", e.target.value as AgentEffort)}>
                <option value="orchestrator">Let the Coordinator decide</option>
                <EffortOptions />
              </Select>
            </Row>
            <Row
              id={fid("arc")}
              label="Routing YAML"
              help="Optional rules for task model and effort, also read from routing.yaml in the data directory. Each turn the first match wins: the task's own choice, then its project's entry, then Model and Effort above when saved or set by an env var, then defaults, then fallback, then claude-opus-5-5 at high."
              hint={hint("agentRoutingConfig")}
            >
              <textarea
                id={fid("arc")}
                className={cx(inputClass, "min-h-40 resize-y font-mono text-xs leading-5")}
                spellCheck={false}
                value={s.agentRoutingConfig}
                onChange={(e) => set("agentRoutingConfig", e.target.value)}
                placeholder={"fallback:\n  model: claude-opus-5-5\n  effort: high\nrules:\n  - name: docs-small-fixes\n    when: docs, typos, small fixes\n    model: claude-haiku-5-5\n    effort: low"}
              />
            </Row>
            <Row
              id={fid("aac")}
              label="Custom auto-compact threshold"
              help="Passed to each agent's CLI as its auto-compact window (100k–1M tokens). Off: the CLI's own default."
              hint={hint("agentAutoCompact")}
            >
              <AutoCompactControl id={fid("aac")} label="Agent auto-compact" value={s.agentAutoCompact} onChange={(v) => set("agentAutoCompact", v)} />
            </Row>
          </Panel>
        ) : section === "limits" ? (
          <LimitsPanel
            s={s}
            set={set}
            hint={hint}
            fid={fid}
            sources={current?.sources}
            changed={changed}
            current={current?.settings}
            pin={pin}
            resetKeys={resetKeys}
            resets={resets}
          />
        ) : (
          <CostsPanel s={s} set={set} hint={hint} fid={fid} />
        )}
      </div>

      <datalist id="boxyard-models">
        {MODELS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </Modal>
  )
}

// ------------------------------------------------------------------ panels

function LimitsPanel({
  s,
  set,
  hint,
  fid,
  sources,
  changed,
  current,
  pin,
  resetKeys,
  resets,
}: {
  s: Settings
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  hint: (k: keyof Settings) => ReactNode
  fid: (k: string) => string
  sources?: Record<keyof Settings, SettingSource>
  changed: (keyof Settings)[]
  current?: Settings
  pin: (k: keyof Settings, on: boolean) => void
  resetKeys: (keys: (keyof Settings)[]) => void
  resets: (keyof Settings)[]
}) {
  const health = useHealth()
  const server = useSettings()
  const int =
    (k: "maxBoxes" | "boxCreateConcurrency" | "maxAgents" | "localAgents" | "boxIdleDeleteMinutes" | "workspaceRetentionDays" | "archiveRetentionDays" | "archiveKeepTouchedDays" | "diskMinFreeMb" | "memoryMaxUsedPercent" | "memoryMinFreeMb" | "buildCleanupIdleMinutes") =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      set(k, Math.trunc(Number(e.target.value)))
  const capacity = agentCapacity(s)
  const limitField = (k: BoxLimitKey) => ({
    k,
    value: s[k],
    current: current?.[k],
    source: sources?.[k],
    changed: changed.includes(k),
    onValue: (v: number) => set(k, v),
    pin: (on: boolean) => pin(k, on),
    onReset: () => resetKeys([k]),
    pendingReset: resets.includes(k),
  })
  // A pending "Use size default" shows the size defaults already.
  const shownSources = sources && { ...sources, ...Object.fromEntries(resets.map((k) => [k, "default"])) }
  const overrides = changed.filter((k) => !resets.includes(k))
  const upstash = health.data?.provider === "upstash"
  return (
    <Panel section="limits">
      <Row
        id={fid("ws")}
        label="Worker size"
        help="Upstash Box size for newly created boxes, unless a project sets its own preferred size. Existing boxes keep their size until resized from the Boxes page."
        hint={hint("workerSize")}
      >
        <Select id={fid("ws")} className="w-full" value={s.workerSize} onChange={(e) => set("workerSize", e.target.value as WorkerSize)}>
          {WORKER_SIZES.map((size) => (
            <option key={size} value={size}>
              {size} ({SIZE_DEFAULTS[size].slotsPerBox} slots, {SIZE_DEFAULTS[size].maxResidentPerBox} resident tasks by default)
            </option>
          ))}
        </Select>
      </Row>
      <Row
        id={fid("are")}
        label="Allow the Coordinator to resize boxes automatically"
        help="The Coordinator, and Captains for boxes their project uses, may resize a box with resize_box: up when it keeps running low on disk, down when it sits mostly empty. They never stop running tasks for it, and every resize they make sends you a notice with their reason."
        hint={hint("autoResizeEnabled")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
          <input id={fid("are")} type="checkbox" checked={s.autoResizeEnabled} onChange={(e) => set("autoResizeEnabled", e.target.checked)} data-testid="auto-resize" />
          {s.autoResizeEnabled ? "Allowed" : "Off: only you resize boxes"}
        </label>
      </Row>
      <Row id={fid("arm")} label="Max size it may choose" help="resize_box refuses anything bigger. You can still pick any size yourself on the Boxes page." hint={hint("autoResizeMaxSize")}>
        <Select
          id={fid("arm")}
          className="w-full disabled:opacity-50"
          value={s.autoResizeMaxSize}
          disabled={!s.autoResizeEnabled}
          onChange={(e) => set("autoResizeMaxSize", e.target.value as BoxSize)}
          data-testid="auto-resize-max"
        >
          {BOX_SIZES.map((size) => (
            <option key={size} value={size}>
              {BOX_SIZE_SPECS[size].label} · {BOX_SIZE_SPECS[size].cpu} vCPU · {BOX_SIZE_SPECS[size].ramGb} GB RAM
            </option>
          ))}
        </Select>
      </Row>
      <Row
        id={fid("pre")}
        label="Resize an idle box when no big-enough box is free"
        help="For projects with a box size: when the pool is at Max boxes and no box of that size has room, Box Yard may grow an idle smaller box (no agent running on it) to that size and run the task there. Larger boxes cost more. Off, the task waits for a box of its size; it never runs on a smaller one."
        hint={hint("placementResizeEnabled")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
          <input
            id={fid("pre")}
            type="checkbox"
            checked={s.placementResizeEnabled}
            onChange={(e) => set("placementResizeEnabled", e.target.checked)}
            data-testid="placement-resize"
          />
          {s.placementResizeEnabled ? "On: an idle box may be resized" : "Off: the task waits"}
        </label>
      </Row>
      <SizeCapacityTable s={s} sources={shownSources} changed={overrides} />
      <Row id={fid("mb")} label="Max boxes" help="Most worker boxes alive at once." hint={hint("maxBoxes")}>
        <input id={fid("mb")} type="number" min={1} max={100} className={inputClass} value={s.maxBoxes} onChange={int("maxBoxes")} />
      </Row>
      <Row
        id={fid("bcc")}
        label="Boxes created at once"
        help="When many tasks wait for a box (say a Captain starts a batch of tasks), Box Yard creates up to this many boxes in parallel, still within Max boxes. Lower it if your box provider rate-limits box creation; Box Yard also backs off by itself when a create fails or is rate-limited."
        hint={hint("boxCreateConcurrency")}
      >
        <input
          id={fid("bcc")}
          type="number"
          min={BOX_CREATE_CONCURRENCY.min}
          max={BOX_CREATE_CONCURRENCY.max}
          className={inputClass}
          value={s.boxCreateConcurrency}
          onChange={int("boxCreateConcurrency")}
          data-testid="box-create-concurrency"
        />
      </Row>
      <Row
        id={fid("spb")}
        label="Tasks running at once per box"
        help={`Tasks that may run at the same time inside one box, every project's together (each task runs its own Claude Code agent). A project's own Tasks running at once (project settings) limits only its own tasks within this. Unless set here, each box uses its own size's default: ${WORKER_SIZES.map((z) => `${z} ${SIZE_DEFAULTS[z].slotsPerBox}`).join(", ")}.`}
        hint={hint("slotsPerBox")}
      >
        <BoxLimitInput id={fid("spb")} max={20} {...limitField("slotsPerBox")} />
      </Row>
      <Row id={fid("ma")} label="Max tasks running at once" help="A cap on tasks running at once across all boxes. 0 = boxes × tasks running at once per box." hint={hint("maxAgents")}>
        <input id={fid("ma")} type="number" min={0} max={1000} className={inputClass} value={s.maxAgents} onChange={int("maxAgents")} />
      </Row>
      <Row
        id={fid("la")}
        label="Tasks running at once on this computer"
        help={`Tasks of projects that run on this computer (project settings › Runs on) that may run at once here, every project's together; a project's own Tasks running at once limits only its own tasks within this. They have their own queue: they never take a box slot or count toward Max tasks running at once. Each task works in its own folder in ${server.data?.localDir ?? "~/boxyard-workspaces"} (BOXYARD_LOCAL_DIR). ${LOCAL_UNSANDBOXED}`}
        hint={hint("localAgents")}
      >
        <input
          id={fid("la")}
          type="number"
          min={LOCAL_AGENTS_LIMITS.min}
          max={LOCAL_AGENTS_LIMITS.max}
          className={inputClass}
          value={s.localAgents}
          onChange={int("localAgents")}
          data-testid="local-agents"
        />
      </Row>
      <Row
        id={fid("mr")}
        label="Task folders kept per box"
        help={`Task folders kept on one box (running or not) before older archived workspaces are parked. Unless set here, each box uses its own size's default: ${WORKER_SIZES.map((z) => `${z} ${SIZE_DEFAULTS[z].maxResidentPerBox}`).join(", ")}.`}
        hint={hint("maxResidentPerBox")}
      >
        <BoxLimitInput id={fid("mr")} max={200} {...limitField("maxResidentPerBox")} />
      </Row>
      <Row id={fid("bid")} label="Idle box deletion" help="Delete an idle worker box after this many minutes, but only when every resident workspace has a fresh archive. 0 keeps boxes." hint={hint("boxIdleDeleteMinutes")}>
        <input id={fid("bid")} type="number" min={0} max={43_200} className={inputClass} value={s.boxIdleDeleteMinutes} onChange={int("boxIdleDeleteMinutes")} />
      </Row>
      <Row
        id={fid("wrd")}
        label="Workspace retention"
        help="After this many idle days, archived resting task folders are removed from boxes and restored from the archive on the next message. 0 keeps folders."
        hint={hint("workspaceRetentionDays")}
      >
        <input id={fid("wrd")} type="number" min={0} max={3650} className={inputClass} value={s.workspaceRetentionDays} onChange={int("workspaceRetentionDays")} />
      </Row>
      <Row
        id={fid("ard")}
        label="Archive retention"
        help="After this many days, orphan archives and long-done task archives are pruned. Archives of tasks with an open or unmerged PR are always kept. A done task whose archive was pruned restarts from a recap on its next message. 0 keeps archives."
        hint={hint("archiveRetentionDays")}
      >
        <input id={fid("ard")} type="number" min={0} max={3650} className={inputClass} value={s.archiveRetentionDays} onChange={int("archiveRetentionDays")} />
      </Row>
      <Row
        id={fid("akt")}
        label="Keep recent archives"
        help="Never prune the archive of a task touched in the last this many days, so recent work resumes with its full session. 0 = only archive retention applies."
        hint={hint("archiveKeepTouchedDays")}
      >
        <input id={fid("akt")} type="number" min={0} max={3650} className={inputClass} value={s.archiveKeepTouchedDays} onChange={int("archiveKeepTouchedDays")} />
      </Row>
      <Row
        id={fid("dmf")}
        label="Disk headroom (MB)"
        help="A new workspace only lands on a box with at least this much free disk. A box below it is cleaned up in the background while tasks go to another box."
        hint={hint("diskMinFreeMb")}
      >
        <input id={fid("dmf")} type="number" min={0} max={1_000_000} step={128} className={inputClass} value={s.diskMinFreeMb} onChange={int("diskMinFreeMb")} />
      </Row>
      <Row
        id={fid("dcf")}
        label="Clone size factor"
        help="...and at least this many times the repo's last clone size, for big repos (the clone plus the box's shared mirror of it)."
        hint={hint("diskCloneFactor")}
      >
        <input
          id={fid("dcf")}
          type="number"
          min={1}
          max={20}
          step={0.5}
          className={inputClass}
          value={s.diskCloneFactor}
          onChange={(e) => set("diskCloneFactor", Number(e.target.value))}
        />
      </Row>
      <Row
        id={fid("mup")}
        label="Memory limit (% used)"
        help="A new agent skips a box with more than this much of its memory in use while other agents run on it, and goes to another box (or waits). Memory is read from the box's cgroup without the reclaimable page cache. 0 = off."
        hint={hint("memoryMaxUsedPercent")}
      >
        <input id={fid("mup")} type="number" min={0} max={100} step={5} className={inputClass} value={s.memoryMaxUsedPercent} onChange={int("memoryMaxUsedPercent")} data-testid="memory-max-used" />
      </Row>
      <Row id={fid("mmf")} label="Memory headroom (MB)" help="...or with less than this much memory free. 0 = off." hint={hint("memoryMinFreeMb")}>
        <input id={fid("mmf")} type="number" min={0} max={1_000_000} step={256} className={inputClass} value={s.memoryMinFreeMb} onChange={int("memoryMinFreeMb")} />
      </Row>
      <Row
        id={fid("lpc")}
        label="Load limit (per CPU)"
        help="...or with a 1-minute load average above this many times its CPUs (nproc). On Upstash, /proc/loadavg and nproc describe the host the box runs on. 0 = off."
        hint={hint("loadMaxPerCpu")}
      >
        <input
          id={fid("lpc")}
          type="number"
          min={0}
          max={100}
          step={0.5}
          className={inputClass}
          value={s.loadMaxPerCpu}
          onChange={(e) => set("loadMaxPerCpu", Number(e.target.value))}
        />
      </Row>
      <Row
        id={fid("bci")}
        label="Build output cleanup (idle minutes)"
        help="Once a task's turn has ended and it has sat idle this long, its git-ignored build output (node_modules, dist, .cache, tmp, perf captures) is removed from the box. Only folders git ignores and doesn't track; uncommitted work is never touched. 0 = off (low-disk cleanup still runs)."
        hint={hint("buildCleanupIdleMinutes")}
      >
        <input id={fid("bci")} type="number" min={0} max={43_200} className={inputClass} value={s.buildCleanupIdleMinutes} onChange={int("buildCleanupIdleMinutes")} />
      </Row>
      <Row
        id={fid("dce")}
        label="Dependency cache (npm)"
        help="Each box keeps the node_modules its agents installed, one per package-lock.json, next to the task folders. A task with that lockfile and no node_modules (a fresh clone, or one the build output cleanup emptied) gets it hard-linked in before its turn, in under a second, and its prompt says it needn't run npm ci. The shared files are read-only, so a task can't change another's. A project can override it."
        hint={hint("depCacheEnabled")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
          <input id={fid("dce")} type="checkbox" checked={s.depCacheEnabled} onChange={(e) => set("depCacheEnabled", e.target.checked)} data-testid="dep-cache" />
          {s.depCacheEnabled ? "On: node_modules restored from the box cache" : "Off: agents install dependencies"}
        </label>
      </Row>
      <Row
        id={fid("dcm")}
        label="Dependency cache size (MB)"
        help="Most work-disk space one box's cache may hold. Over it, the least recently used lockfiles no task links go first. Low-disk cleanup also removes entries no task links."
        hint={hint("depCacheMaxMb")}
      >
        <input id={fid("dcm")} type="number" min={100} max={1_000_000} step={256} className={inputClass} value={s.depCacheMaxMb} disabled={!s.depCacheEnabled} onChange={(e) => set("depCacheMaxMb", Number(e.target.value))} data-testid="dep-cache-max" />
      </Row>
      <Row
        id={fid("gpc")}
        label="Partial clone mirrors"
        help="Each box keeps one mirror per repo, and task checkouts borrow its objects instead of copying them. With this on, mirrors skip old file versions (git clone --filter=blob:none); git fetches one from GitHub when log -p, blame or a checkout needs it. A project can override it."
        hint={hint("gitPartialClone")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
          <input id={fid("gpc")} type="checkbox" checked={s.gitPartialClone} onChange={(e) => set("gitPartialClone", e.target.checked)} data-testid="git-partial-clone" />
          {s.gitPartialClone ? "On: blob:none mirrors" : "Off: full mirrors"}
        </label>
      </Row>
      <Row
        id={fid("gpt")}
        label="Push at turn end"
        help="After every agent turn in a repo project, Box Yard pushes the task's branch and saves uncommitted work (untracked files too) to a hidden ref on origin, refs/boxyard/wip/<task>, without committing in the task's repo. Archives then carry only what git can't, so a box can go at any time without losing code. Without write access it quietly keeps full archives. A project can override it."
        hint={hint("gitPushAtTurnEnd")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
          <input id={fid("gpt")} type="checkbox" checked={s.gitPushAtTurnEnd} onChange={(e) => set("gitPushAtTurnEnd", e.target.checked)} data-testid="git-push-at-turn-end" />
          {s.gitPushAtTurnEnd ? "On: branch and WIP pushed, small archives" : "Off: full archives"}
        </label>
      </Row>
      <div className="mt-2 space-y-2 rounded-xl border border-zinc-900 bg-zinc-900/40 p-4 text-xs leading-relaxed text-zinc-400">
        <p>
          With these limits, up to <span className="font-medium text-zinc-100 tabular-nums">{capacity}</span> {capacity === 1 ? "task runs" : "tasks run"} at once on up to{" "}
          <span className="font-medium text-zinc-100 tabular-nums">{s.maxBoxes}</span> {s.maxBoxes === 1 ? "box" : "boxes"}.
        </p>
        <p>Saved changes apply right away. Lowering a limit never stops running boxes or tasks: no new work is placed until usage drops.</p>
        {upstash && (
          <p className={cx(s.maxBoxes > UPSTASH_FREE_CONCURRENT_BOXES && "text-amber-300")}>
            Free plan: up to {UPSTASH_FREE_CONCURRENT_BOXES} concurrent boxes (
            <NewTabLink className="text-sky-400 hover:underline" href="https://upstash.com/pricing/box">
              Upstash Box pricing
            </NewTabLink>
            ).
          </p>
        )}
      </div>
    </Panel>
  )
}

/** Tasks running at once and task folders kept per box for each worker size, so a small box's lower capacity is visible. */
type BoxLimitKey = "slotsPerBox" | "maxResidentPerBox"

/**
 * Tasks running at once or task folders kept per box. While each box follows its own size, the field shows every size's default
 * instead of one number; typing a number overrides it for every box. A value saved here gets a "Use size default"
 * button, and one set by env says how to remove it.
 */
export function BoxLimitInput({
  id,
  k,
  max,
  value,
  current,
  source,
  changed,
  onValue,
  pin,
  onReset,
  pendingReset = false,
}: {
  id: string
  k: BoxLimitKey
  max: number
  value: number
  current?: number
  source?: SettingSource
  changed: boolean
  onValue: (v: number) => void
  pin: (on: boolean) => void
  onReset: () => void
  /** "Use size default" was pressed; Save forgets the saved value. */
  pendingReset?: boolean
}) {
  // What's typed while focused, so the field can be empty mid-edit without the number snapping back.
  const [text, setText] = useState<string | null>(null)
  const atDefault = pendingReset || (source === "default" && !changed)
  const sizes = boxLimitDefaults(k)
  const env = SETTING_ENV[k]
  const shown = text ?? (atDefault ? "" : String(value))
  return (
    <>
      <input
        id={id}
        type="number"
        min={1}
        max={max}
        className={cx(inputClass, atDefault && "placeholder:text-zinc-300!")}
        value={shown}
        placeholder={atDefault ? sizes : undefined}
        aria-description={atDefault ? `Each box uses its size's default: ${sizes}` : undefined}
        data-testid={`limit-${k}`}
        onChange={(e) => {
          const t = e.target.value
          setText(t)
          const n = Number(t)
          if (t === "" || !Number.isInteger(n) || n < 1 || n > max) return
          onValue(n)
          if (source === "default") pin(true)
        }}
        onBlur={() => {
          // An emptied field drops the edit: back to the saved value, or to the size defaults.
          if (text === "" && current !== undefined) {
            onValue(current)
            pin(false)
          }
          setText(null)
        }}
      />
      {source === "ui" && !changed && (
        <Button type="button" variant="subtle" size="sm" className="w-full sm:w-auto" onClick={onReset} data-testid={`use-size-default-${k}`}>
          Use size default
        </Button>
      )}
      {source === "env" && !changed && env && (
        <p className="text-xs leading-relaxed text-zinc-500" data-testid={`env-note-${k}`}>
          To use each box's size default ({sizes}), remove <code className="font-mono text-zinc-400">{env}</code> from .env (and from the shell or deploy env) and
          restart Box Yard.
        </p>
      )}
    </>
  )
}

/** "small 1 · medium 2 · large 4" */
export function boxLimitDefaults(k: BoxLimitKey) {
  return WORKER_SIZES.map((z) => `${z} ${SIZE_DEFAULTS[z][k]}`).join(" · ")
}

function SizeCapacityTable({ s, sources, changed }: { s: Settings; sources?: Record<keyof Settings, SettingSource>; changed: (keyof Settings)[] }) {
  const rows = sizeCapacities(s, sources, { slotsPerBox: changed.includes("slotsPerBox"), maxResidentPerBox: changed.includes("maxResidentPerBox") })
  const overridden = rows[0]!.slotsOverridden || rows[0]!.residentOverridden
  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-zinc-900 text-xs" data-testid="size-capacity">
      <table className="w-full text-left tabular-nums">
        <thead className="bg-zinc-900/60 text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">Worker size</th>
            <th className="px-3 py-2 font-medium">Tasks running at once per box</th>
            <th className="px-3 py-2 font-medium">Task folders kept per box</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.size} className={cx("border-t border-zinc-900", r.current ? "bg-yard-500/10 text-zinc-100" : "text-zinc-400")}>
              <td className="px-3 py-2 capitalize">
                {r.size}
                {r.current && <span className="ml-2 rounded bg-yard-500/20 px-1.5 py-px text-[10px] text-yard-300 normal-case">in use</span>}
              </td>
              <td className="px-3 py-2">
                {r.slotsPerBox}
                {r.slotsOverridden && r.slotsPerBox !== r.defaults.slotsPerBox && <span className="ml-1 text-zinc-600">(size default {r.defaults.slotsPerBox})</span>}
              </td>
              <td className="px-3 py-2">
                {r.maxResidentPerBox}
                {r.residentOverridden && r.maxResidentPerBox !== r.defaults.maxResidentPerBox && (
                  <span className="ml-1 text-zinc-600">(size default {r.defaults.maxResidentPerBox})</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-zinc-900 px-3 py-2 leading-relaxed text-zinc-500">
        {overridden
          ? "Your saved or env values below replace the size defaults for every size."
          : `Each box uses its own size's values: a small box runs ${SIZE_DEFAULTS.small.slotsPerBox} task at a time and keeps ${SIZE_DEFAULTS.small.maxResidentPerBox} task folders, a medium one ${SIZE_DEFAULTS.medium.slotsPerBox} and ${SIZE_DEFAULTS.medium.maxResidentPerBox}. Set the fields below to override them for every box.`}{" "}
        Before size-based defaults, every box ran {LEGACY_POOL_DEFAULTS.slotsPerBox} tasks at once and kept {LEGACY_POOL_DEFAULTS.maxResidentPerBox} folders.
      </p>
    </div>
  )
}

function CostsPanel({
  s,
  set,
  hint,
  fid,
}: {
  s: Settings
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  hint: (k: keyof Settings) => ReactNode
  fid: (k: string) => string
}) {
  const money = (value: number, onChange: (n: number) => void, id?: string) => (
    <input
      id={id}
      type="number"
      min={0}
      step={0.01}
      className={inputClass}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
  const sizeLabel: Record<BoxSize, string> = { small: "Small", medium: "Medium", large: "Large" }
  // A server older than this UI sends no cost settings and would reject saving them.
  if (!s.costRates || !s.budget)
    return (
      <Panel section="costs">
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
          The server is running an older build without cost settings. Rebuild and restart it to set rates and budgets.
        </div>
      </Panel>
    )
  return (
    <Panel section="costs">
      <Row
        label="Active CPU rates"
        help="Estimated Upstash Box active CPU cost per hour. Defaults match the public Small / Medium / Large rates."
        hint={hint("costRates")}
      >
        <div className="grid grid-cols-3 gap-2">
          {BOX_SIZES.map((size) => (
            <label key={size} className="space-y-1">
              <span className="text-[11px] text-zinc-500">{sizeLabel[size]}</span>
              {money(s.costRates.boxActiveCpuHourlyUsd[size], (n) =>
                set("costRates", { ...s.costRates, boxActiveCpuHourlyUsd: { ...s.costRates.boxActiveCpuHourlyUsd, [size]: n } }),
              )}
            </label>
          ))}
        </div>
      </Row>
      <Row
        label="Keep-alive rates"
        help="Monthly keep-alive rates, prorated by box uptime when a provider reports keep-alive is enabled."
        hint={hint("costRates")}
      >
        <div className="grid grid-cols-3 gap-2">
          {BOX_SIZES.map((size) => (
            <label key={size} className="space-y-1">
              <span className="text-[11px] text-zinc-500">{sizeLabel[size]}</span>
              {money(s.costRates.boxKeepAliveMonthlyUsd[size], (n) =>
                set("costRates", { ...s.costRates, boxKeepAliveMonthlyUsd: { ...s.costRates.boxKeepAliveMonthlyUsd, [size]: n } }),
              )}
            </label>
          ))}
        </div>
      </Row>
      <Row id={fid("storage")} label="Storage rate" help="Storage and snapshot cost per GB-month. Disk use is probed from boxes when available." hint={hint("costRates")}>
        {money(s.costRates.boxStorageGbMonthUsd, (n) => set("costRates", { ...s.costRates, boxStorageGbMonthUsd: n }), fid("storage"))}
      </Row>
      <Row id={fid("daily-budget")} label="Daily budget" help="0 disables the daily budget. At 80% Box Yard warns; at 100% queued agent turns pause." hint={hint("budget")}>
        {money(s.budget.dailyUsd, (n) => set("budget", { ...s.budget, dailyUsd: n }), fid("daily-budget"))}
      </Row>
      <Row id={fid("monthly-budget")} label="Monthly budget" help="0 disables the 30-day budget window. Raising this value resumes queued turns immediately." hint={hint("budget")}>
        {money(s.budget.monthlyUsd, (n) => set("budget", { ...s.budget, monthlyUsd: n }), fid("monthly-budget"))}
      </Row>
      <div className="mt-2 rounded-xl border border-zinc-900 bg-zinc-900/40 p-4 text-xs leading-relaxed text-zinc-400">
        Claude Code costs come from the CLI's result JSON. Box costs use provider usage when exposed by the API; otherwise active CPU and storage are labeled estimates.
      </div>
    </Panel>
  )
}

function NotificationsPanel({ fid }: { fid: (k: string) => string }) {
  const [saved, setSaved] = useState(browserNotificationsOn)
  const [denied, setDenied] = useState(false)
  const supported = browserNotificationsSupported()
  // Turning them on asks the browser for permission when Save is pressed (still inside the click).
  const [on, setOn] = useDraft("browser-notifications", "notifications", saved, async (want: boolean) => {
    const now = await setBrowserNotifications(want)
    setSaved(now)
    setDenied(want && !now)
  })
  // Sound on send is saved in this browser; the row previews the draft.
  const [sound, setSound] = useDraft("send-sound", "notifications", useSendSound(), setSendSound)
  return (
    <Panel section="notifications">
      <Row
        id={fid("bn")}
        label="Browser notifications"
        help="A system notification when a task finishes or needs you while this tab is in the background. In-app toasts and the sidebar's Recent list work either way."
        hint={
          denied ? (
            <span className="text-xs text-amber-300">The browser blocked notifications for this site. Allow them in the site settings, then try again.</span>
          ) : !supported ? (
            <span className="text-xs text-zinc-500">This browser doesn't support notifications.</span>
          ) : undefined
        }
      >
        <label className="flex items-center gap-2 text-sm text-zinc-200">
          <input
            id={fid("bn")}
            type="checkbox"
            disabled={!supported}
            checked={on}
            onChange={(e) => {
              setOn(e.target.checked)
              setDenied(false)
            }}
          />
          {on ? "On" : "Off"}
        </label>
      </Row>
      <SendSoundRow fid={fid} value={sound} onChange={setSound} />
    </Panel>
  )
}

function AboutRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-8 gap-y-1 border-t border-zinc-900 py-3 first:border-t-0 first:pt-0 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <dt className="text-sm text-zinc-400">{label}</dt>
      <dd className="min-w-0 text-sm break-words text-zinc-100">{children}</dd>
    </div>
  )
}

function AboutPanel() {
  const health = useHealth()
  const server = useSettings()
  const h = health.data
  const link = "inline-flex items-center gap-1 text-sky-400 hover:underline"
  return (
    <Panel section="about">
      <dl>
        <AboutRow label="Version">
          <span className="font-mono">{__APP_VERSION__}</span>
          {__APP_COMMIT__ && (
            <NewTabLink className={cx(link, "ml-2 font-mono")} href={`https://github.com/webdevcody/box-yard/commit/${__APP_COMMIT__}`}>
              {__APP_COMMIT__}
            </NewTabLink>
          )}
        </AboutRow>
        <AboutRow label="Box provider">
          {h?.provider ?? "…"}
          {h?.mock && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-px text-[11px] text-amber-300">mock mode</span>}
        </AboutRow>
        <AboutRow label="Claude CLI">{h ? (h.claude.available ? <span className="font-mono">{h.claude.version}</span> : <span className="text-red-300">not found</span>) : "…"}</AboutRow>
        <AboutRow label="Event bus">{h ? (h.bus === "redis" ? "Upstash Redis" : "Local files") : "…"}</AboutRow>
        <AboutRow label="Scheduler">{h ? (h.scheduler === "qstash" ? "QStash + server timer" : "Server timer") : "…"}</AboutRow>
        <AboutRow label="Default time zone">{server.data?.defaultTimezone ?? "…"}</AboutRow>
        <AboutRow label="Max upload">{server.data ? `${server.data.maxUploadMb} MB` : "…"}</AboutRow>
        <AboutRow label="Links">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <NewTabLink className={link} href="https://github.com/webdevcody/box-yard">
              GitHub <ExternalLink className="h-3 w-3" />
            </NewTabLink>
            <NewTabLink className={link} href="https://upstash.com/docs/box">
              Upstash Box docs <ExternalLink className="h-3 w-3" />
            </NewTabLink>
            <NewTabLink className={link} href="https://console.upstash.com">
              Upstash console <ExternalLink className="h-3 w-3" />
            </NewTabLink>
          </div>
        </AboutRow>
      </dl>
      <p className="mt-6 text-xs text-zinc-500">Time zone, upload size, provider and data directory come from env vars on the server (see the README).</p>
    </Panel>
  )
}

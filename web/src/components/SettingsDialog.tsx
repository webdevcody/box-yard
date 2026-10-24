import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { useSearchParams } from "wouter"
import { Bell, Bot, Boxes, Check, DollarSign, ExternalLink, Info, Network, Volume2, Webhook, type LucideIcon } from "lucide-react"
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
import { LEGACY_POOL_DEFAULTS, sizeCapacities } from "../lib/capacity"
import { browserNotificationsOn, browserNotificationsSupported, setBrowserNotifications } from "../lib/notifications"
import { withParam } from "./TaskFilters"
import { VoicePanel } from "./VoiceSettings"
import { HooksPanel } from "./Hooks"
import { Modal } from "./Modal"
import { confirmDialog } from "../lib/confirm"
import { Button, NewTabLink, Select, cx, inputClass } from "./ui"
import {
  AUTOCOMPACT_MAX_TOKENS,
  AUTOCOMPACT_MIN_TOKENS,
  BOX_SIZES,
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

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]
const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" }

const SECTION_ICON: Record<SettingsSection, LucideIcon> = { orchestrator: Network, agents: Bot, hooks: Webhook, limits: Boxes, costs: DollarSign, notifications: Bell, voice: Volume2, about: Info }

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

function SourceHint({ source, env, changed }: { source?: SettingSource; env?: string; changed: boolean }) {
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

function AutoCompactControl({ id, label, value, onChange }: { id: string; label: string; value: AutoCompact; onChange: (v: AutoCompact) => void }) {
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
            onChange({ ...value, unit, value: unit === "percent" ? 80 : 800_000 })
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
  const [draft, setDraft] = useState<Settings | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const ids = useId()
  const navRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const current = info.data
  const s = draft ?? current?.settings
  const changed = changedKeys(draft, current?.settings)
  const dirty = changed.length > 0
  const dirtySections = changedSections(changed)

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => s && setDraft({ ...s, [k]: v })
  const hint = (k: keyof Settings) => <SourceHint source={current?.sources[k]} env={SETTING_ENV[k]} changed={changed.includes(k)} />
  const fid = (k: string) => `${ids}-${k}`

  const close = async () => {
    if (
      dirty &&
      !(await confirmDialog({ title: "Discard unsaved changes?", body: "Your edits to settings haven't been saved.", confirmLabel: "Discard", danger: true }))
    )
      return
    onClose()
  }

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

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!s || !dirty) return
    save.mutate(savePatch(s, current?.settings), {
      onSuccess: () => {
        setDraft(null)
        setSavedAt(Date.now())
      },
    })
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
              }).then((ok) => ok && reset.mutate(undefined, { onSuccess: () => setDraft(null) }))
            }}
            title="Forget saved values: env vars and defaults apply again"
          >
            Reset to defaults
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row sm:items-center sm:gap-3">
            {dirty ? (
              <span className="text-xs text-amber-300" role="status">
                {changed.length === 1 ? "1 unsaved change" : `${changed.length} unsaved changes`}
              </span>
            ) : savedAt ? (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-400" role="status">
                <Check className="h-3.5 w-3.5" /> Saved
              </span>
            ) : null}
            {dirty && (
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                Discard
              </Button>
            )}
            {!dirty && (
              <Button type="button" variant="ghost" onClick={onClose}>
                Close
              </Button>
            )}
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!s || !dirty}>
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
        {section === "about" ? (
          <AboutPanel />
        ) : section === "notifications" ? (
          <NotificationsPanel fid={fid} />
        ) : section === "voice" ? (
          <VoicePanel fid={fid} />
        ) : section === "hooks" ? (
          <Panel section="hooks">
            <HooksPanel projectId={null} />
          </Panel>
        ) : !s ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : section === "orchestrator" ? (
          <Panel section="orchestrator">
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
              help="Compacts between turns once context usage passes this. A summary is saved to the compaction log first. Off: only the CLI's own last-resort compaction near the window limit."
              hint={hint("orchestratorAutoCompact")}
            >
              <AutoCompactControl
                id={fid("oac")}
                label="Coordinator auto-compact"
                value={s.orchestratorAutoCompact}
                onChange={(v) => set("orchestratorAutoCompact", v)}
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
          </Panel>
        ) : section === "agents" ? (
          <Panel section="agents">
            <Row id={fid("am")} label="Model" help="The Claude model each task's agent runs on." hint={hint("agentModel")}>
              <input id={fid("am")} className={inputClass} list="boxyard-models" value={s.agentModel} onChange={(e) => set("agentModel", e.target.value)} />
            </Row>
            <Row
              id={fid("ae")}
              label="Effort"
              help={
                s.agentEffort === "orchestrator"
                  ? "The Coordinator picks an effort in create_task and send_to_task: low for one-command chores, high for real coding."
                  : "Every agent turn uses this effort."
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
              help="Optional rules the orchestrator reads when choosing a task model and effort. Also works from routing.yaml in the data directory."
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
          <LimitsPanel s={s} set={set} hint={hint} fid={fid} sources={current?.sources} changed={changed} />
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
}: {
  s: Settings
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  hint: (k: keyof Settings) => ReactNode
  fid: (k: string) => string
  sources?: Record<keyof Settings, SettingSource>
  changed: (keyof Settings)[]
}) {
  const health = useHealth()
  const int =
    (k: "maxBoxes" | "slotsPerBox" | "maxAgents" | "maxResidentPerBox" | "boxIdleDeleteMinutes" | "workspaceRetentionDays" | "archiveRetentionDays" | "archiveKeepTouchedDays" | "diskMinFreeMb") =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      set(k, Math.trunc(Number(e.target.value)))
  const capacity = agentCapacity(s)
  const upstash = health.data?.provider === "upstash"
  const sizeDefault = SIZE_DEFAULTS[s.workerSize]
  return (
    <Panel section="limits">
      <Row
        id={fid("ws")}
        label="Worker size"
        help="Upstash Box size for newly created boxes. Existing boxes keep the size they were created with."
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
      <SizeCapacityTable s={s} sources={sources} changed={changed} />
      <Row id={fid("mb")} label="Max boxes" help="Most worker boxes alive at once." hint={hint("maxBoxes")}>
        <input id={fid("mb")} type="number" min={1} max={100} className={inputClass} value={s.maxBoxes} onChange={int("maxBoxes")} />
      </Row>
      <Row
        id={fid("spb")}
        label="Agents per box"
        help={`Claude turns that may run at the same time inside one box. Default for ${s.workerSize}: ${sizeDefault.slotsPerBox}.`}
        hint={hint("slotsPerBox")}
      >
        <input id={fid("spb")} type="number" min={1} max={20} className={inputClass} value={s.slotsPerBox} onChange={int("slotsPerBox")} />
      </Row>
      <Row id={fid("ma")} label="Max agents" help="A cap on agents running at once across all boxes. 0 = boxes × agents per box." hint={hint("maxAgents")}>
        <input id={fid("ma")} type="number" min={0} max={1000} className={inputClass} value={s.maxAgents} onChange={int("maxAgents")} />
      </Row>
      <Row
        id={fid("mr")}
        label="Resident tasks per box"
        help={`Task folders kept on one box before older archived workspaces are parked. Default for ${s.workerSize}: ${sizeDefault.maxResidentPerBox}.`}
        hint={hint("maxResidentPerBox")}
      >
        <input id={fid("mr")} type="number" min={1} max={200} className={inputClass} value={s.maxResidentPerBox} onChange={int("maxResidentPerBox")} />
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
      <div className="mt-2 space-y-2 rounded-xl border border-zinc-900 bg-zinc-900/40 p-4 text-xs leading-relaxed text-zinc-400">
        <p>
          With these limits, up to <span className="font-medium text-zinc-100 tabular-nums">{capacity}</span> {capacity === 1 ? "agent runs" : "agents run"} at once on up to{" "}
          <span className="font-medium text-zinc-100 tabular-nums">{s.maxBoxes}</span> {s.maxBoxes === 1 ? "box" : "boxes"}.
        </p>
        <p>Changes apply right away. Lowering a limit never stops running boxes or agents: no new work is placed until usage drops.</p>
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

/** Agents and resident folders per box for each worker size, so a small box's lower capacity is visible. */
function SizeCapacityTable({ s, sources, changed }: { s: Settings; sources?: Record<keyof Settings, SettingSource>; changed: (keyof Settings)[] }) {
  const rows = sizeCapacities(s, sources, { slotsPerBox: changed.includes("slotsPerBox"), maxResidentPerBox: changed.includes("maxResidentPerBox") })
  const overridden = rows[0]!.slotsOverridden || rows[0]!.residentOverridden
  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-zinc-900 text-xs" data-testid="size-capacity">
      <table className="w-full text-left tabular-nums">
        <thead className="bg-zinc-900/60 text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">Worker size</th>
            <th className="px-3 py-2 font-medium">Agents per box</th>
            <th className="px-3 py-2 font-medium">Resident tasks per box</th>
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
          : `Values come from the worker size: small boxes run ${SIZE_DEFAULTS.small.slotsPerBox} agent at a time and keep ${SIZE_DEFAULTS.small.maxResidentPerBox} task folders. Set the fields below to override.`}{" "}
        Before size-based defaults, every box ran {LEGACY_POOL_DEFAULTS.slotsPerBox} agents and kept {LEGACY_POOL_DEFAULTS.maxResidentPerBox} folders.
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
  const [on, setOn] = useState(browserNotificationsOn)
  const [denied, setDenied] = useState(false)
  const supported = browserNotificationsSupported()
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
            onChange={async (e) => {
              const want = e.target.checked
              const now = await setBrowserNotifications(want)
              setOn(now)
              setDenied(want && !now)
            }}
          />
          {on ? "On" : "Off"}
        </label>
      </Row>
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

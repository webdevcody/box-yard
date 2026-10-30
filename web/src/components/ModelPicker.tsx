// The one model picker and effort picker every model/effort choice uses (Settings › Coordinator and Box agents, the
// New task dialog): the CLI's models grouped as Latest / Aliases / Older plus a custom model ID, and effort levels
// greyed out where the chosen model doesn't take them, with a line saying what the CLI runs instead.
import { useState, type ReactNode } from "react"
import { AlertTriangle } from "lucide-react"
import { EFFORTS } from "../../../shared/types"
import { EFFORT_LABEL, MODEL_GROUP_LABEL, checkEffort, findModel, type ClaudeModel, type ModelGroup } from "../../../shared/models"
import { useModels } from "../lib/queries"
import { LineIcon, Select, cx, inputClass } from "./ui"

const CUSTOM = "\u0000custom"
const GROUPS: ModelGroup[] = ["latest", "alias", "older"]

const optionText = (m: ClaudeModel) => (m.group === "alias" ? `${m.id}${m.note ? ` · ${m.note}` : ""}` : `${m.label} · ${m.id}`)

/**
 * A model choice. `value` is what `claude --model` gets; one the list doesn't have shows as "Custom model ID" with a
 * text field. `defaultLabel` adds a leading "" option (e.g. "Default (claude-opus-5-5)") for "use the default".
 */
export function ModelPicker({
  id,
  value,
  onChange,
  defaultLabel,
  className,
  testId,
  disabled,
  ariaLabel,
}: {
  id?: string
  value: string
  onChange: (model: string) => void
  defaultLabel?: string
  className?: string
  testId?: string
  disabled?: boolean
  ariaLabel?: string
}) {
  const models = useModels()
  const listed = value === "" ? defaultLabel !== undefined : models.some((m) => m.id === value)
  const [customOpen, setCustomOpen] = useState(false)
  const custom = customOpen || !listed
  const note = custom ? null : findModel(models, value)?.note
  return (
    <div className={cx("space-y-1.5", className)}>
      <Select
        id={id}
        className="w-full"
        value={custom ? CUSTOM : value}
        title={note ?? undefined}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
        onChange={(e) => {
          if (e.target.value === CUSTOM) return setCustomOpen(true)
          setCustomOpen(false)
          onChange(e.target.value)
        }}
      >
        {defaultLabel !== undefined && <option value="">{defaultLabel}</option>}
        {GROUPS.map((g) => {
          const rows = models.filter((m) => m.group === g)
          return rows.length ? (
            <optgroup key={g} label={MODEL_GROUP_LABEL[g]}>
              {rows.map((m) => (
                <option key={m.id} value={m.id}>
                  {optionText(m)}
                </option>
              ))}
            </optgroup>
          ) : null
        })}
        <option value={CUSTOM}>Custom model ID…</option>
      </Select>
      {custom && (
        <input
          className={cx(inputClass, "font-mono disabled:opacity-50")}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="claude-opus-5-5, opus[1m]…"
          aria-label="Custom model ID"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          data-testid={testId && `${testId}-custom`}
        />
      )}
    </div>
  )
}

/**
 * An effort choice for `model` (no warning while `disabled`: that choice doesn't run). Levels the model doesn't take are greyed out (still shown, and still selectable when
 * already saved), and a warning says what the CLI runs instead. `lead` adds options before the levels (e.g. "Let the
 * Coordinator decide"); `effective` is the level that runs when one of those is picked, for the warning.
 */
export function EffortPicker({
  id,
  value,
  onChange,
  model,
  lead,
  effective,
  className,
  testId,
  disabled,
  ariaLabel,
}: {
  id?: string
  value: string
  onChange: (effort: string) => void
  model: string
  lead?: ReactNode
  effective?: string
  className?: string
  testId?: string
  disabled?: boolean
  ariaLabel?: string
}) {
  const models = useModels()
  const m = findModel(models, model)
  const check = checkEffort(models, model, effective ?? value)
  return (
    <div className={cx("space-y-1.5", className)}>
      <Select id={id} className="w-full" value={value} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        {lead}
        {EFFORTS.map((x) => {
          const takes = !m || m.efforts.includes(x)
          return (
            <option key={x} value={x} disabled={!takes && x !== value}>
              {EFFORT_LABEL[x]}
              {takes ? "" : ` (not on ${m!.label})`}
            </option>
          )
        })}
      </Select>
      {!check.ok && !disabled && (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-amber-300/90" role="status" data-testid={testId && `${testId}-warning`}>
          <LineIcon icon={AlertTriangle} className="h-3.5 w-3.5" />
          <span className="min-w-0">{check.message}</span>
        </p>
      )}
    </div>
  )
}

// Pure helpers for per-box capacity: what each worker size gives you, and the one-time
// notice for installs whose capacity fell below the pre-size-default values (#48).
import { SIZE_DEFAULTS, WORKER_SIZES, type SettingSource, type WorkerSize } from "../../../shared/types"

/** Pool defaults before they became size-based: every box ran 2 agents and kept 12 task folders. */
export const LEGACY_POOL_DEFAULTS = { slotsPerBox: 2, maxResidentPerBox: 12 } as const

export interface SizeCapacity {
  size: WorkerSize
  /** Agents per box that would apply with this size. */
  slotsPerBox: number
  maxResidentPerBox: number
  /** The size's own defaults (SIZE_DEFAULTS). */
  defaults: { slotsPerBox: number; maxResidentPerBox: number }
  /** True when a saved or env value replaces the size default. */
  slotsOverridden: boolean
  residentOverridden: boolean
  current: boolean
}

export interface CapacityInput {
  workerSize: WorkerSize
  slotsPerBox: number
  maxResidentPerBox: number
}

/**
 * Effective slots and resident limit for each worker size. A value is "overridden" when it was
 * saved in Settings or set by env (or edited in the form); otherwise the size default applies.
 */
export function sizeCapacities(
  s: CapacityInput,
  sources: Partial<Record<"slotsPerBox" | "maxResidentPerBox", SettingSource>> = {},
  edited: { slotsPerBox?: boolean; maxResidentPerBox?: boolean } = {},
): SizeCapacity[] {
  const slotsOverridden = Boolean(edited.slotsPerBox) || (sources.slotsPerBox !== undefined && sources.slotsPerBox !== "default")
  const residentOverridden = Boolean(edited.maxResidentPerBox) || (sources.maxResidentPerBox !== undefined && sources.maxResidentPerBox !== "default")
  return WORKER_SIZES.map((size) => {
    const defaults = SIZE_DEFAULTS[size]
    return {
      size,
      slotsPerBox: slotsOverridden ? s.slotsPerBox : defaults.slotsPerBox,
      maxResidentPerBox: residentOverridden ? s.maxResidentPerBox : defaults.maxResidentPerBox,
      defaults,
      slotsOverridden,
      residentOverridden,
      current: size === s.workerSize,
    }
  })
}

export interface CapacityNotice {
  /** A stable id for these values; dismissing stores it so the notice stays hidden. */
  key: string
  slotsPerBox: { now: number; was: number } | null
  maxResidentPerBox: { now: number; was: number } | null
  workerSize: WorkerSize
}

/** The notice to show when effective per-box capacity is below the old defaults, or null. */
export function capacityNotice(s: CapacityInput): CapacityNotice | null {
  const slots = s.slotsPerBox < LEGACY_POOL_DEFAULTS.slotsPerBox ? { now: s.slotsPerBox, was: LEGACY_POOL_DEFAULTS.slotsPerBox } : null
  const resident =
    s.maxResidentPerBox < LEGACY_POOL_DEFAULTS.maxResidentPerBox ? { now: s.maxResidentPerBox, was: LEGACY_POOL_DEFAULTS.maxResidentPerBox } : null
  if (!slots && !resident) return null
  return { key: `${s.slotsPerBox}/${s.maxResidentPerBox}`, slotsPerBox: slots, maxResidentPerBox: resident, workerSize: s.workerSize }
}

/** localStorage key holding the dismissed notice. */
export const CAPACITY_NOTICE_KEY = "boxyard:capacity-notice-dismissed"

/**
 * Whether to show the notice. It is one-time: any earlier dismissal hides it for good, so changing
 * limits later (Cody's own choice) doesn't bring it back.
 */
export function showCapacityNotice(notice: CapacityNotice | null, dismissed: string | null | undefined): notice is CapacityNotice {
  return Boolean(notice) && !dismissed
}

/** One sentence describing what dropped, e.g. "1 agent per box (was 2) and 3 resident task folders (was 12)". */
export function capacityNoticeText(n: CapacityNotice): string {
  const parts: string[] = []
  if (n.slotsPerBox) parts.push(`${n.slotsPerBox.now} ${n.slotsPerBox.now === 1 ? "agent" : "agents"} per box (was ${n.slotsPerBox.was})`)
  if (n.maxResidentPerBox)
    parts.push(`${n.maxResidentPerBox.now} resident task ${n.maxResidentPerBox.now === 1 ? "folder" : "folders"} per box (was ${n.maxResidentPerBox.was})`)
  return parts.join(" and ")
}

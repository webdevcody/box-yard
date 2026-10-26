// One Save for the whole Settings dialog. Nothing in it saves on change: every control edits a draft, the
// dialog's Save writes every draft, and Discard (or closing and discarding) drops them. Plain Settings fields
// live in the dialog's own draft; every other part (voice and dictation in this browser, the TTS provider and
// keys, credentials, RunPod, hook switches, browser notifications) keeps its own with useDraft, which registers
// it here so the Save button, the "N unsaved changes" line and each section's dot see it.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import type { SettingsSection } from "./settingsNav"

export interface DraftPart {
  /** The section whose nav entry gets the unsaved dot. */
  section: SettingsSection
  /** How many values differ from the saved ones (at least 1 while registered). */
  count: number
  /** Write the draft. Starts synchronously, so a permission prompt still counts as part of the Save click. */
  save: () => Promise<void>
  discard: () => void
}

export interface DraftRegistry {
  update(id: string, part: DraftPart | null): void
}

export const SettingsDraftContext = createContext<DraftRegistry | null>(null)

/** True inside the Settings dialog, where edits wait for its Save. */
export const useInSettingsDraft = () => useContext(SettingsDraftContext) !== null

const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** How many values `draft` changes: differing top-level fields of an object, else 0 or 1. */
export function draftChanges(draft: unknown, saved: unknown): number {
  if (plain(draft) && plain(saved)) return [...new Set([...Object.keys(draft), ...Object.keys(saved)])].filter((k) => !same(draft[k], saved[k])).length
  return same(draft, saved) ? 0 : 1
}

/** Adds and removes parts in a record, for the dialog's state. */
export function updateParts(parts: Record<string, DraftPart>, id: string, part: DraftPart | null): Record<string, DraftPart> {
  if (part) return { ...parts, [id]: part }
  if (!(id in parts)) return parts
  const { [id]: _gone, ...rest } = parts
  return rest
}

/**
 * A value edited as a draft in the Settings dialog: `[value, set, dirty]`. `value` is the draft, or `saved` while
 * nothing differs; `persist(draft)` runs only when the dialog's Save is pressed. Changing a value back to the saved
 * one makes it clean again. Outside the dialog there's no Save, so `set` persists right away.
 */
export function useDraft<T>(
  id: string,
  section: SettingsSection,
  saved: T,
  persist: (draft: T) => unknown,
  /** How many changes the draft holds, for "N unsaved changes" (default: draftChanges). */
  countChanges: (draft: T, saved: T) => number = draftChanges,
): [value: T, set: (next: T | ((prev: T) => T)) => void, dirty: boolean] {
  const registry = useContext(SettingsDraftContext)
  const [draft, setDraft] = useState<{ value: T } | null>(null)
  const value = draft ? draft.value : saved
  const count = draft ? countChanges(draft.value, saved) : 0
  const latest = useRef({ value, saved, persist })
  latest.current = { value, saved, persist }

  useEffect(() => {
    if (!registry) return
    registry.update(
      id,
      count
        ? {
            section,
            count,
            save: async () => {
              await latest.current.persist(latest.current.value)
              setDraft(null)
            },
            discard: () => setDraft(null),
          }
        : null,
    )
  }, [registry, id, section, count])
  useEffect(() => () => registry?.update(id, null), [registry, id])

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const cur = latest.current
      const v = typeof next === "function" ? (next as (prev: T) => T)(cur.value) : next
      latest.current = { ...cur, value: v }
      if (registry) setDraft({ value: v })
      // Errors surface where the caller shows them (a mutation's error, a toast).
      else Promise.resolve(cur.persist(v)).catch(() => {})
    },
    [registry],
  )
  return [value, set, count > 0]
}

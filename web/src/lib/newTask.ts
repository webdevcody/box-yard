// Drafts for the New task popover, one per place it opens from (a project, "any" where you pick the project, or
// a selected quote).
// Esc, a click outside or "More options" keeps the text; starting the task clears it. Kept in sessionStorage,
// so a reload keeps it but a new tab starts empty.

const KEY = "box-yard:new-task-draft:"
const memory = new Map<string, string>()

/** Where a draft belongs: the project the popover is for, or "any" when it has a project picker. */
export const draftScope = (projectId: string | null | undefined) => projectId ?? "any"

/** A selection's instructions are kept per quote, so another selection starts empty. */
export function selectionScope(text: string) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `selection:${(h >>> 0).toString(36)}`
}

export function loadDraft(scope: string): string {
  try {
    return sessionStorage.getItem(KEY + scope) ?? memory.get(scope) ?? ""
  } catch {
    return memory.get(scope) ?? ""
  }
}

export function saveDraft(scope: string, text: string) {
  if (text.trim()) memory.set(scope, text)
  else memory.delete(scope)
  try {
    if (text.trim()) sessionStorage.setItem(KEY + scope, text)
    else sessionStorage.removeItem(KEY + scope)
  } catch {
    // Storage full or blocked: the in-memory copy still lasts until a reload.
  }
}

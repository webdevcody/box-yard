// Up/Down in an empty composer walks back through the prompts sent from that chat, like a shell. The shown
// prompt is a gray ghost (nothing in the box's value, so a stray Enter can't send it); the first Enter makes it
// real, editable text and the next one sends. Each chat keeps its own list in this browser's localStorage:
// "coordinator", "captain:<projectId>" or "task:<taskId>". Pure apart from the injected storage, so it's unit tested.

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">

/** Prompts kept per chat. */
export const HISTORY_LIMIT = 50
/** Chats that keep a history; the one used longest ago is dropped past this, so old tasks don't fill storage. */
export const HISTORY_SCOPES = 100

const PREFIX = "boxyard:prompt-history:"
const INDEX_KEY = "boxyard:prompt-history"
export const promptHistoryKey = (scope: string) => PREFIX + scope

function readList(store: KV, key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(key) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/** The chat's sent prompts, newest first. */
export function readHistory(scope: string | undefined, store: KV = localStorage): string[] {
  return scope ? readList(store, promptHistoryKey(scope)) : []
}

/** Adds a sent prompt to the front, unless it repeats the newest one. */
export function rememberPrompt(scope: string | undefined, text: string, store: KV = localStorage) {
  const prompt = text.trim()
  if (!scope || !prompt) return
  try {
    const list = readHistory(scope, store)
    if (list[0] !== prompt) store.setItem(promptHistoryKey(scope), JSON.stringify([prompt, ...list].slice(0, HISTORY_LIMIT)))
    const scopes = readList(store, INDEX_KEY).filter((s) => s !== scope)
    scopes.unshift(scope)
    for (const old of scopes.splice(HISTORY_SCOPES)) store.removeItem(promptHistoryKey(old))
    store.setItem(INDEX_KEY, JSON.stringify(scopes))
  } catch {
    // Storage can be full or blocked; the prompt just isn't offered on Up.
  }
}

// ------------------------------------------------------------------ the keyboard state machine

/** The prompt shown as a ghost while browsing (`index` into the history, 0 = newest), or null. */
export type Browse = { index: number; text: string } | null

export type KeyLike = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">

export interface BrowseStep {
  /** The browse state after the key. */
  browse: Browse
  /** The key was used here: preventDefault, and don't send. */
  handled: boolean
  /** Enter took the shown prompt: put this in the box (caret at the end). */
  select?: string
}

/**
 * What a key press does to history browsing. `empty` is whether the box's value is empty; `history` is read only
 * when needed. Keys it doesn't handle (typing, Shift+Enter, Enter outside browsing) keep their normal meaning,
 * and the Composer ends browsing as soon as the value stops being empty.
 */
export function browseStep(browse: Browse, e: KeyLike, empty: boolean, history: () => string[]): BrowseStep {
  const stay: BrowseStep = { browse, handled: false }
  const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
  if (!empty) return browse ? { browse: null, handled: false } : stay
  switch (e.key) {
    case "ArrowUp": {
      if (!plain) return stay
      const list = history()
      if (!list.length) return stay
      const index = browse ? Math.min(browse.index + 1, list.length - 1) : 0
      return { browse: { index, text: list[index]! }, handled: true }
    }
    case "ArrowDown": {
      if (!plain || !browse) return stay
      const list = history()
      const index = Math.min(browse.index, list.length) - 1
      return { browse: index >= 0 ? { index, text: list[index]! } : null, handled: true }
    }
    case "Enter":
      if (!browse) return stay
      // Shift+Enter is a new line: start fresh with it, like any other typed key.
      if (e.shiftKey) return { browse: null, handled: false }
      return { browse: null, handled: true, select: browse.text }
    case "Escape":
      return browse ? { browse: null, handled: true } : stay
    case "Backspace":
    case "Delete":
      return browse ? { browse: null, handled: false } : stay
    default:
      return stay
  }
}

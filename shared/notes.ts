// Project notes are a small, curated set of lasting rules. Agents only suggest notes; the project's Captain
// (or the owner, on the Notes tab) decides what becomes one. This file holds the pure parts the server
// and the web app share: the injection budget and how notes and their authors read.
import type { ProjectNote } from "./types.js"

export interface NoteBudget {
  /** At most this many notes go into a prompt... */
  maxNotes: number
  /** ...and at most about this many tokens of them. */
  maxTokens: number
}

/** Longest note or suggestion Box Yard takes. Notes are rules, not reports. */
export const MAX_NOTE_CHARS = 4000

/** Settings' defaults: about 25 notes or 4k tokens. */
export const DEFAULT_NOTE_BUDGET: NoteBudget = { maxNotes: 25, maxTokens: 4000 }

/** A rough token count (about 4 characters a token), the same everywhere so the meter and the cap agree. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

/** How a note reads in a prompt. */
export const noteLine = (n: Pick<ProjectNote, "author" | "content">) => `- (${n.author}) ${n.content}`

/** A note's share of the budget: its whole prompt line. */
export const noteTokens = (n: Pick<ProjectNote, "author" | "content">) => estimateTokens(noteLine(n))

export interface NoteBudgetReport<T> {
  count: number
  tokens: number
  maxNotes: number
  maxTokens: number
  /** More notes, or more tokens of them, than the budget allows: the Captain should prune. */
  over: boolean
  /** The notes that go into prompts, in their original order. The newest are picked first. */
  shown: T[]
  /** The notes left out of prompts because they don't fit; empty unless `over`. */
  hidden: T[]
}

/**
 * Pick the notes a prompt gets. Under the budget that's all of them. Over it, the newest notes that fit go in
 * and the rest are reported as hidden, never dropped silently: the prompt says how many are left out, and the
 * Captain is told to prune.
 */
export function budgetNotes<T extends Pick<ProjectNote, "author" | "content">>(notes: T[], budget: NoteBudget): NoteBudgetReport<T> {
  const cost = notes.map(noteTokens)
  const tokens = cost.reduce((a, b) => a + b, 0)
  const base = { count: notes.length, tokens, maxNotes: budget.maxNotes, maxTokens: budget.maxTokens }
  if (notes.length <= budget.maxNotes && tokens <= budget.maxTokens) return { ...base, over: false, shown: notes, hidden: [] }
  const keep = new Set<number>()
  let used = 0
  for (let i = notes.length - 1; i >= 0 && keep.size < budget.maxNotes; i--) {
    if (used + cost[i]! > budget.maxTokens) continue
    keep.add(i)
    used += cost[i]!
  }
  return { ...base, over: true, shown: notes.filter((_, i) => keep.has(i)), hidden: notes.filter((_, i) => !keep.has(i)) }
}

/** "2.9k" style, for budget lines. */
export function shortTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`
}

/** "18 of 25 notes, ~2.9k of 4k tokens". */
export function budgetLine(r: Pick<NoteBudgetReport<unknown>, "count" | "tokens" | "maxNotes" | "maxTokens">): string {
  return `${r.count} of ${r.maxNotes} notes, ~${shortTokens(r.tokens)} of ${shortTokens(r.maxTokens)} tokens`
}

/** What the Captain is told when the notes don't fit. Box Yard text: pass it through withOwner where it names the owner. */
export function pruneAdvice(r: NoteBudgetReport<unknown>): string {
  const left = r.hidden.length
  return (
    `Project notes are over budget (${budgetLine(r)}). ` +
    (left ? `Agents only get the newest notes that fit, so ${left} note${left === 1 ? " is" : "s are"} left out of their prompts. ` : "") +
    `Prune them: merge overlapping notes, shorten long ones and delete stale ones (list_notes, update_note, delete_note), or move a code convention to AGENTS.md with a small PR task.`
  )
}

/** Who a note's author or editor is, as the Notes tab names them. */
export function noteAuthorLabel(author: string): string {
  if (author === "orchestrator") return "Coordinator"
  if (author === "captain") return "Captain"
  return author
}

import type { Hub } from "./hub.js"
import { BadRequestError, ConflictError, NotFoundError, type Store } from "./store.js"
import { noteBudgetOf } from "./settings.js"
import { budgetLine, budgetNotes, pruneAdvice, type NoteBudgetReport } from "../shared/notes.js"
import { withOwner } from "../shared/owner.js"
import type { NoteSuggestion, ProjectNote, Settings } from "../shared/types.js"

/** Longest note or suggestion Box Yard takes. Notes are rules, not reports. */
export const MAX_NOTE_CHARS = 4000

export const SUGGESTION_ACTIONS = ["accept", "merge", "reject"] as const
export type SuggestionAction = (typeof SUGGESTION_ACTIONS)[number]

/**
 * Who changes the notes, as stored on the note (`by`: the owner's name, "captain" or "orchestrator").
 * The Captain reads the budget in its own tool results, so its changes don't send it a prune notice too.
 */
export interface NoteEditor {
  by: string
  captain?: boolean
}

export interface NotesDeps {
  store: Store
  hub: Hub
  settings: { get(): Settings }
  /** Share a project's live notes with its workers (TaskManager.publishNotes). */
  publish: (projectId: string) => void
  /** Leave a project's Captain a notice and wake it (the over-budget prune signal). */
  tellCaptain?: (projectId: string, content: string, meta: Record<string, unknown>) => void
}

const overKey = (projectId: string) => `notes_over_budget:${projectId}`

/**
 * Project notes are a small, curated set of lasting rules the Captain chooses. Every change to them goes
 * through here, from the Captain's and the Coordinator's MCP tools and from the Notes tab, so the workers'
 * copy, the UI and the budget signal stay in step.
 */
export class ProjectNotes {
  constructor(private readonly deps: NotesDeps) {}

  private get store() {
    return this.deps.store
  }

  /** Where the project's notes stand against Settings' budget. */
  budget(projectId: string): NoteBudgetReport<ProjectNote> {
    return budgetNotes(this.store.listNotes(projectId), noteBudgetOf(this.deps.settings.get()))
  }

  /** "18 of 25 notes, ~2.9k of 4k tokens", plus what to do when that's over. */
  budgetStatus(projectId: string): { line: string; over: boolean; prune?: string } {
    const r = this.budget(projectId)
    return { line: budgetLine(r), over: r.over, ...(r.over ? { prune: this.owner(pruneAdvice(r)) } : {}) }
  }

  add(projectId: string, content: string, who: NoteEditor): ProjectNote {
    if (!this.store.getProject(projectId)) throw new NotFoundError(`Project ${projectId} not found`)
    const note = this.store.addNote(projectId, who.by, noteText(content))
    this.changed(projectId, who)
    return note
  }

  update(noteId: string, content: string, who: NoteEditor): ProjectNote {
    const note = this.require(noteId)
    const updated = this.store.updateNote(note.id, noteText(content), who.by)
    this.changed(note.projectId, who)
    return updated
  }

  remove(noteId: string, who: NoteEditor): ProjectNote {
    const note = this.require(noteId)
    this.store.deleteNote(note.id)
    this.changed(note.projectId, who)
    return note
  }

  require(noteId: string): ProjectNote {
    const note = this.store.getNote(noteId)
    if (!note) throw new NotFoundError(`No note "${noteId}". Use list_notes for ids.`)
    return note
  }

  requireSuggestion(id: string): NoteSuggestion {
    const s = this.store.getNoteSuggestion(id)
    if (!s) throw new NotFoundError(`No suggestion "${id}". Use list_note_suggestions for ids.`)
    return s
  }

  /**
   * Settle a suggestion: accept it as a new note (optionally reworded), merge it into an existing note of the
   * same project (`content` is that note's new text), or reject it.
   */
  resolve(
    suggestionId: string,
    input: { action: SuggestionAction; content?: string; noteId?: string; reason?: string },
    who: NoteEditor,
  ): { suggestion: NoteSuggestion; note: ProjectNote | null } {
    const s = this.requireSuggestion(suggestionId)
    if (s.status !== "pending") throw new ConflictError(`Suggestion ${s.id} was already ${s.status}${s.resolvedBy ? ` by ${s.resolvedBy}` : ""}.`)
    const result = this.store.db.transaction(() => {
      if (input.action === "reject") {
        return { suggestion: this.store.resolveNoteSuggestion(s.id, { status: "rejected", by: who.by, reason: input.reason }), note: null }
      }
      if (input.action === "merge") {
        if (!input.noteId) throw new BadRequestError("Pass note: the id of the note to merge this suggestion into.")
        if (!input.content?.trim()) throw new BadRequestError("Pass content: the merged note's new text.")
        const target = this.require(input.noteId)
        if (target.projectId !== s.projectId) throw new BadRequestError(`Note ${target.id} belongs to another project.`)
        const note = this.store.updateNote(target.id, noteText(input.content), who.by)
        return { suggestion: this.store.resolveNoteSuggestion(s.id, { status: "merged", noteId: note.id, by: who.by, reason: input.reason }), note }
      }
      const note = this.store.addNote(s.projectId, who.by, noteText(input.content?.trim() ? input.content : s.content))
      return { suggestion: this.store.resolveNoteSuggestion(s.id, { status: "accepted", noteId: note.id, by: who.by, reason: input.reason }), note }
    })()
    if (result.note) this.changed(s.projectId, who)
    else this.suggestionsChanged(s.projectId)
    return result
  }

  /**
   * Tell the Captain once when a project's notes go over budget; the flag clears when they fit again.
   * Nothing is ever cut silently: agents' prompts also say how many notes were left out.
   */
  checkBudget(projectId: string, who: NoteEditor | null = null) {
    const r = this.budget(projectId)
    const flagged = this.store.getKv(overKey(projectId)) === "1"
    if (!r.over) {
      if (flagged) this.store.setKv(overKey(projectId), null)
      return
    }
    if (flagged) return
    this.store.setKv(overKey(projectId), "1")
    if (who?.captain) return
    this.deps.tellCaptain?.(projectId, `📝 ${this.owner(pruneAdvice(r))}`, { kind: "notes_budget", loopKey: `notes_budget:${projectId}` })
  }

  /** Settings' budget changed: check every project. */
  checkAllBudgets() {
    for (const p of this.store.listProjects()) this.checkBudget(p.id)
  }

  private changed(projectId: string, who: NoteEditor) {
    this.deps.publish(projectId)
    this.checkBudget(projectId, who)
    this.suggestionsChanged(projectId)
  }

  /** The project (its notes and pending count) and its suggestion list changed. */
  suggestionsChanged(projectId: string) {
    const project = this.store.getProject(projectId)
    if (project) this.deps.hub.broadcast({ type: "project", project })
    this.deps.hub.broadcast({ type: "note_suggestions", projectId })
  }

  private owner(text: string) {
    return withOwner(text, this.deps.settings.get().ownerName)
  }
}

function noteText(content: string): string {
  const text = content.trim()
  if (!text) throw new BadRequestError("A note needs some text.")
  if (text.length > MAX_NOTE_CHARS) throw new BadRequestError(`Notes are short rules: keep it under ${MAX_NOTE_CHARS} characters (this one has ${text.length}).`)
  return text
}

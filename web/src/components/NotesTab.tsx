// A project's Notes tab: the small, curated set of lasting rules every agent in the project starts with, the
// notes budget, and the note suggestions agents left for the Captain's notes retro (accept or reject them here too).
import { useState } from "react"
import { Link } from "wouter"
import { Check, GitMerge, History, Lightbulb, NotebookPen, Pencil, Plus, Search, Settings, Trash2, X } from "lucide-react"
import { useAddNote, useAgentSettings, useDeleteNote, useNoteSuggestions, useResolveSuggestion, useUpdateNote } from "../lib/queries"
import { confirmDialog } from "../lib/confirm"
import { Modal } from "./Modal"
import { Button, Empty, Field, Select, TimeAgo, cx, inputClass } from "./ui"
import { useOpenSettings } from "./SettingsDialog"
import { DEFAULT_NOTE_BUDGET, MAX_NOTE_CHARS, budgetLine, budgetNotes, noteAuthorLabel, type NoteBudget } from "../../../shared/notes"
import type { NoteSuggestion, Project, ProjectNote, Settings as AppSettings } from "../../../shared/types"

const budgetOf = (s: AppSettings | undefined): NoteBudget => (s ? { maxNotes: s.notesMaxCount, maxTokens: s.notesMaxTokens } : DEFAULT_NOTE_BUDGET)

export function NotesTab({ project }: { project: Project }) {
  const settings = useAgentSettings().data?.settings
  const report = budgetNotes(project.notes, budgetOf(settings))
  const leftOut = new Set(report.hidden.map((n) => n.id))
  const [filter, setFilter] = useState("")
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const notes = [...project.notes].reverse().filter((n) => words.every((w) => `${noteAuthorLabel(n.author)} ${n.content}`.toLowerCase().includes(w)))

  return (
    <section className="space-y-6">
      <p className="text-sm text-zinc-500">
        Lasting rules every agent in this project starts with. Agents suggest notes, and the Captain curates them when a task finishes
        {settings && !settings.notesRetroEnabled && " (the notes retro is off in Settings, so suggestions wait for you here)"}.
      </p>

      <Suggestions project={project} />

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 className="text-sm font-semibold text-zinc-200">Notes</h3>
          <BudgetMeter report={report} />
        </div>
        {report.over && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200" data-testid="notes-over-budget">
            Over budget: {report.hidden.length ? `${report.hidden.length} older note${report.hidden.length === 1 ? " is" : "s are"} left out of agents' prompts` : "agents' prompts are full"}.
            The Captain has been asked to prune them; you can merge, shorten or delete notes here too.
          </p>
        )}
        <AddNote projectId={project.id} />
        {project.notes.length > 5 && (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input className={cx(inputClass, "pl-9")} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter notes" aria-label="Filter notes" />
          </div>
        )}
        {project.notes.length === 0 ? (
          <Empty icon={<NotebookPen className="h-8 w-8" />} title="No notes yet">
            Add your decisions and preferences, box gotchas and facts that aren't in the code, so every agent starts with them.
          </Empty>
        ) : notes.length === 0 ? (
          <p className="text-sm text-zinc-500">No notes match "{filter.trim()}".</p>
        ) : (
          <ul className="space-y-2">
            {notes.map((n) => (
              <NoteRow key={n.id} note={n} leftOut={leftOut.has(n.id)} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function BudgetMeter({ report }: { report: ReturnType<typeof budgetNotes> }) {
  const openSettings = useOpenSettings()
  const share = Math.min(1, Math.max(report.count / report.maxNotes, report.tokens / report.maxTokens))
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
      <div
        className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-zinc-800"
        role="meter"
        aria-label="Notes budget"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
      >
        <div className={cx("h-full rounded-full", report.over ? "bg-amber-400" : share > 0.8 ? "bg-yellow-500/80" : "bg-yard-500")} style={{ width: `${share * 100}%` }} />
      </div>
      <span className={cx("tabular-nums", report.over && "text-amber-300")}>{budgetLine(report)}</span>
      <Button variant="ghost" size="sm" onClick={() => openSettings("orchestrator")} title="Change the notes budget in Settings" aria-label="Notes budget settings">
        <Settings className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

function AddNote({ projectId }: { projectId: string }) {
  const add = useAddNote()
  const [text, setText] = useState("")
  const submit = () => {
    if (!text.trim()) return
    add.mutate({ projectId, content: text.trim() })
    setText("")
  }
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-start"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <textarea
        className={cx(inputClass, "min-h-[2.5rem] resize-y")}
        rows={1}
        maxLength={MAX_NOTE_CHARS}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="e.g. Use pnpm, not npm"
        aria-label="New note"
      />
      <Button type="submit" variant="primary" disabled={!text.trim()} className="shrink-0">
        <Plus className="h-4 w-4" /> Add note
      </Button>
    </form>
  )
}

function NoteRow({ note, leftOut }: { note: ProjectNote; leftOut: boolean }) {
  const update = useUpdateNote()
  const remove = useDeleteNote()
  const [draft, setDraft] = useState<string | null>(null)
  const edited = note.updatedAt !== note.createdAt
  const save = () => {
    if (draft === null) return
    if (draft.trim() && draft.trim() !== note.content) update.mutate({ projectId: note.projectId, noteId: note.id, content: draft.trim() })
    setDraft(null)
  }
  const del = async () => {
    const ok = await confirmDialog({ title: "Delete this note?", body: note.content.slice(0, 280), confirmLabel: "Delete note", danger: true })
    if (ok) remove.mutate({ projectId: note.projectId, noteId: note.id })
  }
  return (
    <li className={cx("rounded-xl border bg-zinc-900/40 px-4 py-3", leftOut ? "border-amber-500/30" : "border-zinc-800/80")} data-testid="note">
      <div className="mb-1 flex items-start gap-2 text-xs text-zinc-500">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 pt-1 sm:pt-0.5">
          <span className="truncate font-medium text-zinc-400">{noteAuthorLabel(note.author)}</span>
          <span>
            added <TimeAgo ts={note.createdAt} />
          </span>
          {edited && (
            <span>
              · edited <TimeAgo ts={note.updatedAt} />
              {note.updatedBy && ` by ${noteAuthorLabel(note.updatedBy)}`}
            </span>
          )}
          {leftOut && (
            <span className="rounded-full bg-amber-500/15 px-1.5 text-[11px] text-amber-300" title="Over the notes budget: agents' prompts leave this note out">
              not in prompts
            </span>
          )}
        </div>
        {draft === null && (
          <div className="-my-1 flex shrink-0 gap-0.5 sm:-my-0.5">
            <Button variant="ghost" size="sm" onClick={() => setDraft(note.content)} aria-label="Edit note" title="Edit">
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" onClick={del} aria-label="Delete note" title="Delete">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      {draft === null ? (
        <p className="text-sm break-words whitespace-pre-wrap text-zinc-300">{note.content}</p>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <textarea
            className={cx(inputClass, "min-h-24 resize-y")}
            value={draft}
            maxLength={MAX_NOTE_CHARS}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraft(null)
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save()
            }}
            aria-label="Note text"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={!draft.trim()}>
              Save
            </Button>
          </div>
        </form>
      )}
    </li>
  )
}

function Suggestions({ project }: { project: Project }) {
  const pending = useNoteSuggestions(project.id)
  const [history, setHistory] = useState(false)
  const [editing, setEditing] = useState<NoteSuggestion | null>(null)
  const list = pending.data ?? []
  if (!list.length && !history) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <Lightbulb className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">No note suggestions waiting.</span>
        <Button variant="ghost" size="sm" onClick={() => setHistory(true)}>
          <History className="h-3.5 w-3.5" /> Past suggestions
        </Button>
      </div>
    )
  }
  return (
    <section aria-labelledby={`sug-${project.id}`} className="space-y-2 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <Lightbulb className="h-4 w-4 shrink-0 text-amber-300" />
        <h3 id={`sug-${project.id}`} className="text-sm font-semibold text-zinc-200">
          Suggestions
        </h3>
        {list.length > 0 && <span className="rounded-full bg-amber-500/15 px-1.5 text-[11px] text-amber-300 tabular-nums">{list.length}</span>}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setHistory((h) => !h)} aria-pressed={history}>
          <History className="h-3.5 w-3.5" /> {history ? "Hide past" : "Past"}
        </Button>
      </div>
      {list.length > 0 ? (
        <>
          <p className="text-xs text-zinc-500">From agents, waiting for the Captain's notes retro. Accept one to make it a note, or reject it.</p>
          <ul className="divide-y divide-zinc-800/80">
            {list.map((s) => (
              <SuggestionRow key={s.id} suggestion={s} onEdit={() => setEditing(s)} />
            ))}
          </ul>
        </>
      ) : (
        <p className="text-xs text-zinc-500">No note suggestions waiting.</p>
      )}
      {history && <PastSuggestions projectId={project.id} />}
      {editing && <AcceptDialog project={project} suggestion={editing} onClose={() => setEditing(null)} />}
    </section>
  )
}

function SuggestionRow({ suggestion: s, onEdit }: { suggestion: NoteSuggestion; onEdit: () => void }) {
  const resolve = useResolveSuggestion()
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-1 last:pb-1 sm:flex-row sm:items-start sm:gap-3" data-testid="suggestion">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm break-words whitespace-pre-wrap text-zinc-200">{s.content}</p>
        {s.why && (
          <p className="text-xs break-words text-zinc-400">
            <span className="text-zinc-500">Why: </span>
            {s.why}
          </p>
        )}
        <p className="truncate text-xs text-zinc-500">
          {s.taskId ? (
            <Link href={`/tasks/${s.taskId}`} className="text-zinc-400 hover:text-zinc-200 hover:underline">
              {s.taskTitle}
            </Link>
          ) : (
            s.taskTitle
          )}{" "}
          · <TimeAgo ts={s.createdAt} />
          {s.retroAt && " · sent to the Captain"}
        </p>
      </div>
      <div className="flex shrink-0 gap-1.5 sm:pt-0.5">
        <Button variant="primary" size="sm" onClick={() => resolve.mutate({ projectId: s.projectId, id: s.id, action: "accept" })} aria-label={`Accept: ${s.content.slice(0, 60)}`}>
          <Check className="h-3.5 w-3.5" /> Accept
        </Button>
        <Button variant="subtle" size="sm" onClick={onEdit} title="Reword it, or merge it into a note" aria-label="Edit before accepting">
          <Pencil className="h-3.5 w-3.5" /> <span className="sm:hidden">Edit</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => resolve.mutate({ projectId: s.projectId, id: s.id, action: "reject" })} aria-label={`Reject: ${s.content.slice(0, 60)}`}>
          <X className="h-3.5 w-3.5" /> Reject
        </Button>
      </div>
    </li>
  )
}

/** Accept a suggestion reworded, or merge it into one of the project's notes. */
function AcceptDialog({ project, suggestion, onClose }: { project: Project; suggestion: NoteSuggestion; onClose: () => void }) {
  const resolve = useResolveSuggestion()
  const [target, setTarget] = useState("")
  const [text, setText] = useState(suggestion.content)
  const note = project.notes.find((n) => n.id === target)
  const pick = (id: string) => {
    setTarget(id)
    const n = project.notes.find((x) => x.id === id)
    setText(n ? `${n.content}\n${suggestion.content}` : suggestion.content)
  }
  return (
    <Modal
      onClose={onClose}
      title={note ? "Merge into a note" : "Accept as a note"}
      description={suggestion.why ? `Why: ${suggestion.why}` : undefined}
      dirty={text !== suggestion.content || Boolean(target)}
      onSubmit={(e) => {
        e.preventDefault()
        if (!text.trim()) return
        resolve.mutate(
          note
            ? { projectId: project.id, id: suggestion.id, action: "merge", noteId: note.id, content: text.trim() }
            : { projectId: project.id, id: suggestion.id, action: "accept", content: text.trim() },
        )
        onClose()
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!text.trim()}>
            {note ? <GitMerge className="h-4 w-4" /> : <Check className="h-4 w-4" />} {note ? "Merge" : "Accept"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {project.notes.length > 0 && (
          <Field label="Becomes">
            <Select className="w-full" value={target} onChange={(e) => pick(e.target.value)}>
              <option value="">A new note</option>
              {[...project.notes].reverse().map((n) => (
                <option key={n.id} value={n.id}>
                  Merged into: {n.content.length > 70 ? `${n.content.slice(0, 70)}…` : n.content}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={note ? "The merged note" : "Note"} hint="One short, lasting rule.">
          <textarea className={cx(inputClass, "min-h-32 resize-y")} value={text} maxLength={MAX_NOTE_CHARS} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

const STATUS_LABEL: Record<NoteSuggestion["status"], { label: string; chip: string }> = {
  pending: { label: "Pending", chip: "bg-amber-500/15 text-amber-300" },
  accepted: { label: "Accepted", chip: "bg-yard-500/15 text-yard-300" },
  merged: { label: "Merged", chip: "bg-sky-500/15 text-sky-300" },
  rejected: { label: "Rejected", chip: "bg-zinc-800 text-zinc-400" },
}

function PastSuggestions({ projectId }: { projectId: string }) {
  const all = useNoteSuggestions(projectId, "all")
  const past = (all.data ?? []).filter((s) => s.status !== "pending").reverse().slice(0, 30)
  if (all.isLoading) return <p className="text-xs text-zinc-500">Loading…</p>
  if (!past.length) return <p className="text-xs text-zinc-500">No past suggestions yet.</p>
  return (
    <ul className="space-y-1.5 border-t border-zinc-800/80 pt-3" aria-label="Past suggestions">
      {past.map((s) => (
        <li key={s.id} className="flex items-start gap-2 text-xs">
          <span className={cx("mt-0.5 shrink-0 rounded-full px-1.5 text-[11px]", STATUS_LABEL[s.status].chip)}>{STATUS_LABEL[s.status].label}</span>
          <div className="min-w-0 flex-1">
            <p className="break-words text-zinc-300">{s.content}</p>
            <p className="text-zinc-500">
              {s.resolvedBy && `by ${noteAuthorLabel(s.resolvedBy)}`}
              {s.reason && ` · ${s.reason}`}
              {s.resolvedAt && (
                <>
                  {" · "}
                  <TimeAgo ts={s.resolvedAt} />
                </>
              )}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}

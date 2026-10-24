// A project's Notes tab: the small, curated set of lasting rules every agent in the project starts with, the
// notes budget, and a read-only history of the note suggestions agents left and what the Captain decided.
import { useState } from "react"
import { Link, useLocation } from "wouter"
import { ChevronDown, ChevronUp, Lightbulb, NotebookPen, Pencil, Plus, Search, Settings, Trash2 } from "lucide-react"
import { useAddNote, useAgentSettings, useDeleteNote, useNoteSuggestions, useUpdateNote } from "../lib/queries"
import { confirmDialog } from "../lib/confirm"
import { Button, Empty, TimeAgo, cx, inputClass } from "./ui"
import { useOpenSettings } from "./SettingsDialog"
import { MAX_NOTE_CHARS, budgetLine, budgetNotes, noteAuthorLabel, projectNoteBudget } from "../../../shared/notes"
import type { NoteSuggestion, Project, ProjectNote } from "../../../shared/types"

export function NotesTab({ project }: { project: Project }) {
  const settings = useAgentSettings().data?.settings
  const own = project.notesMaxCount !== null || project.notesMaxTokens !== null
  const report = budgetNotes(project.notes, projectNoteBudget(settings, project))
  const leftOut = new Set(report.hidden.map((n) => n.id))
  const [filter, setFilter] = useState("")
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const notes = [...project.notes].reverse().filter((n) => words.every((w) => `${noteAuthorLabel(n.author)} ${n.content}`.toLowerCase().includes(w)))

  return (
    <section className="space-y-6">
      <p className="text-sm text-zinc-500">
        Lasting rules every agent in this project starts with. Agents suggest notes, and the Captain decides which to keep when their task finishes
        {settings && !settings.notesRetroEnabled && " (the notes retro is off in Settings, so new suggestions stay pending until it's on)"}. You can add, edit or
        delete notes here at any time.
      </p>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 className="text-sm font-semibold text-zinc-200">Notes</h3>
          <BudgetMeter report={report} projectId={project.id} own={own} />
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

      <RecentSuggestions projectId={project.id} />
    </section>
  )
}

/** How full the notes budget is. It's Settings › Max notes unless the project has its own (its Settings tab). */
function BudgetMeter({ report, projectId, own }: { report: ReturnType<typeof budgetNotes>; projectId: string; own: boolean }) {
  const openSettings = useOpenSettings()
  const [, navigate] = useLocation()
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
      <span className={cx("tabular-nums", report.over && "text-amber-300")}>
        {budgetLine(report)}
        {own && " (this project's)"}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => (own ? navigate(`/projects/${projectId}?tab=settings`) : openSettings("orchestrator"))}
        title={own ? "Change this project's notes budget on its Settings tab" : "Change Max notes in Settings (or give this project its own on its Settings tab)"}
        aria-label="Notes budget settings"
      >
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

const STATUS_LABEL: Record<NoteSuggestion["status"], { label: string; chip: string; title: string }> = {
  pending: { label: "Pending", chip: "bg-amber-500/15 text-amber-300", title: "Waiting for the Captain's notes retro after its task" },
  accepted: { label: "Accepted", chip: "bg-yard-500/15 text-yard-300", title: "Became a note" },
  merged: { label: "Merged", chip: "bg-sky-500/15 text-sky-300", title: "Merged into a note" },
  rejected: { label: "Rejected", chip: "bg-zinc-800 text-zinc-400", title: "Not kept as a note" },
}

const SHOWN = 5

/** What agents suggested and what the Captain decided, newest first. Read-only: the Captain settles every one. */
function RecentSuggestions({ projectId }: { projectId: string }) {
  const all = useNoteSuggestions(projectId)
  const [expanded, setExpanded] = useState(false)
  const list = [...(all.data ?? [])].reverse()
  const shown = expanded ? list : list.slice(0, SHOWN)
  return (
    <section aria-labelledby={`sug-${projectId}`} className="space-y-2 border-t border-zinc-800/80 pt-5">
      <div className="flex items-center gap-2">
        <Lightbulb className="h-4 w-4 shrink-0 text-zinc-500" />
        <h3 id={`sug-${projectId}`} className="text-sm font-semibold text-zinc-200">
          Recent suggestions
        </h3>
      </div>
      <p className="text-xs text-zinc-500">Notes agents suggested, and what the Captain decided in its notes retro. Nothing here needs you.</p>
      {all.isLoading ? (
        <p className="text-xs text-zinc-500">Loading…</p>
      ) : !list.length ? (
        <p className="text-xs text-zinc-500">No suggestions yet.</p>
      ) : (
        <>
          <ul className="divide-y divide-zinc-800/80" aria-label="Recent suggestions">
            {shown.map((s) => (
              <SuggestionRow key={s.id} suggestion={s} />
            ))}
          </ul>
          {list.length > SHOWN && (
            <Button variant="ghost" size="sm" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} {expanded ? "Show fewer" : `Show ${list.length - SHOWN} more`}
            </Button>
          )}
        </>
      )}
    </section>
  )
}

function SuggestionRow({ suggestion: s }: { suggestion: NoteSuggestion }) {
  const status = STATUS_LABEL[s.status]
  return (
    <li className="flex items-start gap-2.5 py-2.5 text-xs first:pt-1 last:pb-1" data-testid="suggestion">
      <span className={cx("mt-0.5 shrink-0 rounded-full px-1.5 text-[11px]", status.chip)} title={status.title}>
        {status.label}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm break-words whitespace-pre-wrap text-zinc-300">{s.content}</p>
        {s.status === "pending" ? (
          <p className="text-zinc-500">{s.retroAt ? "With the Captain now, in its notes retro." : "Goes to the Captain's notes retro once its task is finished."}</p>
        ) : (
          s.reason && (
            <p className="break-words text-zinc-400">
              <span className="text-zinc-500">{noteAuthorLabel(s.resolvedBy ?? "captain")}: </span>
              {s.reason}
            </p>
          )
        )}
        <p className="truncate text-zinc-500">
          {s.taskId ? (
            <Link href={`/tasks/${s.taskId}`} className="text-zinc-400 hover:text-zinc-200 hover:underline">
              {s.taskTitle}
            </Link>
          ) : (
            s.taskTitle
          )}{" "}
          · <TimeAgo ts={s.resolvedAt ?? s.createdAt} />
        </p>
      </div>
    </li>
  )
}

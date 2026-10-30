// "New task": a button that opens a small popover anchored to it (a bottom sheet on phones) with one textarea.
// Enter starts the task, titled from its prompt; "More options" opens the full dialog (title, model, effort, files,
// env vars) with the text in it. Esc, a click outside or More options keep the draft (lib/newTask.ts).
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "wouter"
import { AlertTriangle, FileText, Laptop, Loader2, Paperclip, Plus, ShieldAlert, SlidersHorizontal, X } from "lucide-react"
import { newClientId, useAgentSettings, useCreateTask, useProjects, useSettings } from "../lib/queries"
import { draftScope, loadDraft, saveDraft } from "../lib/newTask"
import { primeSendSound } from "../lib/sendSound"
import { EFFORT_LABEL } from "../../../shared/models"
import { EffortPicker, ModelPicker } from "./ModelPicker"
import { uploadFile } from "../lib/api"
import { titleFromPrompt } from "../../../shared/taskTitle"
import { type Attachment, type Effort, type Project } from "../../../shared/types"
import { LOCAL_UNSANDBOXED, type Runner } from "../../../shared/runner"
import { Modal, focusables } from "./Modal"
import { formatSize } from "./Attachments"
import { Button, Field, LineIcon, Select, cx, inputClass, parseEnv } from "./ui"

/** Below Tailwind's `sm`: the popover is a bottom sheet. */
const NARROW = "(max-width: 639.98px)"
const subscribeNarrow = (cb: () => void) => {
  const mq = window.matchMedia?.(NARROW)
  mq?.addEventListener("change", cb)
  return () => mq?.removeEventListener("change", cb)
}
const isNarrow = () => window.matchMedia?.(NARROW).matches ?? false
export const useNarrow = () => useSyncExternalStore(subscribeNarrow, isNarrow, () => false)

/** Popover width (26rem) and its gap to the trigger and the window edges. */
const WIDTH = 416
const GAP = 6
const EDGE = 8

export function NewTaskButton({
  projectId,
  defaultProjectId,
  open: openProp,
  onOpenChange,
  variant = "primary",
  size,
  className,
  children,
}: {
  /** The project the task goes to. Without it the popover has a project picker. */
  projectId?: string
  /** The picker's first choice when there's no `projectId` (e.g. the Yard's project filter); else the first project. */
  defaultProjectId?: string | null
  /** Controlled open state (the command palette's `?new=task` opens it). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  variant?: "primary" | "subtle" | "ghost"
  size?: "sm" | "md"
  className?: string
  children?: ReactNode
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [ownOpen, setOwnOpen] = useState(false)
  const open = openProp ?? ownOpen
  const setOpen = (next: boolean) => {
    setOwnOpen(next)
    onOpenChange?.(next)
  }
  const [dialog, setDialog] = useState<{ projectId: string; prompt: string } | null>(null)
  const id = useId()
  const scope = draftScope(projectId)

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant={variant}
        size={size}
        className={className}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {children ?? (
          <>
            <Plus className="h-4 w-4" /> New task
          </>
        )}
      </Button>
      {open && (
        <NewTaskPopover
          id={id}
          trigger={trigger}
          projectId={projectId}
          defaultProjectId={defaultProjectId}
          onClose={(refocus) => {
            setOpen(false)
            if (refocus) trigger.current?.focus()
          }}
          onMore={(target, prompt) => {
            // Focus the trigger first: the dialog returns focus to whatever had it when it opened.
            trigger.current?.focus()
            setOpen(false)
            setDialog({ projectId: target, prompt })
          }}
        />
      )}
      {dialog && (
        <NewTaskDialog
          projectId={dialog.projectId}
          initialPrompt={dialog.prompt}
          onCancel={(prompt) => {
            saveDraft(scope, prompt)
            setDialog(null)
          }}
          onDone={() => {
            saveDraft(scope, "")
            setDialog(null)
          }}
        />
      )}
    </>
  )
}

/**
 * The popover itself. NewTaskButton opens it on a project; SelectionToTask opens it on selected output with
 * `quote`, its own draft `scope` and `onStart`, which then gets the text instead of a task being created here.
 */
export function NewTaskPopover({
  id,
  trigger,
  projectId,
  defaultProjectId,
  heading = "New task",
  quote,
  placeholder = "What should the agent do?",
  scope: scopeProp,
  align = "end",
  onStart,
  onClose,
  onMore,
}: {
  id: string
  /** What it hangs from; a press on it is not a click outside. */
  trigger: RefObject<HTMLElement | null>
  projectId?: string
  defaultProjectId?: string | null
  heading?: string
  /** Selected text shown above the textarea as a short preview. */
  quote?: string
  placeholder?: string
  /** Where the draft is kept; defaults to the project's. */
  scope?: string
  /** "end": its right edge on the trigger's (a header button); "center": centred under it (a selection). */
  align?: Align
  /** Takes the (possibly empty) text instead of creating a task; there's no project picker then. */
  onStart?: (text: string) => void
  /** `refocus`: put focus back on the trigger (Esc, the close button); not after a click elsewhere. */
  onClose: (refocus: boolean) => void
  onMore: (projectId: string, prompt: string) => void
}) {
  const narrow = useNarrow()
  const scope = scopeProp ?? draftScope(projectId)
  const [text, setText] = useState(() => loadDraft(scope))
  const projects = useProjects().data ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const target =
    projectId ?? [picked, defaultProjectId].find((p) => p && projects.some((x) => x.id === p)) ?? projects[0]?.id ?? ""
  const project = projects.find((p) => p.id === target)
  const create = useCreateTask()
  const [, navigate] = useLocation()
  const input = useRef<HTMLTextAreaElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const labelId = `${id}-label`
  const preview = quote ? quotePreview(quote) : ""

  useEffect(() => saveDraft(scope, text), [scope, text])

  // Grow with the text up to 40% of the window, then scroll inside.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    const max = Math.min(360, Math.max(120, Math.round(window.innerHeight * 0.4)))
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden"
  }, [text, narrow])

  // A press anywhere outside closes it (the trigger toggles it itself). The sheet's backdrop does this on phones.
  useEffect(() => {
    if (narrow) return
    const down = (e: Event) => {
      const t = e.target as Node
      if (panel.current?.contains(t) || trigger.current?.contains(t)) return
      closeRef.current(false)
    }
    document.addEventListener("pointerdown", down, true)
    return () => document.removeEventListener("pointerdown", down, true)
  }, [narrow, trigger])

  const pos = useAnchor(trigger, panel, !narrow, align)

  // Focus the text with the caret after a kept draft.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [narrow])

  const submit = () => {
    const prompt = text.trim()
    primeSendSound()
    if (onStart) {
      saveDraft(scope, "")
      onClose(false)
      return onStart(prompt)
    }
    if (!prompt || !target) return
    const taskId = newClientId("task")
    create.mutate({ id: taskId, projectId: target, title: titleFromPrompt(prompt), prompt })
    saveDraft(scope, "")
    onClose(false)
    navigate(`/tasks/${taskId}`)
  }

  const form = (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {preview && (
        <blockquote data-testid="selection-quote" title={quote} className="rounded-lg border border-zinc-800 border-l-2 border-l-yard-500/60 bg-zinc-900/60 px-3 py-2 text-xs leading-5 wrap-anywhere text-zinc-400">
          {/* Clamped inside the padding, or a fourth line peeks out under the third. */}
          <span className="line-clamp-3">{preview}</span>
        </blockquote>
      )}
      <textarea
        ref={input}
        rows={3}
        value={text}
        aria-labelledby={labelId}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={placeholder}
        className={cx(inputClass, "scroll-thin block resize-none overflow-y-hidden leading-6 sm:leading-5")}
      />
      <div className="flex items-center gap-2">
        {!projectId && !onStart && (
          <Select size="sm" aria-label="Project" className="w-0 min-w-0 flex-1 sm:max-w-[13rem]" value={target} onChange={(e) => setPicked(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        <button
          type="button"
          disabled={!target && !onStart}
          onClick={() => onMore(target, text)}
          className={cx(
            "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs whitespace-nowrap text-zinc-500 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none disabled:opacity-50 sm:min-h-0 sm:py-1",
            (projectId || onStart) && "-ml-1.5",
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" /> More options
        </button>
        <Button type="submit" variant="primary" size="sm" className="ml-auto shrink-0" disabled={onStart ? false : !text.trim() || !target}>
          Start task
        </Button>
      </div>
    </form>
  )

  if (narrow)
    return (
      <Modal placement="sheet" title={<span id={labelId}>{heading}</span>} description={projectId ? project?.name : undefined} onClose={() => onClose(true)} bodyClassName="px-4 pt-3 pb-4">
        {form}
      </Modal>
    )

  return createPortal(
    <div
      ref={panel}
      id={id}
      role="dialog"
      aria-labelledby={labelId}
      tabIndex={-1}
      style={pos}
      onKeyDown={(e) => trapKeys(e, panel.current, () => onClose(true))}
      className="fixed z-40 flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl shadow-black/50 focus:outline-none"
    >
      <div className="mb-2 flex items-baseline gap-3 px-0.5">
        <h2 id={labelId} className="min-w-0 truncate text-sm font-medium text-zinc-200">
          {heading}
          {projectId && project && <span className="font-normal text-zinc-500"> in {project.name}</span>}
        </h2>
        <span className="ml-auto shrink-0 text-[11px] text-zinc-600" aria-hidden>
          Enter to start · Shift+Enter new line
        </span>
      </div>
      {form}
    </div>,
    document.body,
  )
}

/** A short one-paragraph preview of selected text; the task still gets all of it. */
export function quotePreview(text: string, max = 240) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** Esc closes; Tab and Shift+Tab stay inside the panel. */
export function trapKeys(e: ReactKeyboardEvent, root: HTMLElement | null, close: () => void) {
  if (e.key === "Escape") {
    e.preventDefault()
    e.stopPropagation()
    return close()
  }
  if (e.key !== "Tab" || !root) return
  const items = focusables(root)
  if (!items.length) return
  const first = items[0]!
  const last = items.at(-1)!
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

export type Align = "end" | "center"

/**
 * Fixed-position style that puts the panel under the trigger, its right edge on the trigger's (or its left edge
 * on the trigger's when there's no room to the left; or centred on it), inside the window, and above the trigger
 * when there's more room there. Follows scrolling and resizes.
 */
export function useAnchor(trigger: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, on: boolean, align: Align): CSSProperties {
  // Placed from the first render: a hidden panel couldn't take focus.
  const [style, setStyle] = useState<CSSProperties>(() => anchorStyle(trigger.current, 0, align))
  useLayoutEffect(() => {
    if (!on) return
    const place = () => setStyle(anchorStyle(trigger.current, panel.current?.offsetHeight ?? 0, align))
    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [on, trigger, panel, align])
  return style
}

function anchorStyle(trigger: HTMLElement | null, height: number, align: Align): CSSProperties {
  const vw = document.documentElement.clientWidth || window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(WIDTH, vw - 2 * EDGE)
  const t = trigger?.getBoundingClientRect() ?? { left: vw - EDGE - width, right: vw - EDGE, top: EDGE, bottom: EDGE }
  let left = align === "center" ? t.left + (t.right - t.left - width) / 2 : t.right - width
  if (left < EDGE && align === "end") left = t.left
  left = Math.max(EDGE, Math.min(left, vw - EDGE - width))
  const below = vh - t.bottom - GAP - EDGE
  const above = t.top - GAP - EDGE
  return height > below && above > below
    ? { left, width, bottom: vh - t.top + GAP, maxHeight: above }
    : { left, width, top: t.bottom + GAP, maxHeight: Math.max(below, 160) }
}

interface Pending {
  key: number
  name: string
  size: number
  status: "uploading" | "done" | "error"
  error?: string
  attachment?: Attachment
}
let nextKey = 0

/**
 * The full New task form: an optional title (made from the prompt when blank), the prompt, and the options the
 * popover leaves out: model, effort, "Run on this computer", files and env vars. `onCancel` gets the prompt so the popover's draft keeps it.
 */
export function NewTaskDialog({
  projectId: projectProp,
  initialPrompt = "",
  onCancel,
  onDone,
}: {
  /** Without one the dialog has a project picker, starting on the first project in the saved order. */
  projectId?: string | null
  initialPrompt?: string
  onCancel: (prompt: string) => void
  onDone: () => void
}) {
  const create = useCreateTask()
  const [, navigate] = useLocation()
  const projects = useProjects().data ?? []
  const [picked, setPicked] = useState("")
  const projectId = projectProp || (projects.some((p) => p.id === picked) ? picked : (projects[0]?.id ?? ""))
  const project: Project | undefined = projects.find((p) => p.id === projectId)
  const settings = useAgentSettings().data?.settings
  const maxMb = useSettings().data?.maxUploadMb ?? 20
  const [title, setTitle] = useState("")
  const [prompt, setPrompt] = useState(initialPrompt)
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState<Effort | "">("")
  const [files, setFiles] = useState<Pending[]>([])
  const [env, setEnv] = useState("")
  const [showEnv, setShowEnv] = useState(false)
  // Starts on the project's "Runs on"; flipping it pins this task to the other runner (Task.runsOn).
  const projectRunner: Runner = project?.runner ?? "box"
  const [runner, setRunner] = useState<Runner | null>(null)
  const runsOn = runner ?? projectRunner
  const picker = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  // Opened from the popover with text: continue where it left off.
  useLayoutEffect(() => {
    const el = promptRef.current
    if (!el || !initialPrompt) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [initialPrompt])

  const patch = (key: number, change: Partial<Pending>) => setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...change } : f)))
  const add = (picked: File[]) => {
    for (const file of picked) {
      const key = nextKey++
      const item: Pending = { key, name: file.name, size: file.size, status: "uploading" }
      if (file.size > maxMb * 1024 * 1024) {
        setFiles((list) => [...list, { ...item, status: "error", error: `"${file.name}" is larger than the ${maxMb} MB upload limit.` }])
        continue
      }
      setFiles((list) => [...list, item])
      uploadFile(file).then(
        (attachment) => patch(key, { status: "done", attachment }),
        (err: Error) => patch(key, { status: "error", error: err.message }),
      )
    }
  }

  const uploading = files.some((f) => f.status === "uploading")
  const canStart = Boolean(prompt.trim()) && !uploading && Boolean(projectId)
  const autoTitle = prompt.trim() ? titleFromPrompt(prompt) : "Made from the prompt when blank"

  return (
    <Modal
      size="lg"
      title="New task"
      description={project?.name}
      dirty={Boolean(title || prompt || env || files.length)}
      onClose={() => onCancel(prompt)}
      onSubmit={(e) => {
        e.preventDefault()
        if (!canStart) return
        primeSendSound()
        const id = newClientId("task")
        create.mutate({
          id,
          projectId,
          title: title.trim() || titleFromPrompt(prompt),
          prompt: prompt.trim(),
          env: parseEnv(env),
          ...(model && { model }),
          ...(effort && { effort }),
          ...(runsOn !== projectRunner && { runsOn }),
          attachments: files.flatMap((f) => (f.attachment ? [f.attachment.id] : [])),
        })
        onDone()
        navigate(`/tasks/${id}`)
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={() => onCancel(prompt)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canStart}>
            Start agent
          </Button>
        </>
      }
    >
      {!projectProp && (
        <Field label="Project">
          <Select className="w-full" value={projectId} onChange={(e) => setPicked(e.target.value)} data-testid="new-task-project">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Title" hint="Optional.">
        <input autoFocus={!initialPrompt} className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={autoTitle} />
      </Field>
      <Field label="What should the agent do?">
        <textarea ref={promptRef} className={inputClass} rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Goal, constraints, and what done looks like." />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Model">
          <ModelPicker value={model} onChange={setModel} defaultLabel={`Default${settings?.agentModel ? ` (${settings.agentModel})` : ""}`} testId="new-task-model" />
        </Field>
        <Field label="Effort">
          <EffortPicker
            value={effort}
            onChange={(v) => setEffort(v as Effort | "")}
            model={model || settings?.agentModel || ""}
            effective={effort || (settings?.agentEffort !== "orchestrator" ? settings?.agentEffort : "") || ""}
            lead={<option value="">Default{settings?.agentEffort ? ` (${settings.agentEffort === "orchestrator" ? "Coordinator decides" : EFFORT_LABEL[settings.agentEffort]})` : ""}</option>}
            testId="new-task-effort"
          />
        </Field>
      </div>
      <RunHereToggle on={runsOn === "local"} projectLocal={projectRunner === "local"} onChange={(on) => setRunner(on ? "local" : projectRunner === "local" ? "box" : projectRunner)} />
      <div role="group" aria-label="Files" className="space-y-2">
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {files.map((f) => (
              <li
                key={f.key}
                title={f.error ?? `${f.name} · ${formatSize(f.size)}`}
                className={cx(
                  "inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-zinc-900 py-1 pr-1 pl-2 text-xs",
                  f.status === "error" ? "border-red-900/60 text-red-300" : "border-zinc-800 text-zinc-300",
                )}
              >
                {f.status === "uploading" ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : f.status === "error" ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                )}
                <span className="min-w-0 truncate">{f.name}</span>
                <span className="shrink-0 text-zinc-600">{formatSize(f.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((list) => list.filter((x) => x.key !== f.key))}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 sm:h-5 sm:w-5"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {files.some((f) => f.status === "error") && <p className="text-xs text-red-400">{files.find((f) => f.status === "error")!.error}</p>}
        <div className="flex flex-wrap items-center gap-x-4">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              add(Array.from(e.target.files ?? []))
              e.target.value = ""
            }}
          />
          <button type="button" className="inline-flex min-h-11 items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 sm:min-h-0" onClick={() => picker.current?.click()}>
            <Paperclip className="h-3.5 w-3.5" /> Attach files
          </button>
          {!showEnv && (
            <button type="button" className="min-h-11 text-xs whitespace-nowrap text-zinc-500 hover:text-zinc-300 sm:min-h-0" onClick={() => setShowEnv(true)}>
              + env vars
            </button>
          )}
        </div>
      </div>
      {showEnv && (
        <Field label="Extra env vars for this task" hint="KEY=value per line; added to the project's env.">
          <textarea className={`${inputClass} font-mono text-xs`} rows={2} value={env} onChange={(e) => setEnv(e.target.value)} />
        </Field>
      )}
    </Modal>
  )
}

/** "Run on this computer": this task only, over its project's "Runs on", in either direction. */
function RunHereToggle({ on, projectLocal, onChange }: { on: boolean; projectLocal: boolean; onChange: (on: boolean) => void }) {
  const hint = projectLocal
    ? on
      ? "Its project runs on this computer. Turn it off to run this task in an Upstash box."
      : "This task only runs in an Upstash box, though its project runs on this computer."
    : on
      ? "This task only runs on this computer, though its project runs in Upstash boxes."
      : "Its project runs in Upstash boxes. Turn it on to run this task here."
  return (
    <div className="space-y-2">
      <label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-sm text-zinc-300">
        <input type="checkbox" className="mt-1 shrink-0" checked={on} onChange={(e) => onChange(e.target.checked)} data-testid="new-task-local" />
        <span className="min-w-0">
          <span className="inline-flex items-center gap-1.5 text-zinc-200">
            <Laptop className="h-3.5 w-3.5 text-zinc-400" /> Run on this computer
          </span>
          <span className="block text-xs text-zinc-500">{hint}</span>
        </span>
      </label>
      {on && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <LineIcon icon={ShieldAlert} className="h-3.5 w-3.5 text-amber-300" />
          <span>{LOCAL_UNSANDBOXED}</span>
        </p>
      )}
    </div>
  )
}

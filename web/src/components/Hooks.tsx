// Hooks: automations on task events. One panel serves a project's Hooks tab (the Captain's hooks) and the
// global section in Settings (the Coordinator's). A list with on/off switches and a "Recent runs" view as
// tabs, a one-click template strip, and a centered editor Modal with a live preview of the prompt.
import { useId, useMemo, useRef, useState, type ReactNode } from "react"
import { Link, useSearchParams } from "wouter"
import { ChevronDown, ChevronRight, GitMerge, History, Pencil, Plus, Trash2, Webhook } from "lucide-react"
import {
  useCreateHook,
  useDeleteHook,
  useHookFromTemplate,
  useHookRuns,
  useHookTemplates,
  useHooks,
  useOwnerName,
  useProjects,
  useTasks,
  useToggleHook,
  useUpdateHook,
} from "../lib/queries"
import {
  HOOK_LIST_FILTERS,
  RUN_FILTERS,
  draftFromHook,
  draftFromTemplate,
  draftProblems,
  draftToInput,
  draftWarnings,
  emptyDraft,
  filterChips,
  filterHooks,
  filterRuns,
  insertVariable,
  parseRunFilter,
  previewVars,
  runCounts,
  type HookDraft,
  type HookListFilter,
} from "../lib/hookForm"
import {
  ACTION_INFO,
  HOOK_ACTIONS,
  HOOK_SOURCES,
  HOOK_TRIGGERS,
  HOOK_VARIABLES,
  TRIGGER_INFO,
  VARIABLE_INFO,
  hookSummary,
  renderHookTemplate,
  shortSha,
  sourceLabel,
  type Hook,
  type HookRun,
  type HookRunStatus,
  type HookTemplateView,
  type HookWithLastRun,
} from "../../../shared/hooks"
import { Button, Empty, Field, Select, TimeAgo, cx, inputClass } from "./ui"
import { Modal } from "./Modal"
import { withParam } from "./TaskFilters"
import { confirmDialog } from "../lib/confirm"
import { toast } from "../lib/toast"

/** The param that picks the panel's view: `?hooks=runs` for Recent runs. */
const VIEW_PARAM = "hooks"

/** A project's hooks (projectId), or the global ones (null). `intro: false` when the page already explains them (Settings). */
export function HooksPanel({ projectId, intro = true }: { projectId: string | null; intro?: boolean }) {
  const scope = projectId ?? "global"
  const hooks = useHooks(scope)
  const runs = useHookRuns(scope)
  const templates = useHookTemplates()
  const fromTemplate = useHookFromTemplate()
  const [params, setParams] = useSearchParams()
  const view = params.get(VIEW_PARAM) === "runs" ? "runs" : "list"
  const [listFilter, setListFilter] = useState<HookListFilter>("all")
  const [editing, setEditing] = useState<{ hook: Hook | null; draft: HookDraft } | null>(null)
  const list = hooks.data ?? []
  const shown = filterHooks(list, listFilter)
  const setView = (v: "list" | "runs") => setParams((p) => withParam(p, VIEW_PARAM, v === "runs" ? "runs" : null), { replace: true })

  const addTemplate = (t: HookTemplateView) =>
    fromTemplate.mutate(
      { projectId, template: t.key },
      {
        onSuccess: (hook) => {
          toast.info(`Added "${hook.name}"`, "It's off until you switch it on.")
          setEditing({ hook, draft: draftFromHook(hook) })
        },
      },
    )

  return (
    <section className="space-y-4" data-testid="hooks-panel">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-end">
        {intro && (
          <p className="min-w-0 flex-1 text-sm text-zinc-500">
            {projectId
              ? "Automations on this project's task events, run by its Captain. A hook sends a prompt to the task, the Captain or the Coordinator, or starts a task, when a task finishes, opens a PR, fails, needs you, or its PR merges."
              : "Global hooks belong to the Coordinator and see every project's task events. Project hooks live on each project's Hooks tab."}
          </p>
        )}
        <Button type="button" variant="primary" className="w-full sm:w-auto" onClick={() => setEditing({ hook: null, draft: emptyDraft() })}>
          <Plus className="h-4 w-4" /> New hook
        </Button>
      </div>

      {(templates.data ?? []).map((t) => {
        const existing = list.find((h) => h.template === t.key)
        return <TemplateCard key={t.key} template={t} existing={existing ?? null} busy={fromTemplate.isPending} onAdd={() => addTemplate(t)} onEdit={(h) => setEditing({ hook: h, draft: draftFromHook(h) })} />
      })}

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Hooks views"
          value={view}
          onChange={setView}
          options={[
            { key: "list", label: "Hooks", count: list.length, icon: Webhook },
            { key: "runs", label: "Recent runs", count: runs.data?.length, icon: History },
          ]}
        />
        {view === "list" && list.length > 0 && (
          <Segmented
            label="Show hooks"
            size="sm"
            value={listFilter}
            onChange={setListFilter}
            options={HOOK_LIST_FILTERS.map((f) => ({ key: f.key, label: f.label, count: filterHooks(list, f.key).length }))}
          />
        )}
      </div>

      {view === "list" ? (
        hooks.isLoading ? null : list.length === 0 ? (
          <Empty icon={<Webhook className="h-8 w-8" />} title="No hooks yet">
            Add the merge template above, or a hook of your own. You can also ask the {projectId ? "Captain" : "Coordinator"}: "when a PR is ready, ask the agent to merge it".
          </Empty>
        ) : shown.length === 0 ? (
          <p className="text-sm text-zinc-500">No hooks are {listFilter === "on" ? "on" : "off"}.</p>
        ) : (
          <ul className="space-y-3">
            {shown.map((h) => (
              <HookRow key={h.id} hook={h} scope={scope} onEdit={() => setEditing({ hook: h, draft: draftFromHook(h) })} />
            ))}
          </ul>
        )
      ) : (
        <RunsView runs={runs.data ?? []} hooks={list} loading={runs.isLoading} />
      )}

      {editing && <HookEditor projectId={projectId} hook={editing.hook} initial={editing.draft} templates={templates.data ?? []} onDone={() => setEditing(null)} />}
    </section>
  )
}

/** Small pill tabs. They're buttons, not links: the panel can live inside the Settings dialog. */
function Segmented<K extends string>({
  label,
  value,
  onChange,
  options,
  size = "md",
}: {
  label: string
  value: K
  onChange: (k: K) => void
  options: { key: K; label: string; count?: number; icon?: typeof Webhook }[]
  size?: "sm" | "md"
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 rounded-lg bg-zinc-900/70 p-1">
      {options.map((o) => {
        const on = o.key === value
        const Icon = o.icon
        return (
          <button
            key={o.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.key)}
            className={cx(
              "inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 font-medium whitespace-nowrap transition sm:min-h-0",
              size === "sm" ? "py-1 text-xs" : "py-1.5 text-sm",
              on ? "bg-zinc-800 text-zinc-50 shadow-sm" : "text-zinc-400 hover:text-zinc-200",
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {o.label}
            {o.count !== undefined && <span className={cx("rounded-full px-1.5 text-[11px] tabular-nums", on ? "bg-yard-500/20 text-yard-300" : "bg-zinc-800 text-zinc-500")}>{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** An on/off switch with a 44px touch target on phones. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group grid h-11 w-12 shrink-0 place-items-center rounded-lg disabled:opacity-50 sm:h-7 sm:w-10"
    >
      <span className={cx("relative h-5 w-9 rounded-full transition", checked ? "bg-yard-500" : "bg-zinc-700 group-hover:bg-zinc-600")}>
        <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-zinc-50 shadow transition-all", checked ? "left-[1.125rem]" : "left-0.5")} />
      </span>
    </button>
  )
}

function TemplateCard({
  template: t,
  existing,
  busy,
  onAdd,
  onEdit,
}: {
  template: HookTemplateView
  existing: Hook | null
  busy: boolean
  onAdd: () => void
  onEdit: (h: Hook) => void
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-merged/30 bg-merged/5 p-3 sm:flex-row sm:items-center sm:p-4" data-testid="hook-template">
      <GitMerge className="hidden h-5 w-5 shrink-0 text-merged-fg sm:block" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-zinc-100">{t.name}</span>
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">Template</span>
          {existing && (
            <span className={cx("rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase", existing.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-400")}>
              {existing.enabled ? "Added · on" : "Added · off"}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-zinc-400">{t.description}</p>
      </div>
      {existing ? (
        <Button type="button" size="sm" variant="subtle" onClick={() => onEdit(existing)} className="w-full sm:w-auto">
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Button>
      ) : (
        <Button type="button" size="sm" variant="primary" loading={busy} onClick={onAdd} className="w-full sm:w-auto">
          <Plus className="h-3.5 w-3.5" /> Add (starts off)
        </Button>
      )}
    </div>
  )
}

function HookRow({ hook: h, scope, onEdit }: { hook: HookWithLastRun; scope: string; onEdit: () => void }) {
  const toggle = useToggleHook(scope)
  const remove = useDeleteHook()
  const projects = useProjects()
  const ownerName = useOwnerName()
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name
  const chips = filterChips(h.filters, projectName, ownerName)
  const last = h.lastRun
  return (
    <li id={h.id} className={cx("rounded-xl border bg-zinc-900/40 p-3 sm:p-4", h.enabled ? "border-zinc-800/80" : "border-zinc-900 opacity-75")} data-testid="hook-row">
      <div className="flex items-start gap-2 sm:gap-3">
        <div className="-my-2 -ml-1 sm:-my-0.5">
          <Switch checked={h.enabled} onChange={(enabled) => toggle.mutate({ id: h.id, enabled })} label={h.enabled ? `Turn off ${h.name}` : `Turn on ${h.name}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button type="button" onClick={onEdit} className="min-w-0 truncate text-left font-medium text-zinc-100 hover:underline">
              {h.name}
            </button>
            {!h.enabled && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400 uppercase">Off</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
            <span className="text-zinc-300">{hookSummary(h)}</span>
            {h.action === "create_task" && h.taskTitle && <span className="text-zinc-500">“{h.taskTitle}”</span>}
          </div>
          {chips.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {chips.map((c) => (
                <span key={c} className="max-w-full truncate rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[11px] text-zinc-400">
                  {c}
                </span>
              ))}
            </div>
          )}
          <p className="mt-1.5 line-clamp-2 text-xs wrap-anywhere text-zinc-500">{h.prompt}</p>
          <div className="mt-1.5 text-[11px] text-zinc-500">
            {last ? (
              <>
                <RunPill status={last.status} /> <TimeAgo ts={last.createdAt} />
                {last.taskId && (
                  <>
                    {" "}on{" "}
                    <Link href={`/tasks/${last.taskId}`} className="text-sky-400 hover:underline">
                      {last.taskTitle ?? last.taskId}
                    </Link>
                  </>
                )}
              </>
            ) : (
              <span>Hasn't fired yet · by {h.createdBy}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <Button type="button" size="sm" variant="ghost" onClick={onEdit} title="Edit hook" aria-label={`Edit ${h.name}`}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            title="Delete hook"
            aria-label={`Delete ${h.name}`}
            onClick={() =>
              void confirmDialog({ title: "Delete hook?", body: `Delete "${h.name}"? Its past runs stay in Recent runs.`, confirmLabel: "Delete hook", danger: true }).then((ok) => ok && remove.mutate(h.id))
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </li>
  )
}

const RUN_TONE: Record<HookRunStatus, string> = {
  fired: "bg-emerald-500/15 text-emerald-300",
  skipped: "bg-amber-500/15 text-amber-300",
  failed: "bg-red-500/15 text-red-300",
}

function RunPill({ status }: { status: HookRunStatus }) {
  return <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-medium", RUN_TONE[status])}>{status}</span>
}

function RunsView({ runs, hooks, loading }: { runs: HookRun[]; hooks: Hook[]; loading: boolean }) {
  const [params, setParams] = useSearchParams()
  const status = parseRunFilter(params.get("runs"))
  const hookId = params.get("hook")
  const counts = runCounts(runs, hookId)
  const shown = filterRuns(runs, status, hookId)
  // Hooks that ran here, deleted ones included (by the name they had).
  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of runs) if (r.hookId) m.set(r.hookId, r.hookName)
    for (const h of hooks) m.set(h.id, h.name)
    return [...m]
  }, [runs, hooks])
  if (loading) return null
  if (!runs.length)
    return (
      <Empty icon={<History className="h-8 w-8" />} title="No runs yet">
        Each time a hook matches a task event, it's logged here: what it sent, and whether it fired, was held back by a guard, or failed.
      </Empty>
    )
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Segmented
          label="Run status"
          size="sm"
          value={status}
          onChange={(v) => setParams((p) => withParam(p, "runs", v === "all" ? null : v), { replace: true })}
          options={RUN_FILTERS.map((f) => ({ key: f.key, label: f.label, count: counts[f.key] }))}
        />
        {names.length > 1 && (
          <Select size="sm" className="w-full sm:w-56" value={hookId ?? ""} onChange={(e) => setParams((p) => withParam(p, "hook", e.target.value || null), { replace: true })} aria-label="Filter by hook">
            <option value="">Every hook</option>
            {names.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-zinc-500">No runs match.</p>
      ) : (
        <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-800/80">
          {shown.slice(0, 100).map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </ul>
      )}
    </div>
  )
}

function RunRow({ run: r }: { run: HookRun }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="px-3 py-2.5" data-testid="hook-run">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <RunPill status={r.status} />
        <span className="min-w-0 truncate font-medium text-zinc-200">{r.hookName}</span>
        <span className="text-xs text-zinc-500">{TRIGGER_INFO[r.event]?.label ?? r.event}</span>
        <span className="ml-auto text-xs text-zinc-500">
          <TimeAgo ts={r.createdAt} />
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {r.taskId && (
          <Link href={`/tasks/${r.taskId}`} className="min-w-0 truncate text-sky-400 hover:underline">
            {r.taskTitle ?? r.taskId}
          </Link>
        )}
        {r.headSha && <code className="rounded bg-zinc-800/80 px-1 text-[11px] text-zinc-400">{shortSha(r.headSha)}</code>}
        {r.targetTaskId && r.targetTaskId !== r.taskId && (
          <Link href={`/tasks/${r.targetTaskId}`} className="text-sky-400 hover:underline">
            → new task
          </Link>
        )}
      </div>
      <p className={cx("mt-1 text-xs wrap-anywhere", r.status === "failed" ? "text-red-300/90" : r.status === "skipped" ? "text-amber-200/80" : "text-zinc-400")}>{r.result}</p>
      <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 flex min-h-11 items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 sm:min-h-0">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {open ? "Hide" : "Show"} the prompt it {r.status === "fired" ? "sent" : "rendered"}
      </button>
      {open && <div className="mt-1 rounded-lg bg-zinc-950/60 px-3 py-2 text-xs whitespace-pre-wrap wrap-anywhere text-zinc-300">{r.prompt}</div>}
    </li>
  )
}

// ------------------------------------------------------------------ editor

function HookEditor({
  projectId,
  hook,
  initial,
  templates,
  onDone,
}: {
  projectId: string | null
  hook: Hook | null
  initial: HookDraft
  templates: HookTemplateView[]
  onDone: () => void
}) {
  const projects = useProjects()
  const tasks = useTasks()
  const ownerName = useOwnerName()
  const create = useCreateHook()
  const update = useUpdateHook()
  const [d, setD] = useState(initial)
  const [filtersOpen, setFiltersOpen] = useState(() => draftToInput(initial, projectId).filters !== undefined && Object.keys(draftToInput(initial, projectId).filters).length > 0)
  const [sampleTask, setSampleTask] = useState("")
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const set = <K extends keyof HookDraft>(key: K, value: HookDraft[K]) => setD((x) => ({ ...x, [key]: value }))
  const problems = draftProblems(d)
  const warnings = draftWarnings(d)
  const dirty = JSON.stringify(d) !== JSON.stringify(initial)
  const project = projects.data?.find((p) => p.id === projectId)
  const input = draftToInput(d, projectId)
  const filterCount = Object.keys(input.filters).length

  // Real tasks to preview with: this project's (or any, for a global hook), PRs first.
  const candidates = useMemo(
    () =>
      (tasks.data ?? [])
        .filter((t) => !projectId || t.projectId === projectId)
        .sort((a, b) => Number(Boolean(b.prUrl)) - Number(Boolean(a.prUrl)) || b.updatedAt - a.updatedAt)
        .slice(0, 30),
    [tasks.data, projectId],
  )
  const previewTask = candidates.find((t) => t.id === sampleTask) ?? null
  const vars = previewVars(previewTask, projects.data?.find((p) => p.id === previewTask?.projectId)?.name)
  const rendered = renderHookTemplate(d.prompt, vars)

  const addVariable = (name: string) => {
    const el = promptRef.current
    const { text, cursor } = insertVariable(d.prompt, name, el?.selectionStart ?? d.prompt.length, el?.selectionEnd ?? d.prompt.length)
    set("prompt", text)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(cursor, cursor)
    })
  }

  const submit = () => {
    if (problems.length) return
    if (hook) update.mutate({ id: hook.id, ...input, projectId: undefined }, { onSuccess: onDone })
    else create.mutate(input, { onSuccess: onDone })
  }

  return (
    <Modal
      size="lg"
      title={hook ? "Edit hook" : "New hook"}
      description={projectId ? `For tasks in ${project?.name ?? "this project"}. The ${project?.name ?? "project"} Captain owns it.` : "Global: every project's tasks. The Coordinator owns it."}
      dirty={dirty}
      onClose={onDone}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      footer={
        <>
          {problems.length > 0 && <span className="mr-auto text-xs text-amber-300">{problems[0]}</span>}
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={problems.length > 0} loading={create.isPending || update.isPending}>
            {hook ? "Save hook" : "Create hook"}
          </Button>
        </>
      }
    >
      <div data-testid="hook-editor" className="space-y-5">
        {!hook && templates.length > 0 && (
          <FieldGroup label="Start from">
            <div className="flex flex-wrap gap-1.5">
              <Chip on={d.template === null} onClick={() => setD(emptyDraft())}>
                Blank
              </Chip>
              {templates.map((t) => (
                <Chip key={t.key} on={d.template === t.key} onClick={() => setD(draftFromTemplate(t))}>
                  <GitMerge className="h-3.5 w-3.5" /> {t.name}
                </Chip>
              ))}
            </div>
          </FieldGroup>
        )}

        {d.template === "pr_merge" && (
          <p className="rounded-lg border border-merged/30 bg-merged/5 px-3 py-2 text-xs text-zinc-300">
            The Merge PR button's request: it goes out the button's way, so it's skipped while another merge of the PR is pending, and the Captain and Coordinator are told who asked. Edit the prompt to make it your own.
          </p>
        )}

        <Field label="Name">
          <input autoFocus={!hook} className={inputClass} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="Merge when ready" />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="When" hint={TRIGGER_INFO[d.trigger].description}>
            <Select className="w-full" value={d.trigger} onChange={(e) => set("trigger", e.target.value as HookDraft["trigger"])}>
              {HOOK_TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_INFO[t].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Then" hint={ACTION_INFO[d.action].description}>
            <Select className="w-full" value={d.action} onChange={(e) => set("action", e.target.value as HookDraft["action"])}>
              {HOOK_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {ACTION_INFO[a].label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="rounded-xl border border-zinc-800/80">
          <button type="button" onClick={() => setFiltersOpen((v) => !v)} className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 sm:min-h-0" aria-expanded={filtersOpen}>
            {filtersOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Filters
            <span className="text-xs text-zinc-500">{filterCount ? `${filterCount} set` : "every task"} · draft PRs{d.trigger === "schedule.run_finished" ? " and quiet runs" : d.trigger === "task.finished" ? " and agent wakes" : ""} skipped unless included</span>
          </button>
          {filtersOpen && (
            <div className="space-y-4 border-t border-zinc-800/80 p-3">
              {!projectId && (
                <Field label="Project">
                  <Select className="w-full" value={d.projectFilter} onChange={(e) => set("projectFilter", e.target.value)}>
                    <option value="">Every project</option>
                    {projects.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Title matches" hint="A regular expression, ignoring case.">
                  <input className={cx(inputClass, "font-mono")} value={d.titleRegex} onChange={(e) => set("titleRegex", e.target.value)} placeholder="^(fix|feat)" />
                </Field>
                <Field label="Prompt matches">
                  <input className={cx(inputClass, "font-mono")} value={d.promptRegex} onChange={(e) => set("promptRegex", e.target.value)} placeholder="deploy|release" />
                </Field>
              </div>
              <FieldGroup label="Started by" hint="None picked: anyone.">
                <div className="flex flex-wrap gap-1.5">
                  {HOOK_SOURCES.map((s) => (
                    <Chip key={s} on={d.sources.includes(s)} onClick={() => set("sources", d.sources.includes(s) ? d.sources.filter((x) => x !== s) : [...d.sources, s])}>
                      {sourceLabel(s, ownerName)}
                    </Chip>
                  ))}
                </div>
              </FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="PR has a label" hint="Any of these, comma-separated.">
                  <input className={inputClass} value={d.labels} onChange={(e) => set("labels", e.target.value)} placeholder="automerge" />
                </Field>
                <Field label="Skip PRs labelled">
                  <input className={inputClass} value={d.excludeLabels} onChange={(e) => set("excludeLabels", e.target.value)} placeholder="no-automerge" />
                </Field>
              </div>
              <div className="flex flex-col gap-2 text-sm text-zinc-300 sm:flex-row sm:gap-5">
                <Check checked={d.includeDrafts} onChange={(v) => set("includeDrafts", v)}>
                  Include draft PRs
                </Check>
                {d.trigger === "schedule.run_finished" && (
                  <Check checked={d.includeQuiet} onChange={(v) => set("includeQuiet", v)}>
                    Include quiet no-op runs
                  </Check>
                )}
                {d.trigger === "task.finished" && (
                  <Check checked={d.includeAgentWakes} onChange={(v) => set("includeAgentWakes", v)}>
                    Include turns another agent woke
                  </Check>
                )}
              </div>
            </div>
          )}
        </div>

        {d.action === "create_task" && (
          <Field label="New task's title" hint="Variables work here too.">
            <input className={inputClass} value={d.taskTitle} onChange={(e) => set("taskTitle", e.target.value)} placeholder="Review {task_title}" />
          </Field>
        )}

        <div className="space-y-1.5">
          <span className="block text-xs font-medium tracking-wide whitespace-nowrap text-zinc-400 uppercase">Prompt</span>
          <div className="flex flex-wrap gap-1" aria-label="Insert a variable">
            {HOOK_VARIABLES.map((v) => (
              <button
                key={v}
                type="button"
                title={VARIABLE_INFO[v]}
                onClick={() => addVariable(v)}
                className="min-h-9 rounded-md bg-zinc-800/80 px-1.5 font-mono text-[11px] text-zinc-300 hover:bg-zinc-700 sm:min-h-0 sm:py-0.5"
              >
                {`{${v}}`}
              </button>
            ))}
          </div>
          <textarea
            ref={promptRef}
            aria-label="Prompt"
            className={cx(inputClass, "min-h-32 font-mono text-[13px] leading-relaxed sm:text-xs")}
            rows={6}
            value={d.prompt}
            onChange={(e) => set("prompt", e.target.value)}
            placeholder="Please merge {pr_url} once the checks pass."
          />
          {warnings.map((w) => (
            <span key={w} className="block text-xs text-amber-300/90">
              {w}
            </span>
          ))}
        </div>

        <div className="space-y-2 rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3" data-testid="hook-preview">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <span className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Preview</span>
            <Select size="sm" className="w-full sm:ml-auto sm:w-64" value={sampleTask} onChange={(e) => setSampleTask(e.target.value)} aria-label="Preview with">
              <option value="">Sample values</option>
              {candidates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.prUrl ? "PR · " : ""}
                  {t.title}
                </option>
              ))}
            </Select>
          </div>
          {d.action === "create_task" && <div className="text-xs text-zinc-400">Task: <span className="text-zinc-200">{renderHookTemplate(d.taskTitle, vars) || "(no title)"}</span></div>}
          <div className="text-[11px] font-semibold text-yard-400">Hook: {d.name.trim() || "(unnamed)"}</div>
          <div className="max-h-56 overflow-y-auto text-sm whitespace-pre-wrap wrap-anywhere text-zinc-200">{rendered || <span className="text-zinc-600">The prompt shows here with its variables filled in.</span>}</div>
          <p className="text-[11px] text-zinc-500">
            {d.action === "send_to_task"
              ? `The agent gets it as a message from the hook (not from ${ownerName}); its transcript labels it like this.`
              : d.action === "create_task"
                ? "The new task starts with this prompt."
                : `The ${d.action === "message_captain" ? "Captain" : "Coordinator"} gets it as a message from the hook.`}{" "}
            Every fire also goes to the Captain and the Coordinator as an update.
          </p>
        </div>

        <div className="flex flex-col gap-3 text-sm text-zinc-300 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
          <label className="flex items-center gap-1">
            <Switch checked={d.enabled} onChange={(v) => set("enabled", v)} label={d.enabled ? "On" : "Off"} />
            {d.enabled ? "On" : "Off"}
          </label>
          <label className="flex items-center gap-2 whitespace-nowrap">
            At most
            <input type="number" min={1} max={50} className={cx(inputClass, "max-w-20")} value={d.maxFiresPerTask} onChange={(e) => set("maxFiresPerTask", e.target.value)} />
            fires per task
          </label>
          <Check checked={d.allowSelfTrigger} onChange={(v) => set("allowSelfTrigger", v)}>
            Fire on its own turns too
          </Check>
        </div>
      </div>
    </Modal>
  )
}

/** Field's look for a group of buttons. Not a <label>: that would make the label click its first button. */
function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className="space-y-1.5">
      <span id={id} className="block text-xs font-medium tracking-wide whitespace-nowrap text-zinc-400 uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        "inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-xs whitespace-nowrap sm:min-h-0 sm:py-1",
        on ? "bg-yard-500/20 text-yard-300" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200",
      )}
    >
      {children}
    </button>
  )
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex min-h-11 items-center gap-2 sm:min-h-0">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

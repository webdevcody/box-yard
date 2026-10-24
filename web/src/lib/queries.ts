import { useCallback } from "react"
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api, clientId } from "./api"
import { toast } from "./toast"
import { deferClose, undoClose, UNDO_MS } from "./inbox"
import { withCleanup } from "./diskCleanup"
import type {
  BoxCleanup,
  AppNotification,
  Artifact,
  Attachment,
  BoxInfo,
  CaptainCompaction,
  CaptainMessage,
  CaptainState,
  ChatMessage,
  Health,
  OrchestratorCompactionRecord,
  OrchestratorState,
  Settings,
  SettingsInfo,
  Project,
  Schedule,
  ScheduleRun,
  ScheduleTarget,
  CatchUp,
  Task,
  TaskCompactionRecord,
  TaskMessage,
  TaskStatus,
  UsageReport,
} from "../../../shared/types"
import type { Hook, HookRun, HookTemplateView, HookWithLastRun } from "../../../shared/hooks"
import type { HookInput } from "./hookForm"

export const keys = {
  me: ["me"] as const,
  health: ["health"] as const,
  projects: ["projects"] as const,
  tasks: ["tasks"] as const,
  taskMessages: (id: string) => ["task-messages", id] as const,
  chat: ["chat"] as const,
  chatStream: ["chat-stream"] as const,
  chatBusy: ["chat-busy"] as const,
  artifacts: ["artifacts"] as const,
  boxes: ["boxes"] as const,
  schedules: ["schedules"] as const,
  scheduleRuns: ["schedule-runs"] as const,
  compactions: ["compactions"] as const,
  compaction: (id: string) => ["compaction", id] as const,
  taskCompactions: (id: string) => ["task-compactions", id] as const,
  settings: ["settings"] as const,
  orchestrator: ["orchestrator"] as const,
  captain: (projectId: string) => ["captain", projectId] as const,
  captainMessages: (projectId: string) => ["captain-messages", projectId] as const,
  captainCompactions: (projectId: string) => ["captain-compactions", projectId] as const,
  agentSettings: ["agent-settings"] as const,
  notifications: ["notifications"] as const,
  usage: ["usage"] as const,
  /** A project's hooks, or "global" for the Coordinator's. */
  hooks: (scope: string) => ["hooks", scope] as const,
  hookRuns: (scope: string) => ["hook-runs", scope] as const,
  hookTemplates: ["hook-templates"] as const,
}

/** `?projectId=…` for a project's hooks, `?scope=global` for the Coordinator's. */
const hookQuery = (scope: string) => (scope === "global" ? "scope=global" : `projectId=${encodeURIComponent(scope)}`)

// ------------------------------------------------------------------ cache helpers

export function upsert<T extends { id: string }>(list: T[] | undefined, item: T, prepend = false): T[] {
  if (!list) return [item]
  const idx = list.findIndex((x) => x.id === item.id)
  if (idx === -1) return prepend ? [item, ...list] : [...list, item]
  const next = list.slice()
  next[idx] = item
  return next
}

export function patchTask(qc: QueryClient, id: string, patch: Partial<Task>) {
  qc.setQueryData<Task[]>(keys.tasks, (list) => list?.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t)))
}

/** Run an optimistic change; returns a function that undoes it. */
function snapshot<T>(qc: QueryClient, key: readonly unknown[]) {
  const before = qc.getQueryData<T>(key)
  return () => qc.setQueryData(key, before)
}

// ------------------------------------------------------------------ queries

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api<{ authed: boolean; authRequired: boolean }>("/api/me") })
export const useHealth = () =>
  useQuery({ queryKey: keys.health, queryFn: () => api<Health>("/api/health"), refetchInterval: 30_000 })
export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/api/projects") })
export const useTasks = () => useQuery({ queryKey: keys.tasks, queryFn: () => api<Task[]>("/api/tasks") })
/** One task from the shared list. Re-renders only when that task changes, not on every task update. */
export function useTask(id: string) {
  const select = useCallback((list: Task[]) => list.find((t) => t.id === id) ?? null, [id])
  return useQuery({ queryKey: keys.tasks, queryFn: () => api<Task[]>("/api/tasks"), select })
}
export const useTaskMessages = (id: string) =>
  useQuery({ queryKey: keys.taskMessages(id), queryFn: () => api<TaskMessage[]>(`/api/tasks/${id}/messages`) })
export const useChat = () => useQuery({ queryKey: keys.chat, queryFn: () => api<ChatMessage[]>("/api/chat") })
export const useArtifacts = () => useQuery({ queryKey: keys.artifacts, queryFn: () => api<Artifact[]>("/api/artifacts") })
export const useSchedules = () => useQuery({ queryKey: keys.schedules, queryFn: () => api<Schedule[]>("/api/schedules") })
export const useScheduleRuns = () => useQuery({ queryKey: keys.scheduleRuns, queryFn: () => api<ScheduleRun[]>("/api/schedule-runs") })
export const useCompactions = () => useQuery({ queryKey: keys.compactions, queryFn: () => api<OrchestratorCompactionRecord[]>("/api/compactions") })
export const useCompaction = (id: string | null) =>
  useQuery({ queryKey: id ? keys.compaction(id) : ["compaction", "none"], queryFn: () => api<OrchestratorCompactionRecord>(`/api/compactions/${id}`), enabled: Boolean(id) })
export const useTaskCompactions = (taskId: string) =>
  useQuery({ queryKey: keys.taskCompactions(taskId), queryFn: () => api<TaskCompactionRecord[]>(`/api/task-compactions?taskId=${encodeURIComponent(taskId)}`) })
export const useSettings = () =>
  useQuery({
    queryKey: keys.settings,
    queryFn: () => api<{ defaultTimezone: string; scheduler: "local" | "qstash"; maxUploadMb: number }>("/api/settings"),
    staleTime: Infinity,
  })
export const useOrchestratorState = () =>
  useQuery({ queryKey: keys.orchestrator, queryFn: () => api<OrchestratorState>("/api/orchestrator"), staleTime: Infinity })
export const useCaptainState = (projectId: string) =>
  useQuery({ queryKey: keys.captain(projectId), queryFn: () => api<CaptainState>(`/api/projects/${projectId}/captain`), staleTime: Infinity })
export const useCaptainMessages = (projectId: string) =>
  useQuery({ queryKey: keys.captainMessages(projectId), queryFn: () => api<CaptainMessage[]>(`/api/projects/${projectId}/captain/messages`) })
export const useCaptainCompactions = (projectId: string) =>
  useQuery({ queryKey: keys.captainCompactions(projectId), queryFn: () => api<CaptainCompaction[]>(`/api/projects/${projectId}/captain/compactions`) })
export const useAgentSettings = () =>
  useQuery({ queryKey: keys.agentSettings, queryFn: () => api<SettingsInfo>("/api/agent-settings"), staleTime: Infinity })
/** Newest first; kept live by the event stream (see lib/notifications.ts). */
export const useNotifications = () =>
  useQuery({ queryKey: keys.notifications, queryFn: () => api<AppNotification[]>("/api/notifications?limit=50"), staleTime: Infinity })
export const useBoxes = () => useQuery({ queryKey: keys.boxes, queryFn: () => api<BoxInfo[]>("/api/boxes") })
/** The usage report; with a range it includes `period` for it. Live events invalidate every range (prefix key). */
export const useUsage = (range?: { from: number; to: number; live: boolean }) =>
  useQuery({
    // A range that runs to "now" is keyed by its start only, so refetches don't make a new cache entry.
    queryKey: range ? [...keys.usage, range.from, range.live ? "now" : range.to] : keys.usage,
    queryFn: () => api<UsageReport>(range ? `/api/usage?from=${range.from}${range.live ? "" : `&to=${range.to}`}` : "/api/usage"),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })

export const useChatStream = () =>
  useQuery({ queryKey: keys.chatStream, queryFn: () => "", initialData: "", staleTime: Infinity, gcTime: Infinity })
export const useChatBusy = () =>
  useQuery({
    queryKey: keys.chatBusy,
    queryFn: async () => (await api<Health>("/api/health")).orchestratorBusy,
    staleTime: Infinity,
  })

// ------------------------------------------------------------------ mutations

const fail = (title: string) => (err: Error) => toast.error(title, err.message)

// ------------------------------------------------------------------ hooks (automations on task events)

export const useHooks = (scope: string) => useQuery({ queryKey: keys.hooks(scope), queryFn: () => api<HookWithLastRun[]>(`/api/hooks?${hookQuery(scope)}`) })
export const useHookRuns = (scope: string) =>
  useQuery({ queryKey: keys.hookRuns(scope), queryFn: () => api<HookRun[]>(`/api/hooks/runs?${hookQuery(scope)}&limit=200`) })
export const useHookTemplates = () => useQuery({ queryKey: keys.hookTemplates, queryFn: () => api<HookTemplateView[]>("/api/hooks/templates"), staleTime: Infinity })

function useHookMutation<V, R>(fn: (v: V) => Promise<R>, what: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onError: fail(`Couldn't ${what}`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["hooks"] })
      void qc.invalidateQueries({ queryKey: ["hook-runs"] })
    },
  })
}

export const useCreateHook = () => useHookMutation((input: HookInput) => api<Hook>("/api/hooks", { body: input }), "create the hook")
export const useUpdateHook = () =>
  useHookMutation(({ id, ...patch }: { id: string } & Partial<HookInput>) => api<Hook>(`/api/hooks/${id}`, { method: "PATCH", body: patch }), "update the hook")
export const useDeleteHook = () => useHookMutation((id: string) => api(`/api/hooks/${id}`, { method: "DELETE" }), "delete the hook")
export const useHookFromTemplate = () =>
  useHookMutation((v: { projectId: string | null; template: string }) => api<Hook>("/api/hooks/from-template", { body: v }), "add the hook")

/** Optimistic on/off: the switch flips at once and flips back if the server says no. */
export function useToggleHook(scope: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api<Hook>(`/api/hooks/${id}`, { method: "PATCH", body: { enabled } }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: keys.hooks(scope) })
      const undo = snapshot<HookWithLastRun[]>(qc, keys.hooks(scope))
      qc.setQueryData<HookWithLastRun[]>(keys.hooks(scope), (list) => list?.map((h) => (h.id === id ? { ...h, enabled } : h)))
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't switch the hook")(err)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["hooks"] }),
  })
}

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; name: string; description?: string; repo?: string | null; baseBranch?: string; env?: Record<string, string> }) =>
      api<Project>("/api/projects", { body: input }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.projects })
      const undo = snapshot<Project[]>(qc, keys.projects)
      const now = Date.now()
      qc.setQueryData<Project[]>(keys.projects, (list) =>
        upsert(list, {
          id: input.id,
          name: input.name,
          description: input.description ?? "",
          repo: input.repo || null,
          baseBranch: input.baseBranch || "main",
          envKeys: Object.keys(input.env ?? {}),
          notes: [],
          createdAt: now,
          updatedAt: now,
        }),
      )
      return { undo }
    },
    onError: (err, _input, ctx) => {
      ctx?.undo()
      fail("Couldn't create the project")(err)
    },
    onSuccess: (project) => qc.setQueryData<Project[]>(keys.projects, (list) => upsert(list, project)),
  })
}

export function useUpdateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; description?: string; repo?: string | null; baseBranch?: string; env?: Record<string, string>; removeEnv?: string[] }) =>
      api<Project>(`/api/projects/${id}`, { method: "PATCH", body: patch }),
    onMutate: async ({ id, env, removeEnv, ...patch }) => {
      await qc.cancelQueries({ queryKey: keys.projects })
      const undo = snapshot<Project[]>(qc, keys.projects)
      qc.setQueryData<Project[]>(keys.projects, (list) =>
        list?.map((p) =>
          p.id === id
            ? {
                ...p,
                ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
                envKeys: [...new Set([...p.envKeys.filter((k) => !removeEnv?.includes(k)), ...Object.keys(env ?? {})])],
              }
            : p,
        ),
      )
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't save the project")(err)
    },
    onSuccess: (project) => qc.setQueryData<Project[]>(keys.projects, (list) => upsert(list, project)),
  })
}

export function useDeleteProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api(`/api/projects/${id}`, { method: "DELETE" }),
    onMutate: async (id) => {
      const undoP = snapshot<Project[]>(qc, keys.projects)
      const undoT = snapshot<Task[]>(qc, keys.tasks)
      qc.setQueryData<Project[]>(keys.projects, (list) => list?.filter((p) => p.id !== id))
      qc.setQueryData<Task[]>(keys.tasks, (list) => list?.filter((t) => t.projectId !== id))
      return { undo: () => (undoP(), undoT()) }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't delete the project")(err)
    },
  })
}

export function useAddNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, content }: { projectId: string; content: string }) =>
      api<Project>(`/api/projects/${projectId}/notes`, { body: { content } }),
    onMutate: async ({ projectId, content }) => {
      const undo = snapshot<Project[]>(qc, keys.projects)
      qc.setQueryData<Project[]>(keys.projects, (list) =>
        list?.map((p) =>
          p.id === projectId
            ? { ...p, notes: [...p.notes, { id: `tmp-${Date.now()}`, projectId, author: "Cody", content, createdAt: Date.now() }] }
            : p,
        ),
      )
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't save the note")(err)
    },
    onSuccess: (project) => qc.setQueryData<Project[]>(keys.projects, (list) => upsert(list, project)),
  })
}

export function useCreateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; projectId: string; title: string; prompt: string; env?: Record<string, string> }) =>
      api<Task>("/api/tasks", { body: input }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.tasks })
      const undo = snapshot<Task[]>(qc, keys.tasks)
      const now = Date.now()
      qc.setQueryData<Task[]>(keys.tasks, (list) =>
        upsert(list, {
          id: input.id,
          projectId: input.projectId,
          title: input.title,
          prompt: input.prompt,
          status: "queued",
          boxId: null,
          sessionId: "",
          branch: null,
          prUrl: null,
          prState: null,
          prMergedAt: null,
          prMergedBy: null,
          previews: [],
          question: null,
          summary: null,
          error: null,
          waitReason: null,
          turnCount: 0,
          pendingCount: 0,
          lastArchivedAt: null,
          scheduleId: null,
          outcome: null,
          contextTokens: null,
          contextWindow: null,
          compactPending: false,
          compacting: false,
          model: null,
          effort: null,
          claudeCostUsd: 0,
          claudeTokens: 0,
          routingRule: null,
          routingReason: null,
          createdAt: now,
          updatedAt: now,
        }),
      )
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't start the task")(err)
    },
    onSuccess: (task) => qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task)),
  })
}

export function useSendTaskMessage(taskId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { content: string; attachments?: Attachment[] }) =>
      api<Task>(`/api/tasks/${taskId}/messages`, { body: { content: input.content, attachments: input.attachments?.map((a) => a.id) } }),
    onMutate: async ({ content, attachments }) => {
      const undoTasks = snapshot<Task[]>(qc, keys.tasks)
      const undoMsgs = snapshot<TaskMessage[]>(qc, keys.taskMessages(taskId))
      const task = qc.getQueryData<Task[]>(keys.tasks)?.find((t) => t.id === taskId)
      const running = task?.status === "working" || task?.status === "starting"
      patchTask(qc, taskId, running ? { pendingCount: (task?.pendingCount ?? 0) + 1 } : { status: "queued", question: null })
      qc.setQueryData<TaskMessage[]>(keys.taskMessages(taskId), (list) => [
        ...(list ?? []),
        { id: `tmp-${Date.now()}`, taskId, role: "user", content, meta: { pending: true, ...(attachments?.length ? { attachments } : {}) }, createdAt: Date.now() },
      ])
      return { undo: () => (undoTasks(), undoMsgs()) }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't send the message")(err)
    },
    onSuccess: (task) => qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task)),
  })
}

function useTaskAction(action: "stop" | "close" | "retry", optimistic: (t: Task) => Partial<Task>, label: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => api<Task>(`/api/tasks/${taskId}/${action}`, { method: "POST" }),
    onMutate: async (taskId) => {
      const undo = snapshot<Task[]>(qc, keys.tasks)
      const task = qc.getQueryData<Task[]>(keys.tasks)?.find((t) => t.id === taskId)
      if (task) patchTask(qc, taskId, optimistic(task))
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail(`Couldn't ${label}`)(err)
    },
    onSuccess: (task) => qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task)),
  })
}

/** The "Merge PR" button: POST /api/tasks/:id/merge. The button guards against double sends (lib/mergePr.ts). */
export function useRequestMerge() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => api<{ task: Task; delivery: "now" | "queued" }>(`/api/tasks/${taskId}/merge`, { method: "POST" }),
    onError: fail("Couldn't request the merge"),
    onSuccess: ({ task, delivery }) => {
      qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task))
      if (delivery === "queued") toast.info("Merge request queued", `${task.title} is mid-turn; the request goes out when that turn ends.`)
      else toast.info("Merge requested", task.title)
    },
  })
}

export const useStopTask = () =>
  useTaskAction("stop", (t) => (t.status === "queued" ? { status: (t.turnCount ? "idle" : "failed") as TaskStatus } : {}), "stop the task")
export const useCloseTask = () => useTaskAction("close", () => ({ status: "done" as TaskStatus, question: null }), "close the task")
export const useRetryTask = () => useTaskAction("retry", () => ({ status: "queued" as TaskStatus, error: null }), "retry the task")

/** Inbox card "Mark done": the same close as the task view's, sent after a short undo window. */
export function useMarkDoneFromInbox() {
  const { mutateAsync } = useCloseTask()
  return useCallback(
    (task: Task) => {
      if (!deferClose(task.id, () => mutateAsync(task.id))) return
      toast.info("Marked done", task.title, { action: { label: "Undo", onClick: () => undoClose(task.id) }, duration: UNDO_MS })
    },
    [mutateAsync],
  )
}

export function useDeleteTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => api(`/api/tasks/${taskId}`, { method: "DELETE" }),
    onMutate: async (taskId) => {
      const undo = snapshot<Task[]>(qc, keys.tasks)
      qc.setQueryData<Task[]>(keys.tasks, (list) => list?.filter((t) => t.id !== taskId))
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't delete the task")(err)
    },
  })
}

export interface ScheduleInput {
  id: string
  target: ScheduleTarget
  /** Null for Coordinator schedules (stored as target "orchestrator" for compatibility). */
  projectId: string | null
  name: string
  cron: string
  timezone: string
  prompt: string
  catchUp: CatchUp
  allowOverlap: boolean
}

export function useCreateSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ScheduleInput) => api<Schedule>("/api/schedules", { body: input }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.schedules })
      const undo = snapshot<Schedule[]>(qc, keys.schedules)
      const now = Date.now()
      qc.setQueryData<Schedule[]>(keys.schedules, (list) =>
        upsert(list, {
          ...input,
          enabled: true,
          nextRunAt: null,
          lastRunAt: null,
          lastTaskId: null,
          lastSkipReason: null,
          runCount: 0,
          qstashId: null,
          createdAt: now,
          updatedAt: now,
        }),
      )
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't create the schedule")(err)
    },
    onSuccess: (schedule) => qc.setQueryData<Schedule[]>(keys.schedules, (list) => upsert(list, schedule)),
  })
}

export function useUpdateSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<Omit<ScheduleInput, "id" | "projectId" | "target">> & { enabled?: boolean }) =>
      api<Schedule>(`/api/schedules/${id}`, { method: "PATCH", body: patch }),
    onMutate: async ({ id, ...patch }) => {
      const undo = snapshot<Schedule[]>(qc, keys.schedules)
      qc.setQueryData<Schedule[]>(keys.schedules, (list) => list?.map((s) => (s.id === id ? { ...s, ...patch } : s)))
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't update the schedule")(err)
    },
    onSuccess: (schedule) => qc.setQueryData<Schedule[]>(keys.schedules, (list) => upsert(list, schedule)),
  })
}

export function useDeleteSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api(`/api/schedules/${id}`, { method: "DELETE" }),
    onMutate: async (id) => {
      const undo = snapshot<Schedule[]>(qc, keys.schedules)
      qc.setQueryData<Schedule[]>(keys.schedules, (list) => list?.filter((s) => s.id !== id))
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't delete the schedule")(err)
    },
  })
}

export function useRunSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<Task | ScheduleRun>(`/api/schedules/${id}/run`, { method: "POST" }),
    onError: fail("Couldn't start a run"),
    onSuccess: (run) => {
      if ("dueAt" in run) qc.setQueryData<ScheduleRun[]>(keys.scheduleRuns, (list) => upsert(list, run, true))
      else qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, run))
    },
  })
}

/** Clean up a box's disk now (graduated, safe steps). The result arrives as SSE box.cleanup. */
export function useCleanBox() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (boxId: string) => api<BoxCleanup>(`/api/boxes/${boxId}/cleanup`, { method: "POST" }),
    onError: fail("Couldn't start the cleanup"),
    onSuccess: (cleanup) => qc.setQueryData<BoxInfo[]>(keys.boxes, (list) => withCleanup(list, cleanup)),
  })
}

export function useSendChat() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; content: string; attachments?: Attachment[] }) =>
      api<ChatMessage>("/api/chat", { body: { ...input, attachments: input.attachments?.map((a) => a.id) } }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.chat })
      const undo = snapshot<ChatMessage[]>(qc, keys.chat)
      qc.setQueryData<ChatMessage[]>(keys.chat, (list) =>
        upsert(list, {
          id: input.id,
          role: "user",
          content: input.content,
          meta: { pending: true, ...(input.attachments?.length ? { attachments: input.attachments } : {}) },
          createdAt: Date.now(),
        }),
      )
      qc.setQueryData(keys.chatBusy, true)
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      qc.setQueryData(keys.chatBusy, false)
      fail("Couldn't send to the Coordinator")(err)
    },
    onSuccess: (msg) => qc.setQueryData<ChatMessage[]>(keys.chat, (list) => upsert(list, msg)),
  })
}

export function useSendCaptainMessage(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; content: string; attachments?: Attachment[] }) =>
      api<CaptainMessage>(`/api/projects/${projectId}/captain/messages`, { body: { ...input, attachments: input.attachments?.map((a) => a.id) } }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.captainMessages(projectId) })
      const undo = snapshot<CaptainMessage[]>(qc, keys.captainMessages(projectId))
      qc.setQueryData<CaptainMessage[]>(keys.captainMessages(projectId), (list) =>
        upsert(list, {
          id: input.id,
          projectId,
          role: "user",
          content: input.content,
          meta: { pending: true, source: "cody", ...(input.attachments?.length ? { attachments: input.attachments } : {}) },
          createdAt: Date.now(),
        }),
      )
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't message the Captain")(err)
    },
    onSuccess: (msg) => qc.setQueryData<CaptainMessage[]>(keys.captainMessages(projectId), (list) => upsert(list, msg)),
  })
}

export function useChatControl() {
  return {
    stop: () => api("/api/chat/stop", { method: "POST" }).catch(fail("Couldn't stop the Coordinator")),
  }
}

export const newClientId = clientId

export function useSaveSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => api<SettingsInfo>("/api/agent-settings", { method: "PUT", body: patch }),
    onSuccess: (info) => qc.setQueryData(keys.agentSettings, info),
    onError: fail("Couldn't save the settings"),
  })
}

export function useResetSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<SettingsInfo>("/api/agent-settings", { method: "DELETE" }),
    onSuccess: (info) => qc.setQueryData(keys.agentSettings, info),
    onError: fail("Couldn't reset the settings"),
  })
}

export function useCompactTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => api<Task>(`/api/tasks/${taskId}/compact`, { method: "POST", body: {} }),
    onMutate: (taskId) => patchTask(qc, taskId, { compactPending: true }),
    onSuccess: (task) => qc.setQueryData<Task[]>(keys.tasks, (list) => (list ? upsert(list, task) : list)),
    onError: (err, taskId) => {
      patchTask(qc, taskId, { compactPending: false })
      toast.error("Couldn't compact", err.message)
    },
  })
}

export function useCompactOrchestrator() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<OrchestratorState>("/api/orchestrator/compact", { method: "POST", body: {} }),
    onSuccess: (state) => qc.setQueryData(keys.orchestrator, state),
    onError: fail("Couldn't compact"),
  })
}

export function useCompactCaptain(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<CaptainState>(`/api/projects/${projectId}/captain/compact`, { method: "POST", body: {} }),
    onSuccess: (state) => qc.setQueryData(keys.captain(projectId), state),
    onError: fail("Couldn't compact the Captain"),
  })
}

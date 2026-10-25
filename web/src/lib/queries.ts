import { useCallback, useEffect, useRef } from "react"
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api, clientId } from "./api"
import { toast } from "./toast"
import { deferClose, undoClose, UNDO_MS } from "./inbox"
import { withCleanup } from "./diskCleanup"
import { announceResize, withResize } from "./boxResize"
import type { ProjectSnapshotState } from "./projectSnapshot"
import type { SnapshotJob } from "../../../shared/snapshots"
import { DEFAULT_OWNER_NAME } from "../../../shared/owner"
import type { TtsInfo } from "../../../shared/tts"
import type { CredentialKey, CredentialTest, CredentialsPatch, RecentRepos, SetupStatus } from "../../../shared/setup"
import type { RunPodGpuOption, RunPodImageBuild, RunPodStatus } from "../../../shared/runpod"
import type { Runner } from "../../../shared/runner"
import { setTtsInfo } from "./tts"
import { applyOrder } from "./projectOrder"
import { settleOptimistic } from "./queued"
import type {
  BoxCleanup,
  BoxContents,
  BoxResize,
  BoxSize,
  ResizePlan,
  AppNotification,
  Artifact,
  Attachment,
  BoxInfo,
  CaptainCompaction,
  CaptainMessage,
  CaptainState,
  ChatMessage,
  Effort,
  Health,
  OrchestratorCompactionRecord,
  OrchestratorState,
  Settings,
  SettingsInfo,
  NoteSuggestion,
  Project,
  ProjectNote,
  QueuedMessage,
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
import { boxHistoryQuery, type BoxHistoryPage, type HistoryFilter } from "./boxHistory"

export const keys = {
  me: ["me"] as const,
  health: ["health"] as const,
  projects: ["projects"] as const,
  tasks: ["tasks"] as const,
  taskMessages: (id: string) => ["task-messages", id] as const,
  taskQueue: (id: string) => ["task-queue", id] as const,
  chat: ["chat"] as const,
  chatStream: ["chat-stream"] as const,
  chatBusy: ["chat-busy"] as const,
  artifacts: ["artifacts"] as const,
  boxes: ["boxes"] as const,
  /** Prefix of every box history query; a box.event invalidates them all. */
  boxHistory: ["box-history"] as const,
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
  tts: ["tts-settings"] as const,
  setup: ["setup"] as const,
  runpod: ["runpod"] as const,
  runpodGpus: ["runpod-gpus"] as const,
  setupRepos: ["setup-repos"] as const,
  notifications: ["notifications"] as const,
  usage: ["usage"] as const,
  /** A project's hooks, or "global" for the Coordinator's. */
  hooks: (scope: string) => ["hooks", scope] as const,
  hookRuns: (scope: string) => ["hook-runs", scope] as const,
  hookTemplates: ["hook-templates"] as const,
  /** Mutation key of saving the project order, so live order events wait for the last save. */
  projectsOrder: ["projects-order"] as const,
  /** A project's note suggestions from agents: "pending", or "all" for the resolved ones too. */
  noteSuggestions: (projectId: string) => ["note-suggestions", projectId] as const,
  /** A project's snapshot and its running or last snapshot job. */
  projectSnapshot: (projectId: string) => ["project-snapshot", projectId] as const,
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
/**
 * For views that read a list once, like the command palette: re-render when the list loads, not on every live update.
 * `data` is still current whenever the view renders for another reason (a keystroke).
 */
type Quiet = { notifyOnChangeProps?: ["status"] }
export const QUIET: Quiet = { notifyOnChangeProps: ["status"] }

export const useProjects = (o?: Quiet) => useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/api/projects"), notifyOnChangeProps: o?.notifyOnChangeProps })
export const useTasks = (o?: Quiet) => useQuery({ queryKey: keys.tasks, queryFn: () => api<Task[]>("/api/tasks"), notifyOnChangeProps: o?.notifyOnChangeProps })
/** One task from the shared list. Re-renders only when that task changes, not on every task update. */
export function useTask(id: string) {
  const select = useCallback((list: Task[]) => list.find((t) => t.id === id) ?? null, [id])
  return useQuery({ queryKey: keys.tasks, queryFn: () => api<Task[]>("/api/tasks"), select })
}
/**
 * A task's queued messages (the task page's Queued rows). Refetched when the task's queueRev changes, which only
 * this hook's component reads, so live task updates don't re-render the transcript.
 */
export function useTaskQueue(id: string) {
  const qc = useQueryClient()
  const select = useCallback((list: Task[]) => list.find((t) => t.id === id)?.queueRev ?? "", [id])
  const rev = useQuery({ queryKey: keys.tasks, queryFn: () => api<Task[]>("/api/tasks"), select }).data ?? ""
  const queue = useQuery({ queryKey: keys.taskQueue(id), queryFn: () => api<QueuedMessage[]>(`/api/tasks/${id}/queue`) })
  const seen = useRef<string | null>(null)
  useEffect(() => {
    // The first rev is what the first fetch already reflects.
    if (seen.current !== null && seen.current !== rev) void qc.invalidateQueries({ queryKey: keys.taskQueue(id) })
    seen.current = rev
  }, [qc, id, rev])
  return queue
}

/** Edit, delete and undo a queued message. Optimistic; a 409 (already delivered) rolls back and refetches. */
export function useQueuedMessageActions(taskId: string) {
  const qc = useQueryClient()
  const key = keys.taskQueue(taskId)
  const patch = (fn: (list: QueuedMessage[]) => QueuedMessage[]) => {
    void qc.cancelQueries({ queryKey: key })
    const undo = snapshot<QueuedMessage[]>(qc, key)
    qc.setQueryData<QueuedMessage[]>(key, (list) => (list ? fn(list) : list))
    return { undo }
  }
  const settle = () => void qc.invalidateQueries({ queryKey: key })
  const edit = useMutation({
    mutationFn: (m: { id: string; text: string; version: number }) => api<QueuedMessage>(`/api/tasks/${taskId}/queue/${m.id}`, { method: "PATCH", body: { text: m.text, version: m.version } }),
    onMutate: (m) => patch((list) => list.map((x) => (x.id === m.id ? { ...x, text: m.text } : x))),
    onError: (err, _m, ctx) => {
      ctx?.undo()
      fail("Couldn't save the edit")(err)
    },
    onSettled: settle,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api<QueuedMessage>(`/api/tasks/${taskId}/queue/${id}`, { method: "DELETE" }),
    onMutate: (id) => patch((list) => list.filter((x) => x.id !== id)),
    onError: (err, _id, ctx) => {
      ctx?.undo()
      fail("Couldn't delete the message")(err)
    },
    onSettled: settle,
  })
  const restore = useMutation({
    mutationFn: (m: QueuedMessage) => api<QueuedMessage>(`/api/tasks/${taskId}/queue/${m.id}/restore`, { method: "POST" }),
    onMutate: (m) => patch((list) => [...list.filter((x) => x.id !== m.id), m].sort((a, b) => a.createdAt - b.createdAt)),
    onError: (err, _m, ctx) => {
      ctx?.undo()
      fail("Couldn't undo")(err)
    },
    onSettled: settle,
  })
  return { edit, remove, restore }
}

/**
 * Edit or delete a message queued mid-turn in the Coordinator chat (`projectId` null) or a Captain's thread.
 * Optimistic; the live stream brings the server's copy. Delete shows an Undo toast. The server refuses once the
 * turn that reads it has started ("already delivered"), and the change rolls back.
 */
export function useQueuedChatActions(projectId: string | null) {
  const qc = useQueryClient()
  const key = projectId ? keys.captainMessages(projectId) : keys.chat
  const base = projectId ? `/api/projects/${projectId}/captain/messages` : "/api/chat/messages"
  type Msg = ChatMessage | CaptainMessage
  const patch = (id: string, fn: (m: Msg) => Msg) => {
    void qc.cancelQueries({ queryKey: key })
    const undo = snapshot<Msg[]>(qc, key)
    qc.setQueryData<Msg[]>(key, (list) => list?.map((m) => (m.id === id ? fn(m) : m)))
    return { undo }
  }
  const rollback = (title: string) => (err: Error, _v: unknown, ctx?: { undo: () => void }) => {
    ctx?.undo()
    void qc.invalidateQueries({ queryKey: key })
    fail(title)(err)
  }
  const restore = useMutation({
    mutationFn: (id: string) => api<Msg>(`${base}/${id}/restore`, { method: "POST" }),
    onMutate: (id) => patch(id, (m) => ({ ...m, meta: { ...withoutKey(m.meta, "cancelled"), queued: true } })),
    onError: rollback("Couldn't undo"),
  })
  const edit = useMutation({
    mutationFn: (m: { id: string; text: string }) => api<Msg>(`${base}/${m.id}`, { method: "PATCH", body: { text: m.text } }),
    onMutate: (m) => patch(m.id, (x) => ({ ...x, content: m.text.trim() })),
    onError: rollback("Couldn't save the edit"),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api<Msg>(`${base}/${id}`, { method: "DELETE" }),
    onMutate: (id) => patch(id, (m) => ({ ...m, meta: { ...withoutKey(m.meta, "queued"), cancelled: true } })),
    onError: rollback("Couldn't delete the message"),
    onSuccess: (_m, id) =>
      toast.info("Queued message deleted", undefined, { action: { label: "Undo", onClick: () => restore.mutate(id) }, duration: UNDO_MS }),
  })
  return { edit, remove, restore }
}

function withoutKey(meta: Record<string, unknown> | null, key: string): Record<string, unknown> {
  const { [key]: _, ...rest } = meta ?? {}
  return rest
}

export const useTaskMessages = (id: string) =>
  useQuery({ queryKey: keys.taskMessages(id), queryFn: () => api<TaskMessage[]>(`/api/tasks/${id}/messages`) })
export const useChat = () => useQuery({ queryKey: keys.chat, queryFn: () => api<ChatMessage[]>("/api/chat") })
export const useArtifacts = (o?: Quiet) => useQuery({ queryKey: keys.artifacts, queryFn: () => api<Artifact[]>("/api/artifacts"), notifyOnChangeProps: o?.notifyOnChangeProps })
export const useSchedules = (o?: Quiet) => useQuery({ queryKey: keys.schedules, queryFn: () => api<Schedule[]>("/api/schedules"), notifyOnChangeProps: o?.notifyOnChangeProps })
export const useScheduleRuns = () => useQuery({ queryKey: keys.scheduleRuns, queryFn: () => api<ScheduleRun[]>("/api/schedule-runs") })
export const useCompactions = () => useQuery({ queryKey: keys.compactions, queryFn: () => api<OrchestratorCompactionRecord[]>("/api/compactions") })
export const useCompaction = (id: string | null) =>
  useQuery({ queryKey: id ? keys.compaction(id) : ["compaction", "none"], queryFn: () => api<OrchestratorCompactionRecord>(`/api/compactions/${id}`), enabled: Boolean(id) })
export const useTaskCompactions = (taskId: string) =>
  useQuery({ queryKey: keys.taskCompactions(taskId), queryFn: () => api<TaskCompactionRecord[]>(`/api/task-compactions?taskId=${encodeURIComponent(taskId)}`) })
export const useSettings = () =>
  useQuery({
    queryKey: keys.settings,
    queryFn: () => api<{ defaultTimezone: string; scheduler: "local" | "qstash"; maxUploadMb: number; localDir?: string }>("/api/settings"),
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
export const useAgentSettings = (o: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: keys.agentSettings, queryFn: () => api<SettingsInfo>("/api/agent-settings"), staleTime: Infinity, enabled: o.enabled })
/** Settings › Voice text-to-speech choices; keys only as set/unset. Also feeds lib/speech's engine choice. */
export const useTtsSettings = () =>
  useQuery({
    queryKey: keys.tts,
    queryFn: async () => {
      const info = await api<TtsInfo>("/api/tts/settings")
      setTtsInfo(info)
      return info
    },
    staleTime: Infinity,
  })
export function useSaveTts() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<TtsInfo>("/api/tts/settings", { method: "PUT", body: patch }),
    onSuccess: (info) => {
      qc.setQueryData(keys.tts, info)
      setTtsInfo(info)
    },
    onError: fail("Couldn't save the voice settings"),
  })
}
/** First-run setup and Settings › Credentials: what's set and where from, never a value. Kept live by the "setup" event. */
export const useSetup = (o: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: keys.setup, queryFn: () => api<SetupStatus>("/api/setup"), staleTime: Infinity, enabled: o.enabled })
/** The GitHub token's most recently pushed repos, for Zen's first prompts. Empty without a token or on any error. */
export const useRecentRepos = (o: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: keys.setupRepos, queryFn: () => api<RecentRepos>("/api/setup/repos"), staleTime: Infinity, enabled: o.enabled })
/** Save or remove credentials. Errors show next to the field, so there's no toast. */
export function useSaveCredentials() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: CredentialsPatch) => api<SetupStatus>("/api/setup/credentials", { method: "PUT", body: patch }),
    onSuccess: (status) => {
      qc.setQueryData(keys.setup, status)
      void qc.invalidateQueries({ queryKey: keys.health })
      void qc.invalidateQueries({ queryKey: keys.setupRepos })
    },
  })
}
/** Where agents run (the setup choice): "local" needs no Upstash key. New projects follow it. */
export function useSaveRunnerChoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (runner: Runner) => api<SetupStatus>("/api/setup/runner", { method: "PUT", body: { runner } }),
    onSuccess: (status) => {
      qc.setQueryData(keys.setup, status)
      void qc.invalidateQueries({ queryKey: keys.health })
      void qc.invalidateQueries({ queryKey: keys.setupRepos })
    },
  })
}
/** Look at this computer's tools and logins again (Node, claude, gh, Chrome). */
export function useCheckLocal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<SetupStatus>("/api/setup/local/check", { method: "POST" }),
    onSuccess: (status) => {
      qc.setQueryData(keys.setup, status)
      void qc.invalidateQueries({ queryKey: keys.health })
    },
  })
}
/** A live check of a credential: `value` when given (typed, not saved), else the one in effect. */
export function useTestCredential() {
  return useMutation({
    mutationFn: ({ key, value }: { key: CredentialKey; value?: string }) =>
      api<CredentialTest>(`/api/setup/test/${key}`, { method: "POST", body: value ? { value } : {} }),
  })
}
/** What Box Yard calls its human (Settings › Box agents › Your name). */
export const useOwnerName = () => useAgentSettings().data?.settings.ownerName ?? DEFAULT_OWNER_NAME
/** Newest first; kept live by the event stream (see lib/notifications.ts). */
export const useNotifications = () =>
  useQuery({ queryKey: keys.notifications, queryFn: () => api<AppNotification[]>("/api/notifications?limit=50"), staleTime: Infinity })
export const useBoxes = (o?: Quiet) => useQuery({ queryKey: keys.boxes, queryFn: () => api<BoxInfo[]>("/api/boxes"), notifyOnChangeProps: o?.notifyOnChangeProps })
/** The box history log, newest first, for a filter; the previous page stays on screen while a new filter loads. */
export const useBoxHistory = (filter: HistoryFilter, limit: number) =>
  useQuery({
    queryKey: [...keys.boxHistory, filter.boxId ?? "", filter.type ?? "", filter.actor ?? "", limit],
    queryFn: () => api<BoxHistoryPage>(`/api/box-history${boxHistoryQuery(filter, limit)}`),
    placeholderData: keepPreviousData,
  })
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

// ------------------------------------------------------------------ RunPod GPU (Settings › RunPod GPU)

/** Settings, pods, volumes, Docker and the image build. Polled while open: pods change at RunPod, not here. */
export const useRunPod = (o: { enabled?: boolean; poll?: boolean } = {}) =>
  useQuery({ queryKey: keys.runpod, queryFn: () => api<RunPodStatus>("/api/runpod"), enabled: o.enabled, refetchInterval: o.poll ? 15_000 : false, staleTime: 5_000 })
/** GPU types RunPod offers on Secure Cloud, cheapest first. */
export const useRunPodGpus = (o: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: keys.runpodGpus, queryFn: () => api<RunPodGpuOption[]>("/api/runpod/gpus"), enabled: o.enabled, staleTime: 5 * 60_000 })
/** A RunPod action: save settings, build the image, stop a pod, keep it warm, delete a volume. */
export function useRunPodAction<T>(title: string, call: (input: T) => Promise<RunPodStatus | RunPodImageBuild>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: call,
    onSuccess: (r) => {
      if ("settings" in r) qc.setQueryData(keys.runpod, r)
      else void qc.invalidateQueries({ queryKey: keys.runpod })
    },
    onError: fail(title),
  })
}

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
    mutationFn: (input: { id: string; name: string; description?: string; repo?: string | null; baseBranch?: string; env?: Record<string, string>; runner?: Runner }) =>
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
          notesMaxCount: null,
          notesMaxTokens: null,
          boxSize: null,
          partialClone: null,
          pushAtTurnEnd: null,
          depCache: null,
          // Unless the form picked one, the server uses the setup choice.
          runner: input.runner ?? qc.getQueryData<SetupStatus>(keys.setup)?.runner.default ?? "box",
          agentsPerBox: null,
          tasksPerBox: null,
          maxBoxes: null,
          gpuMaxHourlyUsd: null,
          snapshot: null,
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
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string
      name?: string
      description?: string
      repo?: string | null
      baseBranch?: string
      env?: Record<string, string>
      removeEnv?: string[]
      boxSize?: BoxSize | null
      partialClone?: boolean | null
      notesMaxCount?: number | null
      notesMaxTokens?: number | null
      pushAtTurnEnd?: boolean | null
      depCache?: boolean | null
      runner?: Runner
      agentsPerBox?: number | null
      tasksPerBox?: number | null
      maxBoxes?: number | null
    }) =>
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

/**
 * Save the owner's project order (every project id, first to last). The cache changes at once and rolls back with a
 * toast if the server refuses. Once the last of several quick saves settles, the list is refetched so it can't drift.
 */
export function useReorderProjects() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: keys.projectsOrder,
    mutationFn: (ids: string[]) => api<{ ids: string[] }>("/api/projects/order", { method: "PUT", body: { ids } }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: keys.projects })
      const undo = snapshot<Project[]>(qc, keys.projects)
      qc.setQueryData<Project[]>(keys.projects, (list) => (list ? applyOrder(list, ids) : list))
      return { undo }
    },
    onError: (err, _ids, ctx) => {
      ctx?.undo()
      fail("Couldn't save the project order")(err)
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey: keys.projectsOrder }) <= 1) void qc.invalidateQueries({ queryKey: keys.projects })
    },
  })
}

/** Optimistically change one project's notes. */
function editNotes(qc: QueryClient, projectId: string, edit: (notes: ProjectNote[], who: string) => ProjectNote[]) {
  const undo = snapshot<Project[]>(qc, keys.projects)
  const who = qc.getQueryData<SettingsInfo>(keys.agentSettings)?.settings.ownerName ?? DEFAULT_OWNER_NAME
  qc.setQueryData<Project[]>(keys.projects, (list) => list?.map((p) => (p.id === projectId ? { ...p, notes: edit(p.notes, who) } : p)))
  return undo
}

export function useAddNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, content }: { projectId: string; content: string }) =>
      api<Project>(`/api/projects/${projectId}/notes`, { body: { content } }),
    onMutate: async ({ projectId, content }) => {
      const now = Date.now()
      const undo = editNotes(qc, projectId, (notes, who) => [
        ...notes,
        { id: `tmp-${now}`, projectId, author: who, content, createdAt: now, updatedAt: now, updatedBy: null },
      ])
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't save the note")(err)
    },
    onSuccess: (project) => qc.setQueryData<Project[]>(keys.projects, (list) => upsert(list, project)),
  })
}

export function useUpdateNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, noteId, content }: { projectId: string; noteId: string; content: string }) =>
      api<Project>(`/api/projects/${projectId}/notes/${noteId}`, { method: "PATCH", body: { content } }),
    onMutate: async ({ projectId, noteId, content }) => {
      const undo = editNotes(qc, projectId, (notes, who) =>
        notes.map((n) => (n.id === noteId ? { ...n, content, updatedAt: Date.now(), updatedBy: who } : n)),
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

export function useDeleteNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, noteId }: { projectId: string; noteId: string }) =>
      api<Project>(`/api/projects/${projectId}/notes/${noteId}`, { method: "DELETE" }),
    onMutate: async ({ projectId, noteId }) => {
      const undo = editNotes(qc, projectId, (notes) => notes.filter((n) => n.id !== noteId))
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't delete the note")(err)
    },
    onSuccess: (project) => qc.setQueryData<Project[]>(keys.projects, (list) => upsert(list, project)),
  })
}

/** The project's suggestion history, newest 200 (the Captain settles them in its notes retros). */
export const useNoteSuggestions = (projectId: string) =>
  useQuery({
    queryKey: keys.noteSuggestions(projectId),
    queryFn: () => api<NoteSuggestion[]>(`/api/projects/${projectId}/suggestions?status=all`),
  })

export function useCreateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      id: string
      projectId: string
      title: string
      prompt: string
      env?: Record<string, string>
      model?: string
      effort?: Effort
      /** Upload ids. */
      attachments?: string[]
      /** Run on this computer (or a box) over the project's "Runs on". */
      runsOn?: Runner
    }) =>
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
          waitBoxSize: null,
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
          runsOn: input.runsOn ?? null,
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
      const undoQueue = snapshot<QueuedMessage[]>(qc, keys.taskQueue(taskId))
      const task = qc.getQueryData<Task[]>(keys.tasks)?.find((t) => t.id === taskId)
      const running = task?.status === "working" || task?.status === "starting"
      patchTask(qc, taskId, running ? { pendingCount: (task?.pendingCount ?? 0) + 1 } : { status: "queued", question: null })
      // It shows as a Queued row until a turn delivers it into the transcript.
      const now = Date.now()
      qc.setQueryData<QueuedMessage[]>(keys.taskQueue(taskId), (list) => [
        ...(list ?? []),
        { id: `tmp-${now}`, taskId, source: "cody", kind: "owner", sender: "", text: content, attachments: attachments ?? [], status: "queued", version: 0, createdAt: now, updatedAt: now },
      ])
      return { undo: () => (undoTasks(), undoQueue()) }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't send the message")(err)
    },
    onSuccess: (task) => {
      qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task))
      void qc.invalidateQueries({ queryKey: keys.taskQueue(taskId) })
    },
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

/** What Clear box / Delete box would touch, fetched fresh each time a confirmation opens. */
export const useBoxContents = (boxId: string) =>
  useQuery({ queryKey: ["box-contents", boxId], queryFn: () => api<BoxContents>(`/api/boxes/${encodeURIComponent(boxId)}/contents`), staleTime: 0, gcTime: 0 })

/** Archive every workspace and take it off the box. Resolves with the finished report (SSE box.cleanup toasts it). */
export function useClearBox() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { boxId: string; stopAgents: boolean }) => api<BoxCleanup>(`/api/boxes/${encodeURIComponent(input.boxId)}/clear`, { body: { stopAgents: input.stopAgents } }),
    onSuccess: (cleanup) => qc.setQueryData<BoxInfo[]>(keys.boxes, (list) => withCleanup(list, cleanup)),
    // Not awaited: the dialog closes as soon as the server answers.
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.boxes }),
  })
}

/** What resizing a box to `size` would do (mode, running agents, a scale-down's disk fit). */
export const useResizePlan = (boxId: string, size: BoxSize) =>
  useQuery({
    queryKey: ["box-resize-plan", boxId, size],
    queryFn: () => api<ResizePlan>(`/api/boxes/${encodeURIComponent(boxId)}/resize?size=${size}`),
    staleTime: 0,
    gcTime: 0,
  })

/** Start a resize; it answers with the running report and SSE box.resize toasts its progress. */
export function useResizeBox() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { boxId: string; size: BoxSize; stopAgents: boolean }) =>
      api<BoxResize>(`/api/boxes/${encodeURIComponent(input.boxId)}/resize`, { body: { size: input.size, stopAgents: input.stopAgents } }),
    onSuccess: (r) => {
      qc.setQueryData<BoxInfo[]>(keys.boxes, (list) => withResize(list, r))
      announceResize(r)
    },
  })
}

/** A project's snapshot and its running or last snapshot job; SSE project.snapshot keeps the job live. */
export const useProjectSnapshot = (projectId: string) =>
  useQuery({ queryKey: keys.projectSnapshot(projectId), queryFn: () => api<ProjectSnapshotState>(`/api/projects/${encodeURIComponent(projectId)}/snapshot`) })

/** Take (or replace) a project's snapshot from one of its boxes. Answers with the running job; the toast follows it. */
export function useTakeSnapshot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { projectId: string; boxId: string; reason?: string }) =>
      api<SnapshotJob>(`/api/projects/${encodeURIComponent(input.projectId)}/snapshot`, { body: { boxId: input.boxId, ...(input.reason ? { reason: input.reason } : {}) } }),
    onSuccess: (job) => {
      qc.setQueryData<ProjectSnapshotState>(keys.projectSnapshot(job.projectId), (s) => (s ? { ...s, job } : s))
      void qc.invalidateQueries({ queryKey: keys.boxes })
    },
  })
}

/** Forget a project's snapshot and delete it at the provider. */
export function useClearSnapshot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (projectId: string) => api<Project>(`/api/projects/${encodeURIComponent(projectId)}/snapshot`, { method: "DELETE" }),
    onSuccess: (project) => {
      qc.setQueryData<Project[]>(keys.projects, (list) => (list ? upsert(list, project) : list))
      qc.setQueryData<ProjectSnapshotState>(keys.projectSnapshot(project.id), (s) => (s ? { ...s, snapshot: null } : s))
      toast.info(`Cleared ${project.name}'s snapshot`, "New boxes for it start cold.")
    },
    onError: fail("Couldn't clear the snapshot"),
  })
}

/** Archive every workspace, then destroy the box at the provider. */
export function useDeleteBox() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { boxId: string; stopAgents: boolean }) =>
      api<{ ok: true }>(`/api/boxes/${encodeURIComponent(input.boxId)}${input.stopAgents ? "?stopAgents=1" : ""}`, { method: "DELETE" }),
    onSuccess: (_res, input) => {
      qc.setQueryData<BoxInfo[]>(keys.boxes, (list) => list?.filter((b) => b.id !== input.boxId))
      toast.info(`Deleted ${input.boxId}`, "Every workspace was archived first. Its tasks move to another box on their next message.")
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.boxes })
      void qc.invalidateQueries({ queryKey: keys.tasks })
    },
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
      // Mid-turn it shows as queued right away; the server's answer says for sure.
      const queued = Boolean(qc.getQueryData<boolean>(keys.chatBusy))
      qc.setQueryData<ChatMessage[]>(keys.chat, (list) =>
        upsert(list, {
          id: input.id,
          role: "user",
          content: input.content,
          meta: { pending: true, ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(queued ? { queued: true } : {}) },
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
    onSuccess: (msg) => qc.setQueryData<ChatMessage[]>(keys.chat, (list) => settleOptimistic(list, msg)),
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
      const queued = Boolean(qc.getQueryData<CaptainState>(keys.captain(projectId))?.busy)
      qc.setQueryData<CaptainMessage[]>(keys.captainMessages(projectId), (list) =>
        upsert(list, {
          id: input.id,
          projectId,
          role: "user",
          content: input.content,
          meta: { pending: true, source: "cody", ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(queued ? { queued: true } : {}) },
          createdAt: Date.now(),
        }),
      )
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't message the Captain")(err)
    },
    onSuccess: (msg) => qc.setQueryData<CaptainMessage[]>(keys.captainMessages(projectId), (list) => settleOptimistic(list, msg)),
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
    /** No keys: forget every saved value. Keys: forget only those, so env vars or defaults apply to them again. */
    mutationFn: (keys?: (keyof Settings)[]) =>
      api<SettingsInfo>(keys ? `/api/agent-settings?keys=${keys.map(encodeURIComponent).join(",")}` : "/api/agent-settings", { method: "DELETE" }),
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

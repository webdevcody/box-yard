import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api, clientId } from "./api"
import { toast } from "./toast"
import type {
  Artifact,
  BoxInfo,
  ChatMessage,
  Health,
  Project,
  Schedule,
  CatchUp,
  Task,
  TaskMessage,
  TaskStatus,
} from "../../../shared/types"

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
  settings: ["settings"] as const,
}

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
export const useTaskMessages = (id: string) =>
  useQuery({ queryKey: keys.taskMessages(id), queryFn: () => api<TaskMessage[]>(`/api/tasks/${id}/messages`) })
export const useChat = () => useQuery({ queryKey: keys.chat, queryFn: () => api<ChatMessage[]>("/api/chat") })
export const useArtifacts = () => useQuery({ queryKey: keys.artifacts, queryFn: () => api<Artifact[]>("/api/artifacts") })
export const useSchedules = () => useQuery({ queryKey: keys.schedules, queryFn: () => api<Schedule[]>("/api/schedules") })
export const useSettings = () =>
  useQuery({
    queryKey: keys.settings,
    queryFn: () => api<{ defaultTimezone: string; scheduler: "local" | "qstash" }>("/api/settings"),
    staleTime: Infinity,
  })
export const useBoxes = () => useQuery({ queryKey: keys.boxes, queryFn: () => api<BoxInfo[]>("/api/boxes") })

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
          previews: [],
          question: null,
          summary: null,
          error: null,
          turnCount: 0,
          pendingCount: 0,
          lastArchivedAt: null,
          scheduleId: null,
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
    mutationFn: (content: string) => api<Task>(`/api/tasks/${taskId}/messages`, { body: { content } }),
    onMutate: async (content) => {
      const undoTasks = snapshot<Task[]>(qc, keys.tasks)
      const undoMsgs = snapshot<TaskMessage[]>(qc, keys.taskMessages(taskId))
      const task = qc.getQueryData<Task[]>(keys.tasks)?.find((t) => t.id === taskId)
      const running = task?.status === "working" || task?.status === "starting"
      patchTask(qc, taskId, running ? { pendingCount: (task?.pendingCount ?? 0) + 1 } : { status: "queued", question: null })
      qc.setQueryData<TaskMessage[]>(keys.taskMessages(taskId), (list) => [
        ...(list ?? []),
        { id: `tmp-${Date.now()}`, taskId, role: "user", content, meta: { pending: true }, createdAt: Date.now() },
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

export const useStopTask = () =>
  useTaskAction("stop", (t) => (t.status === "queued" ? { status: (t.turnCount ? "idle" : "failed") as TaskStatus } : {}), "stop the task")
export const useCloseTask = () => useTaskAction("close", () => ({ status: "done" as TaskStatus, question: null }), "close the task")
export const useRetryTask = () => useTaskAction("retry", () => ({ status: "queued" as TaskStatus, error: null }), "retry the task")

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
  projectId: string
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
    mutationFn: ({ id, ...patch }: { id: string } & Partial<Omit<ScheduleInput, "id" | "projectId">> & { enabled?: boolean }) =>
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
    mutationFn: (id: string) => api<Task>(`/api/schedules/${id}/run`, { method: "POST" }),
    onError: fail("Couldn't start a run"),
    onSuccess: (task) => qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task)),
  })
}

export function useSendChat() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; content: string }) => api<ChatMessage>("/api/chat", { body: input }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.chat })
      const undo = snapshot<ChatMessage[]>(qc, keys.chat)
      qc.setQueryData<ChatMessage[]>(keys.chat, (list) =>
        upsert(list, { id: input.id, role: "user", content: input.content, meta: { pending: true }, createdAt: Date.now() }),
      )
      qc.setQueryData(keys.chatBusy, true)
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      qc.setQueryData(keys.chatBusy, false)
      fail("Couldn't send to the orchestrator")(err)
    },
    onSuccess: (msg) => qc.setQueryData<ChatMessage[]>(keys.chat, (list) => upsert(list, msg)),
  })
}

export function useChatControl() {
  const qc = useQueryClient()
  return {
    stop: () => api("/api/chat/stop", { method: "POST" }).catch(fail("Couldn't stop the orchestrator")),
    reset: async () => {
      try {
        await api("/api/chat/reset", { method: "POST" })
        qc.setQueryData(keys.chat, [])
        qc.setQueryData(keys.chatStream, "")
      } catch (err) {
        fail("Couldn't reset the chat")(err as Error)
      }
    },
  }
}

export const newClientId = clientId

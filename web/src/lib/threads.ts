// Side threads: a question about a highlighted passage in the Coordinator chat or a Captain's chat, answered in a
// panel on the right (server/sideThreads.ts). This keeps their queries, the live events that update them, and which
// thread each chat has open.
import { useSyncExternalStore } from "react"
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api } from "./api"
import { newClientId, upsert } from "./queries"
import { toast } from "./toast"
import type { SideThread, SideThreadMessage, UiEvent } from "../../../shared/types"

/** Which chat a thread hangs off: "coordinator", or the project id of a Captain's chat. */
export type ThreadChat = string
export const COORDINATOR_CHAT: ThreadChat = "coordinator"
export const chatOf = (projectId: string | null): ThreadChat => projectId ?? COORDINATOR_CHAT
const projectOf = (chat: ThreadChat) => (chat === COORDINATOR_CHAT ? null : chat)

export const threadKeys = {
  list: (chat: ThreadChat) => ["threads", chat] as const,
  messages: (id: string) => ["thread-messages", id] as const,
  stream: (id: string) => ["thread-stream", id] as const,
}

const NONE: SideThread[] = []

export function useThreads(chat: ThreadChat) {
  const projectId = projectOf(chat)
  return useQuery({
    queryKey: threadKeys.list(chat),
    queryFn: () => api<SideThread[]>(`/api/threads${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
    staleTime: Infinity,
  })
}

/** The threads on one message; a message row re-renders only when its own threads change. */
export function useMessageThreads(chat: ThreadChat, anchorId: string): SideThread[] {
  const q = useQuery({
    queryKey: threadKeys.list(chat),
    queryFn: () => api<SideThread[]>(`/api/threads${projectOf(chat) ? `?projectId=${encodeURIComponent(chat)}` : ""}`),
    staleTime: Infinity,
    select: (list: SideThread[]) => list.filter((t) => t.anchorId === anchorId),
  })
  return q.data ?? NONE
}

export function useThread(chat: ThreadChat, id: string | null): SideThread | null {
  const q = useThreads(chat)
  return (id && q.data?.find((t) => t.id === id)) || null
}

export function useThreadMessages(id: string) {
  return useQuery({ queryKey: threadKeys.messages(id), queryFn: () => api<SideThreadMessage[]>(`/api/threads/${id}/messages`), staleTime: Infinity })
}

export function useThreadStream(id: string) {
  return useQuery({ queryKey: threadKeys.stream(id), queryFn: () => "", initialData: "", staleTime: Infinity })
}

const setBusy = (qc: QueryClient, chat: ThreadChat, id: string, busy: boolean) =>
  qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => list?.map((t) => (t.id === id ? { ...t, busy } : t)))

const pendingMessage = (threadId: string, id: string, content: string): SideThreadMessage => ({ id, threadId, role: "user", content, meta: { pending: true }, createdAt: Date.now() })

/** Start a thread on a highlighted passage with its first question, and open it. */
export function useAskThread(chat: ThreadChat) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; messageId: string; anchorId: string; quote: string; question: string }) =>
      api<{ thread: SideThread; message: SideThreadMessage }>("/api/threads", { body: { ...input, projectId: projectOf(chat) } }),
    onMutate: (input) => {
      const now = Date.now()
      const thread: SideThread = { id: input.id, projectId: projectOf(chat), anchorId: input.anchorId, quote: input.quote.trim(), context: null, busy: true, createdAt: now, updatedAt: now }
      qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => upsert(list ?? [], thread))
      qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(input.id), [pendingMessage(input.id, input.messageId, input.question.trim())])
      openThread(chat, input.id)
    },
    onError: (err: Error, input) => {
      qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => list?.filter((t) => t.id !== input.id))
      qc.removeQueries({ queryKey: threadKeys.messages(input.id) })
      if (openThreadId(chat) === input.id) closeThread(chat)
      toast.error("Couldn't ask", err.message)
    },
    onSuccess: ({ thread, message }) => {
      qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => upsert(list ?? [], thread))
      qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(thread.id), (list) => upsert(list ?? [], message))
    },
  })
}

export function useSendThreadMessage(chat: ThreadChat, id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; content: string }) => api<SideThreadMessage>(`/api/threads/${id}/messages`, { body: input }),
    onMutate: (input) => {
      qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(id), (list) => upsert(list ?? [], pendingMessage(id, input.id, input.content)))
      setBusy(qc, chat, id, true)
    },
    onError: (err: Error, input) => {
      qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(id), (list) => list?.filter((m) => m.id !== input.id))
      toast.error("Couldn't send", err.message)
    },
    onSuccess: (message) => qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(id), (list) => upsert(list ?? [], message)),
  })
}

export const newThreadIds = () => ({ id: newClientId("thr"), messageId: newClientId("thm") })

export function useThreadControl(chat: ThreadChat) {
  const qc = useQueryClient()
  return {
    stop: (id: string) => void api(`/api/threads/${id}/stop`, { body: {} }).catch((err: Error) => toast.error("Couldn't stop", err.message)),
    remove: async (id: string) => {
      try {
        await api(`/api/threads/${id}`, { method: "DELETE" })
        if (openThreadId(chat) === id) closeThread(chat)
        dropThread(qc, chat, id)
      } catch (err) {
        toast.error("Couldn't delete the thread", (err as Error).message)
      }
    },
  }
}

function dropThread(qc: QueryClient, chat: ThreadChat, id: string) {
  qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => list?.filter((t) => t.id !== id))
  qc.removeQueries({ queryKey: threadKeys.messages(id) })
  qc.removeQueries({ queryKey: threadKeys.stream(id) })
}

/** Live events (lib/stream.ts). Returns false for an event that isn't a thread's. */
export function applyThreadEvent(qc: QueryClient, ev: UiEvent): boolean {
  switch (ev.type) {
    case "thread":
      qc.setQueryData<SideThread[]>(threadKeys.list(chatOf(ev.thread.projectId)), (list) => (list ? upsert(list, ev.thread) : list))
      if (!ev.thread.busy) qc.setQueryData(threadKeys.stream(ev.thread.id), "")
      return true
    case "thread.message":
      qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(ev.message.threadId), (list) => (list ? upsert(list, ev.message) : list))
      if (ev.message.role !== "user") qc.setQueryData(threadKeys.stream(ev.message.threadId), "")
      return true
    case "thread.delta":
      qc.setQueryData<string>(threadKeys.stream(ev.threadId), (prev) => (prev ?? "") + ev.text)
      return true
    case "thread.deleted":
      if (openThreadId(chatOf(ev.projectId)) === ev.threadId) closeThread(chatOf(ev.projectId))
      dropThread(qc, chatOf(ev.projectId), ev.threadId)
      return true
    default:
      return false
  }
}

// ---------------------------------------------------------------- the open thread, per chat

/** A chat's open thread. `closing`: it's sliding away (the chat already takes the room back). */
export interface OpenThread {
  id: string
  closing: boolean
}

let open = new Map<ThreadChat, OpenThread>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
const set = (chat: ThreadChat, value: OpenThread | null) => {
  const next = new Map(open)
  if (value) next.set(chat, value)
  else next.delete(chat)
  open = next
  emit()
}

export const openThreadId = (chat: ThreadChat) => open.get(chat)?.id ?? null
export const openThread = (chat: ThreadChat, id: string) => set(chat, { id, closing: false })
/** Slide the thread away; the panel calls `forgetThread` once it's gone. */
export const closeThread = (chat: ThreadChat) => {
  const cur = open.get(chat)
  if (cur && !cur.closing) set(chat, { ...cur, closing: true })
}
export const forgetThread = (chat: ThreadChat, id: string) => {
  if (open.get(chat)?.id === id && open.get(chat)?.closing) set(chat, null)
}

export function useOpenThread(chat: ThreadChat): OpenThread | null {
  return useSyncExternalStore(
    subscribe,
    () => open.get(chat) ?? null,
    () => null,
  )
}

/** Whether a chat has a thread open (or opening): the Coordinator's dock makes room for it. */
export function useThreadShown(chat: ThreadChat): boolean {
  return useSyncExternalStore(
    subscribe,
    () => Boolean(open.get(chat) && !open.get(chat)!.closing),
    () => false,
  )
}

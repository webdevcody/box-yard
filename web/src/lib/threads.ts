// Side threads: a question about a highlighted passage in the Coordinator chat or a Captain's chat, answered in a
// panel on the right (server/sideThreads.ts). This keeps their queries, the live events that update them, and which
// thread each chat has open.
import { useSyncExternalStore } from "react"
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api } from "./api"
import { newClientId, upsert } from "./queries"
import { toast } from "./toast"
import type { SideThread, SideThreadKind, SideThreadMessage, UiEvent } from "../../../shared/types"

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

const patch = (qc: QueryClient, chat: ThreadChat, id: string, change: (t: SideThread) => Partial<SideThread>) =>
  qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => list?.map((t) => (t.id === id ? { ...t, ...change(t) } : t)))

const pendingMessage = (threadId: string, id: string, content: string): SideThreadMessage => ({ id, threadId, role: "user", content, meta: { pending: true }, createdAt: Date.now() })

/**
 * Start a thread on a message with its first message, and open it: a question about a highlighted passage, or (kind
 * "reply") a reply to the whole message, whose quote is the message.
 */
export function useAskThread(chat: ThreadChat) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; messageId: string; anchorId: string; quote: string; question: string; kind?: SideThreadKind }) =>
      api<{ thread: SideThread; message: SideThreadMessage }>("/api/threads", {
        body: { ...input, quote: input.kind === "reply" ? undefined : input.quote, projectId: projectOf(chat) },
      }),
    onMutate: (input) => {
      const now = Date.now()
      const thread: SideThread = {
        id: input.id,
        projectId: projectOf(chat),
        anchorId: input.anchorId,
        kind: input.kind ?? "ask",
        quote: input.quote.trim(),
        context: null,
        busy: true,
        replies: 1,
        unread: false,
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      }
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
    onSuccess: ({ thread, message }, input) => {
      // A reply to a message that already had a reply thread went to that one.
      if (thread.id !== input.id) {
        dropThread(qc, chat, input.id)
        if (openThreadId(chat) === input.id) openThread(chat, thread.id)
        qc.removeQueries({ queryKey: threadKeys.messages(thread.id) })
      } else qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(thread.id), (list) => upsert(list ?? [], message))
      qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => upsert(list ?? [], thread))
    },
  })
}

export function useSendThreadMessage(chat: ThreadChat, id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; content: string }) => api<SideThreadMessage>(`/api/threads/${id}/messages`, { body: input }),
    onMutate: (input) => {
      qc.setQueryData<SideThreadMessage[]>(threadKeys.messages(id), (list) => upsert(list ?? [], pendingMessage(id, input.id, input.content)))
      // Busy, and a new message reopens a resolved thread.
      patch(qc, chat, id, (t) => ({ busy: true, resolvedAt: null, replies: t.replies + 1 }))
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
    /** Resolve (fold it away under its message and close it) or reopen. */
    resolve: async (id: string, resolved: boolean) => {
      const before = qc.getQueryData<SideThread[]>(threadKeys.list(chat))?.find((t) => t.id === id)
      patch(qc, chat, id, () => ({ resolvedAt: resolved ? Date.now() : null }))
      if (resolved && openThreadId(chat) === id) closeThread(chat)
      try {
        const thread = await api<SideThread>(`/api/threads/${id}/resolve`, { body: { resolved } })
        qc.setQueryData<SideThread[]>(threadKeys.list(chat), (list) => (list ? upsert(list, thread) : list))
      } catch (err) {
        if (before) patch(qc, chat, id, () => ({ resolvedAt: before.resolvedAt }))
        toast.error(resolved ? "Couldn't resolve the thread" : "Couldn't reopen the thread", (err as Error).message)
      }
    },
    /** The thread is open: its answers are read. */
    seen: (id: string) => {
      patch(qc, chat, id, () => ({ unread: false }))
      void api(`/api/threads/${id}/seen`, { body: {} }).catch(() => {})
    },
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

/**
 * A chat's open thread. `closing`: it's sliding away (the chat already takes the room back). `draft`: a reply thread
 * not started yet (Reply on a message with no replies): the panel shows the message and a composer, and the first
 * reply creates the thread with this id. `expanded`: the panel covers the whole chat.
 */
export interface OpenThread {
  id: string
  closing: boolean
  draft?: { anchorId: string; text: string }
  expanded?: boolean
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
export const openThread = (chat: ThreadChat, id: string) => set(chat, { id, closing: false, expanded: open.get(chat)?.expanded })
/** Reply to a message: open its reply thread, or a draft of one when it has none yet. */
export function openReply(qc: QueryClient, chat: ThreadChat, anchorId: string, text: string) {
  const existing = qc.getQueryData<SideThread[]>(threadKeys.list(chat))?.find((t) => t.kind === "reply" && t.anchorId === anchorId)
  if (existing) return openThread(chat, existing.id)
  const cur = open.get(chat)
  if (cur?.draft?.anchorId === anchorId && !cur.closing) return
  set(chat, { id: newClientId("thr"), closing: false, draft: { anchorId, text }, expanded: cur?.expanded })
}
/** The open thread covers the whole chat, or goes back beside it. */
export const toggleExpanded = (chat: ThreadChat) => {
  const cur = open.get(chat)
  if (cur) set(chat, { ...cur, expanded: !cur.expanded })
}
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

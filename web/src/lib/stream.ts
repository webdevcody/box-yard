import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { keys, upsert } from "./queries"
import type { Artifact, ChatMessage, Project, Schedule, Task, TaskMessage, UiEvent } from "../../../shared/types"

export type Connection = "connecting" | "live" | "offline"

/**
 * Subscribe to server events and write them straight into the TanStack Query
 * cache, so every view updates live without refetching.
 */
export function useServerEvents(enabled: boolean): Connection {
  const qc = useQueryClient()
  const [state, setState] = useState<Connection>("connecting")

  useEffect(() => {
    if (!enabled) return
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let wasOffline = false
    let closed = false

    const connect = () => {
      es = new EventSource("/api/stream")
      es.onopen = () => {
        setState("live")
        // Anything could have changed while we were away.
        if (wasOffline) void qc.invalidateQueries()
        wasOffline = false
      }
      es.onerror = () => {
        setState("offline")
        wasOffline = true
        es?.close()
        if (!closed) retry = setTimeout(connect, 2000)
      }
      es.onmessage = (e) => {
        let ev: UiEvent
        try {
          ev = JSON.parse(e.data)
        } catch {
          return
        }
        apply(ev)
      }
    }

    const apply = (ev: UiEvent) => {
      switch (ev.type) {
        case "task":
          qc.setQueryData<Task[]>(keys.tasks, (list) => (list ? upsert(list, ev.task) : list))
          break
        case "task.deleted":
          qc.setQueryData<Task[]>(keys.tasks, (list) => list?.filter((t) => t.id !== ev.taskId))
          break
        case "task.message":
          qc.setQueryData<TaskMessage[]>(keys.taskMessages(ev.message.taskId), (list) => {
            if (!list) return list
            if (list.some((m) => m.id === ev.message.id)) return list
            // Replace the optimistic copy of a message we sent.
            const tmp = list.findIndex((m) => m.id.startsWith("tmp-") && m.role === ev.message.role && m.content === ev.message.content)
            if (tmp >= 0) {
              const next = list.slice()
              next[tmp] = ev.message
              return next
            }
            return [...list, ev.message]
          })
          break
        case "project":
          qc.setQueryData<Project[]>(keys.projects, (list) => (list ? upsert(list, ev.project) : list))
          break
        case "project.deleted":
          qc.setQueryData<Project[]>(keys.projects, (list) => list?.filter((p) => p.id !== ev.projectId))
          qc.setQueryData<Schedule[]>(keys.schedules, (list) => list?.filter((s) => s.projectId !== ev.projectId))
          break
        case "chat.message":
          qc.setQueryData<ChatMessage[]>(keys.chat, (list) => (list ? upsert(list, ev.message) : list))
          if (ev.message.role === "assistant" || ev.message.role === "tool") qc.setQueryData(keys.chatStream, "")
          break
        case "chat.delta":
          qc.setQueryData<string>(keys.chatStream, (prev) => (prev ?? "") + ev.text)
          break
        case "chat.busy":
          qc.setQueryData(keys.chatBusy, ev.busy)
          if (!ev.busy) qc.setQueryData(keys.chatStream, "")
          break
        case "artifact":
          qc.setQueryData<Artifact[]>(keys.artifacts, (list) => (list ? upsert(list, ev.artifact, true) : list))
          break
        case "boxes":
          qc.setQueryData(keys.boxes, ev.boxes)
          break
        case "schedule":
          qc.setQueryData<Schedule[]>(keys.schedules, (list) => (list ? upsert(list, ev.schedule) : list))
          break
        case "schedule.deleted":
          qc.setQueryData<Schedule[]>(keys.schedules, (list) => list?.filter((s) => s.id !== ev.scheduleId))
          break
      }
    }

    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      es?.close()
    }
  }, [enabled, qc])

  return state
}

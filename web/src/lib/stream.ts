import { useEffect, useState } from "react"
import { notifyManager, useQueryClient } from "@tanstack/react-query"
import { keys, upsert } from "./queries"
import { applyRead, receiveNotification } from "./notifications"
import { withActivity } from "./taskSummary"
import { voiceChatBusy, voiceChatMessage, voiceChatTurn } from "./speech"
import type { AppNotification, Artifact, ChatMessage, Project, Schedule, ScheduleRun, Task, TaskMessage, UiEvent } from "../../../shared/types"

export type Connection = "connecting" | "live" | "offline"

/**
 * Subscribe to server events and write them straight into the TanStack Query
 * cache, so every view updates live without refetching. Events are applied in
 * batches, once per frame, so a burst (streamed text, many task updates) costs
 * one render instead of one per event.
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
    let queue: UiEvent[] = []
    let scheduled = false

    const flush = () => {
      scheduled = false
      const events = queue
      queue = []
      notifyManager.batch(() => {
        for (let i = 0; i < events.length; i++) {
          const ev = events[i]!
          // Join a run of streamed chunks into one cache write.
          if (ev.type === "chat.delta") {
            let text = ev.text
            while (events[i + 1]?.type === "chat.delta") text += (events[++i] as { text: string }).text
            apply({ type: "chat.delta", text })
          } else apply(ev)
        }
      })
    }
    const enqueue = (ev: UiEvent) => {
      queue.push(ev)
      if (scheduled) return
      scheduled = true
      // Background tabs get no animation frames; still apply events, just less often.
      if (document.hidden) setTimeout(flush, 250)
      else requestAnimationFrame(flush)
    }

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
        enqueue(ev)
      }
    }

    const apply = (ev: UiEvent) => {
      switch (ev.type) {
        case "task":
          qc.setQueryData<Task[]>(keys.tasks, (list) => (list ? upsert(list, ev.task) : list))
          void qc.invalidateQueries({ queryKey: keys.usage })
          break
        case "task.deleted":
          qc.setQueryData<Task[]>(keys.tasks, (list) => list?.filter((t) => t.id !== ev.taskId))
          qc.setQueryData<AppNotification[]>(keys.notifications, (list) => list?.filter((n) => n.taskId !== ev.taskId))
          void qc.invalidateQueries({ queryKey: keys.usage })
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
          // Cards of tasks without a summary yet show the latest activity line.
          qc.setQueryData<Task[]>(keys.tasks, (list) => withActivity(list, ev.message))
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
          voiceChatMessage(ev.message)
          break
        case "chat.turn":
          voiceChatTurn(ev)
          break
        case "chat.delta":
          qc.setQueryData<string>(keys.chatStream, (prev) => (prev ?? "") + ev.text)
          break
        case "chat.busy":
          qc.setQueryData(keys.chatBusy, ev.busy)
          if (!ev.busy) qc.setQueryData(keys.chatStream, "")
          voiceChatBusy(ev.busy)
          break
        case "orchestrator.state":
          qc.setQueryData(keys.orchestrator, ev.state)
          break
        case "settings":
          qc.setQueryData(keys.agentSettings, ev.info)
          void qc.invalidateQueries({ queryKey: keys.health })
          void qc.invalidateQueries({ queryKey: keys.usage })
          break
        case "artifact":
          qc.setQueryData<Artifact[]>(keys.artifacts, (list) => (list ? upsert(list, ev.artifact, true) : list))
          break
        case "boxes":
          qc.setQueryData(keys.boxes, ev.boxes)
          void qc.invalidateQueries({ queryKey: keys.usage })
          break
        case "schedule":
          qc.setQueryData<Schedule[]>(keys.schedules, (list) => (list ? upsert(list, ev.schedule) : list))
          break
        case "schedule.run":
          qc.setQueryData<ScheduleRun[]>(keys.scheduleRuns, (list) => (list ? upsert(list, ev.run, true) : list))
          break
        case "notification":
          receiveNotification(qc, ev.notification)
          break
        case "notifications.read":
          qc.setQueryData<AppNotification[]>(keys.notifications, (list) => applyRead(list, ev.ids, ev.readAt))
          break
        case "schedule.deleted":
          qc.setQueryData<Schedule[]>(keys.schedules, (list) => list?.filter((s) => s.id !== ev.scheduleId))
          break
      }
    }

    connect()
    return () => {
      closed = true
      queue = []
      if (retry) clearTimeout(retry)
      es?.close()
    }
  }, [enabled, qc])

  return state
}

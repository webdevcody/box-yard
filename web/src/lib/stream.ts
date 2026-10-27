import { useEffect, useState } from "react"
import { notifyManager, useQueryClient } from "@tanstack/react-query"
import { keys, upsert } from "./queries"
import { applyRead, receiveNotification } from "./notifications"
import { withActivity } from "./taskSummary"
import { applyOrder } from "./projectOrder"
import { announceCleanup, withCleanup } from "./diskCleanup"
import { announceResize, withResize } from "./boxResize"
import { announceSnapshot, type ProjectSnapshotState } from "./projectSnapshot"
import { placeMessage } from "./queued"
import { voiceChatBusy, voiceChatMessage, voiceChatTurn } from "./speech"
import { loadTtsInfo, setTtsInfo } from "./tts"
import { onResume } from "./resume"
import type { AppNotification, Artifact, BoxInfo, CaptainMessage, ChatMessage, Project, Schedule, ScheduleRun, Task, TaskMessage, UiEvent } from "../../../shared/types"
import type { RunPodStatus } from "../../../shared/runpod"
import type { DockerStatus } from "../../../shared/docker"

export type Connection = "connecting" | "live" | "offline"

/** Back after this long away, the stream is reopened even if it says it's open: iOS leaves dead ones that never error. */
export const STALE_STREAM_MS = 30_000
/** A batch waiting for a frame is applied after this long anyway (frames can stop coming, e.g. a page iOS just thawed). */
const FLUSH_FALLBACK_MS = 250

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
    let frame = 0
    let fallback: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
      if (!scheduled) return
      scheduled = false
      cancelAnimationFrame(frame)
      if (fallback) clearTimeout(fallback)
      fallback = null
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
      // Background tabs get no animation frames; still apply events, just less often. Whichever comes first wins.
      if (!document.hidden) frame = requestAnimationFrame(flush)
      fallback = setTimeout(flush, FLUSH_FALLBACK_MS)
    }

    const connect = () => {
      es = new EventSource("/api/stream")
      es.onopen = () => {
        setState("live")
        // Which voice to speak with lives on the server (Settings › Voice).
        void loadTtsInfo(true)
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
            // An update (a queued message delivered) may move it.
            if (list.some((m) => m.id === ev.message.id)) return placeMessage(list, ev.message)
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
        case "identities":
          qc.setQueryData(keys.identities, ev.identities)
          break
        case "note_suggestions":
          void qc.invalidateQueries({ queryKey: ["note-suggestions", ev.projectId] })
          break
        case "projects.order":
          // Our own quick moves echo back one by one; the last save's refetch settles the list instead.
          if (qc.isMutating({ mutationKey: keys.projectsOrder }) > 0) break
          qc.setQueryData<Project[]>(keys.projects, (list) => (list ? applyOrder(list, ev.ids) : list))
          break
        case "project.deleted":
          qc.setQueryData<Project[]>(keys.projects, (list) => list?.filter((p) => p.id !== ev.projectId))
          qc.setQueryData<Schedule[]>(keys.schedules, (list) => list?.filter((s) => s.projectId !== ev.projectId))
          break
        case "chat.message":
          qc.setQueryData<ChatMessage[]>(keys.chat, (list) => (list ? placeMessage(list, ev.message) : list))
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
        case "captain.message":
          qc.setQueryData<CaptainMessage[]>(keys.captainMessages(ev.message.projectId), (list) => {
            if (!list) return list
            if (list.some((m) => m.id === ev.message.id)) return placeMessage(list, ev.message)
            const tmp = list.findIndex((m) => m.id.startsWith("tmp-") && m.role === ev.message.role && m.content === ev.message.content)
            if (tmp >= 0) {
              const next = list.slice()
              next[tmp] = ev.message
              return next
            }
            return [...list, ev.message]
          })
          break
        case "captain.state":
          qc.setQueryData(keys.captain(ev.state.projectId), ev.state)
          break
        case "setup":
          qc.setQueryData(keys.setup, ev.status)
          void qc.invalidateQueries({ queryKey: keys.health })
          void qc.invalidateQueries({ queryKey: keys.setupRepos })
          break
        case "runpod.build":
          qc.setQueryData<RunPodStatus>(keys.runpod, (old) => (old ? { ...old, build: ev.build } : old))
          break
        case "docker.build":
          qc.setQueryData<DockerStatus>(keys.docker, (old) =>
            old ? { ...old, build: ev.build, image: ev.build.state === "succeeded" && ev.build.image === old.image.tag ? { ...old.image, present: true } : old.image } : old,
          )
          break
        case "tts":
          setTtsInfo(ev.info)
          qc.setQueryData(keys.tts, ev.info)
          break
        case "settings":
          qc.setQueryData(keys.agentSettings, ev.info)
          void qc.invalidateQueries({ queryKey: keys.health })
          // The setup card shows the owner's name.
          void qc.invalidateQueries({ queryKey: keys.setup })
          void qc.invalidateQueries({ queryKey: keys.usage })
          break
        case "artifact":
          qc.setQueryData<Artifact[]>(keys.artifacts, (list) => (list ? upsert(list, ev.artifact, true) : list))
          break
        case "boxes":
          qc.setQueryData(keys.boxes, ev.boxes)
          void qc.invalidateQueries({ queryKey: keys.usage })
          break
        case "box.cleanup":
          qc.setQueryData<BoxInfo[]>(keys.boxes, (list) => withCleanup(list, ev.cleanup))
          announceCleanup(ev.cleanup)
          break
        case "box.resize":
          qc.setQueryData<BoxInfo[]>(keys.boxes, (list) => withResize(list, ev.resize))
          announceResize(ev.resize)
          break
        case "box.event":
          void qc.invalidateQueries({ queryKey: keys.boxHistory })
          break
        case "project.snapshot": {
          const job = ev.job
          qc.setQueryData<ProjectSnapshotState>(keys.projectSnapshot(job.projectId), (s) => (s ? { ...s, job } : s))
          // The saved snapshot itself comes with the project event; refetch the panel's copy once the job ends.
          if (job.status !== "running") void qc.invalidateQueries({ queryKey: keys.projectSnapshot(job.projectId) })
          void qc.invalidateQueries({ queryKey: keys.boxes })
          announceSnapshot(job, qc.getQueryData<Project[]>(keys.projects)?.find((p) => p.id === job.projectId)?.name)
          break
        }
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
        case "hook":
        case "hook.deleted":
          void qc.invalidateQueries({ queryKey: ["hooks"] })
          break
        case "hook.run":
          // The run log, and each hook's "last run" line.
          void qc.invalidateQueries({ queryKey: ["hook-runs"] })
          void qc.invalidateQueries({ queryKey: ["hooks"] })
          break
      }
    }

    // Back from the background: a stream that isn't open, or one that sat frozen a while, is replaced now
    // (and everything refetched) instead of waiting for an error that may never come.
    const offResume = onResume((away) => {
      if (closed || !es) return
      if (es.readyState === EventSource.OPEN && away < STALE_STREAM_MS) return
      es.close()
      if (retry) clearTimeout(retry)
      retry = null
      wasOffline = true
      setState("connecting")
      connect()
    })

    connect()
    return () => {
      closed = true
      queue = []
      offResume()
      if (retry) clearTimeout(retry)
      if (fallback) clearTimeout(fallback)
      cancelAnimationFrame(frame)
      es?.close()
    }
  }, [enabled, qc])

  return state
}

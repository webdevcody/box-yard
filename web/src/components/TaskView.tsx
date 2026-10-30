import { memo, useCallback, useEffect, useMemo, useRef, type Ref } from "react"
import { Link } from "wouter"
import { Bot, MessageCircleQuestion, Users, Webhook } from "lucide-react"
import {
  newClientId,
  useArtifacts,
  useProjects,
  useSchedules,
  useSendChat,
  useSendTaskMessage,
  useTask,
  useTaskMessages,
} from "../lib/queries"
import { useEntityIndex } from "../lib/entities"
import { useTail } from "../lib/tail"
import { AppLink, Empty, InRepo, LineIcon, LinkedText, Markdown, TimeAgo, cx, useRepoScope, warmMarkdown, WaitIcon } from "./ui"
import { StickyScroll, type StickyScrollHandle } from "./StickyScroll"
import { COMPOSER_FOOTER, Composer } from "./Composer"
import { PAGE_BLEED_BOTTOM } from "../lib/layout"
import { TaskHeader, useStoredFlag } from "./TaskHeader"
import { PublishedFile } from "./TaskFiles"
import { PREVIEW_GROUP } from "./FileLink"
import { runsOf } from "../lib/publishedNotices"
import { AttachmentList } from "./Attachments"
import { TaskQueue } from "./QueuedMessages"
import { RecommendedNextSteps, nextStepsFromMeta } from "./RecommendedNextSteps"
import { SelectionToTask } from "./SelectionToTask"
import { MESSAGE_BLOCK, MessageActions } from "./MessageActions"
import { projectContext, taskContext, type SelectionTaskSource } from "../lib/selectionTask"
import type { Attachment, TaskMessage } from "../../../shared/types"
import { userMessageLabel } from "../../../shared/sender"
import { useOwnerName } from "../lib/queries"
import { WaitFixButton, WaitReason } from "./WaitReason"

/** A task's page. "#12" and "PR #12" in its text link to its project's repo. */
export function TaskView({ id }: { id: string }) {
  return (
    <InRepo taskId={id}>
      <TaskPage id={id} />
    </InRepo>
  )
}

function TaskPage({ id }: { id: string }) {
  // Only this task: other tasks' live updates don't re-render the view.
  const tasks = useTask(id)
  const projects = useProjects()
  const schedules = useSchedules()
  const artifacts = useArtifacts()
  const send = useSendTaskMessage(id)
  const sendChat = useSendChat()
  const [showTools, setShowTools] = useStoredFlag("boxyard:show-tool-calls")
  const panel = useRef<HTMLDivElement>(null)
  const thread = useRef<StickyScrollHandle>(null)
  const task = tasks.data
  const project = projects.data?.find((p) => p.id === task?.projectId)
  const schedule = task?.scheduleId ? schedules.data?.find((s) => s.id === task.scheduleId) : null
  // A message to a busy task shows as a queued row at the end of the transcript: either way, scroll to it.
  const submit = useCallback(
    (content: string, attachments: Attachment[]) => {
      const sending = send.mutateAsync({ content, attachments })
      sending.catch(() => {}) // onError already says so; the Composer puts the text back.
      thread.current?.scrollToEnd()
      return sending
    },
    [send.mutateAsync],
  )
  const sendFollowUp = useCallback((content: string) => submit(content, []), [submit])
  const startFromSelection = useCallback(
    (content: string) => sendChat.mutate({ id: newClientId("chat"), content, attachments: [] }),
    [sendChat.mutate],
  )
  // Memoized so the header's files chip and drawer only recompute when this task's files change.
  const files = useMemo(() => (artifacts.data ?? []).filter((a) => a.taskId === id), [artifacts.data, id])
  const selectionSource: SelectionTaskSource | null = project && task ? { kind: "task", project: projectContext(project)!, task: taskContext(task)! } : null

  if (tasks.isLoading) return null
  if (!task) return <Empty title="Task not found">It may have been deleted.</Empty>

  const running = task.status === "working" || task.status === "starting"

  return (
    // Runs through the page's bottom padding so the composer lines up with the Coordinator panel's.
    <div ref={panel} className={cx("relative flex min-w-0 flex-col", PAGE_BLEED_BOTTOM)}>
      <TaskHeader task={task} project={project} schedule={schedule} files={files} showTools={showTools} onShowTools={setShowTools} />

      {task.status === "needs_input" && task.question && (
        <div className="mb-4 flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-100">
          <MessageCircleQuestion className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
          <div>
            <div className="text-xs font-semibold tracking-wide text-amber-400 uppercase">The agent needs you</div>
            <div className="mt-1 text-sm">
              <LinkedText text={task.question} />
            </div>
          </div>
        </div>
      )}
      {task.status === "queued" && task.waitReason && (
        <div role="status" className="mb-4 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <WaitIcon task={task} className="h-4 w-4 shrink-0 text-amber-300" />
          <span className="min-w-0 flex-1">
            {/* A wait with a fix says when it ends itself ("…, or it resets at midnight"). */}
            <WaitReason task={task} />.
            {!task.waitFix && ` It starts on its own once there is room${task.waitBoxSize ? `, and never on a box smaller than ${task.waitBoxSize}` : ""}.`}
          </span>
          <WaitFixButton task={task} className="shrink-0" />
        </div>
      )}
      {task.status === "failed" && task.error && (
        <div className="mb-4 rounded-xl border border-red-900/50 bg-red-950/30 p-4 text-sm whitespace-pre-wrap wrap-anywhere text-red-200">
          <LinkedText text={task.error} />
        </div>
      )}

      <TaskThread
        handle={thread}
        id={id}
        showTools={showTools}
        working={running ? (task.status === "starting" ? "Preparing the box…" : "Agent is working…") : null}
        selectionSource={selectionSource}
        onStartFromSelection={startFromSelection}
        onFollowUp={sendFollowUp}
      />

      <Composer
        className={cx(COMPOSER_FOOTER, "mt-3")}
        onSubmit={submit}
        panelRef={panel}
        historyKey={`task:${id}`}
        placeholder={
          task.status === "needs_input"
            ? "Answer the agent…"
            : running
              ? "Message is delivered when the current turn ends…"
              : "Send feedback or a follow-up (resumes the same session)…"
        }
      />
    </div>
  )
}

/** The transcript. Its own component so header updates (status, context meter) don't re-render it. */
const TaskThread = memo(function TaskThread({
  handle,
  id,
  showTools,
  working,
  selectionSource,
  onStartFromSelection,
  onFollowUp,
}: {
  handle: Ref<StickyScrollHandle>
  id: string
  showTools: boolean
  working: string | null
  selectionSource: SelectionTaskSource | null
  onStartFromSelection: (prompt: string) => void
  onFollowUp: (message: string) => void
}) {
  const messages = useTaskMessages(id)
  const shown = useMemo(() => (messages.data ?? []).filter((m) => showTools || m.role !== "tool"), [messages.data, showTools])
  const tail = useTail(shown, id)
  const runs = useMemo(() => runsOf(tail.visible, isPublishedEvent), [tail.visible])

  // Older replies aren't rendered yet: parse their markdown in idle time so loading them is quick.
  const hidden = tail.hidden
  const index = useEntityIndex()
  const repo = useRepoScope()
  useEffect(() => {
    if (hidden) warmMarkdown(shown.slice(0, hidden).flatMap((m) => (m.role === "assistant" ? [m.content] : [])), index, repo)
  }, [shown, hidden, index, repo])

  return (
    <SelectionToTask source={selectionSource} onPrompt={onStartFromSelection}>
      <StickyScroll
        handle={handle}
        count={shown.length}
        resetKey={id}
        restoreKey="task"
        hidden={tail.hidden}
        onLoadEarlier={tail.loadEarlier}
        onTrim={tail.trim}
        className="rounded-xl border border-zinc-900 bg-zinc-950 p-4"
        contentClassName="space-y-2.5"
      >
        {messages.isLoading && <div className="text-sm text-zinc-500">Loading transcript…</div>}
        {runs.map((r) => (Array.isArray(r) ? <PublishedRun key={r[0]!.id} messages={r} /> : <Line key={r.id} m={r} onFollowUp={onFollowUp} />))}
        {working && (
          <div className="flex items-center gap-2 pt-1 text-xs text-sky-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> {working}
          </div>
        )}
        <TaskQueue taskId={id} />
      </StickyScroll>
    </SelectionToTask>
  )
})

/** A transcript "Published artifact" event; TaskThread shows back-to-back ones together in one PublishedRun. */
const isPublishedEvent = (m: TaskMessage) => m.role === "event" && m.meta?.kind === "artifact" && typeof m.meta.url === "string"

/** Back-to-back published files as one wrapping row of file chips (one ←/→ gallery), with the newest one's time. */
const PublishedRun = memo(
  function PublishedRun({ messages }: { messages: TaskMessage[] }) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 pl-6" {...PREVIEW_GROUP}>
        {messages.map((m) => (
          <PublishedFile key={m.id} artifactId={typeof m.meta?.artifactId === "string" ? m.meta.artifactId : undefined} url={String(m.meta!.url)} text={m.content} />
        ))}
        <span className="text-[10px] text-zinc-600">
          <TimeAgo ts={messages.at(-1)!.createdAt} />
        </span>
      </div>
    )
  },
  (a, b) => a.messages.length === b.messages.length && a.messages.every((m, i) => m === b.messages[i]),
)

export const Line = memo(function Line({ m, onFollowUp }: { m: TaskMessage; onFollowUp: (message: string) => void }) {
  const ownerName = useOwnerName()
  const time = (
    <span className="ml-2 text-[10px] text-zinc-600">
      <TimeAgo ts={m.createdAt} />
    </span>
  )
  switch (m.role) {
    case "user": {
      // A hook's message (server/hooks.ts) is an automation's, not Cody's: its own colour and icon.
      const hook = m.meta?.source === "hook"
      return (
        <div className={cx(MESSAGE_BLOCK, "rounded-lg border-l-2 px-3 py-2", hook ? "border-teal-500 bg-teal-500/5" : "border-yard-500 bg-yard-500/5", m.meta?.pending ? "opacity-60" : "")} data-testid={hook ? "hook-message" : undefined}>
          <div className={cx("mb-0.5 flex items-center gap-1 text-[11px] font-semibold", hook ? "text-teal-300" : "text-yard-400")}>
            {hook && <Webhook className="h-3 w-3" />}
            {userMessageLabel(m.meta, ownerName)}
            {time}
          </div>
          {m.content && <div className="text-sm whitespace-pre-wrap wrap-anywhere text-zinc-200">{m.content}</div>}
          <AttachmentList files={m.meta?.attachments} />
          {m.meta?.undelivered === true && <div className="mt-1 text-[11px] text-zinc-500">Not delivered: the task was stopped or marked done first.</div>}
          {!m.meta?.pending && <MessageActions text={m.content} />}
        </div>
      )
    }
    case "assistant":
      return (
        // The reply's first block drops its top margin (pt-1.5 keeps the gap) and the row sets one leading,
        // so the icon's one-line box sits on the first line. A reply opening with a code block: the box
        // skips the block's p-3 and is one 16px code line tall.
        <div className={cx(MESSAGE_BLOCK, "group flex min-w-0 items-start gap-2 pt-1.5 text-sm leading-relaxed")}>
          <LineIcon icon={Bot} className="h-4 w-4 text-zinc-500" box="group-has-[>div>.prose-chat>.code-block:first-child]:mt-3 group-has-[>div>.prose-chat>.code-block:first-child]:h-4" />
          <div className="min-w-0 text-zinc-200 [&>.prose-chat>:first-child]:mt-0!">
            <Markdown>{m.content}</Markdown>
            <RecommendedNextSteps steps={nextStepsFromMeta(m.meta)} onPick={onFollowUp} />
          </div>
          <MessageActions text={m.content} />
        </div>
      )
    case "tool":
      return (
        <div className={cx("overflow-x-auto pl-6 font-mono text-[11px] whitespace-nowrap", m.meta?.error ? "text-red-400/80" : "text-zinc-600")}>
          {m.meta?.error ? "✗ " : "› "}
          {m.content}
        </div>
      )
    case "agent":
      return (
        <div className={cx(MESSAGE_BLOCK, "flex items-start gap-2 rounded-lg bg-violet-500/5 px-3 py-2 text-sm text-violet-200")}>
          <LineIcon icon={Users} className="h-4 w-4 text-violet-400" />
          <div className="min-w-0">
            {typeof m.meta?.from === "string" && (
              <Link href={`/tasks/${m.meta.from}`} className="mb-0.5 block text-[11px] leading-5 font-semibold text-violet-400 hover:underline">
                From {String(m.meta.fromTitle ?? m.meta.from)}
              </Link>
            )}
            <div className="whitespace-pre-wrap wrap-anywhere">{m.content}</div>
          </div>
          <MessageActions text={m.content} />
        </div>
      )
    default: {
      const url = typeof m.meta?.url === "string" ? m.meta.url : null
      if (m.meta?.kind === "hook")
        return (
          <div className={cx("flex items-start gap-1.5 pl-1 text-xs leading-relaxed", m.meta.status === "fired" ? "text-teal-300/90" : "text-amber-200/80")} data-testid="hook-event">
            <LineIcon icon={Webhook} className="h-3.5 w-3.5" />
            <div className="min-w-0 wrap-anywhere [&_p]:inline">
              <Markdown>{m.content}</Markdown>
              {time}
            </div>
          </div>
        )
      return (
        <div className="pl-6 text-xs wrap-anywhere text-zinc-500">
          {url ? (
            <AppLink href={url} className="hover:text-zinc-300 hover:underline">
              {m.content}
            </AppLink>
          ) : (
            m.content
          )}
          {time}
        </div>
      )
    }
  }
})

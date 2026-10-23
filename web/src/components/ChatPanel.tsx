import { memo, useCallback, useEffect, useMemo, useRef } from "react"
import { useLocation } from "wouter"
import { Bot, Settings as SettingsIcon, Square, X } from "lucide-react"
import { newClientId, useChat, useChatBusy, useChatControl, useChatStream, useCompactOrchestrator, useOrchestratorState, useProjects, useSendChat, useTasks } from "../lib/queries"
import { REVEAL_CHAT_EVENT } from "../lib/reveal"
import { useTail } from "../lib/tail"
import { Button, Markdown, warmMarkdown } from "./ui"
import { useEntityIndex } from "../lib/entities"
import { StickyScroll } from "./StickyScroll"
import { Composer } from "./Composer"
import { ContextMeter } from "./ContextMeter"
import { useOpenSettings } from "./SettingsDialog"
import { VoiceControl } from "./VoiceControl"
import { ChatLine } from "./ChatLine"
import { SelectionToTask } from "./SelectionToTask"
import { projectContext, type SelectionTaskSource } from "../lib/selectionTask"
import type { Attachment, ChatMessage } from "../../../shared/types"

const SUGGESTIONS = [
  "What's everyone working on?",
  "Create a project for webdevcody/box-yard and add a dark mode toggle",
  "Spin up 3 agents to research Upstash Box pricing, write a summary, and draft a tweet",
]

const NO_MESSAGES: ChatMessage[] = []

/** `onClose` adds a close button to the header, shown while the panel is a drawer (below xl). */
export const ChatPanel = memo(function ChatPanel({ onClose }: { onClose?: () => void }) {
  const chat = useChat()
  const busy = useChatBusy()
  const send = useSendChat()
  const control = useChatControl()
  const orch = useOrchestratorState()
  const compact = useCompactOrchestrator()
  const openSettings = useOpenSettings()
  const projects = useProjects()
  const tasks = useTasks()
  const [location] = useLocation()
  const box = useRef<HTMLTextAreaElement>(null)
  const panel = useRef<HTMLElement>(null)

  const submit = useCallback(
    (text: string, attachments: Attachment[] = []) => {
      const content = text.trim()
      if (!content && !attachments.length) return
      send.mutate({ id: newClientId("chat"), content, attachments })
      box.current?.focus()
    },
    [send.mutate],
  )

  const messages = chat.data ?? NO_MESSAGES
  const tail = useTail(messages, "chat")
  const currentProject = useMemo(() => {
    const projectId = location.match(/^\/projects\/([^/?#]+)/)?.[1]
    if (projectId) return projects.data?.find((p) => p.id === projectId) ?? null
    const taskId = location.match(/^\/tasks\/([^/?#]+)/)?.[1]
    const task = taskId ? tasks.data?.find((t) => t.id === taskId) : null
    return task ? (projects.data?.find((p) => p.id === task.projectId) ?? null) : null
  }, [location, projects.data, tasks.data])
  const selectionSource: SelectionTaskSource = useMemo(() => ({ kind: "orchestrator", project: projectContext(currentProject) }), [currentProject])

  // Older messages aren't rendered yet: parse their markdown in idle time so loading them is quick.
  const hidden = tail.hidden
  const index = useEntityIndex()
  useEffect(() => {
    if (hidden) warmMarkdown(messages.slice(0, hidden).flatMap((m) => (m.role === "assistant" ? [m.content] : [])), index)
  }, [messages, hidden, index])

  // Links to a chat message (e.g. a schedule run) may point above the rendered part of the thread.
  const reveal = tail.reveal
  useEffect(() => {
    const onReveal = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      if (!reveal(id)) return
      // Two frames: let the list settle (and stop following the bottom) before scrolling to the message.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => document.getElementById(`chat-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })),
      )
    }
    window.addEventListener(REVEAL_CHAT_EVENT, onReveal)
    return () => window.removeEventListener(REVEAL_CHAT_EVENT, onReveal)
  }, [reveal])

  return (
    <section ref={panel} data-testid="chat-panel" className="relative flex h-full min-w-0 flex-col bg-zinc-950">
      <header className="flex min-h-14 items-center gap-2 border-b border-zinc-900 pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-4 xl:min-h-0 xl:py-3 xl:pt-3 xl:pr-4">
        <Bot className="h-4 w-4 shrink-0 text-yard-400" />
        <div className="min-w-0 truncate text-sm font-semibold text-zinc-100">Coordinator</div>
        {busy.data && <span className="shrink-0 text-xs text-sky-400">thinking…</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <VoiceControl />
          <Button size="sm" variant="ghost" title="Settings" aria-label="Settings" onClick={() => openSettings("orchestrator")}>
            <SettingsIcon className="h-3.5 w-3.5" />
          </Button>
          {busy.data && (
            <Button size="sm" variant="ghost" onClick={() => control.stop()} title="Stop">
              <Square className="h-3.5 w-3.5" />
            </Button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close"
              aria-label="Close the Coordinator"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 xl:hidden"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>
      <ContextMeter
        className="border-b border-zinc-900 px-4 py-2"
        tokens={orch.data?.usage.tokens ?? null}
        window={orch.data?.usage.window ?? null}
        compacting={orch.data?.compacting ?? false}
        queued={Boolean(orch.data?.compactQueued) || compact.isPending}
        onCompact={() => compact.mutate()}
      />

      <SelectionToTask source={selectionSource} onPrompt={submit}>
        <StickyScroll count={messages.length} hidden={tail.hidden} onLoadEarlier={tail.loadEarlier} className="px-4 py-4" contentClassName="space-y-3">
          {messages.length === 0 && !chat.isLoading && (
            <div className="space-y-3 pt-6 text-center">
              <p className="text-sm text-zinc-400">One chat runs the whole yard. Ask for work in plain words.</p>
              <div className="space-y-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => submit(s)}
                    className="block w-full rounded-lg border border-zinc-800 px-3 py-2 text-left text-xs text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          <ChatLines messages={tail.visible} onFollowUp={submit} />
          <StreamingReply busy={Boolean(busy.data)} />
        </StickyScroll>
      </SelectionToTask>

      <Composer
        onSubmit={submit}
        placeholder={busy.data ? "Queue another message…" : "Ask the Coordinator…"}
        textareaRef={box}
        panelRef={panel}
      />
    </section>
  )
})

const ChatLines = memo(function ChatLines({ messages, onFollowUp }: { messages: ChatMessage[]; onFollowUp: (message: string) => void }) {
  return messages.map((m) => <ChatLine key={m.id} m={m} onFollowUp={onFollowUp} />)
})

/** The reply being streamed. Only this re-renders per streamed chunk, not the thread above it. */
function StreamingReply({ busy }: { busy: boolean }) {
  const stream = useChatStream()
  if (stream.data)
    return (
      <div className="rounded-xl bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200">
        <Markdown live>{stream.data}</Markdown>
      </div>
    )
  if (!busy) return null
  return (
    <div className="flex gap-1 px-1 py-2">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  )
}

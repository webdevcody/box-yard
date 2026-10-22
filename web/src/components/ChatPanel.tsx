import { useRef, useState } from "react"
import { Link } from "wouter"
import { AlarmClock, AlertTriangle, Bot, RotateCcw, Settings as SettingsIcon, Square, Wrench } from "lucide-react"
import { newClientId, useChat, useChatBusy, useChatControl, useChatStream, useCompactOrchestrator, useOrchestratorState, useSendChat } from "../lib/queries"
import { Button, Markdown, cx } from "./ui"
import { StickyScroll } from "./StickyScroll"
import { Composer } from "./Composer"
import { AttachmentList } from "./Attachments"
import { ContextMeter } from "./ContextMeter"
import { SettingsDialog } from "./SettingsDialog"
import type { Attachment, ChatMessage } from "../../../shared/types"

const SUGGESTIONS = [
  "What's everyone working on?",
  "Create a project for webdevcody/box-yard and add a dark mode toggle",
  "Spin up 3 agents to research Upstash Box pricing, write a summary, and draft a tweet",
]

export function ChatPanel() {
  const chat = useChat()
  const stream = useChatStream()
  const busy = useChatBusy()
  const send = useSendChat()
  const control = useChatControl()
  const orch = useOrchestratorState()
  const compact = useCompactOrchestrator()
  const [showSettings, setShowSettings] = useState(false)
  const [draft, setDraft] = useState("")
  const box = useRef<HTMLTextAreaElement>(null)
  const panel = useRef<HTMLElement>(null)

  const submit = (text = draft, attachments: Attachment[] = []) => {
    const content = text.trim()
    if (!content && !attachments.length) return
    send.mutate({ id: newClientId("chat"), content, attachments })
    setDraft("")
    box.current?.focus()
  }

  const messages = chat.data ?? []

  return (
    <section ref={panel} className="relative flex h-full min-w-0 flex-col bg-zinc-950">
      <header className="flex items-center gap-2 border-b border-zinc-900 px-4 py-3">
        <Bot className="h-4 w-4 text-yard-400" />
        <div className="text-sm font-semibold text-zinc-100">Orchestrator</div>
        {busy.data && <span className="text-xs text-sky-400">thinking…</span>}
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" title="Settings" aria-label="Settings" onClick={() => setShowSettings(true)}>
            <SettingsIcon className="h-3.5 w-3.5" />
          </Button>
          {busy.data && (
            <Button size="sm" variant="ghost" onClick={() => control.stop()} title="Stop">
              <Square className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            title="New conversation"
            onClick={() => {
              if (confirm("Start a new orchestrator conversation? Projects and tasks are kept.")) void control.reset()
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
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
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}

      <StickyScroll count={messages.length} className="px-4 py-4" contentClassName="space-y-3">
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
        {messages.map((m) => (
          <ChatLine key={m.id} m={m} />
        ))}
        {stream.data && (
          <div className="rounded-xl bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200">
            <Markdown>{stream.data}</Markdown>
          </div>
        )}
        {busy.data && !stream.data && (
          <div className="flex gap-1 px-1 py-2">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500" style={{ animationDelay: `${i * 120}ms` }} />
            ))}
          </div>
        )}
      </StickyScroll>

      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={(files) => submit(draft, files)}
        placeholder={busy.data ? "Queue another message…" : "Ask the orchestrator…"}
        textareaRef={box}
        panelRef={panel}
      />
    </section>
  )
}

function ChatLine({ m }: { m: ChatMessage }) {
  if (m.role === "user" && m.meta?.scheduleId) {
    // A prompt injected by an orchestrator schedule, not typed by Cody.
    return (
      <div id={`chat-${m.id}`} className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-100">
          <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold tracking-wide text-sky-300 uppercase">
            <AlarmClock className="h-3 w-3" /> Scheduled
          </div>
          {m.content}
        </div>
      </div>
    )
  }
  if (m.role === "user") {
    return (
      <div id={`chat-${m.id}`} className="flex justify-end">
        <div className={cx("max-w-[85%] rounded-2xl rounded-br-md bg-yard-500/15 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-100", m.meta?.pending ? "opacity-70" : "")}>
          {m.content}
          <AttachmentList files={m.meta?.attachments} />
        </div>
      </div>
    )
  }
  if (m.role === "tool") {
    const input = (m.meta?.input ?? {}) as Record<string, unknown>
    const detail = (input.title ?? input.name ?? input.task ?? input.project ?? "") as string
    return (
      <div className="flex items-center gap-1.5 pl-1 text-xs text-zinc-500">
        <Wrench className="h-3 w-3" />
        <span className="font-mono">{m.content}</span>
        {detail && <span className="truncate text-zinc-600">· {String(detail).slice(0, 60)}</span>}
      </div>
    )
  }
  if (m.role === "notice") {
    const taskId = m.meta?.taskId as string | undefined
    const body = (
      <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-1.5 text-xs text-zinc-400">
        {/* The whole notice already links to its task; links inside it would nest. */}
        <Markdown linkify={!taskId}>{m.content}</Markdown>
      </div>
    )
    return taskId ? (
      <Link href={`/tasks/${taskId}`} className="block hover:opacity-90">
        {body}
      </Link>
    ) : (
      body
    )
  }
  if (m.role === "error") {
    return (
      <div className="flex gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 whitespace-pre-wrap">{m.content}</div>
      </div>
    )
  }
  return (
    <div className="text-sm text-zinc-200">
      <Markdown>{m.content}</Markdown>
    </div>
  )
}

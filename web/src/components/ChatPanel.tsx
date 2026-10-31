import { memo, useCallback, useEffect, useMemo, useRef } from "react"
import { useLocation } from "wouter"
import { Expand, Loader2, Minimize2, MoreHorizontal, Settings as SettingsIcon, Shrink, Square, X } from "lucide-react"
import {
  newClientId,
  useCaptainMessages,
  useCaptainState,
  useChat,
  useChatBusy,
  useChatControl,
  useChatStream,
  useCompactCaptain,
  useCompactOrchestrator,
  useOrchestratorState,
  useProjects,
  useSendCaptainMessage,
  useSendChat,
  useTasks,
} from "../lib/queries"
import { REVEAL_CHAT_EVENT } from "../lib/reveal"
import { splitQueued } from "../lib/queued"
import { AgentIcon, Button, InRepo, META_CHIP, Markdown, cx } from "./ui"
import { useEntityIndex } from "../lib/entities"
import { StickyScroll, type StickyScrollHandle } from "./StickyScroll"
import { COMPOSER_FOOTER, Composer, type ComposerHandle } from "./Composer"
import { CONTEXT_WARN_PCT, ContextMeter, ContextMiniBar, contextLabel, contextPct } from "./ContextMeter"
import { menuItem, usePopover } from "./TaskHeader"
import { useOpenSettings } from "./SettingsDialog"
import { ChatSwitcher } from "./ChatSwitcher"
import { focusComposer, useComposerFocus } from "../lib/chatSwitch"
import { VoiceControl } from "./VoiceControl"
import { CloudMeter, useShowCloudMeter } from "./CloudMeter"
import { ChatLine } from "./ChatLine"
import { useCoordinatorRows } from "./UpdateChips"
import { SelectionToTask } from "./SelectionToTask"
import { SideThreadPane, ThreadChatProvider, type CardPanelProps } from "./SideThread"
import { ProjectBar, ProjectFilterEmpty } from "./ProjectBar"
import { chatProvenance, recentProjects, type Provenance } from "../lib/chatProvenance"
import { pickProject, setChatProjectFilter, useChatProjectFilter } from "../lib/projectBar"
import { CardPanel, CardsBarPills, CardsView, NewCardsPill, TasksOnlyToggle, revealInCards, useCards } from "./CoordinatorCards"
import { CaptainCard, showBottomCard } from "./BottomCard"
import { projectColorStyle } from "./TaskIcon"
import { useTiles } from "../lib/taskTiles"
import { COORDINATOR_CHAT } from "../lib/threads"
import { projectContext, type SelectionTaskSource } from "../lib/selectionTask"
import { ZEN_SHORTCUT_LABEL, enterZen, leaveZen } from "../lib/zen"
import { HEAD_CONTAINER, spotClass, useAutoCompact } from "../lib/contextVisibility"
import { SetupCard, SetupReminder, setSetupSkipped, useSetupNeeded, useSetupSkipped } from "./Setup"
import { TryFirst, markTryFirstDone, useTryFirstDone } from "./TryFirst"
import type { Attachment, ChatMessage, ContextUsage } from "../../../shared/types"

const SUGGESTIONS = [
  "What's everyone working on?",
  "Create a project for webdevcody/box-yard and add a dark mode toggle",
  "Spin up 3 agents to research Upstash Box pricing, write a summary, and draft a tweet",
]

const NO_MESSAGES: ChatMessage[] = []

/** How far back a quiet project still gets a chip in the bar: the chat talked about it within this long. */
const RECENT_MS = 24 * 60 * 60_000

/** The projects the chat talked about lately; the same set until that changes, so the bar doesn't re-render. */
function useRecentProjects(all: ChatMessage[], prov: Provenance): ReadonlySet<string> {
  const prev = useRef<ReadonlySet<string>>(new Set())
  return useMemo(() => {
    const next = recentProjects(all, prov, Date.now() - RECENT_MS)
    if (next.size === prev.current.size && [...next].every((p) => prev.current.has(p))) return prev.current
    return (prev.current = next)
  }, [all, prov])
}

/**
 * `onClose` adds a close button to the header; App passes it only while the panel is a drawer. `zen` lays the same
 * chat out as the whole window: every row shares one centered column (`.zen-column` in styles.css), and the
 * context meter moves into the header (CoordinatorContext). With auto-compact on there's no meter or Compact at all.
 * With a project picked in the project bar, the panel talks to that project's Captain instead: the header names it
 * and shows its context, the box sends to it, and its card (BottomCard.tsx) takes the Coordinator card's place.
 */
export const ChatPanel = memo(function ChatPanel({ onClose, zen = false }: { onClose?: () => void; zen?: boolean }) {
  const chat = useChat()
  const busy = useChatBusy()
  const send = useSendChat()
  const control = useChatControl()
  const orch = useOrchestratorState()
  const compact = useCompactOrchestrator()
  const openSettings = useOpenSettings()
  const compactNow = useCallback(() => compact.mutate(), [compact.mutate])
  const autoCompact = useAutoCompact("coordinator")
  // Settings › Usage: off by default, since not everyone uses boxes (the Boxes page always shows the meter).
  const showCloud = useShowCloudMeter()
  const meterRow = spotClass(autoCompact, "header")
  const projects = useProjects()
  const tasks = useTasks()
  // The project bar's pick: the box below talks to its Captain.
  const projectFilter = useChatProjectFilter()
  const captainId = projectFilter
  const captainState = useCaptainState(captainId ?? "", { enabled: captainId !== null })
  const captainMessages = useCaptainMessages(captainId ?? "", { enabled: captainId !== null })
  const sendCaptain = useSendCaptainMessage(captainId ?? "")
  const compactCaptain = useCompactCaptain(captainId ?? "")
  const captainName = captainId ? (projects.data?.find((p) => p.id === captainId)?.name ?? captainId) : null
  const captainColor = useTiles().colors.get(captainId ?? "")
  const [location] = useLocation()
  const box = useRef<HTMLTextAreaElement>(null)
  const composer = useRef<ComposerHandle>(null)
  const panel = useRef<HTMLElement>(null)
  const scroller = useRef<StickyScrollHandle>(null)
  // Until the required keys are set, Zen shows the setup card instead of a chat that can't answer. The thread and
  // composer stay mounted behind it, so a draft survives.
  const setup = useSetupNeeded()
  const skipped = useSetupSkipped()
  const showSetup = zen && setup.needed && !skipped
  const finishSetup = useCallback(() => (zen ? setSetupSkipped(false) : openSettings("credentials")), [zen, openSettings])
  // Picked in a chat switcher: the composer takes focus.
  useComposerFocus(COORDINATOR_CHAT, box)
  // Then an empty Zen chat shows example requests, until one message is sent or they're dismissed.
  const tryFirstDone = useTryFirstDone()
  const fill = useCallback((text: string, select?: string) => composer.current?.fill(text, select), [])
  const addGithub = useCallback(() => openSettings("credentials"), [openSettings])

  // A suggested next step sends without touching the composer (no keyboard pops up on a phone).
  const followUp = useCallback(
    (text: string, attachments: Attachment[] = []) => {
      const content = text.trim()
      if (!content && !attachments.length) return
      const sending = send.mutateAsync({ id: newClientId("chat"), content, attachments })
      sending.catch(() => {}) // onError already says so; the Composer puts the text back.
      // Its answer lands in the Coordinator card: it unfolds, and "Tasks only" shows it again.
      showBottomCard()
      scroller.current?.scrollToEnd()
      markTryFirstDone()
      return sending
    },
    [send.mutateAsync],
  )
  const submit = useCallback(
    (text: string, attachments: Attachment[] = []) => {
      let sending: Promise<unknown> | undefined
      if (captainId) {
        const content = text.trim()
        if (!content && !attachments.length) return
        sending = sendCaptain.mutateAsync({ id: newClientId("chat"), content, attachments })
        sending.catch(() => {}) // onError already says so; the Composer puts the text back.
        // Its answer lands in the Captain card: it unfolds, and "Tasks only" shows it again.
        showBottomCard(true)
        scroller.current?.scrollToEnd()
      } else sending = followUp(text, attachments)
      box.current?.focus()
      return sending
    },
    [followUp, captainId, sendCaptain.mutateAsync],
  )

  const messages = chat.data ?? NO_MESSAGES
  const index = useEntityIndex()
  // Messages sent mid-turn wait under the streaming reply until the turn that reads them starts.
  const { settled: all, queued } = useMemo(() => splitQueued(messages), [messages])
  const allRows = useCoordinatorRows(all)
  // The project bar: which projects each message is about, and the one the chat shows only (lib/chatProvenance.ts).
  const prov = useMemo(() => chatProvenance(all, index, allRows), [all, index, allRows])
  const recent = useRecentProjects(all, prov)
  // The chat as cards, one per task; the side panel (⤢) finds its card here too.
  const cards = useCards(allRows, prov, messages.length > 0, projectFilter)
  const renderCard = (p: CardPanelProps) => <CardPanel {...p} layout={cards} onFollowUp={followUp} />
  const currentProject = useMemo(() => {
    const projectId = location.match(/^\/projects\/([^/?#]+)/)?.[1]
    if (projectId) return projects.data?.find((p) => p.id === projectId) ?? null
    const taskId = location.match(/^\/tasks\/([^/?#]+)/)?.[1]
    const task = taskId ? tasks.data?.find((t) => t.id === taskId) : null
    return task ? (projects.data?.find((p) => p.id === task.projectId) ?? null) : null
  }, [location, projects.data, tasks.data])
  const selectionSource: SelectionTaskSource = useMemo(
    () => (captainId ? { kind: "captain", project: { id: captainId, name: captainName ?? captainId } } : { kind: "orchestrator", project: projectContext(currentProject) }),
    [captainId, captainName, currentProject],
  )
  // Who the header, its context reading and the box are about: the Coordinator, or the picked project's Captain.
  const talking = captainId
    ? { busy: Boolean(captainState.data?.busy), state: captainState.data, queued: compactCaptain.isPending, compact: compactCaptain.mutate, who: "the Captain's" }
    : { busy: Boolean(busy.data), state: orch.data, queued: compact.isPending, compact: compactNow, who: "the Coordinator's" }
  // The chat switcher stays in this chat: a project goes on the project bar and the chat shows only it, its Captain
  // in the box below (rather than opening the Captain's own tab or Zen panel); the Coordinator shows it all again.
  const pickHere = useCallback((chat: string) => {
    if (chat === COORDINATOR_CHAT) setChatProjectFilter(null)
    else pickProject(chat)
    focusComposer(COORDINATOR_CHAT)
    return true
  }, [])

  // Links to a chat message (e.g. a schedule run): go to it in its card.
  useEffect(() => {
    const onReveal = (e: Event) => void revealInCards(cards, (e as CustomEvent<string>).detail)
    window.addEventListener(REVEAL_CHAT_EVENT, onReveal)
    return () => window.removeEventListener(REVEAL_CHAT_EVENT, onReveal)
  }, [cards])

  return (
    <ThreadChatProvider value={COORDINATOR_CHAT}>
      {/* A `coord` container: an open side thread sits beside the chat when the panel is wide (App widens the dock
          for it), over it when not. */}
      <section ref={panel} data-testid="chat-panel" className="@container/coord relative flex h-full min-w-0 bg-zinc-950">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* The `head` container: the header and the docked meter row under it switch to their narrow layout together. */}
          <div className={HEAD_CONTAINER}>
          <header
            className={cx(
              // A container, so the cloud meter (if shown) and the voice chip shrink in a narrow header (see CloudMeter, VoiceControl).
              // A column: the controls' row, then (in a narrow header) the cloud meter's strip.
              "@container flex flex-col justify-center",
              // overflow-hidden (for the column's scrollbar gutter) only from sm: phones have no gutter, and the ⋯ menu drops out of the header.
              zen ? "zen-column min-h-14 border-b border-zinc-900 pt-[env(safe-area-inset-top)] sm:overflow-hidden sm:pt-[max(0.5rem,env(safe-area-inset-top))]"
                : onClose ? "min-h-14 border-b border-zinc-900 pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-4"
                // Docked beside the page: a compact header
                : "border-b border-zinc-900 px-4 py-3",
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <AgentIcon busy={talking.busy} />
              {/* The title takes what's left (flex-1 from 0), so it gives way before the cloud meter's text does. */}
              {/* The title opens the chat switcher: the Coordinator, then every project's Captain. Too narrow for the word
                  beside "Tasks only" (a 320px phone), the icon says it alone and the switcher keeps its chevron. */}
              <div className="flex min-w-0 flex-1">
                <ChatSwitcher current={captainId ?? COORDINATOR_CHAT} onPick={pickHere} hotkey>
                  {captainId ? (
                    <span data-testid="chat-title" style={projectColorStyle(captainColor)} className="flex min-w-0 items-center gap-1.5 @max-[23rem]:sr-only">
                      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-(--pc)" />
                      <span className="min-w-0 truncate">{captainName} Captain</span>
                    </span>
                  ) : (
                    <span data-testid="chat-title" className="@max-[23rem]:sr-only">
                      {/* Zen names the app too; a phone keeps the short title so it isn't cut beside the controls. */}
                      {zen && <span className="max-sm:hidden">Box Yard </span>}
                      Coordinator
                    </span>
                  )}
                </ChatSwitcher>
              </div>
              <TasksOnlyToggle />
              {showCloud && <CloudMeter variant="inline" />}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {!autoCompact && <CoordinatorContext zen={zen} state={talking.state} queued={talking.queued} onCompact={talking.compact} who={talking.who} />}
                <VoiceControl />
                {!zen && (
                  <Button size="sm" variant="ghost" title={`Zen mode: just this chat, full screen (${ZEN_SHORTCUT_LABEL})`} aria-label="Zen mode" onClick={enterZen}>
                    <Expand className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button size="sm" variant="ghost" title="Settings" aria-label="Settings" onClick={() => openSettings("orchestrator")}>
                  <SettingsIcon className="h-3.5 w-3.5" />
                </Button>
                {/* A Captain's turn has no Stop. */}
                {!captainId && busy.data && (
                  <Button size="sm" variant="ghost" onClick={() => control.stop()} title="Stop">
                    <Square className="h-3.5 w-3.5" />
                  </Button>
                )}
                {zen && (
                  <Button size="sm" variant="ghost" title={`Leave Zen mode (Esc or ${ZEN_SHORTCUT_LABEL})`} aria-label="Leave Zen mode" onClick={leaveZen}>
                    <Shrink className="h-3.5 w-3.5" />
                  </Button>
                )}
                {onClose && !zen && (
                  <button
                    type="button"
                    onClick={onClose}
                    title="Close"
                    aria-label="Close the Coordinator"
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            {showCloud && <CloudMeter variant="strip" />}
          </header>
          {!zen && meterRow !== null && (
            <ContextMeter
              className={cx("border-b border-zinc-900 px-4 py-2", meterRow)}
              tokens={talking.state?.usage.tokens ?? null}
              window={talking.state?.usage.window ?? null}
              compacting={talking.state?.compacting ?? false}
              queued={Boolean(talking.state?.compactQueued) || talking.queued}
              onCompact={() => talking.compact()}
            />
          )}
          </div>
          {!showSetup && <ProjectBar recent={recent} className={zen ? "zen-column" : "px-4"} trailing={cards && <CardsBarPills layout={cards} />} />}

          {showSetup && <SetupCard status={setup.status!} className="zen-column" />}
          {setup.needed && !showSetup && <SetupReminder status={setup.status!} onFinish={finishSetup} className={zen ? "zen-column" : "px-4"} />}

          <div className={showSetup ? "hidden" : "contents"}>
            <SelectionToTask source={selectionSource} onPrompt={submit}>
              <StickyScroll
                handle={scroller}
                count={(cards ? cards.live.length + cards.idle.length + cards.done.length + cards.coordinator.length : 0) + (captainId ? (captainMessages.data?.length ?? 0) + (talking.busy ? 1 : 0) : 0)}
                restoreKey="chat:cards"
                overlay={cards && <NewCardsPill cards={cards.live} />}
                // --chat-pad: its top padding, which a card's sticky header pulls up over (CoordinatorCards).
                className={zen ? "zen-column py-6 [--chat-pad:1.5rem]" : "px-4 py-4 [--chat-pad:1rem]"}
                contentClassName="space-y-3"
              >
                {messages.length === 0 && !chat.isLoading && zen && !tryFirstDone && (
                  <TryFirst
                    ready={!setup.needed}
                    github={setup.status?.github.state === "set" && !setup.status.mock}
                    needsGithub={setup.status?.github.state === "unset" && !setup.status.mock}
                    onPick={fill}
                    onGithub={addGithub}
                  />
                )}
                {messages.length === 0 && !chat.isLoading && !zen && (
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
                {projectFilter && (!cards || (!cards.live.length && !cards.idle.length && !cards.done.length && !cards.coordinator.length)) && <ProjectFilterEmpty projectId={projectFilter} />}
                {/* The Coordinator's replies span projects: "#12" links only where a paragraph is about one repo. Notices and chips set their task's. */}
                <InRepo mentions>
                  {cards ? (
                    <CardsView layout={cards} onFollowUp={followUp} active={Boolean(busy.data) || queued.length > 0}>
                      <StreamingReply busy={Boolean(busy.data)} />
                      {queued.length > 0 && <ChatLines messages={queued} onFollowUp={followUp} />}
                    </CardsView>
                  ) : (
                    <StreamingReply busy={Boolean(busy.data)} />
                  )}
                </InRepo>
                {/* Under the cards: the Captain the box below talks to. */}
                {captainId && <CaptainCard projectId={captainId} />}
              </StickyScroll>
            </SelectionToTask>

            <Composer
              onSubmit={submit}
              placeholder={captainId ? (talking.busy ? "Queue another message for the Captain…" : `Message the ${captainName} Captain…`) : busy.data ? "Queue another message…" : "Ask the Coordinator…"}
              textareaRef={box}
              handleRef={composer}
              panelRef={panel}
              historyKey={captainId ? `captain:${captainId}` : "coordinator"}
              tools={
                captainId && (
                  <span
                    data-testid="composer-to"
                    title={`Goes to the ${captainName} Captain, not the Coordinator. Pick "All" in the project bar for the Coordinator.`}
                    style={projectColorStyle(captainColor)}
                    className="flex min-w-0 items-center gap-1.5 px-1 text-[11px] text-zinc-500"
                  >
                    <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-(--pc)" />
                    <span className="min-w-0 truncate">To the {captainName} Captain</span>
                  </span>
                )
              }
              className={zen ? cx(COMPOSER_FOOTER, "zen-column overflow-hidden") : undefined}
            />
          </div>
        </div>
        {/* Its header as tall as the chat's: 3.5rem in Zen and the drawer, the docked header's 47px (py-3, a 22px row, the border). */}
        <InRepo mentions>
          <SideThreadPane chat={COORDINATOR_CHAT} headerClassName={zen || onClose ? "min-h-14" : "min-h-[47px]"} renderCard={renderCard} />
        </InRepo>
      </section>
    </ThreadChatProvider>
  )
})

const contextHint = (who: string) => `How much of ${who} context window is used. Compact when it gets high.`

/**
 * The Coordinator's context reading in its header, left of the voice button, while auto-compact is off. A wide Zen
 * header: the mini bar and "58%" (full reading in its tooltip), then Compact, quiet until CONTEXT_WARN_PCT and amber
 * from there. Compact keeps one width in every state (the icon turns into a spinner), so nothing in the header moves.
 * The docked panel has its meter row under the header instead. A narrow header (a phone, a slim panel) has neither:
 * one ⋯ button, amber from CONTEXT_WARN_PCT, opens a menu with the full reading and Compact.
 */
function CoordinatorContext({
  zen,
  state,
  queued,
  onCompact,
  who,
}: {
  zen: boolean
  /** The Coordinator's state, or the Captain's the panel talks to. */
  state: { usage: ContextUsage; compacting: boolean; compactQueued: boolean } | undefined
  queued: boolean
  onCompact: () => void
  /** Whose context it is, for the hint: "the Coordinator's". */
  who: string
}) {
  const { open, setOpen, root, trigger } = usePopover()
  const tokens = state?.usage.tokens ?? null
  const window = state?.usage.window ?? null
  const pct = contextPct(tokens, window)
  const compacting = state?.compacting ?? false
  const waiting = compacting || queued || Boolean(state?.compactQueued)
  const warn = pct !== null && pct >= CONTEXT_WARN_PCT
  const status = compacting ? "Compacting…" : waiting ? "Compact queued" : null
  const title = status ?? "Compact: summarise the conversation to free up context. If a turn is running, it compacts right after."
  const icon = waiting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Minimize2 className="h-3 w-3" />
  const bar = pct === null ? <span className="text-xs text-zinc-500">Context</span> : <ContextMiniBar tokens={tokens} window={window} hint={contextHint(who)} />
  const reading = `Context ${contextLabel(tokens, window)}`
  const menu = spotClass(false, "menu")
  return (
    <div ref={root} className="relative flex items-center">
      {zen && (
        <div data-testid="zen-context" className={cx("mr-1 flex items-center gap-1.5", spotClass(false, "header"))}>
          {bar}
          <button
            type="button"
            onClick={() => onCompact()}
            disabled={waiting}
            title={title}
            aria-label={status ?? "Compact"}
            className={cx(
              META_CHIP,
              "disabled:cursor-default",
              warn ? "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20" : "border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
            )}
          >
            {icon}
            Compact
          </button>
        </div>
      )}
      <Button
        ref={trigger}
        size="sm"
        variant="ghost"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${reading}: more`}
        title={reading}
        data-testid="context-menu-button"
        className={cx(menu, warn && "text-amber-300! hover:text-amber-200!")}
      >
        {waiting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-3.5 w-3.5" />}
      </Button>
      {open && (
        <div role="menu" className={cx("absolute top-full right-0 z-30 mt-1 w-56 rounded-xl border border-zinc-800 bg-zinc-950 p-1.5 shadow-2xl", menu)}>
          <div className="px-2 py-1.5 text-xs text-zinc-400 tabular-nums">{reading}</div>
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            disabled={waiting}
            onClick={() => {
              onCompact()
              setOpen(false)
            }}
          >
            {icon}
            {status ?? "Compact"}
          </button>
        </div>
      )}
    </div>
  )
}

/** Messages Cody queued mid-turn. */
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

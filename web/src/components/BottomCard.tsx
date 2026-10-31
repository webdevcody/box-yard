// The card pinned under the Coordinator chat's task cards: whoever the box below talks to. With "All" in the project
// bar that's the Coordinator (CoordinatorCard in CoordinatorCards.tsx); with a project picked, it's that project's
// Captain (CaptainCard here), so Cody talks to the Captain directly and the Coordinator never sees it. Either folds
// to its one-line header, with its newest line beside the title; this browser remembers which (one setting for both).
import { memo, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { Bot, ChevronRight, ChevronUp, EyeOff, Maximize2 } from "lucide-react"
import { newClientId, useCaptainMessages, useCaptainState, useProjects, useSendCaptainMessage } from "../lib/queries"
import { localFlag } from "../lib/localFlag"
import { setTasksOnly, useTasksOnly } from "../lib/coordinatorView"
import { splitQueued } from "../lib/queued"
import { captainRows, plainText } from "../lib/captainTranscript"
import { useTiles } from "../lib/taskTiles"
import { captainHref } from "./ChatSwitcher"
import { ChatLine } from "./ChatLine"
import { InboundMessage } from "./CaptainTab"
import { WorkingLine } from "./CardComposer"
import { projectColorStyle } from "./TaskIcon"
import { AppLink, InRepo, cx } from "./ui"
import type { CaptainMessage } from "../../../shared/types"

/** The bottom card folded to its header. */
export const bottomCardFolded = localFlag("boxyard:bottom-card-folded")

/**
 * Cody sent the Coordinator (or with `project`, the picked project's Captain) a message: its card shows, unfolded and
 * not hidden by "Tasks only", so the message and its answer are in view. Folding or hiding it again is up to Cody.
 */
export function showBottomCard(project = false) {
  setTasksOnly(false, project)
  bottomCardFolded.set(false)
}

const HIDDEN =
  "flex w-full min-w-0 items-center gap-2 rounded-[10px] border border-dashed border-zinc-800 px-2 py-1.5 text-left text-xs text-zinc-500 hover:text-zinc-300 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:min-h-10"

/** In place of the bottom card while "Tasks only" hides it: what's hidden, and the way back. */
export function HiddenCard({ label, onShow, testId }: { label: string; onShow: () => void; testId: string }) {
  return (
    <button type="button" onClick={onShow} data-testid={testId} className={HIDDEN}>
      <EyeOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label} hidden (Tasks only)</span>
      <span className="shrink-0 text-zinc-500">show</span>
    </button>
  )
}

const CARD = "scroll-mt-3 rounded-[10px] border border-zinc-800/80 border-l-[3px]"
const EARLIER = "flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-zinc-500 hover:text-zinc-300 pointer-coarse:min-h-11"
const FOOT =
  "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-yard-400 hover:bg-zinc-800 hover:text-yard-300 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:min-h-11"

/**
 * The bottom card's header: its icon, who it is ("Coordinator · your main chat"), and under it what the box below
 * does, or, folded, its newest line. A click anywhere on it (but its links and buttons) folds or unfolds the card.
 * It stays in reach (sticky) while the card's history scrolls by.
 */
export function BottomCardHead({
  icon,
  title,
  tag,
  hint,
  latest,
  working,
  children,
}: {
  icon: ReactNode
  title: ReactNode
  tag: string
  /** What typing below does. */
  hint: string
  /** Folded: the newest line, plain text. */
  latest: string | null
  /** Folded: "is working" dots after the title. */
  working: boolean
  /** More controls before the fold chevron. */
  children?: ReactNode
}) {
  const folded = bottomCardFolded.use()
  const toggle = (e: MouseEvent | KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("a, button")) return
    if ("key" in e && e.key !== "Enter" && e.key !== " ") return
    e.preventDefault()
    bottomCardFolded.set(!folded)
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={!folded}
      data-testid="bottom-card-head"
      title={folded ? "Show the conversation" : "Fold it to this line"}
      onClick={toggle}
      onKeyDown={toggle}
      // Sticky: pinned at the top of the chat while a long history scrolls by under it.
      className={cx(
        "sticky top-[calc(-1*var(--chat-pad,0px))] z-20 flex cursor-pointer items-start gap-2 bg-zinc-950/95 py-2 pr-2 pl-3 backdrop-blur hover:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none",
        folded ? "rounded-[9px]" : "rounded-t-[9px]",
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[13.5px] leading-[22px] font-semibold text-zinc-100">
          <span className="min-w-0 truncate">{title}</span>
          <span className="shrink-0 text-xs font-normal text-zinc-500 @max-[22rem]:hidden">· {tag}</span>
          {folded && working && (
            <span aria-label="Working" className="flex shrink-0 gap-[3px]">
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-[5px] w-[5px] animate-bounce rounded-full bg-yard-400" style={{ animationDelay: `${i * 120}ms` }} />
              ))}
            </span>
          )}
        </div>
        <div data-testid="bottom-card-sub" className={cx("text-[11.5px] text-zinc-500", folded && "truncate")}>
          {folded ? (latest ?? hint) : hint}
        </div>
      </div>
      {children}
      <button
        type="button"
        data-testid="bottom-card-fold"
        onClick={() => bottomCardFolded.set(!folded)}
        aria-expanded={!folded}
        aria-label={folded ? "Unfold" : "Fold"}
        title={folded ? "Show the conversation" : "Fold it to this line"}
        className="-my-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:-my-2.5 pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <ChevronRight className={cx("h-3.5 w-3.5 transition-transform", !folded && "rotate-90")} aria-hidden />
      </button>
    </div>
  )
}

/** How many of the Captain's lines show before "N earlier", and how many more each click adds. */
const CAPTAIN_SHOW = 3
const EARLIER_STEP = 10

const NO_MESSAGES: CaptainMessage[] = []

/** The conversation, not the task notices the cards above already show, nor the Captain's tool calls. */
const isTalk = (m: CaptainMessage) => m.role === "user" || m.role === "assistant" || m.role === "error"

/** A line's text for the folded header: "You: …", "Captain: …". */
function latestLine(m: CaptainMessage | undefined): string | null {
  if (!m) return null
  const who = m.role === "assistant" ? "Captain" : m.role === "error" ? "Error" : m.meta?.source === "cody" || !m.meta?.source ? "You" : "To the Captain"
  return `${who}: ${plainText(m.content.replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/gm, ""))}`
}

/**
 * A project's Captain at the bottom of the chat, while the project bar shows that project: its newest lines with the
 * messages queued for its next turn, who's working, and the way to its whole chat (its Captain tab). "Tasks only"
 * (lib/coordinatorView.ts) leaves a one-line stand-in.
 */
export const CaptainCard = memo(function CaptainCard({ projectId }: { projectId: string }) {
  const hidden = useTasksOnly(true)
  const name = useProjects().data?.find((p) => p.id === projectId)?.name ?? projectId
  if (hidden) return <HiddenCard label={`${name} Captain card`} onShow={() => setTasksOnly(false, true)} testId="captain-hidden" />
  return <CaptainCardBody projectId={projectId} />
})

function CaptainCardBody({ projectId }: { projectId: string }) {
  const project = useProjects().data?.find((p) => p.id === projectId)
  const color = useTiles().colors.get(projectId)
  const state = useCaptainState(projectId).data
  const messages = useCaptainMessages(projectId).data ?? NO_MESSAGES
  const send = useSendCaptainMessage(projectId)
  const folded = bottomCardFolded.use()
  const [limit, setLimit] = useState(CAPTAIN_SHOW)
  const { talk, queued } = useMemo(() => {
    const { settled, queued } = splitQueued(messages)
    // captainRows tells a notice from a message; what's left of its messages is the conversation.
    const talk = captainRows(settled).flatMap((r) => (r.type === "message" && isTalk(r.message) ? [r.message] : []))
    return { talk, queued }
  }, [messages])
  const shown = talk.length > limit ? talk.slice(-limit) : talk
  const hidden = talk.length - shown.length
  const busy = Boolean(state?.busy)
  const name = project?.name ?? projectId
  // A suggested next step from the Captain goes back to it.
  const followUp = (text: string) => {
    const content = text.trim()
    if (content) send.mutateAsync({ id: newClientId("chat"), content }).catch(() => {})
  }
  return (
    <section
      id="card-captain"
      data-testid="captain-card"
      data-project={projectId}
      aria-label={`${name} Captain`}
      style={projectColorStyle(color)}
      className={cx(CARD, "border-l-(--pc) bg-zinc-900/25")}
    >
      <BottomCardHead
        icon={
          <span aria-hidden className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md bg-(--pc)/15 text-(--pc)">
            <Bot className="h-[13px] w-[13px]" />
          </span>
        }
        title={`${name} Captain`}
        tag="this project's chat"
        hint={`What you type below goes to the ${name} Captain. The Coordinator doesn't see it.`}
        latest={latestLine(talk.at(-1))}
        working={busy}
      >
        <AppLink href={captainHref(projectId)} title="The Captain's whole chat" className="-my-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 pointer-coarse:-my-2.5 pointer-coarse:h-11 pointer-coarse:w-11">
          <Maximize2 className="h-[13px] w-[13px]" aria-label="Open the Captain's chat" />
        </AppLink>
      </BottomCardHead>
      {!folded && (
        <InRepo projectId={projectId}>
          <div className="space-y-3 border-t border-zinc-800/70 px-3 py-2.5">
            {state?.error && <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs wrap-anywhere text-red-300">{state.error}</div>}
            {hidden > 0 && (
              <button type="button" onClick={() => setLimit((n) => n + EARLIER_STEP)} className={EARLIER} data-testid="captain-card-earlier">
                <ChevronUp className="h-3 w-3" aria-hidden />
                {hidden} earlier
              </button>
            )}
            {!talk.length && !queued.length && <p className="text-xs text-zinc-500">Nothing yet. Ask the {name} Captain anything about the project below.</p>}
            {shown.map((m, i) =>
              m.role === "user" ? (
                <InboundMessage key={m.id} m={m} />
              ) : (
                // Only its newest reply offers next steps.
                <ChatLine key={m.id} m={m} next={i === shown.length - 1} inCard onFollowUp={followUp} />
              ),
            )}
            {busy && <WorkingLine who={`The ${name} Captain`} />}
            {queued.map((m) => (
              <InboundMessage key={m.id} m={m} />
            ))}
            <AppLink href={captainHref(projectId)} className={FOOT}>
              Captain's whole chat
            </AppLink>
          </div>
        </InRepo>
      )}
    </section>
  )
}

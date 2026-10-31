// The Coordinator chat's box at the bottom, with a line over it. In a narrow chat (a phone, a slim panel:
// lib/dockComposer.ts) it's the only box: cards have none of their own, and it sends to the card Cody opened last, its
// "To [card] ▾" line saying which (the ▾ picks another open card or the chat's own: the Coordinator, or the picked
// project's Captain). A wide chat keeps each open card's own box, and this one is the chat's.
// The line also holds the cards' "↓ N new" pill and "Jump to latest" / "N new messages" (StickyScroll's JumpStore), at
// every width, so neither floats over a card. The line hides while it has nothing to show.
import { memo, useRef, useState, type ReactNode, type RefObject } from "react"
import { ArrowDown, Bot, ChevronDown, LayoutGrid } from "lucide-react"
import { Composer, COMPOSER_FOOTER, type ComposerHandle } from "./Composer"
import { Rerouted, cardPlaceholder, useCardSend } from "./CardComposer"
import { NewCardsPill, useDockCard, useOpenCards, type CardsLayout } from "./CoordinatorCards"
import { MessageMenu, type MenuItem } from "./MessageActions"
import { TaskTile, projectColorStyle } from "./TaskIcon"
import { useJumpState, type JumpStore } from "./StickyScroll"
import { cx } from "./ui"
import { setDockTarget, useDocked } from "../lib/dockComposer"
import { useTask } from "../lib/queries"
import { useTaskTile, useTiles } from "../lib/taskTiles"
import type { ProjectColor } from "../../../shared/projectColors"
import type { Attachment, Task } from "../../../shared/types"

/** Who the chat's own box talks to: the Coordinator, or the picked project's Captain. */
export type ChatTarget = { label: string; color?: ProjectColor }

/** The line's pills: 28px with a mouse, 44px under a finger. */
const LINE_PILL =
  "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:px-3.5"

export const DockComposer = memo(function DockComposer({
  layout,
  jumpStore,
  chat,
  onSubmit,
  placeholder,
  historyKey,
  tools,
  textareaRef,
  handleRef,
  panelRef,
  className,
}: {
  layout: CardsLayout | null
  jumpStore: JumpStore
  chat: ChatTarget
  /** The chat's own box: what it sends to and says. */
  onSubmit: (text: string, attachments: Attachment[]) => Promise<unknown> | void
  placeholder: string
  historyKey: string
  tools?: ReactNode
  textareaRef: RefObject<HTMLTextAreaElement | null>
  handleRef: RefObject<ComposerHandle | null>
  panelRef: RefObject<HTMLElement | null>
  className?: string
}) {
  const docked = useDocked()
  const card = useDockCard(docked ? layout : null)
  const task = useTask(card?.taskId ?? "").data ?? null
  const target = card && task ? task : null
  const send = useCardSend(target)
  return (
    <div data-testid="chat-footer" data-docked={docked || undefined} className={cx(COMPOSER_FOOTER, "px-3", className)}>
      <div data-testid="dock-line" className="@container/dock mb-2 flex min-w-0 items-center gap-1.5 [&:not(:has(button))]:hidden">
        {docked && <DockTo layout={layout} target={target} chat={chat} />}
        <span className="ml-auto flex shrink-0 items-center justify-end gap-1.5 empty:hidden">
          {layout && <NewCardsPill cards={layout.live} />}
          <JumpPill store={jumpStore} />
        </span>
      </div>
      <Composer
        onSubmit={target ? send.submit : onSubmit}
        placeholder={target ? cardPlaceholder(target) : placeholder}
        textareaRef={textareaRef}
        handleRef={handleRef}
        panelRef={panelRef}
        historyKey={target ? `task:${target.id}` : historyKey}
        files={!target}
        tools={target ? null : tools}
        className="relative"
      />
      {target && send.rerouted !== null && <Rerouted reason={send.rerouted} />}
    </div>
  )
})

/** "To [tile] Fix login ▾": where the docked box sends, and the menu to send somewhere else. */
function DockTo({ layout, target, chat }: { layout: CardsLayout | null; target: Task | null; chat: ChatTarget }) {
  const open = useOpenCards(layout)
  const tiles = useTiles().tasks
  const trigger = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const items: MenuItem[] = [
    { icon: Bot, label: `To ${chat.label}`, run: () => setDockTarget(null) },
    ...open.map((c) => ({ icon: LayoutGrid, label: `To ${tiles.get(c.taskId)?.title ?? c.key}`, run: () => setDockTarget(c.key) })),
  ]
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid="dock-to"
        onClick={() => setMenu(!menu)}
        aria-haspopup="menu"
        aria-expanded={menu}
        title={target ? "Goes straight to this task's agent. Pick where else to send" : `Goes to ${chat.label}. Open a card to reply to its task`}
        className={cx(LINE_PILL, "min-w-0 shrink border-zinc-800 bg-zinc-900/60 pl-2 font-normal text-zinc-400 hover:border-zinc-700 hover:text-zinc-100")}
      >
        <span className="shrink-0">To</span>
        {target ? <TargetName task={target} /> : <ChatName chat={chat} />}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
      </button>
      {menu && <MessageMenu trigger={trigger} items={items} onClose={() => setMenu(false)} />}
    </>
  )
}

function TargetName({ task }: { task: Task }) {
  const tile = useTaskTile(task.id)
  return (
    <span data-testid="dock-to-target" style={projectColorStyle(tile?.color)} className="flex min-w-0 items-center gap-1.5 text-zinc-100">
      <TaskTile id={task.id} bare />
      <span className="min-w-0 truncate">{task.title}</span>
    </span>
  )
}

function ChatName({ chat }: { chat: ChatTarget }) {
  return (
    <span data-testid="dock-to-target" style={projectColorStyle(chat.color)} className="flex min-w-0 items-center gap-1.5 text-zinc-100">
      {chat.color ? <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-(--pc)" /> : <Bot className="h-3.5 w-3.5 shrink-0 text-yard-400" aria-hidden />}
      <span className="min-w-0 truncate">{chat.label.replace(/^the /, "")}</span>
    </span>
  )
}

/** "↓ Jump to latest" or "↓ 3 new messages", while the list is scrolled up from its bottom. */
function JumpPill({ store }: { store: JumpStore }) {
  const { away, unread } = useJumpState(store)
  if (!away) return null
  const label = unread > 0 ? `${unread} new message${unread === 1 ? "" : "s"}` : "Jump to latest"
  return (
    <button type="button" data-testid="jump-latest" onClick={store.jump} aria-label={label} title={label} className={cx(LINE_PILL, "shrink-0 border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800")}>
      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
      <span className="@max-[22rem]/dock:sr-only">{label}</span>
    </button>
  )
}

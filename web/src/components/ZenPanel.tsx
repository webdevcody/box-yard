// Zen's side panel (lib/zenPanel.ts): the task page, a project page or its Captain tab, beside the Zen chat. A column
// on the right with a draggable edge when the Zen window is wide, a full-screen sheet over the chat when it isn't
// (the `zen` container in App.tsx, so it follows the window's width at any zoom, never a viewport breakpoint).
import { memo, useEffect, useSyncExternalStore, type CSSProperties, type MouseEvent } from "react"
import { Route, Router, Switch } from "wouter"
import { Bot, ChevronLeft, FolderGit2, ListTodo, Maximize2, X } from "lucide-react"
import { TaskView } from "./TaskView"
import { ProjectView } from "./ProjectView"
import { cx } from "./ui"
import { useProjects, useTasks, QUIET } from "../lib/queries"
import { PAGE_PADDING } from "../lib/layout"
import { ResizeHandle, useResizable } from "../lib/resize"
import { isPlainClick } from "../lib/filePreview"
import { COORDINATOR_CHAT, useThreadShown } from "../lib/threads"
import { closeZenPanel, openPanelFullView, panelPage, useZenPanel, useZenPanelLocation } from "../lib/zenPanel"

/** The Zen window narrower than this shows the panel as a sheet over the chat. */
export const ZEN_PANEL_SHEET = "48rem"
/** What the chat keeps beside the panel. */
const CHAT_ROOM = 360

const subscribeResize = (cb: () => void) => {
  window.addEventListener("resize", cb)
  return () => window.removeEventListener("resize", cb)
}

export function ZenPanel() {
  const open = useZenPanel()
  // One right panel at a time: a side thread opening in the Zen chat closes this one (opening this closes the thread).
  const threadShown = useThreadShown(COORDINATOR_CHAT)
  useEffect(() => {
    if (threadShown) closeZenPanel()
  }, [threadShown])
  // Only to cap a drag; the panel's width on screen is capped by the container (100cqw) instead.
  const viewport = useSyncExternalStore(subscribeResize, () => window.innerWidth)
  const size = useResizable({ key: "box-yard:zen-panel-width", defaultWidth: 640, min: 400, max: 1200, limit: viewport - CHAT_ROOM, edge: "left" })

  if (!open) return null
  return (
    <aside
      data-testid="zen-panel"
      aria-label="Side panel"
      style={{ "--zen-panel-w": `${size.width}px` } as CSSProperties}
      className={cx(
        // Beside the chat: the saved width, as far as the chat keeps CHAT_ROOM.
        "relative flex h-full min-h-0 w-(--zen-panel-w) max-w-[calc(100cqw-22.5rem)] min-w-0 flex-col border-l border-zinc-900 bg-zinc-950",
        // A narrow window: a sheet over the chat.
        "@max-[48rem]/zen:absolute @max-[48rem]/zen:inset-0 @max-[48rem]/zen:z-30 @max-[48rem]/zen:w-full @max-[48rem]/zen:max-w-none @max-[48rem]/zen:border-l-0",
      )}
    >
      <ResizeHandle {...size.handle} className="@min-[48rem]/zen:block" />
      <PanelHeader path={open.path} />
      {/* Scrolls like the main column: the pages' sticky headers and full-height chats are laid out for it. */}
      <div data-testid="zen-panel-scroll" className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-y-contain pr-[env(safe-area-inset-right)]">
        <div className={cx("h-full", PAGE_PADDING)}>
          <PanelPages />
        </div>
      </div>
    </aside>
  )
}

/** The pages, on the panel's own location. Memoized: dragging the edge re-renders the panel on every move. */
const PanelPages = memo(function PanelPages() {
  return (
    <Router hook={useZenPanelLocation}>
      <Switch>
        <Route path="/tasks/:id">{(p) => <TaskView id={p.id} />}</Route>
        <Route path="/projects/:id">{(p) => <ProjectView id={p.id} />}</Route>
      </Switch>
    </Router>
  )
})

const ICON = "grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 sm:h-8 sm:w-8"

function PanelHeader({ path }: { path: string }) {
  const page = panelPage(path)
  // Titles only: the task list's live updates don't re-render the header.
  const tasks = useTasks(QUIET)
  const projects = useProjects()
  const task = page?.kind === "task" ? tasks.data?.find((t) => t.id === page.id) : undefined
  const projectId = page?.kind === "project" ? page.id : task?.projectId
  const project = projects.data?.find((p) => p.id === projectId)
  const captain = page?.kind === "project" && page.tab === "captain"
  const Icon = page?.kind === "task" ? ListTodo : captain ? Bot : FolderGit2
  const title = page?.kind === "task" ? (task?.title ?? page.id) : captain ? `${project?.name ?? page.id} Captain` : (project?.name ?? page?.id ?? "")
  const full = (e: MouseEvent<HTMLAnchorElement>) => {
    // Cmd/Ctrl or middle click: the page in a new tab, and the panel stays.
    if (!isPlainClick(e)) return
    e.preventDefault()
    openPanelFullView()
  }
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-zinc-900 pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-2">
      {/* A sheet goes back to the chat; a column closes with the × on the right. */}
      <button type="button" onClick={closeZenPanel} aria-label="Back to the chat" title="Back to the chat (Esc)" className={cx(ICON, "@min-[48rem]/zen:hidden")}>
        <ChevronLeft className="h-5 w-5" />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-zinc-100 @min-[48rem]/zen:pl-2">
        <Icon className="h-4 w-4 shrink-0 text-yard-300" aria-hidden />
        <span data-testid="zen-panel-title" className="truncate" title={title}>
          {title}
        </span>
        {page?.kind === "task" && project && <span className="hidden shrink-0 truncate text-xs font-normal text-zinc-500 @min-[36rem]/zen:inline">{project.name}</span>}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <a href={path} onClick={full} aria-label="Open in full view" title="Open in full view (leaves Zen)" className={ICON}>
          <Maximize2 className="h-4 w-4" />
        </a>
        <button type="button" onClick={closeZenPanel} aria-label="Close the panel" title="Close (Esc)" className={cx(ICON, "hidden @min-[48rem]/zen:grid")}>
          <X className="h-4 w-4" />
        </button>
      </div>
    </header>
  )
}

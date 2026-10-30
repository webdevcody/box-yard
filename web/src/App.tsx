import { memo, useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react"
import { CHAT_MAX, CHAT_MIN, PAGE_PADDING, coordinatorDock, threadDockWidth } from "./lib/layout"
import { COORDINATOR_CHAT, useThreadShown } from "./lib/threads"
import type { CSSProperties } from "react"
import { Route, Router, Switch } from "wouter"
import { navigate } from "wouter/use-browser-location"
import { SETTINGS_PARAM, parseSection } from "./lib/settingsNav"
import { Menu, MessageSquare } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { keys, useAgentSettings, useMe } from "./lib/queries"
import { useServerEvents } from "./lib/stream"
import { Sidebar } from "./components/Sidebar"
import { ChatPanel } from "./components/ChatPanel"
import { ProjectView } from "./components/ProjectView"
import { TaskView } from "./components/TaskView"
import { BoxesView } from "./components/BoxesView"
import { UsageView } from "./components/UsageView"
import { CompactionsView } from "./components/Compactions"
import { SchedulesView } from "./components/Schedules"
import { CommandPalette } from "./components/CommandPalette"
import { Toasts } from "./components/Toasts"
import { NotificationEffects } from "./components/NotificationEffects"
import { SettingsHost } from "./components/SettingsDialog"
import { ConfirmHost } from "./components/ConfirmDialog"
import { FilePreviewHost } from "./components/FilePreview"
import { LightboxHost } from "./components/Lightbox"
import { HealthBanner, InboxView, Login } from "./components/Views"
import { YardView } from "./components/YardView"
import { cx } from "./components/ui"
import { ResizeHandle, useResizable } from "./lib/resize"
import { BrandLogo } from "./components/BrandLogo"
import { useZen, useZenHotkeys, useZenLanding } from "./lib/zen"
import { closeZenPanel, zenAroundNav } from "./lib/zenPanel"
import { ZenPanel } from "./components/ZenPanel"

export function App() {
  const me = useMe()
  const qc = useQueryClient()
  const authed = Boolean(me.data?.authed)
  const connection = useServerEvents(authed)
  const [navOpen, setNavOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const sidebarSize = useResizable({ key: "box-yard:sidebar-width", defaultWidth: 256, min: 200, max: 360, edge: "right" })
  const viewport = useViewportWidth()
  const chatLimit = coordinatorDock(viewport, sidebarSize.width, CHAT_MAX).max
  const chatSize = useResizable({ key: "box-yard:chat-width", defaultWidth: 416, min: CHAT_MIN, max: CHAT_MAX, limit: chatLimit, edge: "left" })
  const dock = coordinatorDock(viewport, sidebarSize.width, chatSize.width)
  // An open side thread gets the right side of the panel: the docked panel widens to make room for it.
  const threadShown = useThreadShown(COORDINATOR_CHAT)
  const dockWidth = threadShown ? threadDockWidth(viewport, sidebarSize.width, dock.width) : dock.width
  const closeNav = useCallback(() => setNavOpen(false), [])
  const closeChat = useCallback(() => setChatOpen(false), [])
  const openChat = useCallback(() => setChatOpen(true), [])
  const zen = useZen()
  useZenHotkeys(zen)
  const agentSettings = useAgentSettings({ enabled: authed })
  const landed = useZenLanding(agentSettings.data?.settings.startInZen ?? (agentSettings.isError ? false : undefined))
  // Drawers close behind Zen, so leaving it (Esc, back or a link) shows the page, not a drawer over it. Zen's side
  // panel closes when Zen does, so coming back starts with the chat alone.
  useEffect(() => {
    if (!zen) {
      closeZenPanel()
      return
    }
    setNavOpen(false)
    setChatOpen(false)
  }, [zen])

  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: keys.me })
    window.addEventListener("box-yard:unauthorized", onUnauthorized)
    return () => window.removeEventListener("box-yard:unauthorized", onUnauthorized)
  }, [qc])

  if (me.isLoading) return null
  if (me.isError)
    return <div className="grid h-full place-items-center text-sm text-zinc-500">Can't reach the Box Yard server. Is it running?</div>
  if (!authed) return <Login />
  // A new tab on / waits for Start in Zen mode, so it opens straight into Zen or the Yard.
  if (!landed) return null

  // Zen (/zen) drops everything but the chat. The chat keeps its slot in the tree either way, so entering or
  // leaving Zen keeps the same ChatPanel: its draft, attachments and scroll position survive the switch.
  return (
    <div className="flex h-[100dvh] min-h-0 overflow-hidden">
      {/* Projects sidebar: fixed on wide screens, a drawer on small ones */}
      {!zen && (
        <div className={cx("fixed inset-y-0 left-0 z-40 w-[min(20rem,calc(100vw-2rem))] transition-transform lg:relative lg:w-[var(--panel-w)] lg:translate-x-0", navOpen ? "translate-x-0" : "-translate-x-full")}
          style={{ "--panel-w": `${sidebarSize.width}px` } as CSSProperties}
        >
          <Sidebar connection={connection} onNavigate={closeNav} onOpenChat={dock.docked ? undefined : openChat} />
          <ResizeHandle {...sidebarSize.handle} className="lg:block" />
        </div>
      )}
      {!zen && navOpen && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setNavOpen(false)} />}

      {!zen && (
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <HealthBanner />
          <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-zinc-900 px-3 pt-[env(safe-area-inset-top)] lg:hidden">
            <button onClick={() => setNavOpen(true)} className="grid h-11 w-11 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800" aria-label="Open navigation">
              <Menu className="h-5 w-5" />
            </button>
            <BrandLogo markClassName="h-6 w-6" textClassName="font-semibold text-zinc-100" />
            <button onClick={() => setChatOpen(true)} className="ml-auto grid h-11 w-11 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800" aria-label="Open orchestrator">
              <MessageSquare className="h-5 w-5" />
            </button>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <div className={`mx-auto h-full max-w-6xl ${PAGE_PADDING}`}>
              <Routes />
            </div>
          </div>
          <Toasts />
        </main>
      )}

      {/* The global orchestrator chat: docked beside the page when there's room for both, else a drawer;
          the whole window in Zen, with the side panel (ZenPanel) on its right. The `zen` container lays the panel out
          by the window's width. */}
      <div
        data-zen={zen || undefined}
        data-docked={(!zen && dock.docked) || undefined}
        className={cx(
          zen
            ? "@container/zen relative grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)]"
            : dock.docked
              ? // Eased only when a side thread opens or closes, not while its edge is dragged.
                cx("relative shrink-0 border-l border-zinc-900", !chatSize.handle.dragging && "transition-[width] duration-300 ease-out motion-reduce:transition-none")
              : cx(
                  "fixed inset-y-0 right-0 z-40 w-full border-l border-zinc-900 transition-transform",
                  // A drawer with a side thread open takes the window (a tablet shows them side by side).
                  threadShown ? "sm:max-w-4xl" : "sm:max-w-md",
                  chatOpen ? "translate-x-0" : "translate-x-full",
                ),
        )}
        style={!zen && dock.docked ? { width: dockWidth } : undefined}
      >
        {!zen && dock.docked && <ResizeHandle {...chatSize.handle} className="block!" />}
        {/* In Zen, the chat's task, Captain and project links open the side panel instead of leaving (lib/zenPanel.ts). */}
        <Router aroundNav={zenAroundNav}>
          <ChatPanel onClose={dock.docked ? undefined : closeChat} zen={zen} />
        </Router>
        {zen && <ZenPanel />}
      </div>
      {zen && <Toasts quiet />}
      <CommandPalette />
      <SettingsHost />
      <ConfirmHost />
      <FilePreviewHost />
      <LightboxHost />
      <NotificationEffects />
    </div>
  )
}

// The page content and the side panels are memoized: dragging a panel edge re-renders App on every
// pointer move, and that shouldn't re-render the open view, the sidebar or the orchestrator thread.
const Routes = memo(function Routes() {
  return (
    <Switch>
      <Route path="/" component={YardView} />
      <Route path="/inbox" component={InboxView} />
      <Route path="/boxes" component={BoxesView} />
      <Route path="/usage" component={UsageView} />
      <Route path="/compactions" component={CompactionsView} />
      <Route path="/schedules" component={SchedulesView} />
      <Route path="/projects/:id">{(p) => <ProjectView id={p.id} />}</Route>
      <Route path="/tasks/:id">{(p) => <TaskView id={p.id} />}</Route>
      <Route path="/settings/:section?">{(p) => <SettingsLink section={p.section} />}</Route>
      <Route>
        <YardView />
      </Route>
    </Switch>
  )
})

/** /settings and /settings/<section> are links to the settings dialog: it opens over the Yard. */
function SettingsLink({ section }: { section?: string }) {
  useLayoutEffect(() => navigate(`/?${SETTINGS_PARAM}=${parseSection(section)}`, { replace: true }), [section])
  return null
}

const subscribeResize = (cb: () => void) => {
  window.addEventListener("resize", cb)
  return () => window.removeEventListener("resize", cb)
}
/** The window's width in CSS px (it shrinks as the browser zooms in), kept current. */
function useViewportWidth() {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth)
}

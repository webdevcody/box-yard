import { memo, useCallback, useEffect, useState } from "react"
import type { CSSProperties } from "react"
import { Route, Switch } from "wouter"
import { Menu, MessageSquare, X } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { keys, useMe } from "./lib/queries"
import { useServerEvents } from "./lib/stream"
import { Sidebar } from "./components/Sidebar"
import { ChatPanel } from "./components/ChatPanel"
import { ProjectView } from "./components/ProjectView"
import { TaskView } from "./components/TaskView"
import { BoxesView } from "./components/BoxesView"
import { SchedulesView } from "./components/Schedules"
import { CommandPalette } from "./components/CommandPalette"
import { Toasts } from "./components/Toasts"
import { NotificationEffects } from "./components/NotificationEffects"
import { SettingsHost } from "./components/SettingsDialog"
import { ConfirmHost } from "./components/ConfirmDialog"
import { HealthBanner, InboxView, Login } from "./components/Views"
import { YardView } from "./components/YardView"
import { cx } from "./components/ui"
import { ResizeHandle, useResizable } from "./lib/resize"

export function App() {
  const me = useMe()
  const qc = useQueryClient()
  const authed = Boolean(me.data?.authed)
  const connection = useServerEvents(authed)
  const [navOpen, setNavOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const sidebarSize = useResizable({ key: "box-yard:sidebar-width", defaultWidth: 256, min: 200, max: 360, edge: "right" })
  const chatSize = useResizable({ key: "box-yard:chat-width", defaultWidth: 416, min: 320, max: 600, edge: "left" })
  const closeNav = useCallback(() => setNavOpen(false), [])

  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: keys.me })
    window.addEventListener("box-yard:unauthorized", onUnauthorized)
    return () => window.removeEventListener("box-yard:unauthorized", onUnauthorized)
  }, [qc])

  if (me.isLoading) return null
  if (me.isError)
    return <div className="grid h-full place-items-center text-sm text-zinc-500">Can't reach the Box Yard server. Is it running?</div>
  if (!authed) return <Login />

  return (
    <div className="flex h-full">
      {/* Projects sidebar: fixed on wide screens, a drawer on small ones */}
      <div className={cx("fixed inset-y-0 left-0 z-40 transition-transform w-64 lg:relative lg:w-[var(--panel-w)] lg:translate-x-0", navOpen ? "translate-x-0" : "-translate-x-full")}
        style={{ "--panel-w": `${sidebarSize.width}px` } as CSSProperties}
      >
        <Sidebar connection={connection} onNavigate={closeNav} />
        <ResizeHandle {...sidebarSize.handle} className="lg:block" />
      </div>
      {navOpen && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setNavOpen(false)} />}

      <main className="relative flex min-w-0 flex-1 flex-col">
        <HealthBanner />
        <div className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2 lg:hidden">
          <button onClick={() => setNavOpen(true)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800">
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-semibold text-zinc-100">Box Yard</span>
          <button onClick={() => setChatOpen(true)} className="ml-auto rounded p-1.5 text-zinc-400 hover:bg-zinc-800 xl:hidden">
            <MessageSquare className="h-5 w-5" />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto h-full max-w-6xl px-6 py-6">
            <Routes />
          </div>
        </div>
        {/* Clear of the floating orchestrator button, which shows between lg and xl */}
        <Toasts className={chatOpen ? undefined : "lg:bottom-20 xl:bottom-4"} />
      </main>

      {/* The global orchestrator chat: always visible on wide screens */}
      <div
        className={cx(
          "fixed inset-y-0 right-0 z-40 w-full max-w-md border-l border-zinc-900 transition-transform xl:relative xl:w-[var(--panel-w)] xl:max-w-none xl:translate-x-0",
          chatOpen ? "translate-x-0" : "translate-x-full",
        )}
        style={{ "--panel-w": `${chatSize.width}px` } as CSSProperties}
      >
        <ResizeHandle {...chatSize.handle} className="xl:block" />
        <button onClick={() => setChatOpen(false)} className="absolute top-3 right-3 z-10 rounded p-1 text-zinc-500 hover:text-zinc-200 xl:hidden">
          <X className="h-4 w-4" />
        </button>
        <ChatPanel />
      </div>
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="fixed right-4 bottom-4 z-30 hidden rounded-full bg-yard-500 p-3 text-zinc-950 shadow-lg hover:bg-yard-400 lg:block xl:hidden"
          title="Open the orchestrator"
        >
          <MessageSquare className="h-5 w-5" />
        </button>
      )}
      <CommandPalette />
      <SettingsHost />
      <ConfirmHost />
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
      <Route path="/schedules" component={SchedulesView} />
      <Route path="/projects/:id">{(p) => <ProjectView id={p.id} />}</Route>
      <Route path="/tasks/:id">{(p) => <TaskView id={p.id} />}</Route>
      <Route>
        <YardView />
      </Route>
    </Switch>
  )
})

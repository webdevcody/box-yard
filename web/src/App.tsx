import { useEffect, useState } from "react"
import { Route, Switch } from "wouter"
import { Menu, MessageSquare, X } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { keys, useMe } from "./lib/queries"
import { useServerEvents } from "./lib/stream"
import { dismiss, useToasts } from "./lib/toast"
import { Sidebar } from "./components/Sidebar"
import { ChatPanel } from "./components/ChatPanel"
import { ProjectView } from "./components/ProjectView"
import { TaskView } from "./components/TaskView"
import { SchedulesView } from "./components/Schedules"
import { HealthBanner, HomeView, InboxView, Login } from "./components/Views"
import { cx } from "./components/ui"

export function App() {
  const me = useMe()
  const qc = useQueryClient()
  const authed = Boolean(me.data?.authed)
  const connection = useServerEvents(authed)
  const [navOpen, setNavOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)

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
      <div className={cx("fixed inset-y-0 left-0 z-40 transition-transform lg:static lg:translate-x-0", navOpen ? "translate-x-0" : "-translate-x-full")}>
        <Sidebar connection={connection} onNavigate={() => setNavOpen(false)} />
      </div>
      {navOpen && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setNavOpen(false)} />}

      <main className="flex min-w-0 flex-1 flex-col">
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
            <Switch>
              <Route path="/" component={HomeView} />
              <Route path="/inbox" component={InboxView} />
              <Route path="/schedules" component={SchedulesView} />
              <Route path="/projects/:id">{(p) => <ProjectView id={p.id} />}</Route>
              <Route path="/tasks/:id">{(p) => <TaskView id={p.id} />}</Route>
              <Route>
                <HomeView />
              </Route>
            </Switch>
          </div>
        </div>
      </main>

      {/* The global orchestrator chat: always visible on wide screens */}
      <div
        className={cx(
          "fixed inset-y-0 right-0 z-40 w-full max-w-md border-l border-zinc-900 transition-transform xl:static xl:w-[26rem] xl:translate-x-0",
          chatOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
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
      <Toasts />
    </div>
  )
}

function Toasts() {
  const toasts = useToasts()
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={cx(
            "pointer-events-auto max-w-md cursor-pointer rounded-lg border px-4 py-2.5 text-sm shadow-xl",
            t.kind === "error" ? "border-red-900 bg-red-950 text-red-100" : "border-zinc-800 bg-zinc-900 text-zinc-100",
          )}
        >
          <div className="font-medium">{t.title}</div>
          {t.body && <div className="mt-0.5 text-xs opacity-80">{t.body}</div>}
        </div>
      ))}
    </div>
  )
}

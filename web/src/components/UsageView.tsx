import { Link } from "wouter"
import type { ReactNode } from "react"
import { AlertTriangle, BarChart3, Bot, Box, Cpu, HardDrive, Settings } from "lucide-react"
import { useUsage } from "../lib/queries"
import { bytes, compactTokens, hours, money } from "../lib/usage"
import { useOpenSettings } from "./SettingsDialog"
import { Empty, cx } from "./ui"
import type { ClaudeUsageTotals, UsageReport } from "../../../shared/types"

function StatCard({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={cx("rounded-xl border bg-zinc-900/40 p-4", warn ? "border-amber-500/40" : "border-zinc-800/80")}>
      <div className="text-xs font-medium tracking-wide text-zinc-500 uppercase">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-zinc-50 tabular-nums">{value}</div>
      {sub && <div className={cx("mt-1 text-xs", warn ? "text-amber-300" : "text-zinc-500")}>{sub}</div>}
    </div>
  )
}

function ClaudeLine({ u }: { u: ClaudeUsageTotals }) {
  return (
    <span className="text-xs text-zinc-500">
      {u.turns} {u.turns === 1 ? "turn" : "turns"} · {compactTokens(u.totalTokens)} tokens · {money(u.costUsd)}
    </span>
  )
}

export function UsageView() {
  const usage = useUsage()
  const openSettings = useOpenSettings()
  const data = usage.data

  if (usage.isLoading) return null
  if (!data) return <Empty title="Usage unavailable">The server did not return a usage report.</Empty>

  const today = data.windows.find((w) => w.key === "today")!
  const seven = data.windows.find((w) => w.key === "7d")!
  const thirty = data.windows.find((w) => w.key === "30d")!
  const budget = data.budget

  return (
    <div className="space-y-6 pb-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Usage & costs</h1>
          <p className="mt-1 text-sm text-zinc-500">Claude Code spend from CLI result JSON, plus Upstash Box infrastructure estimates when provider usage is unavailable.</p>
        </div>
        <button onClick={() => openSettings("costs")} className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm text-sky-400 hover:underline">
          <Settings className="h-3.5 w-3.5" /> Rates & budgets
        </button>
      </header>

      {budget.blocked && (
        <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
          <div>
            <div className="font-semibold">Budget exceeded. New agent turns are paused.</div>
            <div className="mt-1 text-amber-200/80">Raise the daily or monthly budget in Settings to resume queued work.</div>
          </div>
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Today" value={money(today.totalCostUsd)} sub={`${compactTokens(today.claude.totalTokens)} Claude tokens · ${hours(today.boxes.activeMs)} box active`} warn={budget.daily.warning} />
        <StatCard label="Last 7 days" value={money(seven.totalCostUsd)} sub={`${money(seven.claude.costUsd)} Claude · ${money(seven.boxes.costUsd)} boxes`} />
        <StatCard label="Last 30 days" value={money(thirty.totalCostUsd)} sub={`${compactTokens(thirty.claude.totalTokens)} Claude tokens · ${hours(thirty.boxes.activeMs)} box active`} warn={budget.monthly.warning} />
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <Panel title="Claude Code" icon={<Bot className="h-4 w-4" />}>
          <div className="grid gap-2 sm:grid-cols-3">
            <Mini label="Task turns" value={money(thirty.claude.costUsd)} sub={`${thirty.claude.turns} runs · ${compactTokens(thirty.claude.totalTokens)} tokens`} />
            <Mini label="Coordinator" value={money(data.orchestrator.costUsd)} sub={`All-time · ${data.orchestrator.turns} runs · ${compactTokens(data.orchestrator.totalTokens)} tokens`} />
            <Mini label="Captains" value={money(data.captains.costUsd)} sub={`All-time · ${data.captains.turns} runs · ${compactTokens(data.captains.totalTokens)} tokens`} />
          </div>
          <Table empty="No project usage yet.">
            {data.projects.slice(0, 8).map((p) => (
              <Link key={p.projectId} href={`/projects/${p.projectId}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-sm hover:bg-zinc-900">
                <span className="truncate text-zinc-100">{p.projectName}</span>
                <ClaudeLine u={p.claude} />
              </Link>
            ))}
          </Table>
        </Panel>

        <Panel title="Boxes" icon={<Box className="h-4 w-4" />}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Mini label="Active CPU (30d)" value={hours(thirty.boxes.activeMs)} sub={`${money(thirty.boxes.costUsd)} estimated`} />
            <Mini label="Storage rate" value={`${money(data.rates.boxStorageGbMonthUsd)}/GB-mo`} sub={thirty.boxes.source === "actual" ? "provider usage" : "estimated"} />
          </div>
          <Table empty="No boxes have been metered yet.">
            {data.boxes.map((b) => (
              <Link key={b.boxId} href={`/boxes#${b.boxId}`} className="grid gap-1 px-3 py-2 text-sm hover:bg-zinc-900 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3">
                <span className="min-w-0">
                  <span className="block truncate font-mono text-zinc-100">{b.boxId}</span>
                  <span className="text-xs text-zinc-500">
                    {b.size} · {b.keepAlive ? "keep-alive" : "not keep-alive"} · {b.usageSource}
                  </span>
                </span>
                <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500 sm:justify-end">
                  <span className="inline-flex items-center gap-1"><Cpu className="h-3.5 w-3.5" /> {hours(b.activeMs)}</span>
                  <span className="inline-flex items-center gap-1"><HardDrive className="h-3.5 w-3.5" /> {bytes(b.diskBytes)}</span>
                  <span className="font-medium text-zinc-300">{money(b.estimatedCostUsd)}</span>
                </span>
              </Link>
            ))}
          </Table>
        </Panel>
      </section>

      <Panel title="Top tasks" icon={<BarChart3 className="h-4 w-4" />}>
        <Table empty="No task usage yet.">
          {data.tasks.slice(0, 12).map((t) => (
            <Link key={t.taskId} href={`/tasks/${t.taskId}`} className="grid gap-1 px-3 py-2 text-sm hover:bg-zinc-900 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3">
              <span className="min-w-0">
                <span className="block truncate text-zinc-100">{t.taskTitle}</span>
                <span className="text-xs text-zinc-500">{t.projectName}</span>
              </span>
              <ClaudeLine u={t.claude} />
            </Link>
          ))}
        </Table>
      </Panel>
    </div>
  )
}

function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/30">
      <h2 className="flex items-center gap-2 border-b border-zinc-800/80 px-4 py-3 text-sm font-semibold text-zinc-200">
        {icon} {title}
      </h2>
      <div className="space-y-3 p-3">{children}</div>
    </section>
  )
}

function Mini({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/40 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold text-zinc-100 tabular-nums">{value}</div>
      <div className="text-xs text-zinc-500">{sub}</div>
    </div>
  )
}

function Table({ empty, children }: { empty: string; children: ReactNode }) {
  return <div className="overflow-hidden rounded-lg border border-zinc-800/80">{Array.isArray(children) && children.length === 0 ? <div className="px-3 py-3 text-sm text-zinc-500">{empty}</div> : children}</div>
}

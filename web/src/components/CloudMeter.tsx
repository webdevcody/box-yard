// The cloud meter: how many boxes run, what they cost an hour now, and today's box spend against the daily cloud limit.
// It opens a sheet with the limits, "Raise today's limit" and every box. The Boxes page always has it; the Coordinator's
// header (docked and Zen) only with Settings › Usage › Box spend in the header.
import { memo, useState } from "react"
import { Link } from "wouter"
import { Boxes, ChevronRight, Cpu, Settings as SettingsIcon } from "lucide-react"
import type { CloudStatus } from "../../../shared/types"
import { useAgentSettings, useAllowMoreBoxes, useCloud, useRaiseCloudLimit } from "../lib/queries"
import { BAR_TONE, METER_TONE, boxState, countsLine, dollars, limitPct, meterLabel, meterState, newBoxes, perHour, todayLine } from "../lib/cloud"
import { useOpenSettings } from "./SettingsDialog"
import { Modal } from "./Modal"
import { Button, cx } from "./ui"

/** The chip's look; `inline` has META_CHIP's sizes but may shrink (its text truncates before the header's buttons overflow). */
const CHIP = "inline-flex min-w-0 items-center gap-1 rounded-md border text-xs font-medium whitespace-nowrap tabular-nums transition"
const VARIANT = {
  inline: "min-h-11 px-2 sm:h-6 sm:min-h-0 sm:px-1.5 @max-[26rem]:hidden",
  strip: "mb-2 h-8 w-full px-2.5 @min-[26rem]:hidden",
  page: "min-h-11 max-w-full px-2.5 sm:h-8 sm:min-h-0",
}
type Variant = keyof typeof VARIANT

/** Whether the Coordinator's header shows the meter (Settings › Usage). Off until settings say otherwise. */
export function useShowCloudMeter(): boolean {
  return useAgentSettings().data?.settings.showCloudMeter ?? false
}

/**
 * The meter, read by the header's width (the header is a container). `inline` sits beside the title from 26rem:
 * "$8.50 of $10 · 3 boxes · $0.49/h" from 56rem, "$8.50 of $10 · 3 boxes" from 34rem (Zen's column is 48rem),
 * "$8.50/$10 · 3" below, its text truncating when the header is full. `strip` is the full reading as a row under the
 * header below 26rem (phones), where the header's buttons leave no room. `page` is the full reading as a chip on the
 * Boxes page. Calm, then amber from 80% of a limit, rose at it. Each opens the sheet.
 */
export const CloudMeter = memo(function CloudMeter({ variant }: { variant: Variant }) {
  const cloud = useCloud()
  const [open, setOpen] = useState(false)
  const s = cloud.data
  if (!s) return null
  const label = meterLabel(s)
  const boxes = s.boxes.total === 1 ? "1 box" : `${s.boxes.total} boxes`
  // Today against the limit first: it's what stays when the text truncates.
  const full = `${todayLine(s.spend)} · ${boxes} · ${perHour(s.hourlyUsd)}`
  const short = `${s.spend.dailyLimitUsd > 0 ? `${dollars(s.spend.todayUsd)}/${dollars(s.spend.dailyLimitUsd)}` : dollars(s.spend.todayUsd)} · ${s.boxes.total}`
  return (
    <>
      <button
        type="button"
        data-testid={variant === "inline" ? "cloud-meter" : `cloud-meter-${variant}`}
        data-state={meterState(s)}
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        className={cx(CHIP, VARIANT[variant], METER_TONE[meterState(s)])}
      >
        <Boxes className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {variant === "inline" ? (
          <>
            <span className="truncate @max-[56rem]:hidden">{full}</span>
            <span className="truncate @max-[34rem]:hidden @min-[56rem]:hidden">
              {todayLine(s.spend)} · {boxes}
            </span>
            <span className="truncate @min-[34rem]:hidden">{short}</span>
          </>
        ) : variant === "strip" ? (
          <>
            <span className="truncate">{full}</span>
            <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
          </>
        ) : (
          <span className="truncate">{s.spend.dailyLimitUsd > 0 ? `Today ${full}` : full}</span>
        )}
      </button>
      {open && <CloudSheet status={s} onClose={() => setOpen(false)} />}
    </>
  )
})

/** Today's spend and limit, the boxes now, and each box with what it's doing and what it cost today. */
function CloudSheet({ status: s, onClose }: { status: CloudStatus; onClose: () => void }) {
  const openSettings = useOpenSettings()
  const raise = useRaiseCloudLimit()
  const allow = useAllowMoreBoxes()
  const now = Date.now()
  const { spend } = s
  const pct = limitPct(spend)
  const settings = () => {
    onClose()
    openSettings("costs")
  }
  const daily = spend.dailyLimitUsd > 0
  const dailyReached = spend.state === "reached" && daily && spend.todayUsd >= spend.dailyLimitUsd - 1e-9
  return (
    <Modal
      onClose={onClose}
      placement="sheet"
      size="md"
      title="Cloud boxes"
      description={
        s.idleDeleteMinutes > 0
          ? `Upstash boxes start when work needs one and are deleted after ${s.idleDeleteMinutes} min idle. They cost the CPU they use.`
          : "Upstash boxes start when work needs one. They cost the CPU they use."
      }
      footer={
        <>
          <Link
            href="/boxes"
            onClick={onClose}
            className="inline-flex min-h-11 items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 max-sm:w-full sm:min-h-0"
          >
            All boxes
          </Link>
          <Button variant="subtle" onClick={settings}>
            <SettingsIcon className="h-3.5 w-3.5" />
            Limits and rates
          </Button>
        </>
      }
    >
      <div className="space-y-5 text-sm" data-testid="cloud-sheet">
        <section aria-label="Today">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-zinc-300">Today</span>
            <span className="text-zinc-400 tabular-nums">
              <span className="font-semibold text-zinc-100">{dollars(spend.todayUsd)}</span>
              {daily ? ` of ${dollars(spend.dailyLimitUsd)}` : ""}
            </span>
          </div>
          {daily ? (
            <>
              <div
                className="mt-1.5 h-2 overflow-hidden rounded-full bg-zinc-800"
                role="meter"
                aria-label="Today's cloud limit"
                aria-valuemin={0}
                aria-valuemax={spend.dailyLimitUsd}
                aria-valuenow={spend.todayUsd}
              >
                <div className={cx("h-full rounded-full", BAR_TONE[spend.state])} style={{ width: `${pct ?? 0}%` }} />
              </div>
              <p className="mt-1 text-xs text-zinc-500 tabular-nums">
                {pct}% used · {dollars(Math.max(0, spend.dailyLimitUsd - spend.todayUsd))} left until midnight
                {spend.raisedUsd > 0 ? ` · raised ${dollars(spend.raisedUsd)} today` : ""}
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs text-zinc-500">No daily cloud limit: boxes start whenever work needs one.</p>
          )}
          {spend.monthlyLimitUsd > 0 && (
            <p className="mt-1 text-xs text-zinc-500 tabular-nums">
              Last 30 days: {dollars(spend.monthUsd)} of {dollars(spend.monthlyLimitUsd)}
            </p>
          )}
        </section>

        {spend.state === "reached" && (
          <div role="status" data-testid="cloud-reached" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-rose-100">
            <p>
              <span className="font-semibold">New boxes wait:</span> {spend.blockedReason}. Work already running goes on.
            </p>
            <div className="mt-2">
              {dailyReached && spend.raiseToUsd !== null ? (
                <Button variant="primary" loading={raise.isPending} onClick={() => raise.mutate()} data-testid="raise-cloud-limit">
                  Raise today's limit to {dollars(spend.raiseToUsd)}
                </Button>
              ) : (
                <Button variant="subtle" onClick={settings}>
                  Change the monthly limit
                </Button>
              )}
            </div>
          </div>
        )}
        {spend.state === "warning" && (
          <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-100">
            <p>Near the limit. At it, new boxes wait until midnight; work already running goes on.</p>
            {spend.raiseToUsd !== null && (
              <Button className="mt-2" variant="subtle" loading={raise.isPending} onClick={() => raise.mutate()} data-testid="raise-cloud-limit">
                Raise today's limit to {dollars(spend.raiseToUsd)}
              </Button>
            )}
          </div>
        )}

        {s.fanout.wanted > 0 && (
          <div role="status" data-testid="cloud-fanout" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-100">
            <p>
              <span className="font-semibold">{newBoxes(s.fanout.wanted)} wait for your OK:</span> the queue wants more than the {s.fanout.freePerHour} an hour Box
              Yard makes without asking. Up to {perHour(s.fanout.upToHourlyUsd)} if every core is busy.
            </p>
            <Button className="mt-2" variant="primary" loading={allow.isPending} onClick={() => allow.mutate()} data-testid="allow-more-boxes">
              Allow them for an hour
            </Button>
          </div>
        )}

        <section aria-label="Now">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-zinc-300">Now</span>
            <span className="text-zinc-400 tabular-nums">{perHour(s.hourlyUsd)}</span>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            {countsLine(s.boxes)} · up to {s.ceiling} boxes at once (a safety stop)
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            {s.fanout.allowedUntil
              ? `More than ${s.fanout.freePerHour} new boxes an hour allowed until ${new Date(s.fanout.allowedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
              : `Up to ${s.fanout.freePerHour} new boxes an hour without asking`}
          </p>
          {s.gpu && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-zinc-400 tabular-nums">
              <Cpu className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
              RunPod: {s.gpu.pods === 1 ? "1 pod" : `${s.gpu.pods} pods`} · {perHour(s.gpu.hourlyUsd)}
              {s.gpu.capUsd > 0 ? ` of its ${perHour(s.gpu.capUsd)} cap` : ""}
            </p>
          )}
          {s.vast && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-zinc-400 tabular-nums">
              <Cpu className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
              Vast.ai: {s.vast.pods === 1 ? "1 instance" : `${s.vast.pods} instances`} · {perHour(s.vast.hourlyUsd)}
              {s.vast.capUsd > 0 ? ` of its ${perHour(s.vast.capUsd)} cap` : ""}
            </p>
          )}
        </section>

        <section aria-label="Boxes">
          {s.list.length === 0 ? (
            <p className="text-xs text-zinc-500">No boxes right now. One starts when a task needs it.</p>
          ) : (
            <ul className="divide-y divide-zinc-900 rounded-lg border border-zinc-900">
              {s.list.map((b) => {
                const state = boxState(b, now)
                return (
                  <li key={b.id} data-testid="cloud-box" className="flex items-start gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <Link href={`/boxes#${encodeURIComponent(b.id)}`} onClick={onClose} className="min-w-0 truncate font-mono text-xs text-yard-300 hover:underline">
                          {b.id}
                        </Link>
                        <span className="shrink-0 text-xs text-zinc-500">{b.size}</span>
                      </div>
                      <div
                        className={cx(
                          "mt-0.5 text-xs",
                          state.tone === "busy" ? "text-emerald-300" : state.tone === "held" ? "text-amber-200" : "text-zinc-500",
                        )}
                      >
                        {state.text}
                      </div>
                      {b.projects.length > 0 && <div className="mt-0.5 truncate text-xs text-zinc-500">{b.projects.join(", ")}</div>}
                    </div>
                    <div className="shrink-0 text-right text-xs text-zinc-400 tabular-nums" title={`${dollars(b.totalUsd)} since it was made`}>
                      {dollars(b.todayUsd)}
                      <div className="text-zinc-600">today</div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  )
}

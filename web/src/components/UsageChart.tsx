// Spend over time on the Usage page: stacked columns by category, inline SVG (no chart library).
import { useEffect, useRef, useState } from "react"
import { CATEGORY_META, axisMoney, money, niceTicks } from "../lib/usage"
import { USAGE_CATEGORIES, type UsageBucket, type UsageCategory } from "../../../shared/types"

const PLOT_H = 180
const AXIS_W = 48
const LABEL_H = 22
const GAP = 2

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

/** A column segment with 4px rounded top corners (the data end), square at the bottom. */
function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

const TIP_W = 208

/** Beside the hovered band so it never covers the column: right of it if it fits, else left, else clamped. */
function tooltipLeft(x: number, band: number, width: number) {
  if (x + band + 8 + TIP_W <= width) return x + band + 8
  if (x - 8 - TIP_W >= 0) return x - 8 - TIP_W
  return Math.max(0, Math.min(x + band / 2 - TIP_W / 2, width - TIP_W))
}

const total = (b: UsageBucket) => USAGE_CATEGORIES.reduce((a, c) => a + b.costs[c], 0)

function bucketLabel(t: number, bucketMs: number, long = false) {
  const d = new Date(t)
  if (bucketMs < 24 * 3_600_000) {
    const hour = d.toLocaleTimeString(undefined, { hour: "numeric" })
    return long ? `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${hour}` : hour
  }
  return d.toLocaleDateString(undefined, long ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" })
}

export function UsageChart({ buckets, bucketMs, categories }: { buckets: UsageBucket[]; bucketMs: number; categories: UsageCategory[] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(0, ...buckets.map(total))
  const ticks = niceTicks(max)
  const top = ticks.at(-1)!
  const plotW = Math.max(0, width - AXIS_W)
  const n = Math.max(1, buckets.length)
  const band = plotW / n
  const barW = Math.max(2, Math.min(24, band - Math.max(2, band * 0.3)))
  const y = (v: number) => PLOT_H - (v / top) * PLOT_H
  const stride = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 64))))
  const hovered = hover !== null ? buckets[hover] : null

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={PLOT_H + LABEL_H + 8} role="img" aria-label="Spend over time by category" className="block overflow-visible">
          <g transform="translate(0,4)">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={AXIS_W} x2={width} y1={y(t)} y2={y(t)} className="stroke-zinc-800" strokeWidth={1} shapeRendering="crispEdges" />
                <text x={AXIS_W - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-zinc-500 text-[11px] tabular-nums">
                  {axisMoney(t)}
                </text>
              </g>
            ))}
            {buckets.map((b, i) => {
              const x = AXIS_W + i * band + (band - barW) / 2
              let acc = 0
              const segs = categories
                .filter((c) => b.costs[c] > 0)
                .map((c, k, list) => {
                  const h = (b.costs[c] / top) * PLOT_H
                  const y0 = PLOT_H - acc - h
                  acc += h
                  // A 2px surface gap under every segment but the first; a sliver still shows as 1px.
                  const gap = k > 0 ? GAP : 0
                  const hh = Math.max(h > 0 ? 1 : 0, h - gap)
                  const isTop = k === list.length - 1
                  return isTop ? (
                    <path key={c} d={topRounded(x, y0, barW, hh, 4)} fill={CATEGORY_META[c].color} />
                  ) : (
                    <rect key={c} x={x} y={y0} width={barW} height={hh} fill={CATEGORY_META[c].color} />
                  )
                })
              return (
                <g key={b.start}>
                  {hover === i && <rect x={AXIS_W + i * band} y={0} width={band} height={PLOT_H} className="fill-zinc-800/40" />}
                  {segs}
                  {/* Hit target: the whole band, focusable so the tooltip works from the keyboard. */}
                  <rect
                    x={AXIS_W + i * band}
                    y={0}
                    width={band}
                    height={PLOT_H + LABEL_H}
                    fill="transparent"
                    tabIndex={0}
                    aria-label={`${bucketLabel(b.start, bucketMs, true)}: ${money(total(b))}`}
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    className="outline-none"
                  />
                </g>
              )
            })}
            <line x1={AXIS_W} x2={width} y1={PLOT_H} y2={PLOT_H} className="stroke-zinc-700" strokeWidth={1} shapeRendering="crispEdges" />
            {buckets.map((b, i) =>
              i % stride === 0 ? (
                <text key={b.start} x={AXIS_W + i * band + band / 2} y={PLOT_H + 16} textAnchor="middle" className="fill-zinc-500 text-[11px]">
                  {bucketLabel(b.start, bucketMs)}
                </text>
              ) : null,
            )}
          </g>
        </svg>
      )}
      {hovered && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-52 rounded-lg border border-zinc-700 bg-zinc-900/95 p-3 text-xs shadow-xl backdrop-blur"
          style={{ left: tooltipLeft(AXIS_W + hover * band, band, width) }}
        >
          <div className="text-zinc-400">{bucketLabel(hovered.start, bucketMs, true)}</div>
          <div className="mt-0.5 text-sm font-semibold text-zinc-50 tabular-nums">{money(total(hovered))}</div>
          <ul className="mt-2 space-y-1">
            {[...categories].reverse().map((c) => (
              <li key={c} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: CATEGORY_META[c].color }} />
                <span className="flex-1 text-zinc-300">{CATEGORY_META[c].label}</span>
                <span className="text-zinc-200 tabular-nums">{money(hovered.costs[c])}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

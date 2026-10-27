// A hidden check for "the app froze and nothing takes a tap" on phones, where there's no console: hold two
// fingers still on the screen for a second and a toast says what is on top under them, and how long the main
// thread was last blocked. If no toast comes at all, the page's script is stuck (a busy main thread); if one
// names something unexpected, that element is catching the taps. Also callable from Web Inspector as
// `__boxyardTapDebug()`.
import { toast } from "./toast"

/** How long two fingers rest before the report shows. */
export const HOLD_MS = 1000
/** Fingers that move further than this are a pinch or a scroll, not the gesture. */
const SLOP_PX = 24
/** A gap at least this long between heartbeats while the page was visible is a stall worth reporting. */
export const STALL_MS = 1000
const HEARTBEAT_MS = 250
/** Stalls are remembered this long. */
const STALL_WINDOW_MS = 10 * 60_000

type Stall = { at: number; ms: number }
const stalls: Stall[] = []

/** `tag#id.class.class [fixed z50 pe:none]` for one element. */
export function describeElement(el: Element | null): string {
  if (!el) return "nothing"
  const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean).slice(0, 3) : []
  const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls.map((c) => `.${c}`).join("")}`
  const label = el.getAttribute("aria-label") || el.getAttribute("role")
  const s = getComputedStyle(el)
  const flags = [s.position !== "static" ? s.position : "", s.zIndex !== "auto" ? `z${s.zIndex}` : "", s.pointerEvents === "none" ? "pe:none" : ""].filter(Boolean)
  return `${name}${label ? ` "${label}"` : ""}${flags.length ? ` [${flags.join(" ")}]` : ""}`
}

/** The element under (x, y) and up to two of its positioned ancestors: what would take a tap there. */
export function describePoint(x: number, y: number): string {
  const top = document.elementFromPoint(x, y)
  const chain = [describeElement(top)]
  for (let el = top?.parentElement ?? null; el && chain.length < 3; el = el.parentElement) {
    if (getComputedStyle(el).position !== "static") chain.push(describeElement(el))
  }
  return `(${Math.round(x)},${Math.round(y)}) ${chain.join(" < ")}`
}

/** Everything the report says, as lines. */
export function tapReport(points: { x: number; y: number }[]): string[] {
  const now = Date.now()
  const recent = stalls.filter((s) => now - s.at < STALL_WINDOW_MS)
  const worst = recent.reduce((m, s) => Math.max(m, s.ms), 0)
  const vv = window.visualViewport
  const scrolled = [document.scrollingElement?.scrollTop, document.body.scrollTop, window.scrollY].some(Boolean)
  return [
    ...points.map((p) => describePoint(p.x, p.y)),
    `dialogs: ${document.querySelectorAll('[role="dialog"]').length}, body: "${document.body.className}"${scrolled ? ", document scrolled" : ""}`,
    `viewport ${window.innerWidth}×${window.innerHeight}${vv ? `, visual ${Math.round(vv.width)}×${Math.round(vv.height)} at ${Math.round(vv.offsetTop)}` : ""}, ${document.getElementsByTagName("*").length} elements`,
    recent.length ? `main thread blocked ${recent.length}× in 10 min, longest ${(worst / 1000).toFixed(1)} s` : "main thread: no stalls in 10 min",
  ]
}

function report(points: { x: number; y: number }[]) {
  const lines = tapReport(points)
  console.info("[box-yard] tap debug\n" + lines.join("\n"))
  // An error toast: the only kind Zen shows.
  toast.error("Tap debug", lines.join(" · "), { duration: 20_000 })
}

/** Mounted once (main.tsx). Returns an uninstall. */
export function installTapDebug(): () => void {
  if (typeof window === "undefined") return () => {}
  let last = performance.now()
  const beat = setInterval(() => {
    const now = performance.now()
    // Timers stop while the page is hidden; only a gap the user could see counts.
    if (now - last >= STALL_MS && !document.hidden) {
      stalls.push({ at: Date.now(), ms: Math.round(now - last) })
      if (stalls.length > 50) stalls.shift()
    }
    last = now
  }, HEARTBEAT_MS)
  const onVisible = () => (last = performance.now())
  document.addEventListener("visibilitychange", onVisible)

  let hold: { timer: ReturnType<typeof setTimeout>; points: { x: number; y: number }[] } | null = null
  const cancel = () => {
    if (hold) clearTimeout(hold.timer)
    hold = null
  }
  const onStart = (e: TouchEvent) => {
    cancel()
    if (e.touches.length !== 2) return
    const points = [...e.touches].map((t) => ({ x: t.clientX, y: t.clientY }))
    hold = { points, timer: setTimeout(() => (hold = null, report(points)), HOLD_MS) }
  }
  const onMove = (e: TouchEvent) => {
    if (!hold) return
    const moved = [...e.touches].some((t, i) => {
      const p = hold!.points[i]
      return !p || Math.hypot(t.clientX - p.x, t.clientY - p.y) > SLOP_PX
    })
    if (moved) cancel()
  }
  const opts = { capture: true, passive: true } as const
  window.addEventListener("touchstart", onStart, opts)
  window.addEventListener("touchmove", onMove, opts)
  window.addEventListener("touchend", cancel, opts)
  window.addEventListener("touchcancel", cancel, opts)
  ;(window as { __boxyardTapDebug?: () => string[] }).__boxyardTapDebug = () => tapReport([{ x: innerWidth / 2, y: innerHeight / 2 }])
  return () => {
    cancel()
    clearInterval(beat)
    document.removeEventListener("visibilitychange", onVisible)
    window.removeEventListener("touchstart", onStart, opts)
    window.removeEventListener("touchmove", onMove, opts)
    window.removeEventListener("touchend", cancel, opts)
    window.removeEventListener("touchcancel", cancel, opts)
  }
}

/** Tests only. */
export const recordStall = (ms: number, at = Date.now()) => stalls.push({ at, ms })
export const clearStalls = () => void stalls.splice(0)

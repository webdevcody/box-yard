import { describe, expect, it } from "vitest"
import { WakeLoopGuard } from "../server/loopGuard.js"

const opts = { maxRepeats: 2, windowMs: 60_000, throttleMs: 1000, maxThrottleMs: 4000 }

function guard() {
  let now = 0
  const g = new WakeLoopGuard(opts, () => now)
  return { g, tick: (ms: number) => (now += ms), at: () => now }
}

/** What the Captain does with one wake: check, and record the batch when it runs. */
function wake(g: WakeLoopGuard, batch: string[]) {
  const d = g.check(batch)
  if (d.wake) g.record(batch)
  return d
}

describe("Captain wake loop guard", () => {
  it("never throttles wake-ups that each bring new events", () => {
    const { g, tick } = guard()
    for (let i = 0; i < 50; i++) {
      expect(wake(g, [`✅ **Task ${i}** is done: result ${i}`])).toEqual({ wake: true })
      tick(10)
    }
    expect(g.throttledUntil).toBeNull()
  })

  it("throttles the same events re-waking the Captain, once, and backs off", () => {
    const { g, tick, at } = guard()
    const loop = ["❌ **Build** failed: exit 1"]
    expect(wake(g, loop).wake).toBe(true)
    expect(wake(g, loop).wake).toBe(true)
    const first = wake(g, loop)
    expect(first).toEqual({ wake: false, until: at() + 1000, started: true })
    // Still looping while throttled: held, but not reported again.
    expect(wake(g, [...loop, ...loop])).toEqual({ wake: false, until: at() + 1000, started: false })
    // When the throttle ends, the queued batch goes out.
    tick(1000)
    expect(wake(g, [...loop, ...loop]).wake).toBe(true)
    // The loop goes on: the next throttle is twice as long, then capped.
    expect(wake(g, loop)).toEqual({ wake: false, until: at() + 2000, started: true })
    tick(2000)
    expect(wake(g, loop).wake).toBe(true)
    expect(wake(g, loop)).toEqual({ wake: false, until: at() + 4000, started: true })
    tick(4000)
    expect(wake(g, loop).wake).toBe(true)
    expect(wake(g, loop)).toEqual({ wake: false, until: at() + 4000, started: true })
  })

  it("lets a batch with any new event through at once, queued repeats included", () => {
    const { g } = guard()
    const loop = ["❌ **Build** failed: exit 1"]
    wake(g, loop)
    wake(g, loop)
    expect(wake(g, loop).wake).toBe(false)
    expect(wake(g, [...loop, "✅ **Docs** is done: updated"])).toEqual({ wake: true })
    expect(g.throttledUntil).toBeNull()
  })

  it("treats whitespace and case changes as the same event", () => {
    const { g } = guard()
    wake(g, ["Task  X failed"])
    wake(g, ["task x failed "])
    expect(wake(g, ["TASK X\nFAILED"]).wake).toBe(false)
  })

  it("forgets events outside the window", () => {
    const { g, tick } = guard()
    const loop = ["💬 **Poller** finished its turn: (no reply)"]
    wake(g, loop)
    wake(g, loop)
    tick(60_001)
    expect(wake(g, loop).wake).toBe(true)
  })

  it("reset() lifts the throttle when Cody or the Coordinator steps in", () => {
    const { g } = guard()
    const loop = ["❌ **Build** failed: exit 1"]
    wake(g, loop)
    wake(g, loop)
    expect(wake(g, loop).wake).toBe(false)
    g.reset()
    expect(g.throttledUntil).toBeNull()
    // The history stays, so a loop that carries on is caught again.
    expect(wake(g, loop)).toMatchObject({ wake: false, started: true })
  })
})

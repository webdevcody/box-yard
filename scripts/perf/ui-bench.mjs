#!/usr/bin/env node
// UI performance bench against the heavy mock yard.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/heavy node dist/server/server/index.js &
//   npm i --no-save playwright && npx playwright install chromium   (or PLAYWRIGHT_MODULE=/path/to/playwright)
//   node scripts/perf/ui-bench.mjs http://localhost:4001 [label]
//
// Measures, on the heavy fixture: initial load (TTI-ish, total blocking time), keystroke-to-paint latency and
// React component renders per keystroke in both composers, scroll FPS of the chat and task thread, and the
// main-thread cost of SSE updates (via POST /api/dev/pulse). Prints JSON.
// Renders are counted with a stand-in React DevTools hook: a component counts when it performed work in a commit.

const base = process.argv[2] ?? "http://localhost:4001"
const label = process.argv[3] ?? "run"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const HOOK = () => {
  const stats = { commits: 0, rendered: 0, byName: {} }
  window.__perf = stats
  const COMPONENT_TAGS = new Set([0, 1, 11, 15])
  const name = (f) => {
    const t = f.type
    return (t && (t.displayName || t.name)) || (t && t.render && (t.render.displayName || t.render.name)) || "anon"
  }
  const visit = (fiber, mounting) => {
    for (let f = fiber; f; f = f.sibling) {
      const alt = f.alternate
      const mount = mounting || !alt
      if (COMPONENT_TAGS.has(f.tag) && (mount || (f.flags & 1) === 1)) {
        stats.rendered++
        const n = name(f)
        stats.byName[n] = (stats.byName[n] ?? 0) + 1
      }
      // Untouched subtree: the child pointer was not replaced in this commit.
      if (f.child && (mount || f.child !== alt.child)) visit(f.child, mount)
    }
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) {
      this.renderers.set(1, renderer)
      return 1
    },
    onCommitFiberRoot(_id, root) {
      stats.commits++
      const cur = root.current
      visit(cur.child, !cur.alternate)
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  }
  // Event Timing: the browser's own input-to-next-paint durations.
  window.__events = []
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (["keydown", "keypress", "input", "keyup"].includes(e.name)) window.__events.push({ name: e.name, duration: e.duration })
    }).observe({ type: "event", durationThreshold: 16, buffered: true })
  } catch {}
  window.__longtasks = []
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longtasks.push({ start: e.startTime, duration: e.duration })
    }).observe({ type: "longtask", buffered: true })
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const r1 = (n) => Math.round(n * 10) / 10

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
await context.addInitScript(HOOK)
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
await cdp.send("Performance.enable")
const metric = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics")
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
  return { task: m.TaskDuration * 1000, script: m.ScriptDuration * 1000, layout: m.LayoutDuration * 1000, style: m.RecalcStyleDuration * 1000, nodes: m.Nodes }
}
const diff = (a, b) => ({ task: b.task - a.task, script: b.script - a.script, layout: b.layout - a.layout, style: b.style - a.style })
const resetStats = () =>
  page.evaluate(() => {
    window.__perf.commits = 0
    window.__perf.rendered = 0
    window.__perf.byName = {}
    window.__events = []
    window.__longtasks = []
  })
const stats = () => page.evaluate(() => ({ ...window.__perf, events: window.__events, longtasks: window.__longtasks }))
const topNames = (byName, n = 8) =>
  Object.entries(byName)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}×${v}`)
    .join(", ")

async function load(path) {
  await page.goto("about:blank")
  const t0 = Date.now()
  await page.goto(base + path, { waitUntil: "load" })
  await page.waitForSelector("textarea")
  await sleep(2500)
  const s = await stats()
  const lt = s.longtasks
  const tti = lt.length ? Math.max(...lt.map((t) => t.start + t.duration)) : 0
  const tbt = lt.reduce((n, t) => n + Math.max(0, t.duration - 50), 0)
  const longest = lt.length ? Math.max(...lt.map((t) => t.duration)) : 0
  const dom = await page.evaluate(() => document.getElementsByTagName("*").length)
  return { path, wallMs: Date.now() - t0 - 2500, ttiMs: r1(tti), tbtMs: r1(tbt), longestTaskMs: r1(longest), domElements: dom, rendered: s.rendered }
}

/** Type a sentence into the n-th textarea (0 = first on the page), one key at a time. */
async function typing(selector, text) {
  await page.click(selector)
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    window.__lat = []
    window.__onKey = (e) => {
      const t0 = e.timeStamp
      requestAnimationFrame(() => {
        const ch = new MessageChannel()
        ch.port1.onmessage = () => window.__lat.push(performance.now() - t0)
        ch.port2.postMessage(0)
      })
    }
    el.addEventListener("keydown", window.__onKey, true)
  }, selector)
  await sleep(300)
  await resetStats()
  const before = await metric()
  for (const ch of text) {
    await page.keyboard.type(ch)
    await sleep(40)
  }
  await sleep(300)
  const after = await metric()
  const s = await stats()
  const lat = await page.evaluate(() => window.__lat)
  const evMax = s.events.length ? Math.max(...s.events.map((e) => e.duration)) : 0
  // Clear the box again.
  await page.keyboard.press("Control+A")
  await page.keyboard.press("Backspace")
  const d = diff(before, after)
  return {
    keys: text.length,
    latencyMedianMs: r1(pct(lat, 50)),
    latencyP95Ms: r1(pct(lat, 95)),
    latencyMaxMs: r1(Math.max(...lat)),
    eventTimingOver16: s.events.length,
    eventTimingMaxMs: r1(evMax),
    mainThreadPerKeyMs: r1(d.task / text.length),
    scriptPerKeyMs: r1(d.script / text.length),
    commitsPerKey: r1(s.commits / text.length),
    componentRendersPerKey: r1(s.rendered / text.length),
    topRendered: topNames(s.byName),
  }
}

/** Scroll a list from the bottom towards the top, a fixed distance per frame, and measure frame rate. */
async function scroll(selector, frames = 150, step = 120) {
  await resetStats()
  const before = await metric()
  const res = await page.evaluate(
    ({ selector, frames, step }) =>
      new Promise((resolve) => {
        const el = document.querySelectorAll(selector)[0]
        el.scrollTop = el.scrollHeight
        const times = []
        let i = 0
        const tick = (t) => {
          times.push(t)
          el.scrollTop -= step
          if (++i < frames) requestAnimationFrame(tick)
          else resolve(times)
        }
        requestAnimationFrame(tick)
      }),
    { selector, frames, step },
  )
  const after = await metric()
  const gaps = res.slice(1).map((t, i) => t - res[i])
  const elapsed = res[res.length - 1] - res[0]
  const s = await stats()
  return {
    fps: r1(((res.length - 1) / elapsed) * 1000),
    frameP95Ms: r1(pct(gaps, 95)),
    frameMaxMs: r1(Math.max(...gaps)),
    framesOver33Ms: gaps.filter((g) => g > 33.4).length,
    mainThreadMs: r1(diff(before, after).task),
    componentRenders: s.rendered,
  }
}

async function pulse(kind, count) {
  await sleep(500)
  await resetStats()
  const before = await metric()
  await page.evaluate(
    ({ kind, count }) => fetch("/api/dev/pulse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, count, intervalMs: 50 }) }),
    { kind, count },
  )
  await sleep(count * 50 + 1200)
  const after = await metric()
  const s = await stats()
  const d = diff(before, after)
  return {
    kind,
    events: count,
    mainThreadPerEventMs: r1(d.task / count),
    scriptPerEventMs: r1(d.script / count),
    commitsPerEvent: r1(s.commits / count),
    componentRendersPerEvent: r1(s.rendered / count),
    topRendered: topNames(s.byName, 5),
  }
}

const out = { label, at: new Date().toISOString() }
const SENTENCE = "the quick brown fox jumps over the lazy dog"
const CHAT_BOX = "section textarea"
const TASK_BOX = "main textarea"
const CHAT_SCROLLER = "section .overflow-y-auto"
const TASK_SCROLLER = "main .overflow-y-auto .overflow-y-auto"

out.loadHome = await load("/")
out.typeChatOnHome = await typing(CHAT_BOX, SENTENCE)
out.scrollChat = await scroll(CHAT_SCROLLER)
out.pulseTaskOnHome = await pulse("task", 20)
out.pulseChatDelta = await pulse("chat.delta", 40)
out.pulseChatMessage = await pulse("chat.message", 10)

out.loadTask = await load("/tasks/task_heavy-thread")
out.typeTaskComposer = await typing(TASK_BOX, SENTENCE)
out.typeChatOnTask = await typing(CHAT_BOX, SENTENCE)
out.scrollTask = await scroll(TASK_SCROLLER)
out.pulseTaskMessage = await pulse("task.message", 20)
out.pulseTaskOnTask = await pulse("task", 20)

console.log(JSON.stringify(out, null, 2))
await browser.close()

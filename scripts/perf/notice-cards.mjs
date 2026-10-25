#!/usr/bin/env node
// Browser check: notice cards in a narrow Coordinator panel give the task title the full card width, put the meta
// line (project · Captain, the event) under it, and keep the published files' Show all / Hide toggle on the file
// list's header, not by the title. Checks the panel at 320, 400 and 560 px, 320 px at 125% zoom, and Zen at 800 px.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_DATA_DIR=/tmp/cards node dist/server/server/index.js &
//   npm i --no-save playwright && npx playwright install chromium   (or PLAYWRIGHT_MODULE=/path/to/playwright-core)
//   node scripts/perf/notice-cards.mjs http://localhost:4001 [shots dir]
//
// It creates a project and a long-titled task through the API, then serves the Coordinator chat (/api/chat) one
// notice of every kind about that task. Prints one line per check and exits 1 on a miss. With a shots dir, saves
// <layout>.png.

const [base = "http://localhost:4001", shots] = process.argv.slice(2)
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const launch = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}

const api = async (path, body) => {
  const res = await fetch(base + "/api" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}
const TITLE = "Research and design: RunPod GPU machines as a Box Yard runner"
const projects = await api("/projects")
const project = projects.find((p) => p.name === "notice-cards") ?? (await api("/projects", { id: "prj_noticecards", name: "notice-cards", repo: "webdevcody/box-yard" }))
const tasks = await api("/tasks")
const task = tasks.find((t) => t.title === TITLE) ?? (await api("/tasks", { projectId: project.id, title: TITLE, prompt: "Look at notice cards." }))

const PR = "https://github.com/webdevcody/box-yard/pull/132"
const file = (n) => `${base}/artifacts/art_cards0000${n}/shot-${n}.png`
const NOTICES = [
  `🔀 **${TITLE}** opened a pull request: ${PR}`,
  `✅ **${TITLE}** is done: Wrote the design and ran the game on a GPU pod.`,
  `📎 **${TITLE}** published Survive the Night in-game on a RunPod RTX A5000 pod (headless Chrome, GPU WebGL): ${file(1)}`,
  `📎 **${TITLE}** published Survive the Night menu on a RunPod RTX A5000 pod: ${file(2)}`,
  `❌ **${TITLE}** failed: Claude exited with code 1.`,
  `🙋 **${TITLE}** needs you: Which GPU should the default be?`,
  `🚢 Cody asked **${TITLE}** to merge PR #132 (Merge button): ${PR}`,
  `🪝 **${TITLE}** hook "box-yard: auto-merge ready PRs" (PR ready) sent to the agent: Please merge PR #132.`,
  `💬 **${TITLE}** says: The pod is up.`,
].map((content, i) => ({ id: `chat_cards${String(i).padStart(4, "0")}`, role: "notice", content, meta: { taskId: task.id, projectId: project.id }, createdAt: Date.now() - (20 - i) * 60_000 }))

const LAYOUTS = [
  { name: "panel-320", viewport: { width: 1700, height: 1600 }, chat: 320 },
  { name: "panel-400", viewport: { width: 1700, height: 1600 }, chat: 400 },
  { name: "panel-560", viewport: { width: 1700, height: 1600 }, chat: 560 },
  // Browser zoom shrinks the CSS viewport: 125% on a 1440 px laptop is 1152 px.
  { name: "panel-320 @125%", viewport: { width: 1152, height: 1300 }, scale: 1.25, chat: 320 },
  { name: "zen-800", viewport: { width: 800, height: 1600 }, path: "/zen" },
]

let misses = 0
const check = (ok, what) => {
  if (!ok) misses++
  console.log(`${ok ? "ok  " : "MISS"} ${what}`)
}

const browser = await pw.chromium.launch(launch)
for (const l of LAYOUTS) {
  const ctx = await browser.newContext({ viewport: l.viewport, deviceScaleFactor: l.scale ?? 1 })
  const page = await ctx.newPage()
  await page.addInitScript((w) => {
    if (w) localStorage.setItem("box-yard:chat-width", String(w))
    // A first visit to / may open in Zen; a tab that has landed stays where it is.
    sessionStorage.setItem("box-yard:landed", "1")
  }, l.chat ?? null)
  await page.route("**/api/chat", (r) => (r.request().method() === "GET" ? r.fulfill({ json: NOTICES }) : r.continue()))
  await page.route("**/artifacts/**", (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="40"><rect width="64" height="40" fill="#345"/></svg>' }))
  await page.goto(base + (l.path ?? "/tasks"))
  const scope = l.chat ? "[data-docked]" : "body"
  await page.locator(`${scope} [data-testid="published-group"]`).first().waitFor()
  const r = await page.evaluate((scope) => {
    const root = document.querySelector(scope)
    const cards = [...root.querySelectorAll('[data-testid="notice-body"]')].map((body) => {
      const title = body.querySelector(':scope > [data-testid="notice-title"]')
      const link = title?.querySelector("a")
      const meta = body.querySelector(':scope > [data-testid="notice-meta"]')
      const words = (link?.textContent ?? "").split(/\s+/).filter(Boolean).length
      const lines = link ? new Set([...link.getClientRects()].map((x) => Math.round(x.top))).size : 0
      return {
        content: body.getBoundingClientRect().width,
        link: link?.getBoundingClientRect().width ?? 0,
        alone: title ? title.children.length === 1 && !title.querySelector("button") : false,
        below: title && meta ? meta.getBoundingClientRect().top >= title.getBoundingClientRect().bottom - 1 : false,
        words,
        lines,
      }
    })
    const toggles = [...root.querySelectorAll('[data-testid="published-group"] button[aria-expanded]')].map((b) => ({
      inHeader: Boolean(b.closest('[data-testid="published-files-header"]')),
      byTitle: Boolean(b.closest('[data-testid="notice-title"]')),
      belowTitle: b.getBoundingClientRect().top >= b.closest('[data-testid="notice-body"]').querySelector('[data-testid="notice-title"]').getBoundingClientRect().bottom,
    }))
    return { cards, toggles }
  }, scope)
  check(r.cards.length === NOTICES.length - 1, `${l.name}: ${r.cards.length} cards (the two published files fold into one)`)
  r.cards.forEach((c, i) => {
    // A title that wraps fills the row; one that fits on a line is shorter, which is fine.
    if (c.lines > 1) check(c.link >= 0.9 * c.content, `${l.name} card ${i}: title ${Math.round(c.link)}px of ${Math.round(c.content)}px`)
    check(c.alone && c.below, `${l.name} card ${i}: the title row holds only the title, and the meta line is under it`)
    check(c.lines <= Math.ceil(c.words / 2), `${l.name} card ${i}: the title wraps like a sentence (${c.words} words on ${c.lines} lines)`)
  })
  check(r.toggles.length > 0 && r.toggles.every((t) => t.inHeader && !t.byTitle && t.belowTitle), `${l.name}: Show all / Hide is in the file list's header, under the title`)
  // Open the list: Hide stays in the header, right above the files it hides.
  const toggle = page.locator(`${scope} [data-testid="published-files-header"] button[aria-expanded]`).first()
  await toggle.evaluate((b) => b.click())
  const open = await toggle.evaluate((b) => {
    const list = document.getElementById(b.getAttribute("aria-controls"))
    return { text: b.textContent, next: list?.previousElementSibling === b.closest('[data-testid="published-files-header"]') }
  })
  check(open.text.includes("Hide") && open.next, `${l.name}: Hide sits on the header right above the file list it hides`)
  if (shots) await page.locator(scope).screenshot({ path: `${shots}/${l.name.replace(/\W+/g, "-")}.png` })
  await ctx.close()
}
await browser.close()
console.log(misses ? `${misses} miss(es)` : "all checks passed")
process.exit(misses ? 1 : 0)

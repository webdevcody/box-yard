#!/usr/bin/env node
// Browser check: the Coordinator panel stays docked and resizable at 100% and 125% zoom, and nothing covers a
// composer's Send button whether the panel is docked or a closed drawer.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_DATA_DIR=/tmp/dock node dist/server/server/index.js &
//   (seed a project and a task through POST /api/projects and POST /api/tasks)
//   npm i --no-save playwright && npx playwright install chromium   (or PLAYWRIGHT_MODULE=/path/to/playwright-core)
//   node scripts/perf/coordinator-dock.mjs http://localhost:4001 <projectId> <taskId> [shots dir]
//
// Browser zoom shrinks the CSS viewport, so 125% on a 1440 or 1512 px laptop is a 1152 or 1210 px viewport.
// Where the panel docks: the separator is there, dragging it changes the width, and a reload keeps the width.
// Where it's a drawer: no separator. Everywhere: elementFromPoint at each visible Send button's center is that
// button. Prints one line per check and exits 1 on a miss. With a shots dir, saves <viewport>.png.

const [base = "http://localhost:4001", projectId, taskId, shots] = process.argv.slice(2)
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const launch = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}

const VIEWPORTS = [
  { name: "1440 @100%", width: 1440, height: 900, docked: true },
  { name: "1512 @125%", width: 1210, height: 786, docked: true },
  { name: "1440 @125%", width: 1152, height: 720, docked: true },
  { name: "1100 @100%", width: 1100, height: 760, docked: false },
  { name: "phone", width: 390, height: 844, docked: false },
]
const PAGES = { captain: `/projects/${projectId}?tab=captain`, task: `/tasks/${taskId}`, project: `/projects/${projectId}`, yard: "/", zen: "/zen" }
const HANDLE = "[data-docked] [role=separator]"
const panelWidth = (page) => page.evaluate(() => document.querySelector("[data-docked]")?.getBoundingClientRect().width ?? null)

let misses = 0
const check = (ok, what) => {
  if (!ok) misses++
  console.log(`${ok ? "ok  " : "MISS"} ${what}`)
}

const browser = await pw.chromium.launch(launch)
for (const v of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height } })
  const page = await ctx.newPage()
  await page.goto(base + PAGES.captain)
  await page.waitForSelector("[data-testid=chat-panel]")
  const handles = await page.locator(HANDLE).count()
  check(handles === (v.docked ? 1 : 0), `${v.name}: panel ${v.docked ? "docked with a resize handle" : "is a drawer"}`)

  if (v.docked) {
    const before = await panelWidth(page)
    const box = await page.locator(HANDLE).boundingBox()
    // The handle is on the panel's left edge: drag right to shrink (always possible above the 320 px min), else left.
    const dx = before >= 330 ? 40 : -40
    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx / 2, box.y + 200)
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + 200)
    await page.mouse.up()
    const after = await panelWidth(page)
    check(after !== before, `${v.name}: dragging resizes the panel (${before} → ${after}px)`)
    await page.reload()
    await page.waitForSelector(HANDLE)
    const reloaded = await panelWidth(page)
    check(reloaded === after, `${v.name}: the width survives a reload (${reloaded}px)`)
  }

  for (const [name, path] of Object.entries(PAGES)) {
    await page.goto(base + path)
    await page.waitForSelector("[data-testid=chat-panel]")
    await page.waitForTimeout(400)
    const hits = await page.evaluate(() =>
      [...document.querySelectorAll('button[aria-label="Send"]')]
        .map((b) => [b, b.getBoundingClientRect()])
        .filter(([, r]) => r.width && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight)
        .map(([b, r]) => {
          const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          return b === el || b.contains(el) ? "" : (el?.outerHTML.slice(0, 80) ?? "nothing")
        }),
    )
    for (const covered of hits) check(!covered, `${v.name} ${name}: Send is clickable${covered ? `, covered by ${covered}` : ""}`)
    if (shots && name === "captain") await page.screenshot({ path: `${shots}/${v.width}.png` })
  }
  await ctx.close()
}
await browser.close()
console.log(misses ? `${misses} misses` : "all checks passed")
process.exit(misses ? 1 : 0)

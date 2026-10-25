#!/usr/bin/env node
// Browser check: the Coordinator chat comes back where it was after following a link and pressing Back.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/heavy node dist/server/server/index.js &
//   npm i --no-save playwright && npx playwright install chromium webkit   (or PLAYWRIGHT_MODULE=/path/to/playwright)
//   node scripts/perf/scroll-restore.mjs http://localhost:4001 [chromium,webkit] [shots dir]
//
// For each browser, on the desktop Yard (chat beside the page) and in Zen (wide column, desktop and phone): scroll
// the chat up, click a task or project link in it, go Back, and check the row that was at the top of the view is
// within 3px of where it was. WebKit matters most: it clamps Zen's shorter list to its bottom on the way back.
// Prints JSON and exits 1 on a miss. With a shots dir, saves <browser>-<mode>-{before,after}.png.

const base = process.argv[2] ?? "http://localhost:4001"
const browsers = (process.argv[3] ?? "chromium,webkit").split(",")
const shots = process.argv[4]
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const SCROLLER = "[data-testid=chat-panel] .overflow-y-auto"
// Task and project links in replies, and notice cards (role=link).
const LINK = 'a[href^="/tasks/"], a[href^="/projects/"], [role=link][data-href]'
const TOLERANCE_PX = 3
const MODES = [
  { mode: "desktop", path: "/boxes", viewport: { width: 1500, height: 900 } },
  { mode: "zen", path: "/zen", viewport: { width: 1500, height: 900 } },
  { mode: "zen-phone", path: "/zen", viewport: { width: 390, height: 800 } },
]

// The chat row at the top of the view: its index and its offset from the view's top.
const topRow = (sel) => {
  const el = document.querySelector(sel)
  const rows = [...el.firstElementChild.children]
  const viewTop = el.getBoundingClientRect().top
  const i = rows.findIndex((r) => r.getBoundingClientRect().bottom > viewTop)
  rows.forEach((r) => delete r.dataset.mark)
  rows[i].dataset.mark = "top"
  return { offset: Math.round(rows[i].getBoundingClientRect().top - viewTop), scrollTop: Math.round(el.scrollTop), max: el.scrollHeight - el.clientHeight }
}
const markedRow = (sel) => {
  const el = document.querySelector(sel)
  const row = el.querySelector(":scope > div > [data-mark=top]")
  return {
    offset: row ? Math.round(row.getBoundingClientRect().top - el.getBoundingClientRect().top) : null,
    scrollTop: Math.round(el.scrollTop),
    max: el.scrollHeight - el.clientHeight,
  }
}

const results = []
for (const name of browsers) {
  const browser = await pw[name].launch(name === "chromium" && process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
  for (const { mode, path, viewport } of MODES) {
    const page = await browser.newPage({ viewport })
    await page.goto(base + path)
    const chat = page.locator(SCROLLER)
    await chat.locator(LINK).first().waitFor({ state: "attached" })
    await page.waitForTimeout(1000)
    // Read back a little (over a screen up), then on until a link is in view.
    await chat.hover()
    const box = await chat.boundingBox()
    const links = chat.locator(LINK)
    const linkInView = async () => {
      for (let i = (await links.count()) - 1; i >= 0; i--) {
        const b = await links.nth(i).boundingBox()
        if (b && b.y > box.y + 10 && b.y + Math.min(b.height, 40) < box.y + box.height - 60) return links.nth(i)
      }
      return null
    }
    let link = null
    for (let i = 0; i < 40 && !link; i++) {
      await page.mouse.wheel(0, -viewport.height * 0.4)
      await page.waitForTimeout(100)
      if (i >= 3) link = await linkInView()
    }
    if (!link) throw new Error(`${name} ${mode}: no link in view`)
    await page.waitForTimeout(500)
    const before = await page.evaluate(topRow, SCROLLER)
    if (shots) await page.screenshot({ path: `${shots}/${name}-${mode}-before.png` })
    const href = (await link.getAttribute("href")) ?? (await link.getAttribute("data-href"))
    // A link inside a notice card goes where it points; click the card's own text so the card navigates.
    await link.click({ position: { x: 4, y: 4 } })
    await page.waitForURL((u) => u.pathname !== path)
    await page.waitForTimeout(800)
    await page.goBack()
    await page.waitForTimeout(1500)
    const after = await page.evaluate(markedRow, SCROLLER)
    if (shots) await page.screenshot({ path: `${shots}/${name}-${mode}-after.png` })
    const ok = after.offset !== null && Math.abs(after.offset - before.offset) <= TOLERANCE_PX
    results.push({ browser: name, mode, href, before, after, ok })
    await page.close()
  }
  await browser.close()
}
console.log(JSON.stringify(results, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)

// @vitest-environment happy-dom
// The Coordinator chat's (and Zen mode's) compact card for back-to-back published files.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, Fragment, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { PublishedCard, PublishedRow, STRIP_MAX } from "../web/src/components/PublishedNotices.js"
import { groupPublished, type PublishedGroup } from "../web/src/lib/publishedNotices.js"
import { closePreview, previewState } from "../web/src/lib/preview.js"
import { keys } from "../web/src/lib/queries.js"
import type { ChatMessage } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  history.replaceState(null, "", "/")
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.tasks, keys.projects, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  if (previewState()) closePreview()
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

let seq = 0
const pub = (task: string, title: string, file: string): ChatMessage => ({
  id: `chat_pub${String(seq++).padStart(4, "0")}`,
  role: "notice",
  content: `📎 **${task}** published ${title}: https://yard.example.com/artifacts/art_${seq}/${file}`,
  meta: { taskId: `task_${task.toLowerCase().replace(/\W+/g, "")}` },
  createdAt: seq,
})

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
/** What ChatPanel's ChatLines renders for the files rows. */
const thread = (messages: ChatMessage[]) =>
  render(createElement(Fragment, null, ...groupPublished(messages).flatMap((r) => (r.type === "files" ? [createElement(PublishedCard, { key: r.id, group: r.group })] : []))))
const click = (el: Element) => {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
  act(() => void el.dispatchEvent(e))
  return e
}
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!

const eight = Array.from({ length: 8 }, (_, i) => pub("Zen mode", `Shot ${i + 1}: view`, `shot-${i + 1}.png`))

describe("published files card", () => {
  it("shows the task, the count, a strip of thumbnails with +N and the first titles", () => {
    thread(eight)
    const cards = host.querySelectorAll('[data-testid="published-group"]')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.querySelector('[data-testid="notice-title"]')?.textContent).toBe("Zen mode")
    expect(cards[0]!.querySelector('[data-testid="notice-meta"]')?.textContent).toBe("published 8 files")
    expect(host.querySelector('a[href="/tasks/task_zenmode"]')?.textContent).toBe("Zen mode")
    expect(host.querySelectorAll("img")).toHaveLength(STRIP_MAX)
    expect(button(`+${8 - STRIP_MAX}`)).toBeTruthy()
    expect(host.textContent).toContain("Shot 1: view · Shot 2: view · Shot 3: view · +5 more")
  })

  it("Show all lists every file as a link row, and doesn't open the task", () => {
    thread(eight)
    const e = click(button("Show all"))
    expect(location.pathname).toBe("/")
    expect(e.defaultPrevented).toBe(false)
    const rows = [...host.querySelectorAll("li a")]
    expect(rows.map((a) => a.textContent)).toEqual(eight.map((_, i) => `Shot ${i + 1}: viewshot-${i + 1}.png`))
    expect(rows[0]!.getAttribute("href")).toBe("/artifacts/art_1/shot-1.png")
    click(button("Hide"))
    expect(host.querySelectorAll("li")).toHaveLength(0)
  })

  it("the title row holds only the title; Show all / Hide sits in the file list's header, next to the list", () => {
    thread(eight)
    const card = host.querySelector('[data-testid="published-group"]')!
    const titleRow = card.querySelector('[data-testid="notice-title"]')!
    expect(titleRow.children).toHaveLength(1)
    expect(titleRow.querySelector("button")).toBeNull()
    // The meta line comes after the title row, not beside it.
    expect(titleRow.nextElementSibling?.getAttribute("data-testid")).toBe("notice-meta")
    const header = card.querySelector('[data-testid="published-files-header"]')!
    const toggle = button("Show all")
    expect(header.contains(toggle)).toBe(true)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    click(toggle)
    const hide = button("Hide")
    expect(header.contains(hide)).toBe(true)
    expect(header.textContent).toContain("8 files")
    // The list it opens is the header's next sibling, and the toggle points at it.
    const list = header.nextElementSibling!
    expect(list.tagName).toBe("UL")
    expect(hide.getAttribute("aria-controls")).toBe(list.id)
  })

  it("a thumbnail opens the preview with ←/→ over the whole group, even files not in the strip", () => {
    thread(eight)
    const thumb = host.querySelector('a[href="/artifacts/art_2/shot-2.png"]')!
    expect(click(thumb).defaultPrevented).toBe(true)
    const s = previewState()!
    expect(s.items.map((i) => i.url)).toEqual(eight.map((_, i) => `/artifacts/art_${i + 1}/shot-${i + 1}.png`))
    expect(s.index).toBe(1)
    expect(location.pathname).toBe("/")
  })

  it("shows one card per task when several tasks publish back to back", () => {
    thread([pub("A", "a1", "a1.png"), pub("B", "b1", "b1.md"), pub("A", "a2", "a2.png")])
    const cards = [...host.querySelectorAll('[data-testid="published-group"]')]
    expect(cards.map((c) => c.getAttribute("data-count"))).toEqual(["2", "1"])
    expect(cards[1]!.querySelector('[data-testid="notice-title"]')?.textContent).toBe("B")
    expect(cards[1]!.querySelector('[data-testid="notice-meta"]')?.textContent).toBe("published a file")
    // Not an image: a file-type chip instead of a thumbnail.
    expect(cards[1]!.querySelector(`a[href$="b1.md"]`)?.textContent).toBe("MD")
  })

  it("live append: a new file joins the open card in place, without remounting it", () => {
    const first = eight.slice(0, 3)
    thread(first)
    click(button("Show all"))
    const card = host.querySelector('[data-testid="published-group"]')!
    thread([...first, eight[3]!])
    expect(host.querySelector('[data-testid="published-group"]')).toBe(card)
    expect(card.getAttribute("data-count")).toBe("4")
    // Still open, now with the new file.
    expect(host.querySelectorAll("li")).toHaveLength(4)
  })

  it("the Captain tab's row shows the same card with the newest file's time", () => {
    const g = groupPublished(eight.slice(0, 2))[0]!
    render(createElement(PublishedRow, { group: (g as { group: PublishedGroup }).group }))
    expect(host.querySelector('[data-testid="published-group"]')?.textContent).toContain("published 2 files")
    expect(host.querySelector('[id^="captain-"]')).toBeTruthy()
  })
})

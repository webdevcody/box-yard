import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { buildEntityIndex, linkTarget, refForHref, remarkEntityLinks, splitText, type EntityIndex } from "../web/src/lib/linkify.js"
import type { Artifact, BoxInfo, Project, Schedule, Task } from "../shared/types.js"

const project = { id: "prj_demo01", name: "box-yard", repo: "webdevcody/box-yard" } as Project
const tasks = [
  { id: "task_fb675b48a4e1", projectId: "prj_demo01", title: "Inbox: mark card as reviewed", status: "working" },
  { id: "task_aaaaaaaaaaaa", projectId: "prj_demo01", title: "Same title", status: "done" },
  { id: "task_bbbbbbbbbbbb", projectId: "prj_demo01", title: "Same title", status: "idle" },
] as Task[]
const schedules = [{ id: "sch_0123456789ab", name: "Morning digest", cron: "0 9 * * *", enabled: true }] as Schedule[]
const artifacts = [{ id: "art_96efb3c6cbea", title: "Architecture", filename: "arch.html", url: "/artifacts/art_96efb3c6cbea/arch.html" }] as Artifact[]
const boxes = [{ id: "local-1a2b3c4d", status: "ready", residentTasks: ["task_fb675b48a4e1"] }] as BoxInfo[]

const index = buildEntityIndex({ tasks, projects: [project], schedules, artifacts, boxes }, (s) => s.toUpperCase())

function render(md: string, idx: EntityIndex = index) {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, [remarkEntityLinks, idx]] }, md))
}

const anchors = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1])

describe("buildEntityIndex", () => {
  it("routes each kind to its page with a hover hint", () => {
    expect(index.byId.get("task_fb675b48a4e1")).toMatchObject({ href: "/tasks/task_fb675b48a4e1", hint: "Inbox: mark card as reviewed · WORKING · box-yard" })
    expect(index.byId.get("prj_demo01")).toMatchObject({ href: "/projects/prj_demo01", hint: "Project: box-yard (webdevcody/box-yard)" })
    expect(index.byId.get("sch_0123456789ab")?.href).toBe("/schedules#sch_0123456789ab")
    expect(index.byId.get("art_96efb3c6cbea")?.href).toBe("/artifacts/art_96efb3c6cbea/arch.html")
    expect(index.byId.get("local-1a2b3c4d")).toMatchObject({ href: "/boxes#local-1a2b3c4d", hint: "Box · ready · 1 task" })
  })

  it("only indexes titles exactly one task has", () => {
    expect(index.byTitle.has("Inbox: mark card as reviewed")).toBe(true)
    expect(index.byTitle.has("Same title")).toBe(false)
  })
})

describe("splitText", () => {
  it("splits known ids out of text and leaves unknown ones", () => {
    const parts = splitText("see task_fb675b48a4e1 and task_ffffffffffff, box local-1a2b3c4d.", index)
    expect(parts.map((p) => [p.text, p.ref?.kind])).toEqual([
      ["see ", undefined],
      ["task_fb675b48a4e1", "task"],
      [" and task_ffffffffffff, box ", undefined],
      ["local-1a2b3c4d", "box"],
      [".", undefined],
    ])
  })

  it("needs word boundaries around ids", () => {
    expect(splitText("xtask_fb675b48a4e1 task_fb675b48a4e1-2", index).every((p) => !p.ref)).toBe(true)
  })

  it("links artifact paths without trailing punctuation", () => {
    const parts = splitText("Open /artifacts/art_96efb3c6cbea/arch.html.", index)
    expect(parts[1]).toMatchObject({ text: "/artifacts/art_96efb3c6cbea/arch.html", ref: { hint: "Artifact: Architecture" } })
    expect(parts[2]?.text).toBe(".")
  })
})

describe("remarkEntityLinks", () => {
  it("links ids in plain text", () => {
    const html = render("Started task_fb675b48a4e1 in prj_demo01.")
    expect(anchors(html)).toEqual(["/tasks/task_fb675b48a4e1", "/projects/prj_demo01"])
    expect(html).toContain('title="Inbox: mark card as reviewed · WORKING · box-yard"')
    expect(html).toContain('data-entity="task"')
  })

  it("links ids inside inline code, keeping the code span", () => {
    const html = render("**Inbox: mark card as reviewed** (`task_fb675b48a4e1`)")
    expect(html).toContain('<a href="/tasks/task_fb675b48a4e1" title="Inbox: mark card as reviewed · WORKING · box-yard" data-entity="task"><code>task_fb675b48a4e1</code></a>')
  })

  it("leaves code spans with more than an id alone", () => {
    expect(anchors(render("`git checkout task_fb675b48a4e1`"))).toEqual([])
  })

  it("links ids in table cells", () => {
    const html = render("| Task | Id |\n| --- | --- |\n| Inbox | `task_fb675b48a4e1` |\n| Digest | sch_0123456789ab |")
    expect(html).toContain("<table>")
    expect(anchors(html)).toEqual(["/tasks/task_fb675b48a4e1", "/schedules#sch_0123456789ab"])
  })

  it("keeps unknown ids as plain text", () => {
    const html = render("Gone: task_ffffffffffff and `prj_nothere99`")
    expect(anchors(html)).toEqual([])
    expect(html).toContain("task_ffffffffffff")
  })

  it("does not link inside existing links", () => {
    const html = render("[task_fb675b48a4e1 is **Inbox: mark card as reviewed**](/tasks/task_fb675b48a4e1) and [`prj_demo01`](/projects/prj_demo01)")
    expect(anchors(html)).toEqual(["/tasks/task_fb675b48a4e1", "/projects/prj_demo01"])
    expect(html.match(/<a /g)).toHaveLength(2)
  })

  it("does not link inside fenced code", () => {
    expect(anchors(render("```\ntask_fb675b48a4e1\n```"))).toEqual([])
  })

  it("links bold titles only when unambiguous", () => {
    const html = render("**Inbox: mark card as reviewed** and **Same title**")
    expect(anchors(html)).toEqual(["/tasks/task_fb675b48a4e1"])
    expect(html).toContain("<strong>Same title</strong>")
  })

  it("does nothing with an empty cache except artifact paths", () => {
    const empty = buildEntityIndex({})
    expect(anchors(render("task_fb675b48a4e1 /artifacts/art_x12345/a.txt", empty))).toEqual(["/artifacts/art_x12345/a.txt"])
  })
})

describe("links", () => {
  it("classifies hrefs", () => {
    expect(linkTarget("/tasks/task_1")).toEqual({ kind: "app", href: "/tasks/task_1" })
    expect(linkTarget("http://yard.test/projects/p?tab=notes", "http://yard.test")).toEqual({ kind: "app", href: "/projects/p?tab=notes" })
    expect(linkTarget("/artifacts/art_1/a.html").kind).toBe("file")
    expect(linkTarget("https://github.com/x/y").kind).toBe("external")
    expect(linkTarget("//evil.test/x").kind).toBe("external")
  })

  it("finds the entity behind an in-app href", () => {
    expect(refForHref("/tasks/task_fb675b48a4e1", index)?.kind).toBe("task")
    expect(refForHref("/projects/prj_demo01?tab=schedules", index)?.kind).toBe("project")
    expect(refForHref("/schedules#sch_0123456789ab", index)?.kind).toBe("schedule")
    expect(refForHref("/boxes#local-1a2b3c4d", index)?.kind).toBe("box")
    expect(refForHref("/artifacts/art_96efb3c6cbea/arch.html", index)?.kind).toBe("artifact")
    expect(refForHref("/inbox", index)).toBeNull()
  })
})

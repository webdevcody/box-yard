import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { buildEntityIndex, followAppLink, githubRef, isExternal, linkTarget, refForHref, remarkEntityLinks, shortGithubLabel, shortShas, splitText, toolMentions, type EntityIndex } from "../web/src/lib/linkify.js"
import { createdId } from "../server/orchestrator.js"
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
    expect(html).toContain('data-entity="task"')
  })

  it("links ids inside inline code, keeping the code span", () => {
    const html = render("**Inbox: mark card as reviewed** (`task_fb675b48a4e1`)")
    expect(html).toContain('<a href="/tasks/task_fb675b48a4e1" data-entity="task"><code>task_fb675b48a4e1</code></a>')
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

  it("treats only Box Yard's own origin as in-app", () => {
    const origin = "http://yard.test"
    expect(linkTarget("https://github.com/webdevcody/box-yard/pull/66", origin)).toEqual({ kind: "external", href: "https://github.com/webdevcody/box-yard/pull/66" })
    expect(linkTarget("http://yard.test", origin)).toEqual({ kind: "app", href: "/" })
    expect(linkTarget("http://yard.test?tab=recent", origin)).toEqual({ kind: "app", href: "/?tab=recent" })
    expect(linkTarget("http://YARD.test/tasks/task_1", origin)).toEqual({ kind: "app", href: "/tasks/task_1" })
    expect(linkTarget("http://yard.test/artifacts/art_1/a.html", origin)).toEqual({ kind: "file", href: "/artifacts/art_1/a.html" })
    // Look-alike hosts and other ports are other sites.
    expect(linkTarget("http://yard.test.evil/tasks/task_1", origin).kind).toBe("external")
    expect(linkTarget("http://yard.test:4051/", origin).kind).toBe("external")
    expect(linkTarget("https://yard.test/tasks/task_1", origin).kind).toBe("external")
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

describe("internal vs external", () => {
  const origin = "http://yard.test"

  it("keeps Box Yard's own pages and files in the app", () => {
    for (const href of ["/tasks/task_1", "/projects/prj_demo01?tab=captain", "/schedules#sch_0123456789ab", "/boxes#local-1", "/artifacts/art_1/a.html", "/api/uploads/u/x.png", `${origin}/tasks/task_1`, origin])
      expect(isExternal(href, origin), href).toBe(false)
  })

  it("sends every other site (GitHub, previews, protocol-relative, look-alike origins) to a new tab", () => {
    for (const href of [
      "https://github.com/webdevcody/box-yard/pull/154",
      "https://upstash.com/docs/box",
      "https://4030-box.upstash.app/",
      "//evil.test/x",
      "http://yard.test.evil/tasks/task_1",
      "http://yard.test:4051/",
      "mailto:cody@example.com",
    ])
      expect(isExternal(href, origin), href).toBe(true)
  })
})

describe("GitHub link labels", () => {
  it("reads PR and issue URLs, with or without a trailing path, query or hash", () => {
    expect(githubRef("https://github.com/webdevcody/box-yard/pull/154")).toEqual({ owner: "webdevcody", repo: "box-yard", kind: "pull", number: 154 })
    expect(githubRef("https://github.com/webdevcody/box-yard/pull/154/files#diff-1")?.number).toBe(154)
    expect(githubRef("https://www.github.com/o/r.js/issues/9?x=1")).toEqual({ owner: "o", repo: "r.js", kind: "issue", number: 9 })
  })

  it("shortens a PR to 'PR #154' and an issue to 'owner/repo#154'", () => {
    expect(shortGithubLabel("https://github.com/webdevcody/box-yard/pull/154")).toBe("PR #154")
    expect(shortGithubLabel("https://github.com/webdevcody/box-yard/issues/154")).toBe("webdevcody/box-yard#154")
  })

  it("shortens a commit URL and a whole SHA in prose to git's short form, never the 40 characters", () => {
    const sha = "ff8fc2305ab9c31e61cfc78f89fadf6c2d5d42ee"
    expect(shortGithubLabel(`https://github.com/webdevcody/box-yard/commit/${sha}`)).toBe("ff8fc23")
    expect(shortShas(`merged into main as squash commit ${sha}. Main merged cleanly`)).toBe("merged into main as squash commit ff8fc23. Main merged cleanly")
    // Not a SHA: too short, all letters or digits, or part of a longer word.
    for (const text of ["deadbeef", "a".repeat(40), "1".repeat(40), `x${sha}`]) expect(shortShas(text)).toBe(text)
  })

  it("leaves other links alone", () => {
    for (const href of ["https://github.com/webdevcody/box-yard", "https://github.com/o/r/commit/abc", "https://github.com/o/r/pull/12abc", "https://gitlab.com/o/r/pull/1", "https://evilgithub.com/o/r/pull/1", "/tasks/task_1"])
      expect(shortGithubLabel(href), href).toBeNull()
  })
})

describe("followAppLink", () => {
  const click = (over: Partial<Parameters<typeof followAppLink>[0]> = {}) => {
    const e = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, prevented: false, preventDefault() {
      e.prevented = true
    }, ...over }
    return e
  }
  const run = (href: string, over = {}) => {
    const to: string[] = []
    const e = click(over)
    const navigated = followAppLink(e, href, (h) => to.push(h), "http://yard.test")
    return { navigated, to, prevented: e.prevented }
  }

  it("navigates in-app links through the router", () => {
    expect(run("/tasks/task_25e0c6728cdf")).toEqual({ navigated: true, to: ["/tasks/task_25e0c6728cdf"], prevented: true })
    expect(run("http://yard.test/schedules#sch_0123456789ab").to).toEqual(["/schedules#sch_0123456789ab"])
  })

  it("leaves modified and middle clicks to the browser (new tab)", () => {
    for (const over of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }])
      expect(run("/tasks/task_25e0c6728cdf", over)).toEqual({ navigated: false, to: [], prevented: false })
  })

  it("leaves external links and files to the browser", () => {
    expect(run("https://github.com/webdevcody/box-yard/pull/18")).toEqual({ navigated: false, to: [], prevented: false })
    expect(run("/artifacts/art_96efb3c6cbea/arch.html").navigated).toBe(false)
  })
})

describe("toolMentions", () => {
  const texts = (ms: ReturnType<typeof toolMentions>) => ms.map((m) => [m.text, m.ref?.href ?? null])

  it("links task ids by title", () => {
    expect(texts(toolMentions("send_to_task", { task: "task_fb675b48a4e1", message: "hi" }, null, index))).toEqual([
      ["Inbox: mark card as reviewed", "/tasks/task_fb675b48a4e1"],
    ])
  })

  it("links every task wait_for_tasks waits on, keeping unknown ones as text", () => {
    expect(texts(toolMentions("wait_for_tasks", { tasks: ["task_fb675b48a4e1", "task_ffffffffffff"] }, null, index))).toEqual([
      ["Inbox: mark card as reviewed", "/tasks/task_fb675b48a4e1"],
      ["task_ffffffffffff", null],
    ])
  })

  it("links what a create tool made, from the recorded result id or a unique name", () => {
    expect(texts(toolMentions("create_task", { project: "box-yard", title: "Same title" }, "task_bbbbbbbbbbbb", index))).toEqual([["Same title", "/tasks/task_bbbbbbbbbbbb"]])
    expect(texts(toolMentions("create_task", { project: "box-yard", title: "Same title" }, null, index))).toEqual([["Same title", null]])
    expect(texts(toolMentions("create_project", { name: "box-yard" }, null, index))).toEqual([["box-yard", "/projects/prj_demo01"]])
  })

  it("links schedules and projects by id or name", () => {
    expect(texts(toolMentions("run_schedule_now", { schedule: "Morning digest" }, null, index))).toEqual([["Morning digest", "/schedules#sch_0123456789ab"]])
    expect(texts(toolMentions("save_note", { project: "prj_demo01", content: "x" }, null, index))).toEqual([["box-yard", "/projects/prj_demo01"]])
    expect(texts(toolMentions("create_task", { project: "prj_demo01", title: "New" }, null, index))).toEqual([["New", null]])
    expect(toolMentions("list_projects", {}, null, index)).toEqual([])
  })
})

describe("createdId", () => {
  it("finds the new id in a create tool result", () => {
    expect(createdId("create_task", '{"id":"task_abcdef123456","title":"x","project":"box-yard"}')).toBe("task_abcdef123456")
    expect(createdId("create_schedule", [{ type: "text", text: '{"projectId":"prj_demo01","id":"sch_abcdef123456"}' }])).toBe("sch_abcdef123456")
    expect(createdId("create_project", "Error: exists")).toBeNull()
    expect(createdId("send_to_task", "task_abcdef123456")).toBeNull()
  })
})

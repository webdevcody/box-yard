import { describe, expect, it } from "vitest"
import { fileType, galleryOf, latestAt, listFiles, matchesFile, newestFirst, titleStem, unseenCount, type TaskFile } from "../web/src/lib/taskFiles"

let n = 0
function file(title: string, filename: string, createdAt: number, mime = ""): TaskFile {
  const id = `art_test${String(++n).padStart(4, "0")}`
  return { id, title, filename, mime, size: 1000, url: `/artifacts/${id}/${filename}`, createdAt }
}

describe("titleStem", () => {
  it("cuts at a colon, parenthesis or dash and drops before/after", () => {
    expect(titleStem("Captain tab after (mobile)")).toBe("captain tab")
    expect(titleStem("Captain tab before (desktop)")).toBe("captain tab")
    expect(titleStem("Captain tab after: ⋯ menu with context")).toBe("captain tab")
    expect(titleStem("Header — open drawer")).toBe("header")
    expect(titleStem("Architecture report")).toBe("architecture report")
  })
})

describe("listFiles", () => {
  it("orders newest first and keeps a flat list when nothing groups", () => {
    const a = file("Report", "report.md", 1)
    const b = file("Diagram", "diagram.png", 3)
    const c = file("Page", "page.html", 2)
    const { sections, ordered } = listFiles([a, b, c])
    expect(sections).toHaveLength(1)
    expect(sections[0]!.label).toBeNull()
    expect(sections[0]!.images).toEqual([b])
    expect(sections[0]!.others).toEqual([c, a])
    expect(ordered).toEqual([b, c, a])
  })

  it("groups titles that share a stem and orders sections by their newest file", () => {
    const before = file("Captain tab before (desktop)", "before.png", 1)
    const after = file("Captain tab after (desktop)", "after.png", 5)
    const notes = file("Captain tab after: notes", "notes.md", 4)
    const report = file("Perf report", "perf.html", 6)
    const old = file("Old export", "old.csv", 0)
    const { sections, ordered } = listFiles([before, after, notes, report, old])
    expect(sections.map((s) => s.label)).toEqual([null, "Captain tab"])
    expect(sections[1]!.images).toEqual([after, before])
    expect(sections[1]!.others).toEqual([notes])
    expect(sections[0]!.others).toEqual([report, old])
    // ←/→ follow what is on screen: each section's images, then its list.
    expect(ordered).toEqual([report, old, after, before, notes])
  })

  it("doesn't add a heading when every file is in the same group", () => {
    const { sections } = listFiles([file("Shot before", "a.png", 1), file("Shot after", "b.png", 2)])
    expect(sections).toHaveLength(1)
    expect(sections[0]!.label).toBeNull()
  })

  it("filters by every word across title, file name and type", () => {
    const files = [file("Captain tab after (mobile)", "after-mobile.png", 1), file("Captain notes", "notes.md", 2), file("Desktop page", "desk.html", 3)]
    expect(listFiles(files, "captain png").ordered.map((f) => f.filename)).toEqual(["after-mobile.png"])
    expect(listFiles(files, "  ").ordered).toHaveLength(3)
    expect(listFiles(files, "nothing").sections).toEqual([])
    expect(listFiles(files, "html").total).toBe(3)
  })
})

describe("helpers", () => {
  it("names the type by extension, else by MIME", () => {
    expect(fileType(file("x", "a.tar.gz", 1))).toBe("GZ")
    expect(fileType(file("x", "README", 1, "text/plain; charset=utf-8"))).toBe("PLAIN")
  })

  it("matches the preview kind as a word", () => {
    expect(matchesFile(file("x", "shot.png", 1), "image")).toBe(true)
    expect(matchesFile(file("x", "doc.md", 1), "image")).toBe(false)
  })

  it("keeps only previewable files in the gallery, in order", () => {
    const zip = file("Bundle", "bundle.zip", 3, "application/zip")
    const png = file("Shot", "shot.png", 2)
    const md = file("Notes", "notes.md", 1)
    expect(galleryOf([zip, png, md]).map((g) => g.name)).toEqual(["shot.png", "notes.md"])
  })

  it("counts files newer than the last opened mark", () => {
    const files = [file("a", "a.md", 10), file("b", "b.md", 20), file("c", "c.md", 30)]
    expect(unseenCount(files, null)).toBe(3)
    expect(unseenCount(files, 20)).toBe(1)
    expect(unseenCount(files, latestAt(files))).toBe(0)
    expect(latestAt([])).toBe(0)
  })

  it("sorts ties stably by id", () => {
    const a = file("a", "a.md", 5)
    const b = file("b", "b.md", 5)
    expect(newestFirst([b, a])).toEqual([a, b])
  })
})

import { describe, expect, it } from "vitest"
import {
  fileNameOf,
  interceptPreviewClick,
  isPlainClick,
  lineNumbers,
  parseCsv,
  parsePreviewKey,
  prettyJson,
  previewKey,
  previewKind,
  stepIndex,
  type PreviewItem,
} from "../web/src/lib/filePreview.js"

describe("previewKind", () => {
  const kind = (url: string, extra: Partial<PreviewItem> = {}) => previewKind({ url, ...extra })

  it("detects images, including svg and avif", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "PNG"]) expect(kind(`/artifacts/art_abcdef/shot.${ext}`)).toBe("image")
  })

  it("detects markdown, html, pdf, json and csv", () => {
    expect(kind("/artifacts/art_abcdef/README.md")).toBe("markdown")
    expect(kind("/artifacts/art_abcdef/box-yard-architecture.html")).toBe("html")
    expect(kind("/artifacts/art_abcdef/report.pdf")).toBe("pdf")
    expect(kind("/artifacts/art_abcdef/data.json")).toBe("json")
    expect(kind("/artifacts/art_abcdef/rows.csv")).toBe("csv")
  })

  it("treats code, logs and config as text", () => {
    for (const ext of ["txt", "log", "ts", "js", "py", "yaml", "yml", "toml", "sh", "sql"]) expect(kind(`/api/uploads/up_1/file.${ext}`)).toBe("text")
  })

  it("detects video and audio", () => {
    expect(kind("/a/clip.mp4")).toBe("video")
    expect(kind("/a/clip.webm")).toBe("video")
    expect(kind("/a/sound.mp3")).toBe("audio")
    expect(kind("/a/sound.wav")).toBe("audio")
  })

  it("prefers the file name over the URL and falls back to the MIME type", () => {
    expect(kind("/api/uploads/up_1/blob", { name: "notes.md" })).toBe("markdown")
    expect(kind("/api/uploads/up_1/blob", { mime: "image/png" })).toBe("image")
    expect(kind("/api/uploads/up_1/blob", { mime: "text/html; charset=utf-8" })).toBe("html")
    expect(kind("/api/uploads/up_1/blob", { mime: "application/json" })).toBe("json")
    expect(kind("/api/uploads/up_1/blob", { mime: "text/plain" })).toBe("text")
    expect(kind("/api/uploads/up_1/blob", { mime: "audio/mpeg" })).toBe("audio")
  })

  it("ignores query strings and hashes", () => {
    expect(kind("/artifacts/art_abcdef/shot.png?v=2#x")).toBe("image")
  })

  it("returns null for files it can't show", () => {
    expect(kind("/artifacts/art_abcdef/bundle.zip")).toBeNull()
    expect(kind("/artifacts/art_abcdef/bundle.zip", { mime: "application/zip" })).toBeNull()
    expect(kind("/artifacts/art_abcdef/noext", { mime: "application/octet-stream" })).toBeNull()
    expect(kind("/artifacts/art_abcdef/noext")).toBeNull()
  })
})

describe("fileNameOf", () => {
  it("decodes the last path segment", () => {
    expect(fileNameOf("/artifacts/art_abcdef/before%20shot.png")).toBe("before shot.png")
    expect(fileNameOf("/api/uploads/up_1/a.json?x=1")).toBe("a.json")
    expect(fileNameOf("/artifacts/art_abcdef/%E0%A4%A.txt")).toBe("%E0%A4%A.txt")
  })
})

describe("click interception", () => {
  const click = (over: Record<string, unknown> = {}) => {
    const e = {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      prevented: false,
      preventDefault() {
        e.prevented = true
      },
      ...over,
    }
    return e
  }
  const run = (url: string, over: Record<string, unknown> = {}) => {
    const opened: PreviewItem[] = []
    const e = click(over)
    const handled = interceptPreviewClick(e, { url }, (item) => opened.push(item))
    return { handled, prevented: e.prevented, opened }
  }

  it("opens the preview on a plain left click and cancels the navigation", () => {
    const r = run("/artifacts/art_abcdef/before.png")
    expect(r).toEqual({ handled: true, prevented: true, opened: [{ url: "/artifacts/art_abcdef/before.png" }] })
    expect(run("/api/uploads/up_1/notes.md").handled).toBe(true)
  })

  it("leaves Cmd, Ctrl, Shift, Alt and middle clicks to the browser", () => {
    for (const over of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }]) {
      expect(run("/artifacts/art_abcdef/before.png", over)).toEqual({ handled: false, prevented: false, opened: [] })
    }
  })

  it("leaves clicks someone else already handled", () => {
    expect(run("/artifacts/art_abcdef/before.png", { defaultPrevented: true }).handled).toBe(false)
  })

  it("leaves files it can't show, and anything that isn't a hosted file", () => {
    expect(run("/artifacts/art_abcdef/bundle.zip")).toEqual({ handled: false, prevented: false, opened: [] })
    expect(run("https://example.com/shot.png").handled).toBe(false)
    expect(run("/tasks/task_abcdef123456").handled).toBe(false)
    expect(run("//evil.test/artifacts/x/shot.png").handled).toBe(false)
  })

  it("isPlainClick matches only unmodified primary clicks", () => {
    expect(isPlainClick(click())).toBe(true)
    expect(isPlainClick(click({ ctrlKey: true }))).toBe(false)
  })
})

describe("preview URL keys", () => {
  it("uses the artifact id for artifacts and the path for other files", () => {
    expect(previewKey("/artifacts/art_96efb3c6cbea/box-yard-architecture.html")).toBe("art_96efb3c6cbea")
    expect(previewKey("/api/uploads/up_1/shot.png")).toBe("/api/uploads/up_1/shot.png")
  })

  it("reads keys back, rejecting anything that isn't a hosted file", () => {
    expect(parsePreviewKey("art_96efb3c6cbea")).toEqual({ artifactId: "art_96efb3c6cbea" })
    expect(parsePreviewKey("/api/uploads/up_1/shot.png")).toEqual({ url: "/api/uploads/up_1/shot.png" })
    expect(parsePreviewKey(null)).toBeNull()
    expect(parsePreviewKey("javascript:alert(1)")).toBeNull()
    expect(parsePreviewKey("https://evil.test/a.html")).toBeNull()
    expect(parsePreviewKey("/tasks/task_abcdef123456")).toBeNull()
  })
})

describe("text helpers", () => {
  it("pretty-prints JSON, or returns null when it doesn't parse", () => {
    expect(prettyJson('{"a":1,"b":[true]}')).toBe('{\n  "a": 1,\n  "b": [\n    true\n  ]\n}')
    expect(prettyJson("{nope")).toBeNull()
  })

  it("parses CSV with quotes, escaped quotes, embedded newlines and CRLF", () => {
    expect(parseCsv('name,note\r\n"Smith, J","said ""hi"""\nx,"two\nlines"\n')).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"'],
      ["x", "two\nlines"],
    ])
    expect(parseCsv("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
    expect(parseCsv("a,b,\n")).toEqual([["a", "b", ""]])
    expect(parseCsv("")).toEqual([])
  })

  it("numbers lines, ignoring one trailing newline", () => {
    expect(lineNumbers("a\nb\nc")).toBe("1\n2\n3")
    expect(lineNumbers("a\nb\n")).toBe("1\n2")
    expect(lineNumbers("")).toBe("1")
  })

  it("steps through a gallery, wrapping around", () => {
    expect(stepIndex(0, 1, 3)).toBe(1)
    expect(stepIndex(2, 1, 3)).toBe(0)
    expect(stepIndex(0, -1, 3)).toBe(2)
    expect(stepIndex(0, 1, 0)).toBe(0)
  })
})

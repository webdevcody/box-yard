// create_pull_request copies the files a PR body links to (/artifacts/… from publish_artifact) onto the repo's
// boxyard-assets branch and points the links there, since GitHub can't load Box Yard's own links. It runs the real
// runner against a local git origin and a fake GitHub API that keeps branches, trees and PRs in memory.
import { afterEach, describe, expect, it } from "vitest"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { tmpDir } from "./helpers.js"

const runner = path.resolve(import.meta.dirname, "../runner/box-runner.mjs")
const SLUG = "acme/widgets"
const sha = (s: string) => createHash("sha1").update(s).digest("hex")

/** Just enough of GitHub's REST API: git blobs, trees, commits and refs, and pulls. */
function fakeGitHub() {
  const blobs = new Map<string, Buffer>()
  const trees = new Map<string, Record<string, string>>()
  const commits = new Map<string, { tree: string; parents: string[] }>()
  const refs = new Map<string, string>()
  const pulls: { number: number; title: string; body: string; head: string; html_url: string }[] = []
  /** Fail the next ref update with 422, as when another agent moves the branch first. */
  let raceOnce = false
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (d) => (raw += d))
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {}
      const url = new URL(req.url!, "http://x")
      const p = url.pathname.replace(`/repos/${SLUG}`, "")
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(JSON.stringify(data))
      }
      const at = `${req.method} ${p}`
      if (at === "POST /git/blobs") {
        const buf = Buffer.from(body.content, "base64")
        const s = sha(buf.toString("binary"))
        blobs.set(s, buf)
        return send(201, { sha: s })
      }
      if (at === "POST /git/trees") {
        const entries = { ...(body.base_tree ? trees.get(body.base_tree) : {}) }
        for (const e of body.tree) entries[e.path] = e.sha
        const s = sha(JSON.stringify(Object.entries(entries).sort()))
        trees.set(s, entries)
        return send(201, { sha: s })
      }
      if (at === "POST /git/commits") {
        const s = sha(JSON.stringify(body) + commits.size)
        commits.set(s, { tree: body.tree, parents: body.parents })
        return send(201, { sha: s })
      }
      let m = /^GET \/git\/commits\/(\w+)$/.exec(at)
      if (m) return send(200, { tree: { sha: commits.get(m[1]!)!.tree } })
      m = /^GET \/git\/ref\/heads\/(.+)$/.exec(at)
      if (m) return refs.has(m[1]!) ? send(200, { object: { sha: refs.get(m[1]!) } }) : send(404, { message: "Not Found" })
      if (at === "POST /git/refs") {
        const name = body.ref.replace("refs/heads/", "")
        if (refs.has(name)) return send(422, { message: "Reference already exists" })
        refs.set(name, body.sha)
        return send(201, {})
      }
      m = /^PATCH \/git\/refs\/heads\/(.+)$/.exec(at)
      if (m) {
        const tip = refs.get(m[1]!)
        if (raceOnce || !commits.get(body.sha)?.parents.includes(tip!)) {
          raceOnce = false
          return send(422, { message: "Update is not a fast forward" })
        }
        refs.set(m[1]!, body.sha)
        return send(200, {})
      }
      if (at === "GET /pulls") return send(200, pulls.filter((pr) => `acme:${pr.head}` === url.searchParams.get("head")))
      if (at === "POST /pulls") {
        const pr = { number: pulls.length + 1, title: body.title, body: body.body, head: body.head, html_url: `https://github.com/${SLUG}/pull/${pulls.length + 1}` }
        pulls.push(pr)
        return send(201, pr)
      }
      m = /^PATCH \/pulls\/(\d+)$/.exec(at)
      if (m) {
        const pr = pulls[Number(m[1]) - 1]!
        Object.assign(pr, { title: body.title, body: body.body })
        return send(200, pr)
      }
      send(404, { message: `fake GitHub has no ${at}` })
    })
  })
  /** The file at `file` on a branch, read through its commit's tree. */
  const fileOn = (branch: string, file: string) => {
    const tree = trees.get(commits.get(refs.get(branch)!)!.tree)!
    return tree[file] ? blobs.get(tree[file])! : null
  }
  return { server, pulls, refs, commits, fileOn, race: () => (raceOnce = true) }
}

let gh: ReturnType<typeof fakeGitHub> | null = null
afterEach(() => {
  gh?.server.close()
  gh = null
})

/** A task folder whose work/ is a clone with a local origin, on a feature branch with one commit. */
async function taskFolder() {
  gh = fakeGitHub()
  await new Promise<void>((r) => gh!.server.listen(0, "127.0.0.1", r))
  const dir = tmpDir()
  const origin = path.join(dir, "origin.git")
  const work = path.join(dir, "work")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "pipe" })
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin])
  fs.mkdirSync(work)
  git("init", "-q", "-b", "main")
  git("config", "user.email", "agent@example.com")
  git("config", "user.name", "Agent")
  git("remote", "add", "origin", origin)
  fs.writeFileSync(path.join(work, "README.md"), "hi\n")
  git("add", ".")
  git("commit", "-q", "-m", "init")
  git("push", "-q", "origin", "main")
  git("checkout", "-q", "-b", "boxyard/shots")
  fs.writeFileSync(path.join(work, "a.txt"), "change\n")
  git("add", ".")
  git("commit", "-q", "-m", "change")
  const port = (gh.server.address() as AddressInfo).port
  fs.writeFileSync(
    path.join(dir, "task.json"),
    JSON.stringify({ taskId: "task_abc", baseBranch: "main", env: { GITHUB_TOKEN: "t0ken" }, github: { slug: SLUG, apiUrl: `http://127.0.0.1:${port}` } }),
  )
  return { dir, work }
}

/** Write a file and log it as published, the way publish_artifact does. */
function publish(dir: string, id: string, name: string, content: string) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  const sha256 = createHash("sha256").update(content).digest("hex")
  fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ seq: 1, ts: 1, t: "artifact", id, path: file, title: name, size: content.length, sha256 }) + "\n")
  return file
}

/** Call create_pull_request through the runner's MCP server and return its reply. */
async function createPr(dir: string, body: string, title = "Add shots") {
  const child = spawn(process.execPath, [runner, "mcp", dir], { stdio: ["pipe", "pipe", "inherit"] })
  const reply = new Promise<{ text: string; isError?: boolean }>((resolve) => {
    let out = ""
    child.stdout.on("data", (d) => {
      out += d
      const line = out.split("\n").find((l) => l.includes('"id":7'))
      if (line) {
        const result = JSON.parse(line).result
        resolve({ text: result.content[0].text, isError: result.isError })
      }
    })
  })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "create_pull_request", arguments: { title, body } } }) + "\n")
  const r = await reply
  child.kill()
  return r
}

describe("create_pull_request with screenshots", () => {
  it("copies linked artifacts to the boxyard-assets branch and points the PR's links there", async () => {
    const { dir } = await taskFolder()
    publish(dir, "art_aaa111", "cards.png", "PNG-1")
    publish(dir, "art_bbb222", "report.html", "<p>hi</p>")
    const body = [
      "![The cards](/artifacts/art_aaa111/cards.png)",
      "Full report: [report](/artifacts/art_bbb222/report.html).",
      "Same shot, absolute: https://yard.example.com/artifacts/art_aaa111/cards.png.",
    ].join("\n")
    const r = await createPr(dir, body)
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain("Opened PR #1")
    expect(r.text).toContain("Copied 2 files to the boxyard-assets branch")

    const pr = gh!.pulls[0]!
    const shot = `https://github.com/${SLUG}/blob/boxyard-assets/task_abc/art_aaa111/cards.png?raw=true`
    expect(pr.body).toContain(`![The cards](${shot})`)
    // Not an image: GitHub's file page, no ?raw.
    expect(pr.body).toContain(`[report](https://github.com/${SLUG}/blob/boxyard-assets/task_abc/art_bbb222/report.html).`)
    expect(pr.body).toContain(`absolute: ${shot}.`)
    expect(pr.body).not.toContain("/artifacts/")
    expect(gh!.fileOn("boxyard-assets", "task_abc/art_aaa111/cards.png")?.toString()).toBe("PNG-1")
    expect(gh!.fileOn("boxyard-assets", "task_abc/art_bbb222/report.html")?.toString()).toBe("<p>hi</p>")
    // The assets branch starts with no history of its own; the base branch is never touched.
    expect(gh!.commits.get(gh!.refs.get("boxyard-assets")!)!.parents).toEqual([])
    expect(gh!.refs.has("main")).toBe(false)
  })

  it("updates the open PR's title and body when called again, adding new files on top of the branch", async () => {
    const { dir } = await taskFolder()
    publish(dir, "art_aaa111", "one.png", "PNG-1")
    await createPr(dir, "![one](/artifacts/art_aaa111/one.png)")
    const first = gh!.refs.get("boxyard-assets")!

    // The same file again: nothing new to commit.
    await createPr(dir, "![one](/artifacts/art_aaa111/one.png)", "Same")
    expect(gh!.refs.get("boxyard-assets")).toBe(first)

    publish(dir, "art_ccc333", "two.png", "PNG-2")
    gh!.race()
    const r = await createPr(dir, "![one](/artifacts/art_aaa111/one.png)\n![two](/artifacts/art_ccc333/two.png)", "Retitled")
    expect(r.text).toContain("Updated (pushed to, with this title and body) PR #1")
    expect(gh!.pulls).toHaveLength(1)
    expect(gh!.pulls[0]!.title).toBe("Retitled")
    expect(gh!.pulls[0]!.body).toContain("task_abc/art_ccc333/two.png?raw=true")
    // A lost race starts again from the tip: the new commit sits on the first one, which keeps the first file.
    expect(gh!.commits.get(gh!.refs.get("boxyard-assets")!)!.parents).toEqual([first])
    expect(gh!.fileOn("boxyard-assets", "task_abc/art_aaa111/one.png")?.toString()).toBe("PNG-1")
    expect(gh!.fileOn("boxyard-assets", "task_abc/art_ccc333/two.png")?.toString()).toBe("PNG-2")
  })

  it("leaves links it can't copy and says so", async () => {
    const { dir } = await taskFolder()
    const gone = publish(dir, "art_ddd444", "gone.png", "x")
    fs.rmSync(gone)
    // Published twice from one path: the first artifact's file now holds the second's picture.
    const shot = publish(dir, "art_ggg777", "shot.png", "first")
    publish(dir, "art_hhh888", "shot.png", "second")
    expect(fs.readFileSync(shot, "utf8")).toBe("second")
    const body = "![gone](/artifacts/art_ddd444/gone.png) ![other task's](/artifacts/art_eee555/x.png) ![old](/artifacts/art_ggg777/shot.png) plain text"
    const r = await createPr(dir, body)
    expect(r.isError).toBeFalsy()
    expect(r.text).toMatch(/GitHub can't show art_ddd444, art_eee555, art_ggg777: .*changed since\. Publish the file again/)
    expect(gh!.pulls[0]!.body).toContain(body)
    expect(gh!.refs.has("boxyard-assets")).toBe(false)
  })

  it("leaves links inside code as written", async () => {
    const { dir } = await taskFolder()
    publish(dir, "art_aaa111", "cards.png", "PNG-1")
    const body = [
      "Linked as `/artifacts/art_aaa111/cards.png` in the body:",
      "![cards](/artifacts/art_aaa111/cards.png)",
      "```md",
      "![example](/artifacts/art_aaa111/cards.png)",
      "```",
    ].join("\n")
    const r = await createPr(dir, body)
    expect(r.text).toContain("Copied 1 file")
    const out = gh!.pulls[0]!.body
    expect(out).toContain("Linked as `/artifacts/art_aaa111/cards.png` in the body:")
    expect(out).toContain(`![cards](https://github.com/${SLUG}/blob/boxyard-assets/task_abc/art_aaa111/cards.png?raw=true)`)
    expect(out).toContain("```md\n![example](/artifacts/art_aaa111/cards.png)\n```")
    expect(gh!.fileOn("boxyard-assets", "task_abc/art_aaa111/cards.png")?.toString()).toBe("PNG-1")
  })

  it("doesn't touch a body without artifact links", async () => {
    const { dir } = await taskFolder()
    const r = await createPr(dir, "No pictures: see https://example.com/foo/artifacts/art_fff666/y.png")
    expect(r.text).not.toContain("boxyard-assets")
    expect(gh!.pulls[0]!.body).toContain("https://example.com/foo/artifacts/art_fff666/y.png")
    expect(gh!.refs.size).toBe(0)
  })
})

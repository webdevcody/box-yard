import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"
import { depsPruneScript } from "../server/janitor.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Project, Task } from "../shared/types.js"

// The runner's opt-in npm dependency cache (`box-runner.mjs deps <taskDir> save|restore`):
// a node_modules that matches its lockfile is saved as read-only hard links, and a task
// with the same lockfile and no node_modules gets it back without an install.

const runner = path.resolve(import.meta.dirname, "../runner/box-runner.mjs")

let root: string
let store: string

beforeEach(() => {
  root = tmpDir("box-yard-deps-")
  store = path.join(root, ".boxyard", "deps")
})
afterEach(() => {
  // Store files are read-only; their dirs aren't, so rm works.
  fs.rmSync(root, { recursive: true, force: true })
})

const LOCK = {
  name: "app",
  lockfileVersion: 3,
  packages: {
    "": { name: "app", dependencies: { left: "^1.0.0", "@scope/right": "^2.0.0" } },
    "node_modules/left": { version: "1.0.0" },
    "node_modules/@scope/right": { version: "2.1.0" },
    "node_modules/fsevents": { version: "2.3.3", optional: true },
  },
}

/** A task folder with a lockfile, an installed tree npm would leave behind, and turn.json `deps`. */
function task(name: string, { lock = LOCK, install = true, maxMb = 2048 }: { lock?: object; install?: boolean; maxMb?: number } = {}) {
  const dir = path.join(root, name)
  const work = path.join(dir, "work")
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify({ deps: { npm: true, dir: store, maxMb } }))
  install ? npmInstall(work, lock) : fs.writeFileSync(path.join(work, "package-lock.json"), JSON.stringify(lock))
  return { dir, work, nm: path.join(work, "node_modules") }
}

/** What `npm ci` leaves in work/: package-lock.json, node_modules with its hidden lockfile, a .bin link, a vite cache. */
function npmInstall(work: string, lock: object = LOCK) {
  fs.writeFileSync(path.join(work, "package-lock.json"), JSON.stringify(lock))
  const nm = path.join(work, "node_modules")
  const pkgs = (lock as typeof LOCK).packages
  for (const [k, v] of Object.entries(pkgs)) {
    if (!k || ("optional" in v && v.optional)) continue
    fs.mkdirSync(path.join(work, k), { recursive: true })
    fs.writeFileSync(path.join(work, k, "index.js"), `module.exports = ${JSON.stringify(k)}\n`)
    fs.writeFileSync(path.join(work, k, "package.json"), JSON.stringify({ name: k.slice("node_modules/".length), version: v.version }))
  }
  fs.mkdirSync(path.join(nm, ".bin"), { recursive: true })
  fs.symlinkSync("../left/index.js", path.join(nm, ".bin", "left"))
  fs.mkdirSync(path.join(nm, ".vite"), { recursive: true })
  fs.writeFileSync(path.join(nm, ".vite", "deps.json"), "{}")
  const hidden = Object.fromEntries(Object.entries(pkgs).filter(([k, v]) => k && !("optional" in v && v.optional)))
  fs.writeFileSync(path.join(nm, ".package-lock.json"), JSON.stringify({ name: "app", lockfileVersion: 3, packages: hidden }))
}

function deps(dir: string, step: "save" | "restore") {
  const r = spawnSync(process.execPath, [runner, "deps", dir, step], { encoding: "utf8" })
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(r.stdout.trim()) as Record<string, any> | null
}

const entries = () => (fs.existsSync(path.join(store, "npm")) ? fs.readdirSync(path.join(store, "npm")) : [])

describe("dependency cache", () => {
  it("saves a matching node_modules as read-only hard links and restores it into a task without one", async () => {
    const a = task("a")
    const saved = deps(a.dir, "save")!
    expect(saved).toMatchObject({ ecosystem: "npm", action: "saved" })
    expect(entries()).toEqual([saved.key])

    const entry = path.join(store, "npm", saved.key)
    const meta = JSON.parse(fs.readFileSync(path.join(entry, "meta.json"), "utf8"))
    expect(meta).toMatchObject({ ecosystem: "npm", key: saved.key, node: process.version, files: 5 })
    expect(meta.bytes).toBeGreaterThan(0)
    const cached = path.join(entry, "node_modules", "left", "index.js")
    const st = fs.statSync(cached)
    expect(st.mode & 0o222).toBe(0)
    expect(st.nlink).toBe(2)
    expect(st.ino).toBe(fs.statSync(path.join(a.nm, "left", "index.js")).ino)
    // Per-task tool output stays out of the store; symlinks stay symlinks.
    expect(fs.existsSync(path.join(entry, "node_modules", ".vite"))).toBe(false)
    expect(fs.readlinkSync(path.join(entry, "node_modules", ".bin", "left"))).toBe("../left/index.js")
    // A shared file can't be edited in place.
    expect(() => fs.appendFileSync(cached, "oops")).toThrow(/EACCES|EPERM/)

    expect(deps(a.dir, "save")).toMatchObject({ action: "present", key: saved.key })

    const b = task("b", { install: false })
    const restored = deps(b.dir, "restore")!
    expect(restored).toMatchObject({ ecosystem: "npm", action: "restored", key: saved.key, files: 5 })
    expect(fs.statSync(path.join(b.nm, "left", "index.js")).ino).toBe(st.ino)
    expect(fs.statSync(path.join(b.nm, "@scope", "right", "index.js")).isFile()).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(b.nm, ".boxyard-deps.json"), "utf8"))).toEqual({ ecosystem: "npm", key: saved.key })
    expect(fs.readFileSync(path.join(b.nm, ".package-lock.json"), "utf8")).toContain("node_modules/left")
    // A task that already has node_modules (installed or symlinked) is left alone.
    expect(deps(b.dir, "restore")).toBeNull()
  })

  it("misses on another lockfile and does nothing when the cache is off or there's no lockfile", async () => {
    deps(task("a").dir, "save")
    const other = { ...LOCK, packages: { ...LOCK.packages, "node_modules/left": { version: "1.0.1" } } }
    expect(deps(task("b", { lock: other, install: false }).dir, "restore")).toMatchObject({ action: "miss" })

    const off = task("c", { install: false })
    fs.writeFileSync(path.join(off.dir, "turn.json"), "{}")
    expect(deps(off.dir, "restore")).toBeNull()
    expect(fs.existsSync(off.nm)).toBe(false)

    const none = task("d", { install: false })
    fs.rmSync(path.join(none.work, "package-lock.json"))
    expect(deps(none.dir, "restore")).toBeNull()
  })

  it("doesn't save a tree that differs from the lockfile, nests node_modules, or holds addons built for another Node", async () => {
    const drift = task("drift")
    fs.mkdirSync(path.join(drift.nm, "extra"))
    const hidden = JSON.parse(fs.readFileSync(path.join(drift.nm, ".package-lock.json"), "utf8"))
    hidden.packages["node_modules/extra"] = { version: "0.0.1" }
    fs.writeFileSync(path.join(drift.nm, ".package-lock.json"), JSON.stringify(hidden))
    expect(deps(drift.dir, "save")).toMatchObject({ action: "skipped", reason: "node_modules doesn't match package-lock.json" })

    const stale = task("stale")
    fs.rmSync(path.join(stale.nm, ".package-lock.json"))
    expect(deps(stale.dir, "save")).toMatchObject({ action: "skipped" })

    const nested = { ...LOCK, packages: { ...LOCK.packages, "packages/web/node_modules/left": { version: "0.9.0" } } }
    expect(deps(task("nested", { lock: nested }).dir, "save")).toMatchObject({ action: "skipped", reason: expect.stringMatching(/^nested node_modules/) })

    const native = task("native")
    fs.mkdirSync(path.join(native.nm, "@scope", "right", "build"))
    fs.writeFileSync(path.join(native.nm, "@scope", "right", "build", "config.gypi"), `{ "variables": { "node_module_version": 1 } }`)
    expect(deps(native.dir, "save")).toMatchObject({ action: "skipped", reason: "native addons built for another Node (ABI 1)" })

    const ours = task("ours")
    fs.mkdirSync(path.join(ours.nm, "left", "build"))
    fs.writeFileSync(path.join(ours.nm, "left", "build", "config.gypi"), `{ "variables": { "node_module_version": ${process.versions.modules} } }`)
    expect(deps(ours.dir, "save")).toMatchObject({ action: "saved" })

    expect(entries()).toHaveLength(1)
  })

  it("evicts the least recently used unlinked entries over the size budget, never one a task still uses", async () => {
    const lock = (v: string) => ({ ...LOCK, packages: { ...LOCK.packages, "node_modules/left": { version: v } } })
    const linked = task("linked", { lock: lock("1.0.1") })
    const keyLinked = deps(linked.dir, "save")!.key
    const unlinked = task("unlinked", { lock: lock("1.0.2") })
    const keyUnlinked = deps(unlinked.dir, "save")!.key
    fs.rmSync(unlinked.nm, { recursive: true }) // that task's node_modules is gone, so its entry frees disk
    // Make both entries older than the next save, and weigh more than the budget.
    for (const key of [keyLinked, keyUnlinked]) {
      const file = path.join(store, "npm", key, "meta.json")
      const meta = JSON.parse(fs.readFileSync(file, "utf8"))
      fs.writeFileSync(file, JSON.stringify({ ...meta, lastUsed: 1, bytes: 200 * 1024 * 1024 }))
    }
    const newest = deps(task("newest", { lock: lock("1.0.3"), maxMb: 100 }).dir, "save")!
    expect(newest).toMatchObject({ action: "saved", evicted: [keyUnlinked] })
    expect(entries().sort()).toEqual([keyLinked, newest.key].sort())
  })

  it("the janitor's prune removes entries no task links, or the whole store when clearing", async () => {
    const lock = (v: string) => ({ ...LOCK, packages: { ...LOCK.packages, "node_modules/left": { version: v } } })
    const kept = task("kept", { lock: lock("1.0.1") })
    const keyKept = deps(kept.dir, "save")!.key
    const gone = task("gone", { lock: lock("1.0.2") })
    const keyGone = deps(gone.dir, "save")!.key
    fs.rmSync(gone.nm, { recursive: true })

    const sh = (all: boolean) => spawnSync("sh", ["-c", depsPruneScript(root, all)], { encoding: "utf8" })
    const r = sh(false)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim().split("\n")).toEqual([`${store}/npm/${keyGone}/`])
    expect(entries()).toEqual([keyKept])

    expect(sh(true).status).toBe(0)
    expect(fs.existsSync(store)).toBe(false)
    // The task's own copy is untouched.
    expect(fs.readFileSync(path.join(kept.nm, "left", "index.js"), "utf8")).toContain("left")
  })
})

describe("dependency cache in turns", () => {
  const running: { yard: BoxYard; server: Server }[] = []
  afterEach(async () => {
    for (const r of running.splice(0)) {
      r.yard.stop()
      await new Promise((res) => r.server.close(() => res(null)))
    }
  })

  it("follows Settings unless the project overrides it, saves after a turn and restores before the next", async () => {
    const port = await freePort()
    const config = testConfig({ port })
    const yard = createBoxYard(config, { webDir: "/nonexistent" })
    const server = await new Promise<Server>((resolve) => {
      const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
    })
    await yard.start()
    running.push({ yard, server })
    const call = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
      const res = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
      if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${await res.text()}`)
      return (await res.json()) as T
    }
    const done = (id: string) => waitFor(async () => {
      const t = await call<Task>("GET", `/tasks/${id}`)
      return t.status === "done" && t.pendingCount === 0 ? t : null
    }, `task ${id} to be done`)
    const turnDeps = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "turn.json"), "utf8")).deps
    const turn = async (id: string, content: string) => {
      await call("POST", `/tasks/${id}/messages`, { content })
      return done(id)
    }

    const p = await call<Project>("POST", "/projects", { name: "alpha" })
    expect(p.depCache).toBeNull()
    const t = await done((await call<Task>("POST", "/tasks", { projectId: p.id, title: "one", prompt: "write a haiku" })).id)
    const dir = yard.tasks.taskDir(t.boxId!, t.id)
    const work = path.join(dir, "work")
    expect(turnDeps(dir)).toBeUndefined() // off by default

    await call("PUT", "/agent-settings", { depCacheEnabled: true, depCacheMaxMb: 512 })
    npmInstall(work)
    await turn(t.id, "install deps")
    const deps = turnDeps(dir)
    expect(deps).toEqual({ npm: true, dir: path.join(config.dataDir, "local-boxes", t.boxId!, ".boxyard", "deps"), maxMb: 512 })
    const saved = fs.readdirSync(path.join(deps.dir, "npm"))
    expect(saved).toHaveLength(1)

    fs.rmSync(path.join(work, "node_modules"), { recursive: true })
    await turn(t.id, "run the tests")
    expect(fs.statSync(path.join(work, "node_modules", "left", "index.js")).nlink).toBe(2)
    const events = yard.store.listTaskMessages(t.id, 500).filter((m) => m.role === "event").map((m) => m.content)
    expect(events.filter((e) => e.startsWith("Restored node_modules from the box's dependency cache in "))).toHaveLength(1)
    const demo = fs.readFileSync(path.join(work, "box-yard-demo.md"), "utf8")
    expect(demo).toContain("[Box Yard] Box Yard restored node_modules from this box's dependency cache")

    // The project's "off" wins over Settings.
    expect((await call<Project>("PATCH", `/projects/${p.id}`, { depCache: false })).depCache).toBe(false)
    await turn(t.id, "and again")
    expect(turnDeps(dir)).toBeUndefined()
    expect((await call<Project>("PATCH", `/projects/${p.id}`, { depCache: null })).depCache).toBeNull()
  })
})

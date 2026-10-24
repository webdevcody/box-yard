import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { captainCompactionsDir, findCompactionRecord, lastCompaction, listCompactions, readCompactionRecords, writeCompaction } from "../server/compactions.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { CaptainMessage, CaptainState, CompactionTaskSnapshot, Project, Task } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// #52: list_compactions, read_compaction and find_compactions_by_task see Captain compactions,
// and a Captain only sees its own project's.

const SUMMARY = "## Decisions and preferences\n- Cody wants short replies.\n\n## Ongoing work\n- none\n"
const meta = (at: number) => ({ at, sessionId: "s1", model: "claude-opus-5-5", trigger: "button" as const, tokensBefore: 50_000, heading: "Captain compaction summary: demo" })
const snapshot = (taskId: string): CompactionTaskSnapshot => ({
  taskId,
  title: "Snapshotted",
  status: "idle",
  projectId: "prj_demo01",
  projectName: "demo",
  branch: null,
  prUrl: null,
  sessionId: "s2",
  summary: "Outcome: done",
  lastActiveAt: 1,
})

describe("Captain compaction records", () => {
  it("links a compaction to tasks it snapshotted or named, newest first, and reads older files without a sidecar", () => {
    const dir = tmpDir()
    writeCompaction(dir, meta(Date.parse("2026-10-20T10:00:00Z")), SUMMARY, [snapshot("task_snapped01")])
    writeCompaction(dir, meta(Date.parse("2026-10-21T10:00:00Z")), `${SUMMARY}- task_named0001 is waiting on a review.\n`)
    // An older Captain file: frontmatter only, no task_ids line and no JSON sidecar.
    fs.writeFileSync(
      path.join(dir, "2026-10-19T10-00-00Z.md"),
      "---\ntimestamp: 2026-10-19T10:00:00Z\nsession_id: old\nmodel: m\ntrigger: auto\ntokens_before: 9\ntokens_after: 1\n---\n\n# Captain compaction summary: demo\n\nSee task_named0001.\n",
    )

    expect(readCompactionRecords(dir).map((c) => c.id)).toEqual(["2026-10-21T10-00-00Z", "2026-10-20T10-00-00Z", "2026-10-19T10-00-00Z"])
    expect(readCompactionRecords(dir, { limit: 1 }).map((c) => c.id)).toEqual(["2026-10-21T10-00-00Z"])
    const snapped = readCompactionRecords(dir, { taskId: "task_snapped01" })
    expect(snapped.map((c) => c.id)).toEqual(["2026-10-20T10-00-00Z"])
    expect(snapped[0]).toMatchObject({ sessionId: "s1", model: "claude-opus-5-5", taskCount: 1, tasks: [{ taskId: "task_snapped01" }] })
    expect(readCompactionRecords(dir, { taskId: "task_named0001" }).map((c) => c.id)).toEqual(["2026-10-21T10-00-00Z", "2026-10-19T10-00-00Z"])
    expect(readCompactionRecords(dir, { taskId: "task_nowhere01" })).toEqual([])

    const old = findCompactionRecord(dir, "2026-10-19T10-00-00Z")!
    expect(old).toMatchObject({ sessionId: "old", trigger: "auto", tokensBefore: 9, tokensAfter: 1, tasks: [], taskIds: ["task_named0001"] })
    expect(old.markdown).toContain("See task_named0001.")
    expect(findCompactionRecord(dir, "../../etc/passwd")).toBeNull()
    expect(readCompactionRecords(path.join(dir, "missing"))).toEqual([])
  })

  it("orders two compactions from the same second oldest first", () => {
    const dir = tmpDir()
    const at = Date.parse("2026-10-20T10:00:00Z")
    writeCompaction(dir, meta(at), SUMMARY)
    writeCompaction(dir, meta(at + 300), SUMMARY)
    expect(listCompactions(dir)).toEqual(["2026-10-20T10-00-00Z.md", "2026-10-20T10-00-00Z-2.md"])
    expect(lastCompaction(dir)!.file).toBe(path.join(dir, "2026-10-20T10-00-00Z-2.md"))
    expect(readCompactionRecords(dir).map((c) => c.id)).toEqual(["2026-10-20T10-00-00Z-2", "2026-10-20T10-00-00Z"])
  })
})

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port })
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, dataDir: config.dataDir }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

type ToolRes = { content: { text: string }[]; isError?: boolean }

async function mcpAs(r: Running, caller: McpCaller) {
  const y = r.yard
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024) }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  const raw = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes
  const json = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const res = await raw(name, args)
    if (res.isError) throw new Error(`${name}: ${res.content[0]!.text}`)
    return JSON.parse(res.content[0]!.text)
  }
  return { raw, json }
}

function parkedTask(r: Running, projectId: string, title: string, status: Task["status"] = "idle"): Task {
  const t = r.yard.store.createTask({ projectId, title, prompt: title })
  r.yard.store.updateTask(t.id, { status })
  return r.yard.store.getTask(t.id)!
}

describe("compaction tools and Captain compactions (#52)", () => {
  it("snapshots the project's tasks in a Captain compaction and finds it by task", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "alpha" })
    const other = await call<Project>(r, "POST", "/api/projects", { name: "beta" })
    const active = parkedTask(r, p.id, "Active work")
    const finished = parkedTask(r, p.id, "Finished work", "done")
    const elsewhere = parkedTask(r, other.id, "Beta work")
    // The done task last moved, and was last mentioned, long ago.
    r.yard.store.db.prepare("UPDATE tasks SET updated_at = 1 WHERE id = ?").run(finished.id)
    const notice = r.yard.store.addCaptainMessage(p.id, "notice", `✅ **Finished work** is done: shipped (${finished.id})`, { taskId: finished.id })
    r.yard.store.db.prepare("UPDATE captain_messages SET created_at = 1 WHERE id = ?").run(notice.id)

    const state = () => call<CaptainState>(r, "GET", `/api/projects/${p.id}/captain`)
    const idle = async () => {
      const s = await state()
      return !s.busy && !s.compacting && !s.compactQueued ? s : null
    }
    const dir = captainCompactionsDir(r.dataDir, p.id)
    const ids = () => fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort()
    const compact = async (n: number) => {
      await call(r, "POST", `/api/projects/${p.id}/captain/compact`)
      return waitFor(async () => {
        const s = await idle()
        return s?.lastCompaction && ids().length === n ? s : null
      }, `Captain compaction ${n}`)
    }
    await call(r, "POST", `/api/projects/${p.id}/captain/messages`, { content: "status" })
    await waitFor(async () => (await idle()) && (await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)).some((m) => m.role === "assistant"), "Captain reply")
    const after = await compact(1)
    const [first] = ids()
    // The first compaction covers everything the project ever did, and only this project.
    const text = fs.readFileSync(after.lastCompaction!.file, "utf8")
    expect(text).toMatch(new RegExp(`^task_ids: .*${active.id}`, "m"))
    expect(text).toContain(finished.id)
    expect(text).not.toContain(elsewhere.id)
    // The next one only what's active, updated or mentioned since.
    await compact(2)
    const second = ids().find((x) => x !== first)!
    expect(fs.readFileSync(path.join(dir, `${second}.md`), "utf8")).not.toContain(finished.id)

    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const found = await coordinator.json("find_compactions_by_task", { task: active.id })
    expect(found.orchestratorCompactions).toEqual([])
    expect(found.captainCompactions.map((c: { id: string }) => c.id)).toEqual([second, first])
    expect(found.captainCompactions[1]).toMatchObject({ captain: p.id, trigger: "button", tokensAfter: after.lastCompaction!.tokensAfter })
    expect(found.captainCompactions[1].tasks.map((t: { id: string }) => t.id).sort()).toEqual([active.id, finished.id].sort())
    expect(found.captainCompactions[0].markdown).toBeUndefined()
    expect((await coordinator.json("find_compactions_by_task", { task: finished.id })).captainCompactions.map((c: { id: string }) => c.id)).toEqual([first])
    expect((await coordinator.json("find_compactions_by_task", { task: elsewhere.id })).captainCompactions).toEqual([])

    // Without project the Coordinator still gets its own list; with it, the Captain's.
    expect(await coordinator.json("list_compactions")).toEqual([])
    expect((await coordinator.json("list_compactions", { project: "alpha" })).map((c: { id: string }) => c.id)).toEqual([second, first])
    expect((await coordinator.json("list_compactions", { project: "alpha", task: finished.id, limit: 5 })).map((c: { id: string }) => c.id)).toEqual([first])
    expect(await coordinator.json("list_compactions", { project: "beta" })).toEqual([])
    const read = await coordinator.json("read_compaction", { compaction: first, project: p.id })
    expect(read.markdown).toContain("# Captain compaction summary: alpha")
    expect(read.markdown).toContain("## Decisions and preferences")
    const notCoordinators = await coordinator.raw("read_compaction", { compaction: first })
    expect(notCoordinators.isError).toBe(true)
    expect(notCoordinators.content[0]!.text).toMatch(/No Coordinator compaction .*pass project/)

    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    const own = await captain.json("find_compactions_by_task", { task: finished.id })
    expect(own.orchestratorCompactions).toBeUndefined()
    expect(own.captainCompactions.map((c: { id: string }) => c.id)).toEqual([first])
    expect((await captain.json("list_compactions")).map((c: { id: string }) => c.id)).toEqual([second, first])
    expect((await captain.json("read_compaction", { compaction: first })).markdown).toContain("## Decisions and preferences")
  })

  it("keeps a Captain to its own project's compactions", async () => {
    const r = await start()
    const a = await call<Project>(r, "POST", "/api/projects", { name: "alpha" })
    const b = await call<Project>(r, "POST", "/api/projects", { name: "beta" })
    const ta = parkedTask(r, a.id, "Alpha work")
    const tb = parkedTask(r, b.id, "Beta work")
    // Both Captains' summaries name both tasks, so only the project scope keeps them apart.
    const both = `${SUMMARY}- ${ta.id} and ${tb.id}\n`
    writeCompaction(captainCompactionsDir(r.dataDir, a.id), meta(Date.parse("2026-10-20T10:00:00Z")), both)
    writeCompaction(captainCompactionsDir(r.dataDir, b.id), meta(Date.parse("2026-10-21T10:00:00Z")), both)

    const alpha = await mcpAs(r, { kind: "captain", projectId: a.id })
    expect((await alpha.json("list_compactions")).map((c: { id: string }) => c.id)).toEqual(["2026-10-20T10-00-00Z"])
    expect((await alpha.json("list_compactions", { task: ta.id })).map((c: { id: string }) => c.id)).toEqual(["2026-10-20T10-00-00Z"])
    expect((await alpha.json("find_compactions_by_task", { task: ta.id })).captainCompactions.map((c: { id: string }) => c.id)).toEqual(["2026-10-20T10-00-00Z"])
    for (const [name, args] of [
      ["list_compactions", { project: "beta" }],
      ["list_compactions", { task: tb.id }],
      ["read_compaction", { compaction: "2026-10-21T10-00-00Z", project: b.id }],
      ["find_compactions_by_task", { task: tb.id }],
    ] as const) {
      const res = await alpha.raw(name, args)
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true)
      expect(res.content[0]!.text).toMatch(/^Out of scope: /)
    }
    // Beta's id isn't in alpha's folder, and a path can't reach it either.
    for (const compaction of ["2026-10-21T10-00-00Z", `../../${b.id}/compactions/2026-10-21T10-00-00Z`]) {
      const res = await alpha.raw("read_compaction", { compaction })
      expect(res.isError).toBe(true)
      expect(res.content[0]!.text).toMatch(/^No Captain compaction/)
    }

    const coordinator = await mcpAs(r, { kind: "coordinator" })
    expect((await coordinator.json("find_compactions_by_task", { task: tb.id })).captainCompactions.map((c: { id: string }) => c.id)).toEqual(["2026-10-21T10-00-00Z"])
    expect((await coordinator.json("read_compaction", { compaction: "2026-10-21T10-00-00Z", project: "beta" })).captain).toBe(b.id)
  })
})

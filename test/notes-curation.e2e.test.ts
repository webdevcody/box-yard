import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { CaptainMessage, ChatMessage, NoteSuggestion, Project, Task } from "../shared/types.js"
import { UNRESOLVED_REASON } from "../server/retro.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Project notes, curated: agents suggest, the Captain alone decides (Cody only edits notes by hand). Real HTTP
// and MCP, fake-claude for the worker and Captain turns.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []

async function start({ captainTurns = false } = {}): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port })
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  // Most tests here are about the notes, not the Captain's turns: keep its wake-ups far away unless asked.
  yard.captains.tuning.wakeDebounceMs = captainTurns ? 100 : 10 * 60_000
  yard.retro.tuning.debounceMs = 50
  yard.retro.tuning.maxWaitMs = 500
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, dataDir: config.dataDir }
  running.push(r)
  return r
}

afterEach(async () => {
  delete process.env.FAKE_RETRO
  delete process.env.FAKE_CLAUDE_LOG
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    // Let any Captain turn finish before the database closes under it.
    await waitFor(() => !r.yard.captains.anyBusy() || null, "Captains to go idle", 30_000).catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`), { status: res.status })
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
  const tool = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await tool(name, args)
    expect(res.isError, `${name}: ${res.content[0]?.text}`).not.toBe(true)
    const text = res.content[0]!.text
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return { client, tool, ok }
}

function parkedTask(r: Running, projectId: string, title: string): Task {
  const t = r.yard.store.createTask({ projectId, title, prompt: title })
  return r.yard.store.updateTask(t.id, { status: "idle" })
}

const suggest = (r: Running, t: Task, content: string, why = "a future agent would get it wrong") =>
  r.yard.store.addNoteSuggestion({ projectId: t.projectId, taskId: t.id, taskTitle: t.title, content, why })

const captainNotices = (r: Running, projectId: string, kind?: string): CaptainMessage[] =>
  r.yard.store.listCaptainMessages(projectId).filter((m) => m.role === "notice" && (!kind || m.meta?.kind === kind))

async function twoProjects(r: Running) {
  const a = await call<Project>(r, "POST", "/api/projects", { name: "alpha" })
  const b = await call<Project>(r, "POST", "/api/projects", { name: "beta" })
  return { a, b, ta: parkedTask(r, a.id, "Alpha work"), tb: parkedTask(r, b.id, "Beta work") }
}

describe("Captain note tools", () => {
  it("can't read or change another project's notes or suggestions", async () => {
    const r = await start()
    const { a, b, ta, tb } = await twoProjects(r)
    const betaNote = r.yard.store.addNote(b.id, "Ana", "Beta deploys from the release branch")
    const betaSug = suggest(r, tb, "Beta uses yarn")
    const alphaSug = suggest(r, ta, "Alpha uses pnpm")
    const { tool } = await mcpAs(r, { kind: "captain", projectId: a.id })
    const denied: [string, Record<string, unknown>][] = [
      ["list_notes", { project: "beta" }],
      ["add_note", { project: b.id, content: "sneaky" }],
      ["update_note", { note: betaNote.id, content: "rewritten" }],
      ["delete_note", { note: betaNote.id }],
      ["list_note_suggestions", { project: "beta" }],
      ["list_note_suggestions", { task: tb.id }],
      ["resolve_suggestion", { suggestion: betaSug.id, action: "accept", reason: "useful" }],
      ["resolve_suggestion", { suggestion: betaSug.id, action: "reject", reason: "not useful" }],
      // Its own suggestion, merged into another project's note.
      ["resolve_suggestion", { suggestion: alphaSug.id, action: "merge", note: betaNote.id, content: "merged", reason: "overlaps" }],
    ]
    for (const [name, args] of denied) {
      const res = await tool(name, args)
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true)
      expect(res.content[0]!.text, name).toMatch(/^Out of scope: .*You are the Captain for project "alpha"/)
    }
    expect(r.yard.store.listNotes(b.id)).toMatchObject([{ id: betaNote.id, content: "Beta deploys from the release branch", updatedBy: null }])
    expect(r.yard.store.getNoteSuggestion(betaSug.id)!.status).toBe("pending")
    expect(r.yard.store.getNoteSuggestion(alphaSug.id)!.status).toBe("pending")
    expect(r.yard.store.listNotes(a.id)).toHaveLength(0)
    // Unknown ids say so without leaking anything.
    expect((await tool("update_note", { note: "note_nope", content: "x" })).content[0]!.text).toMatch(/No note "note_nope"/)
  })

  it("curates its own project's notes: list with ids, add, rewrite, delete, accept, merge, reject", async () => {
    const r = await start()
    const { a, ta } = await twoProjects(r)
    const { ok, tool } = await mcpAs(r, { kind: "captain", projectId: a.id })
    const added = await ok("add_note", { content: "Run tests with npm test" })
    expect(added).toMatchObject({ added: expect.stringMatching(/^note_/), budget: "1 of 25 notes, ~9 of 4k tokens" })
    const listed = await ok("list_notes")
    expect(listed).toMatchObject({ project: "alpha", notes: [{ id: added.added, content: "Run tests with npm test", author: "captain" }] })

    await ok("update_note", { note: added.added, content: "Run tests with npm test; e2e files alone" })
    const edited = r.yard.store.getNote(added.added)!
    expect(edited).toMatchObject({ content: "Run tests with npm test; e2e files alone", updatedBy: "captain" })
    expect(edited.updatedAt).toBeGreaterThanOrEqual(edited.createdAt)

    const s1 = suggest(r, ta, "use pnpm", "npm breaks the lockfile")
    const s2 = suggest(r, ta, "flaky: retention.e2e")
    const s3 = suggest(r, ta, "Merged PR #12, all green")
    const pending = await ok("list_note_suggestions")
    expect(pending.suggestions.map((s: { id: string }) => s.id)).toEqual([s1.id, s2.id, s3.id])
    expect(pending.suggestions[0]).toMatchObject({ content: "use pnpm", why: "npm breaks the lockfile", task: `${ta.id} Alpha work`, status: "pending" })

    // Every decision needs its one-line reason: the Notes tab shows it.
    const noReason = await tool("resolve_suggestion", { suggestion: s1.id, action: "accept" })
    expect(noReason.isError).toBe(true)
    expect(r.yard.store.getNoteSuggestion(s1.id)!.status).toBe("pending")
    const accepted = await ok("resolve_suggestion", {
      suggestion: s1.id,
      action: "accept",
      content: "Use pnpm, never npm: npm rewrites the lockfile.",
      reason: "A lasting\n  rule agents would   get wrong.",
    })
    expect(accepted).toMatchObject({ accepted: s1.id, note: expect.stringMatching(/^note_/), pendingSuggestions: 2 })
    expect(r.yard.store.getNote(accepted.note)).toMatchObject({ author: "captain", content: "Use pnpm, never npm: npm rewrites the lockfile." })
    expect(r.yard.store.getNoteSuggestion(s1.id)).toMatchObject({ status: "accepted", resolvedBy: "captain", reason: "A lasting rule agents would get wrong." })

    const merged = await ok("resolve_suggestion", { suggestion: s2.id, action: "merge", note: added.added, content: "Run tests with npm test; rerun retention.e2e alone if it flakes", reason: "Same topic as the test note." })
    expect(merged).toMatchObject({ merged: s2.id, note: added.added })
    expect(r.yard.store.getNote(added.added)!.content).toBe("Run tests with npm test; rerun retention.e2e alone if it flakes")

    await ok("resolve_suggestion", { suggestion: s3.id, action: "reject", reason: "a run log, not a rule" })
    expect(r.yard.store.getNoteSuggestion(s3.id)).toMatchObject({ status: "rejected", resolvedBy: "captain", reason: "a run log, not a rule" })
    const again = await tool("resolve_suggestion", { suggestion: s3.id, action: "accept", reason: "changed my mind" })
    expect(again.isError).toBe(true)
    expect(again.content[0]!.text).toMatch(/already rejected by captain/)
    const bad = await tool("resolve_suggestion", { suggestion: s3.id, action: "merge", reason: "overlaps" })
    expect(bad.isError).toBe(true)

    expect((await ok("list_note_suggestions")).suggestions).toEqual([])
    expect((await ok("list_note_suggestions", { status: "all" })).suggestions.map((s: NoteSuggestion) => s.status)).toEqual(["accepted", "merged", "rejected"])

    await ok("delete_note", { note: accepted.note })
    expect(r.yard.store.listNotes(a.id).map((n) => n.id)).toEqual([added.added])
    // save_note is the Coordinator's.
    expect((await tool("save_note", { project: "alpha", content: "x" })).content[0]!.text).toMatch(/not found/)
  })

  it("lets the Coordinator curate any project's notes, naming the project", async () => {
    const r = await start()
    const { b, tb } = await twoProjects(r)
    const { ok, tool } = await mcpAs(r, { kind: "coordinator" })
    expect((await tool("list_notes")).content[0]!.text).toMatch(/Pass project/)
    const saved = await ok("save_note", { project: "beta", content: "Beta deploys on Fridays only" })
    expect(r.yard.store.getNote(saved.saved)).toMatchObject({ author: "orchestrator", projectId: b.id })
    const s = suggest(r, tb, "Beta uses yarn")
    await ok("resolve_suggestion", { suggestion: s.id, action: "accept", reason: "Beta's package manager." })
    expect((await ok("list_notes", { project: "beta" })).notes.map((n: { author: string }) => n.author)).toEqual(["orchestrator", "orchestrator"])
    expect((await ok("list_projects")).find((p: { name: string }) => p.name === "beta").notes).toHaveLength(2)
  })
})

describe("notes budget", () => {
  it("tells the Captain once when the notes go over budget, and again only after they fit and overflow again", async () => {
    const r = await start()
    const { a } = await twoProjects(r)
    await call(r, "PUT", "/api/agent-settings", { notesMaxCount: 2 })
    const add = (content: string) => call<Project>(r, "POST", `/api/projects/${a.id}/notes`, { content })
    await add("one")
    await add("two")
    expect(captainNotices(r, a.id, "notes_budget")).toHaveLength(0)
    const p = await add("three")
    expect(p.notes.map((n) => n.author)).toEqual(["Cody", "Cody", "Cody"])
    const notices = captainNotices(r, a.id, "notes_budget")
    expect(notices).toHaveLength(1)
    expect(notices[0]!.content).toMatch(/^📝 Project notes are over budget \(3 of 2 notes, ~\d+ of 4k tokens\)\. Agents only get the newest notes that fit, so 1 note is left out/)
    expect(notices[0]!.meta).toMatchObject({ loopKey: `notes_budget:${a.id}` })

    // Still over: no repeat. The Captain's own add shows the budget in its result instead.
    await add("four")
    const { ok } = await mcpAs(r, { kind: "captain", projectId: a.id })
    const res = await ok("add_note", { content: "five" })
    expect(res).toMatchObject({ overBudget: true, prune: expect.stringContaining("Prune them") })
    expect((await ok("list_notes")).notes.filter((n: { leftOut?: boolean }) => n.leftOut)).toHaveLength(3)
    expect(captainNotices(r, a.id, "notes_budget")).toHaveLength(1)

    // Pruned back under budget, then over again: a new notice.
    for (const n of r.yard.store.listNotes(a.id).slice(0, 4)) await call(r, "DELETE", `/api/projects/${a.id}/notes/${n.id}`)
    expect(r.yard.store.listNotes(a.id)).toHaveLength(1)
    await add("six")
    expect(captainNotices(r, a.id, "notes_budget")).toHaveLength(1)
    await add("seven")
    expect(captainNotices(r, a.id, "notes_budget")).toHaveLength(2)
  })

  it("re-checks every project when Settings lowers the budget", async () => {
    const r = await start()
    const { a, b } = await twoProjects(r)
    for (const c of ["one", "two", "three"]) await call(r, "POST", `/api/projects/${a.id}/notes`, { content: c })
    expect(captainNotices(r, a.id, "notes_budget")).toHaveLength(0)
    await call(r, "PUT", "/api/agent-settings", { notesMaxTokens: 200, notesMaxCount: 2 })
    expect(captainNotices(r, a.id, "notes_budget")).toHaveLength(1)
    expect(captainNotices(r, b.id, "notes_budget")).toHaveLength(0)
    await expect(call(r, "PUT", "/api/agent-settings", { notesMaxCount: 0 })).rejects.toThrow(/400/)
  })

  it("a project's own budget wins over Settings in the Captain's budget, the prune notice and its prompt", async () => {
    const r = await start()
    const { a, b } = await twoProjects(r)
    for (const p of [a, b]) for (const c of ["one", "two", "three"]) await call(r, "POST", `/api/projects/${p.id}/notes`, { content: c })
    expect(captainNotices(r, a.id, "notes_budget")).toHaveLength(0)

    const patched = await call<Project>(r, "PATCH", `/api/projects/${a.id}`, { notesMaxCount: 2, notesMaxTokens: 1000 })
    expect(patched).toMatchObject({ notesMaxCount: 2, notesMaxTokens: 1000 })
    const notices = captainNotices(r, a.id, "notes_budget")
    expect(notices).toHaveLength(1)
    expect(notices[0]!.content).toMatch(/^📝 Project notes are over budget \(3 of 2 notes, ~\d+ of 1k tokens\)/)
    expect(captainNotices(r, b.id, "notes_budget")).toHaveLength(0)
    expect(r.yard.notes.budgetStatus(b.id).line).toMatch(/^3 of 25 notes/)
    const { ok } = await mcpAs(r, { kind: "captain", projectId: a.id })
    expect(await ok("list_notes")).toMatchObject({ budget: expect.stringMatching(/^3 of 2 notes, ~\d+ of 1k tokens$/) })

    // Its Captain is told the project's own budget.
    const log = path.join(tmpDir(), "fake-claude.log")
    process.env.FAKE_CLAUDE_LOG = log
    r.yard.captains.tuning.wakeDebounceMs = 50
    await call(r, "POST", `/api/projects/${a.id}/captain/messages`, { content: "status" })
    await waitFor(() => (fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("You are the Box Yard Captain") && !r.yard.captains.anyBusy()) || null, "the Captain's turn", 30_000)
    expect(fs.readFileSync(log, "utf8")).toContain("Their budget is 2 notes or about 1k tokens (Max notes in Cody's Settings, or this project's own)")

    // Cleared, it's Settings' budget again; out of range is refused.
    expect(await call<Project>(r, "PATCH", `/api/projects/${a.id}`, { notesMaxCount: null, notesMaxTokens: null })).toMatchObject({ notesMaxCount: null, notesMaxTokens: null })
    expect(r.yard.notes.budgetStatus(a.id).line).toMatch(/^3 of 25 notes/)
    await expect(call(r, "PATCH", `/api/projects/${a.id}`, { notesMaxCount: 0 })).rejects.toThrow(/400/)
    await expect(call(r, "PATCH", `/api/projects/${a.id}`, { notesMaxTokens: 10 })).rejects.toThrow(/400/)
    // The Coordinator can set it too.
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    await coordinator.ok("update_project", { project: "beta", notes_max: 2 })
    expect(r.yard.store.getProject(b.id)).toMatchObject({ notesMaxCount: 2, notesMaxTokens: null })
    expect(captainNotices(r, b.id, "notes_budget")).toHaveLength(1)
  })
})

describe("Notes tab API", () => {
  it("edits and deletes notes by hand and shows the suggestion history, with no way to approve suggestions", async () => {
    const r = await start()
    await call(r, "PUT", "/api/agent-settings", { ownerName: "Ana" })
    const { a, b, ta, tb } = await twoProjects(r)
    const p = await call<Project>(r, "POST", `/api/projects/${a.id}/notes`, { content: "Use tabs" })
    const noteId = p.notes[0]!.id
    expect(p.notes[0]).toMatchObject({ author: "Ana", updatedBy: null })
    const edited = await call<Project>(r, "PATCH", `/api/projects/${a.id}/notes/${noteId}`, { content: "Use tabs, width 2" })
    expect(edited.notes[0]).toMatchObject({ content: "Use tabs, width 2", updatedBy: "Ana" })

    const s1 = suggest(r, ta, "Run the linter before pushing")
    const s2 = suggest(r, ta, "Merged #4")
    suggest(r, tb, "Beta rule")
    r.yard.store.resolveNoteSuggestion(s2.id, { status: "rejected", by: "captain", reason: "A run log, not a rule." })
    const history = await call<NoteSuggestion[]>(r, "GET", `/api/projects/${a.id}/suggestions?status=all`)
    expect(history.map((s) => [s.id, s.status, s.reason])).toEqual([
      [s1.id, "pending", null],
      [s2.id, "rejected", "A run log, not a rule."],
    ])
    expect((await call<NoteSuggestion[]>(r, "GET", `/api/projects/${a.id}/suggestions`)).map((s) => s.id)).toEqual([s1.id])
    // Nobody approves suggestions from the Notes tab: the Captain decides.
    await expect(call(r, "POST", `/api/projects/${a.id}/suggestions/${s1.id}/resolve`, { action: "accept", reason: "x" })).rejects.toThrow(/404/)
    expect(r.yard.store.getNoteSuggestion(s1.id)!.status).toBe("pending")

    // Only through the project it belongs to.
    const betaNote = r.yard.store.addNote(b.id, "Ana", "Beta note")
    await expect(call(r, "PATCH", `/api/projects/${a.id}/notes/${betaNote.id}`, { content: "x" })).rejects.toThrow(/400/)
    await expect(call(r, "DELETE", `/api/projects/${a.id}/notes/${betaNote.id}`)).rejects.toThrow(/400/)
    await expect(call(r, "PATCH", `/api/projects/${a.id}/notes/${noteId}`, { content: "x".repeat(4001) })).rejects.toThrow(/400/)
    await call(r, "DELETE", `/api/projects/${a.id}/notes/${noteId}`)
    expect(r.yard.store.listNotes(a.id)).toEqual([])
  })
})

const resting = (r: Running, id: string, statuses: string[]) =>
  waitFor(() => {
    const t = r.yard.store.getTask(id)
    return t && statuses.includes(t.status) && !r.yard.store.getTaskRow(id)?.current_turn_id ? t : null
  }, `task ${id} to rest in ${statuses.join("/")}`, 30_000)

describe("notes retro, end to end", () => {
  it("a task that ends done without a PR: its suggestion goes to the Captain, which curates it", async () => {
    const r = await start({ captainTurns: true })
    const project = await call<Project>(r, "POST", "/api/projects", { name: "site" })
    const task = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Write docs", prompt: "Write the docs [note]" })
    await resting(r, task.id, ["done"])

    // The agent's suggest_note is a suggestion, not a note, and its transcript says so.
    const [s] = r.yard.store.listNoteSuggestions({ taskId: task.id })
    expect(s).toMatchObject({ content: "The mock agent says: tests run with npm test.", why: "A future agent would guess the wrong test command." })
    expect(r.yard.store.listTaskMessages(task.id).some((m) => m.content === `Suggested a project note: ${s!.content}`)).toBe(true)

    // The retro wakes the Captain, which accepts it (the mock Captain accepts what a retro lists).
    await waitFor(() => r.yard.store.getNoteSuggestion(s!.id)!.status === "accepted" || null, "the Captain to accept the suggestion", 30_000)
    const retro = captainNotices(r, project.id, "retro")
    expect(retro).toHaveLength(1)
    expect(retro[0]!.content).toContain(`**[Write docs](/tasks/${task.id})** (${task.id}) · done, no PR`)
    expect(retro[0]!.meta).toMatchObject({ taskIds: [task.id], suggestionIds: [s!.id] })
    expect(r.yard.store.listNotes(project.id)).toMatchObject([{ author: "captain", content: s!.content }])
    expect(r.yard.store.getNoteSuggestion(s!.id)).toMatchObject({ resolvedBy: "captain", reason: "mock retro accept" })
    await waitFor(() => !r.yard.captains.anyBusy() || null, "the Captain to finish")
    // "(no update)" stays out of the Coordinator's chat.
    const chat = await call<ChatMessage[]>(r, "GET", "/api/chat")
    expect(chat.some((m) => m.content.includes("(no update)"))).toBe(false)
  })

  it("a merged PR: the retro names the PR", async () => {
    const r = await start({ captainTurns: true })
    const project = await call<Project>(r, "POST", "/api/projects", { name: "site" })
    const task = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Add footer", prompt: "Add a footer [slow] [note] [pr]" })
    await waitFor(() => r.yard.store.getTaskRow(task.id)?.status === "working", "the turn to start")
    const url = "https://github.com/acme/site/pull/7"
    await r.yard.tasks.apply(task.id, { seq: 0, ts: Date.now(), turnId: null, t: "pr", url, number: 7, branch: "boxyard/add-footer" })
    await resting(r, task.id, ["pr_ready"])
    await waitFor(() => r.yard.store.listNoteSuggestions({ taskId: task.id }).length || null, "the suggestion")
    // Waiting for review: no retro yet.
    await new Promise((res) => setTimeout(res, 300))
    expect(captainNotices(r, project.id, "retro")).toHaveLength(0)

    // GitHub says it merged.
    r.yard.tasks.prs.apply(task.id, url, { state: "merged", mergedAt: Date.now(), mergedBy: "ana" })
    await waitFor(() => captainNotices(r, project.id, "retro").length || null, "the retro")
    expect(captainNotices(r, project.id, "retro")[0]!.content).toContain(`PR merged: ${url}`)
    await waitFor(() => r.yard.store.listNotes(project.id).length || null, "the Captain to accept it", 30_000)
  })

  it("batches tasks that finish close together into one retro", async () => {
    const r = await start()
    r.yard.retro.tuning.debounceMs = 60_000
    r.yard.retro.tuning.maxWaitMs = 60_000
    const project = await call<Project>(r, "POST", "/api/projects", { name: "site" })
    const one = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "One", prompt: "one [note]" })
    const two = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Two", prompt: "two [note]" })
    await resting(r, one.id, ["done"])
    await resting(r, two.id, ["done"])
    await waitFor(() => r.yard.retro.queued(project.id).length === 2 || null, "both tasks in the batch")
    r.yard.retro.flush(project.id)
    const retro = captainNotices(r, project.id, "retro")
    expect(retro).toHaveLength(1)
    expect(retro[0]!.content.split("\n")[0]).toBe("📝 **Notes retro**: 2 finished tasks left 2 note suggestions to curate.")
    expect((retro[0]!.meta!.taskIds as string[]).sort()).toEqual([one.id, two.id].sort())
  })

  it("rejects what the Captain left pending when its retro turn ends, so nothing waits", async () => {
    process.env.FAKE_RETRO = "skip"
    const r = await start({ captainTurns: true })
    const project = await call<Project>(r, "POST", "/api/projects", { name: "site" })
    const task = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Write docs", prompt: "Write the docs [note]" })
    await resting(r, task.id, ["done"])
    const [s] = r.yard.store.listNoteSuggestions({ taskId: task.id })
    await waitFor(() => r.yard.store.getNoteSuggestion(s!.id)!.status !== "pending" || null, "the leftover to be settled", 30_000)
    expect(r.yard.store.getNoteSuggestion(s!.id)).toMatchObject({ status: "rejected", resolvedBy: "boxyard", reason: UNRESOLVED_REASON })
    expect(captainNotices(r, project.id, "retro")).toHaveLength(1)
    expect(r.yard.store.listNotes(project.id)).toEqual([])
    // Nothing asks Cody about it.
    await waitFor(() => !r.yard.captains.anyBusy() || null, "the Captain to finish")
    const chat = await call<ChatMessage[]>(r, "GET", "/api/chat")
    expect(chat.some((m) => /suggestion/i.test(m.content))).toBe(false)
  })

  it("is off when Settings turns it off: suggestions stay pending, and go to the Captain once it's back on", async () => {
    const r = await start()
    await call(r, "PUT", "/api/agent-settings", { notesRetroEnabled: false })
    const project = await call<Project>(r, "POST", "/api/projects", { name: "site" })
    const task = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Docs", prompt: "docs [note]" })
    await resting(r, task.id, ["done"])
    await waitFor(() => r.yard.store.listNoteSuggestions({ taskId: task.id }).length || null, "the suggestion")
    expect(r.yard.retro.queued(project.id)).toEqual([])
    expect(captainNotices(r, project.id, "retro")).toHaveLength(0)
    expect(await call<NoteSuggestion[]>(r, "GET", `/api/projects/${project.id}/suggestions`)).toHaveLength(1)

    await call(r, "PUT", "/api/agent-settings", { notesRetroEnabled: true })
    await waitFor(() => captainNotices(r, project.id, "retro").length || null, "the catch-up retro")
    expect(captainNotices(r, project.id, "retro")[0]!.meta).toMatchObject({ taskIds: [task.id] })
  })
})

describe("notes retro loop safety", () => {
  it("the Captain's loop guard holds back a retro that keeps repeating, without dropping it", async () => {
    const r = await start({ captainTurns: true })
    r.yard.captains.tuning.loopGuard = { maxRepeats: 1, windowMs: 60 * 60_000, throttleMs: 60 * 60_000, maxThrottleMs: 60 * 60_000 }
    const project = await call<Project>(r, "POST", "/api/projects", { name: "site" })
    const captain = r.yard.captains.get(project.id)
    const retro = (n: number, loopKey: string) =>
      r.yard.captains.projectNotice(project.id, `📝 **Notes retro**: 1 finished task left 1 note suggestion to curate. (round ${n})`, { kind: "retro", loopKey })

    retro(1, "retro:task_a")
    await waitFor(() => captain.state().autoTurns === 1 && !captain.state().busy, "the first retro wake")
    expect(r.yard.store.peekUnseenCaptainNoticeEntries(project.id)).toEqual([])

    // The same task's retro again, worded differently: the guard sees the same loopKey and holds it.
    retro(2, "retro:task_a")
    await waitFor(() => captain.state().throttledUntil, "the loop guard to hold the wake")
    expect(captain.state().autoTurns).toBe(1)
    expect(r.yard.store.peekUnseenCaptainNoticeEntries(project.id).map((e) => e.loopKey)).toEqual(["retro:task_a"])

    // Another task's retro is new: both go out together.
    retro(3, "retro:task_b")
    await waitFor(() => captain.state().autoTurns === 2 && !captain.state().busy, "the next wake")
    expect(r.yard.store.peekUnseenCaptainNoticeEntries(project.id)).toEqual([])
  })
})

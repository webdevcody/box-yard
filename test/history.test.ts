import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { Artifacts } from "../server/artifacts.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { captainCompactionsDir, compactCommand, compactionTime, recapBlock, summaryBody, summaryPrompt, summarySection, SUMMARY_PROMPT, writeCompaction } from "../server/compactions.js"
import { compactionTaskSnapshots, liveTaskLines } from "../server/compactionTasks.js"
import { parseTerms, snippetOf } from "../server/history.js"
import type { CompactionTaskSnapshot, Project, Task } from "../shared/types.js"
import { freePort, testConfig, tmpDir } from "./helpers.js"

// #135: recalling what came before a compaction. The summary carries decisions forward and checks task
// state, the saved summary comes back after /compact, and search_history / read_artifact reach older
// history and files, a Captain only its own project's.

const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const SUMMARY = [
  "## Decisions and preferences",
  "- Cody wants PRs squash-merged.",
  "- Spending is paused until Friday.",
  "",
  "## Projects and repos",
  "- demo (acme/demo)",
  "",
  "## Ongoing work",
  "- task_aaaaaaaaaaaa is working on the runner.",
  "",
  "## Open threads and next steps",
  "- Ask Cody about the local runner brief.",
].join("\n")
const meta = (at: number, heading?: string) => ({ at, sessionId: "s1", model: "claude-opus-5-5", trigger: "button" as const, tokensBefore: 300_000, heading })

describe("compaction summaries carry forward", () => {
  it("reads sections and the body of a saved summary", () => {
    const files = writeCompaction(tmpDir(), meta(Date.parse("2026-10-20T10:00:00Z")), SUMMARY)
    expect(summarySection(files.markdown, "Decisions and preferences")).toBe("- Cody wants PRs squash-merged.\n- Spending is paused until Friday.")
    expect(summarySection(files.markdown, "open threads and next steps")).toBe("- Ask Cody about the local runner brief.")
    expect(summarySection(files.markdown, "Nope")).toBe("")
    const body = summaryBody(files.markdown)
    expect(body.startsWith("## Decisions and preferences")).toBe(true)
    expect(body).not.toContain("session_id")
    expect(body).not.toContain("# Orchestrator compaction summary")
  })

  it("asks the summarizer to carry the previous decisions and threads forward, with live task state", () => {
    const at = Date.parse("2026-10-20T10:00:00Z")
    const previous = { at, markdown: writeCompaction(tmpDir(), meta(at), SUMMARY).markdown }
    const prompt = summaryPrompt(SUMMARY_PROMPT, { previous, liveTasks: ['- task_aaaaaaaaaaaa "Runner" [demo] done · PR https://github.com/acme/demo/pull/7 (merged)'] })
    expect(prompt.startsWith(SUMMARY_PROMPT)).toBe(true)
    expect(prompt).toContain("Your previous summary (2026-10-20T10:00:00Z) recorded these. Carry each one forward")
    expect(prompt).toContain("- Spending is paused until Friday.")
    expect(prompt).toContain("- Ask Cody about the local runner brief.")
    // Ongoing work is rebuilt from live state, not copied.
    expect(prompt).not.toContain("is working on the runner")
    expect(prompt).toMatch(/Live task state from Box Yard, right now\..*\n- task_aaaaaaaaaaaa "Runner" \[demo\] done/)
    // Nothing to add: the plain prompt.
    expect(summaryPrompt(SUMMARY_PROMPT)).toBe(SUMMARY_PROMPT)
    // A huge previous section is cut.
    const long = `## Decisions and preferences\n${"- a decision that goes on and on\n".repeat(400)}`
    expect(summaryPrompt(SUMMARY_PROMPT, { previous: { at, markdown: long } })).toContain("- …(cut)")
  })

  it("tells /compact not to repeat Box Yard's summary, naming the owner", () => {
    expect(compactCommand()).toMatch(/^\/compact Box Yard saved the summary in your last reply/)
    expect(compactCommand()).toContain("Don't repeat what it says")
    expect(compactCommand("Sam")).toContain("Sam's recent requests")
  })

  it("gives the saved summary back with the live state of the tasks it names", () => {
    const files = writeCompaction(tmpDir(), meta(Date.parse("2026-10-20T10:00:00Z")), SUMMARY)
    const block = recapBlock(files.markdownFile, files.markdown, ['- task_aaaaaaaaaaaa "Runner" [demo] done'])
    expect(block.split("\n")[0]).toBe(
      `[Box Yard: Your context was just compacted. This is the summary you wrote right before it (2026-10-20T10:00:00Z, saved as ${files.markdownFile}). Task states under "Live now" are current and beat the summary. For anything older, use search_history.]`,
    )
    expect(block).toContain("## Open threads and next steps\n- Ask Cody about the local runner brief.")
    expect(block).not.toContain("tokens_before")
    expect(block.endsWith('Live now, tasks it names:\n- task_aaaaaaaaaaaa "Runner" [demo] done')).toBe(true)
    expect(recapBlock("f.md", "## Decisions and preferences\n- none", [], "Your session was reset")).toBe(
      '[Box Yard: Your session was reset (saved as f.md). Task states under "Live now" are current and beat the summary. For anything older, use search_history.]\n## Decisions and preferences\n- none',
    )
  })

  it("parses compaction ids and ISO times for paging", () => {
    expect(compactionTime("2026-10-22T18-40-05Z")).toBe(Date.parse("2026-10-22T18:40:05Z"))
    expect(compactionTime("2026-10-22T18-40-05Z-2")).toBe(Date.parse("2026-10-22T18:40:05Z"))
    expect(compactionTime("2026-10-22")).toBe(Date.parse("2026-10-22"))
    expect(compactionTime("soon")).toBeNull()
  })
})

describe("live task state for summaries", () => {
  function seeded() {
    const store = memStore()
    const a = store.createProject({ name: "alpha" })
    const b = store.createProject({ name: "beta" })
    const task = (projectId: string, title: string, status: Task["status"], updatedAt: number, extra: Partial<Task> = {}) => {
      const t = store.createTask({ projectId, title, prompt: title })
      store.updateTask(t.id, { status, ...extra })
      store.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(updatedAt, t.id)
      return store.getTask(t.id)!
    }
    return { store, a, b, task }
  }

  it("snapshots only the tasks updated or mentioned since the previous compaction", () => {
    const { store, a, task } = seeded()
    const old = task(a.id, "Old and idle", "idle", 1000)
    const oldPr = task(a.id, "Old PR", "pr_ready", 1000)
    const moved = task(a.id, "Moved since", "done", 5000)
    const named = task(a.id, "Named since", "idle", 1000)
    const snaps = compactionTaskSnapshots(store, store.listTasks(), 2000, new Set([named.id]))
    expect(snaps.map((s: CompactionTaskSnapshot) => s.taskId)).toEqual([moved.id, named.id])
    expect(snaps.map((s) => s.taskId)).not.toContain(old.id)
    expect(snaps.map((s) => s.taskId)).not.toContain(oldPr.id)
  })

  it("lists busy tasks and the named ones, scoped to a project, with PR and question", () => {
    const { store, a, b, task } = seeded()
    const asking = task(a.id, "Asking", "needs_input", 1000, { question: "Which\ncolour?" })
    const merged = task(a.id, "Merged", "done", 1000, { prUrl: "https://github.com/acme/alpha/pull/3", prState: "merged" })
    const idle = task(a.id, "Idle", "idle", 1000)
    const elsewhere = task(b.id, "Beta work", "working", 1000)

    const all = liveTaskLines(store, [merged.id, "task_missing0001"], { busy: true })
    expect(all).toContain(`- ${asking.id} "Asking" [alpha] needs_input · asks: Which colour?`)
    expect(all).toContain(`- ${merged.id} "Merged" [alpha] done · PR https://github.com/acme/alpha/pull/3 (merged)`)
    expect(all).toContain(`- ${elsewhere.id} "Beta work" [beta] working`)
    expect(all.join("\n")).not.toContain(idle.id)
    expect(all.join("\n")).not.toContain("task_missing0001")

    // A Captain's lines: its own project only, without the project name.
    const own = liveTaskLines(store, [merged.id, elsewhere.id], { projectId: a.id, busy: true })
    expect(own).toEqual([`- ${asking.id} "Asking" needs_input · asks: Which colour?`, `- ${merged.id} "Merged" done · PR https://github.com/acme/alpha/pull/3 (merged)`])
    // Without busy, only the named tasks.
    expect(liveTaskLines(store, [idle.id])).toEqual([`- ${idle.id} "Idle" [alpha] idle`])
  })

  it("caps the list", () => {
    const { store, a, task } = seeded()
    for (let i = 0; i < 65; i++) task(a.id, `Busy ${i}`, "working", 1000)
    const lines = liveTaskLines(store, [], { busy: true })
    expect(lines).toHaveLength(61)
    expect(lines.at(-1)).toBe("- …and 5 more (list_tasks)")
  })
})

describe("history search helpers", () => {
  it("parses words and quoted phrases", () => {
    expect(parseTerms('Local  runner "auto  merge" runner')).toEqual(["local", "runner", "auto merge"])
    expect(parseTerms("   ")).toEqual([])
  })
  it("cuts a one-line snippet around the first match", () => {
    const text = `${"lead in words ".repeat(40)}the LOCAL runner brief\nis here ${"and trailing words ".repeat(40)}`
    const s = snippetOf(text, ["local runner"], 40)
    expect(s.startsWith("…")).toBe(true)
    expect(s.endsWith("…")).toBe(true)
    expect(s).toContain("the LOCAL runner brief is here")
    expect(s.length).toBeLessThan(100)
    expect(snippetOf("short text", ["text"])).toBe("short text")
  })
})

interface Running {
  yard: BoxYard
  server: Server
  dataDir: string
  artifacts: Artifacts
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
  const r = { yard, server, dataDir: config.dataDir, artifacts: new Artifacts(yard.store, path.join(config.dataDir, "artifacts")) }
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

type ToolRes = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean }

async function mcpAs(r: Running, caller: McpCaller) {
  const y = r.yard
  const deps = {
    store: y.store,
    tasks: y.tasks,
    hub: y.hub,
    artifacts: r.artifacts,
    publicUrl: () => "",
    scheduler: y.scheduler,
    captains: y.captains,
    settings: y.settings,
    notes: y.notes,
    uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024),
    coordinatorCompactionsDir: y.orchestrator.compactionsDir,
  }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  const raw = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes
  const text = (res: ToolRes, i = 0) => (res.content[i] as { text: string }).text
  const json = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const res = await raw(name, args)
    if (res.isError) throw new Error(`${name}: ${text(res)}`)
    return JSON.parse(text(res))
  }
  const error = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await raw(name, args)
    expect(res.isError, `${name} should fail`).toBe(true)
    return text(res)
  }
  const tools = async () => (await client.listTools()).tools.map((t) => t.name)
  return { raw, json, error, text, tools }
}

/** Two projects with history in every source: summaries, chats, tasks and a transcript. */
function seedHistory(r: Running) {
  const { store, orchestrator } = r.yard
  const alpha = store.createProject({ name: "alpha" })
  const beta = store.createProject({ name: "beta" })
  const ta = store.createTask({ projectId: alpha.id, title: "Local runner", prompt: "Build the local runner from the brief." })
  const tb = store.createTask({ projectId: beta.id, title: "Beta runner", prompt: "Beta's own local runner work." })
  store.addTaskMessage(ta.id, "assistant", "I found the flaky watchdog test in runner.spec.ts.")
  const old = Date.parse("2026-09-01T10:00:00Z")
  writeCompaction(orchestrator.compactionsDir, meta(old), `## Decisions and preferences\n- Cody: the local runner ships behind a flag (${ta.id}).\n\n## Open threads and next steps\n- none`)
  writeCompaction(captainCompactionsDir(r.dataDir, alpha.id), meta(old, "Captain compaction summary: alpha"), `## Decisions and preferences\n- Alpha keeps the local runner opt-in.\n`)
  writeCompaction(captainCompactionsDir(r.dataDir, beta.id), meta(old, "Captain compaction summary: beta"), `## Decisions and preferences\n- Beta's local runner secret plan.\n`)
  store.addChat("user", "Coordinator chat: what happened to the local runner?")
  const c1 = store.addChat("assistant", "The local runner is with the alpha Captain.")
  store.addChat("tool", "tool output that mentions the local runner")
  store.addChat("user", "thanks")
  const ca = store.addCaptainMessage(alpha.id, "user", "Alpha chat: local runner status?")
  store.addCaptainMessage(alpha.id, "assistant", "Alpha: it's in review.")
  store.addCaptainMessage(beta.id, "user", "Beta chat: local runner budget")
  return { alpha, beta, ta, tb, c1, ca }
}

describe("search_history", () => {
  it("searches the Coordinator's and every Captain's summaries, chats and tasks, and opens chat hits", async () => {
    const r = await start()
    const { alpha, ta, c1 } = seedHistory(r)
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const res = await coordinator.json("search_history", { query: "local runner", limit: 30 })
    const kinds = new Set(res.hits.map((h: { kind: string }) => h.kind))
    expect([...kinds].sort()).toEqual(["captain_chat", "captain_summary", "coordinator_chat", "coordinator_summary", "task"])
    // Tool output isn't searched; transcripts only when asked for.
    expect(JSON.stringify(res)).not.toContain("tool output")
    expect(JSON.stringify(res)).not.toContain("watchdog")
    const summary = res.hits.find((h: { kind: string }) => h.kind === "coordinator_summary")
    expect(summary).toMatchObject({ id: "2026-09-01T10-00-00Z", at: "2026-09-01T10:00:00.000Z", where: "Decisions and preferences", tasks: [ta.id] })
    expect(summary.file).toBe(path.join(r.yard.orchestrator.compactionsDir, "2026-09-01T10-00-00Z.md"))
    expect(summary.snippet).toContain("the local runner ships behind a flag")
    expect(summary.open).toBe('read_compaction {"compaction":"2026-09-01T10-00-00Z"}')
    const captainSummary = res.hits.find((h: { kind: string; project?: string }) => h.kind === "captain_summary" && h.project === "alpha")
    expect(captainSummary.open).toBe('read_compaction {"compaction":"2026-09-01T10-00-00Z","project":"alpha"}')
    // Newest first.
    const times = res.hits.map((h: { at: string }) => h.at)
    expect([...times].sort().reverse()).toEqual(times)

    // Every word must match.
    expect((await coordinator.json("search_history", { query: "runner flag" })).hits.map((h: { kind: string }) => h.kind)).toEqual(["coordinator_summary"])
    const none = await coordinator.json("search_history", { query: "zebra" })
    expect(none.hits).toEqual([])
    expect(none.none).toMatch(/Nothing matched/)
    // % and _ are literal, not LIKE wildcards.
    expect((await coordinator.json("search_history", { query: "lo_al" })).hits).toEqual([])
    // A project filter keeps to that project and leaves the Coordinator's own history out.
    const onlyAlpha = await coordinator.json("search_history", { query: "local runner", project: "alpha", limit: 30 })
    expect(new Set(onlyAlpha.hits.map((h: { project?: string }) => h.project))).toEqual(new Set(["alpha"]))
    expect(onlyAlpha.hits.some((h: { kind: string }) => h.kind.startsWith("coordinator"))).toBe(false)
    // Transcripts are opt-in.
    const transcript = await coordinator.json("search_history", { query: "watchdog", sources: ["transcripts"] })
    expect(transcript.hits).toHaveLength(1)
    expect(transcript.hits[0]).toMatchObject({ kind: "task_transcript", project: "alpha", tasks: [ta.id], open: `get_task {"task":"${ta.id}"}` })
    // Time window.
    expect((await coordinator.json("search_history", { query: "local runner", until: "2026-09-02" })).hits.map((h: { kind: string }) => h.kind).sort()).toEqual([
      "captain_summary",
      "captain_summary",
      "coordinator_summary",
    ])
    expect(await coordinator.error("search_history", { query: "x", since: "someday" })).toMatch(/not an ISO date/)
    expect(await coordinator.error("search_history", {})).toMatch(/Pass query/)

    // Opening a chat hit: the message with its neighbours, tool rows left out.
    const chatHit = res.hits.find((h: { id: string }) => h.id === c1.id)
    expect(chatHit.open).toBe(`search_history {"around":"${c1.id}"}`)
    const around = await coordinator.json("search_history", { around: c1.id })
    expect(around.kind).toBe("coordinator_chat")
    expect(around.messages.map((m: { content: string }) => m.content)).toEqual(["Coordinator chat: what happened to the local runner?", "The local runner is with the alpha Captain.", "thanks"])
    const alphaAround = await coordinator.json("search_history", { around: res.hits.find((h: { kind: string; project?: string }) => h.kind === "captain_chat" && h.project === "alpha").id })
    expect(alphaAround).toMatchObject({ kind: "captain_chat", project: "alpha" })
    expect(alphaAround.messages.map((m: { content: string }) => m.content)).toEqual(["Alpha chat: local runner status?", "Alpha: it's in review."])
    expect(alpha.id).toBeTruthy()
  })

  it("keeps a Captain to its own project's history", async () => {
    const r = await start()
    const { alpha, ta, tb, c1, ca } = seedHistory(r)
    const captain = await mcpAs(r, { kind: "captain", projectId: alpha.id })
    expect(await captain.tools()).toContain("search_history")
    const res = await captain.json("search_history", { query: "local runner", limit: 30, sources: ["summaries", "chat", "tasks", "transcripts"] })
    const text = JSON.stringify(res)
    expect(new Set(res.hits.map((h: { kind: string }) => h.kind))).toEqual(new Set(["captain_summary", "captain_chat", "task"]))
    expect(text).toContain("Alpha keeps the local runner opt-in.")
    expect(text).toContain(ta.id)
    for (const other of ["Beta", "beta", tb.id, "Coordinator chat", "ships behind a flag"]) expect(text).not.toContain(other)
    // Hits name no project and open without one.
    expect(res.hits.every((h: { project?: string }) => h.project === undefined)).toBe(true)
    expect(res.hits.find((h: { kind: string }) => h.kind === "captain_summary").open).toBe('read_compaction {"compaction":"2026-09-01T10-00-00Z"}')
    expect(await captain.error("search_history", { query: "runner", project: "beta" })).toMatch(/^Out of scope: project "beta" belongs to another Captain/)
    // The Coordinator's chat and another project's Captain chat can't be opened.
    expect(await captain.error("search_history", { around: c1.id })).toMatch(/No chat message/)
    const betaChat = r.yard.store.listCaptainMessages(r.yard.store.findProject("beta")!.id, 10)[0]!
    expect(await captain.error("search_history", { around: betaChat.id })).toMatch(/No chat message/)
    expect((await captain.json("search_history", { around: ca.id })).messages).toHaveLength(2)
  })
})

describe("read_artifact and artifact attachments", () => {
  function seedArtifacts(r: Running) {
    const { store } = r.yard
    const alpha = store.createProject({ name: "alpha" })
    const beta = store.createProject({ name: "beta" })
    const tb = store.createTask({ projectId: beta.id, title: "Beta task", prompt: "x" })
    const brief = r.artifacts.save({ title: "Local runner brief", filename: "brief.md", data: Buffer.from(`# Brief\n${"line of the brief\n".repeat(3000)}THE END`), projectId: alpha.id, taskId: null })
    const betaDoc = r.artifacts.save({ title: "Beta doc", filename: "doc.md", data: Buffer.from("beta only"), projectId: null, taskId: tb.id })
    const global = r.artifacts.save({ title: "Coordinator report", filename: "report.md", data: Buffer.from("for Cody"), projectId: null, taskId: null })
    const zip = r.artifacts.save({ title: "Export", filename: "export.zip", data: Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), projectId: alpha.id, taskId: null })
    // 1x1 transparent PNG.
    const png = r.artifacts.save({
      title: "Screenshot",
      filename: "shot.png",
      data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
      projectId: alpha.id,
      taskId: null,
    })
    return { alpha, beta, tb, brief, betaDoc, global, zip, png }
  }

  it("reads text in pages, shows small images, and only describes other binaries", async () => {
    const r = await start()
    const { brief, zip, png, global } = seedArtifacts(r)
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const first = await coordinator.raw("read_artifact", { artifact: brief.id })
    const info = JSON.parse(coordinator.text(first))
    expect(info).toMatchObject({ id: brief.id, title: "Local runner brief", filename: "brief.md", project: "alpha", offset: 0 })
    expect(info.totalChars).toBe(brief.size)
    expect(coordinator.text(first, 1).startsWith("# Brief\nline of the brief\n")).toBe(true)
    expect(coordinator.text(first, 1)).toHaveLength(20_000)
    expect(info.more).toBe(`${brief.size - 20_000} more chars: call again with offset 20000`)
    // By URL, from an offset, to the end.
    const rest = await coordinator.raw("read_artifact", { artifact: `http://yard.local${brief.url}`, offset: 20_000, max_chars: 50_000 })
    expect(coordinator.text(rest, 1).endsWith("THE END")).toBe(true)
    expect(JSON.parse(coordinator.text(rest)).more).toBeUndefined()

    const image = await coordinator.raw("read_artifact", { artifact: png.id })
    expect(image.content[1]).toMatchObject({ type: "image", mimeType: "image/png" })
    const binary = await coordinator.json("read_artifact", { artifact: zip.id })
    expect(binary.note).toMatch(/Not a text file/)
    expect(binary.text).toBeUndefined()
    expect((await coordinator.raw("read_artifact", { artifact: global.id })).content[1]).toMatchObject({ text: "for Cody" })
    expect(await coordinator.error("read_artifact", { artifact: "art_000000000000" })).toMatch(/No artifact/)
  })

  it("keeps a Captain to its own project's artifacts, by project or by task", async () => {
    const r = await start()
    const { alpha, beta, brief, betaDoc, global } = seedArtifacts(r)
    const captainA = await mcpAs(r, { kind: "captain", projectId: alpha.id })
    expect(await captainA.tools()).toContain("read_artifact")
    expect(JSON.parse(captainA.text(await captainA.raw("read_artifact", { artifact: brief.id }))).id).toBe(brief.id)
    expect(await captainA.error("read_artifact", { artifact: betaDoc.id })).toMatch(/^Out of scope: artifact .* is not in this project/)
    expect(await captainA.error("read_artifact", { artifact: global.id })).toMatch(/^Out of scope/)
    // An artifact tied to a task counts as that task's project.
    const captainB = await mcpAs(r, { kind: "captain", projectId: beta.id })
    expect((await captainB.raw("read_artifact", { artifact: betaDoc.id })).content[1]).toMatchObject({ text: "beta only" })
  })

  it("attaches an artifact to a new task by id, as a copy, and refuses another project's", async () => {
    const r = await start()
    const { alpha, brief, betaDoc } = seedArtifacts(r)
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const created = await coordinator.json("create_task", { project: "alpha", title: "Use the brief", prompt: "Read the attached brief.", attachments: [brief.id] })
    const first = r.yard.store.listTaskMessages(created.id, 10).find((m) => m.role === "user")!
    const [file] = (first.meta as { attachments: { id: string; name: string; size: number }[] }).attachments
    expect(file).toMatchObject({ name: "brief.md", size: brief.size })
    expect(file!.id).toMatch(/^up_/)
    expect(fs.readFileSync(path.join(uploadsDir(r.dataDir), file!.id, "brief.md"), "utf8")).toContain("THE END")

    const captainA = await mcpAs(r, { kind: "captain", projectId: alpha.id })
    expect(await captainA.error("create_task", { project: "alpha", title: "Nope", prompt: "x", attachments: [betaDoc.url] })).toMatch(/^Out of scope: artifact/)
    expect(await captainA.error("create_task", { project: "alpha", title: "Nope", prompt: "x", attachments: ["art_000000000000"] })).toMatch(/No artifact/)
  })
})

describe("compaction lists stay small", () => {
  it("lists digests with capped task lists, current status and a before cursor", async () => {
    const r = await start()
    const { store, orchestrator } = r.yard
    const p: Project = store.createProject({ name: "alpha" })
    const tasks = Array.from({ length: 14 }, (_, i) => store.createTask({ projectId: p.id, title: `Task ${i}`, prompt: "x" }))
    for (const t of tasks) store.updateTask(t.id, { status: "working" })
    store.updateTask(tasks[0]!.id, { status: "done" })
    const snap = (t: Task): CompactionTaskSnapshot => ({ taskId: t.id, title: t.title, status: "working", projectId: p.id, projectName: "alpha", branch: null, prUrl: null, sessionId: "s", summary: "x".repeat(4000), lastActiveAt: 1 })
    for (let day = 1; day <= 3; day++) {
      const at = Date.parse(`2026-10-0${day}T10:00:00Z`)
      const files = writeCompaction(orchestrator.compactionsDir, meta(at), SUMMARY, tasks.map(snap))
      store.addOrchestratorCompaction({ id: files.id, at, sessionId: "s1", model: "m", trigger: "button", tokensBefore: 1, tokensAfter: 2, markdownPath: files.markdownFile, jsonPath: files.jsonFile, markdown: files.markdown, tasks: tasks.map(snap) })
    }
    const coordinator = await mcpAs(r, { kind: "coordinator" })
    const res = await coordinator.raw("list_compactions")
    const list = JSON.parse(coordinator.text(res))
    expect(list.map((c: { id: string }) => c.id)).toEqual(["2026-10-03T10-00-00Z", "2026-10-02T10-00-00Z", "2026-10-01T10-00-00Z"])
    expect(list[0].tasks).toHaveLength(10)
    expect(list[0].moreTasks).toBe(4)
    const listed = (await coordinator.json("list_compactions", { limit: 1 }))[0].tasks.concat()
    const full0 = await coordinator.json("read_compaction", { compaction: "2026-10-03T10-00-00Z" })
    expect(full0.tasks).toHaveLength(14)
    const done = full0.tasks.find((t: { id: string }) => t.id === tasks[0]!.id)
    expect(done).toMatchObject({ status: "working", statusNow: "done" })
    for (const t of listed) expect(t.now).toBe(t.id === tasks[0]!.id ? "done" : undefined)
    expect(listed.find((t: { id: string }) => t.id !== tasks[0]!.id)).toMatchObject({ status: "working", title: expect.stringMatching(/^Task \d+$/) })
    // No snapshot summaries in a list: three compactions of 14 tasks with 4k-char snapshots stay small.
    expect(coordinator.text(res).length).toBeLessThan(6000)
    expect((await coordinator.json("list_compactions", { before: "2026-10-02T10-00-00Z" })).map((c: { id: string }) => c.id)).toEqual(["2026-10-01T10-00-00Z"])
    expect((await coordinator.json("list_compactions", { limit: 1 })).map((c: { id: string }) => c.id)).toEqual(["2026-10-03T10-00-00Z"])
    expect(await coordinator.error("list_compactions", { before: "later" })).toMatch(/not a compaction id/)
    // read_compaction has the full snapshots, with the status now.
    const full = await coordinator.json("read_compaction", { compaction: "2026-10-01T10-00-00Z" })
    const doneThen = full.tasks.find((t: { id: string }) => t.id === tasks[0]!.id)
    expect(doneThen).toMatchObject({ status: "working", statusNow: "done" })
    expect(doneThen.summary).toHaveLength(4000)
  })
})

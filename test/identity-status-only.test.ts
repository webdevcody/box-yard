import { afterEach, describe, expect, it } from "vitest"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { Artifacts } from "../server/artifacts.js"
import { STATUS_ONLY_SNAPSHOT, compactionTaskSnapshots, liveTaskLines } from "../server/compactionTasks.js"
import { SEALED_NOTICE } from "../server/history.js"
import { HookStore } from "../server/hookStore.js"
import { HookEngine, SUMMARY_WITHHELD, type HookMeta } from "../server/hooks.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { ORCHESTRATOR_PROMPT, captainPrompt } from "../server/prompts.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { DEFAULT_IDENTITY_ID } from "../shared/identities.js"
import { withOwner } from "../shared/owner.js"
import { freePort, testConfig } from "./helpers.js"

// Coordinator sees: status only (docs/identities.md). A project whose identity is set to "status" shows the
// Coordinator its tasks' titles, states and PRs, never their content, while its Captain sees everything; and no
// MCP tool lets a model undo the seal.

type ToolRes = { content: { text: string }[]; isError?: boolean }

const running: { yard: BoxYard; server: Server }[] = []
const clients: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

/** The words only a sealed project's content holds: none may reach the Coordinator. */
const CONTENT = ["PROMPT-WORDS", "REPLY-WORDS", "QUESTION-WORDS", "ERROR-WORDS", "SUMMARY-WORDS", "NOTE-WORDS", "ARTIFACT-WORDS", "PREVIEW-WORDS", "CHAT-WORDS"]

async function start() {
  const port = await freePort()
  const config = testConfig({ port })
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  // Nothing launches: the tasks below rest as they're written.
  yard.tasks.stop()
  running.push({ yard, server })
  const artifacts = new Artifacts(yard.store, path.join(config.dataDir, "artifacts"))
  const sealed = yard.identities.create({ name: "Private", coordinatorSees: "status" })
  const secret = yard.store.createProject({ name: "secret", repo: "acme/secret" })
  const open = yard.store.createProject({ name: "open", repo: "acme/open" })
  yard.identities.assign(secret.id, sealed.id)

  const task = (projectId: string, title: string) => {
    const t = yard.store.createTask({ projectId, title, prompt: "Build it. PROMPT-WORDS", branch: "boxyard/build-1a2b" })
    yard.store.updateTask(
      t.id,
      {
        status: "needs_input",
        question: "Which colour? QUESTION-WORDS",
        error: "It broke once: ERROR-WORDS",
        summary: "Did the thing. SUMMARY-WORDS",
        prUrl: "https://github.com/acme/secret/pull/9",
        prState: "open",
        previews: [{ port: 4230, url: "https://preview.example/PREVIEW-WORDS", label: "app" }],
        turnCount: 1,
      },
      { quiet: true },
    )
    yard.store.addTaskMessage(t.id, "assistant", "Here is what I found. REPLY-WORDS")
    return yard.store.getTask(t.id)!
  }
  const hidden = task(secret.id, "Ship the private build")
  const visible = task(open.id, "Ship the open build")
  yard.notes.add(secret.id, "Deploy with care. NOTE-WORDS", { by: "Cody" })
  const art = artifacts.save({ title: "Private plan", filename: "plan.md", data: Buffer.from("# Plan ARTIFACT-WORDS"), projectId: secret.id, taskId: null })
  yard.store.addCaptainMessage(secret.id, "user", "Keep the launch date quiet CHAT-WORDS")

  const seen: string[] = []
  const as = async (caller: McpCaller, extra: { hooks?: HookEngine } = {}) => {
    const y = yard
    const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(config.dataDir), 1024 * 1024), identities: y.identities, ...extra }
    const mcp = buildMcpServer(deps, caller)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await mcp.connect(a)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(b)
    clients.push({ close: async () => (await client.close(), await mcp.close()) })
    return async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as ToolRes
      const text = r.content.map((c) => c.text).join("\n")
      if (caller.kind === "coordinator") seen.push(text)
      return { ok: !r.isError, text, json: () => JSON.parse(text) }
    }
  }
  /** Nothing the Coordinator got holds the sealed project's content. */
  const sealedFromCoordinator = () => {
    const all = seen.join("\n")
    for (const w of CONTENT) expect(all, w).not.toContain(w)
  }
  return { yard, sealed, secret, open, hidden, visible, art, as, sealedFromCoordinator }
}

describe("Identities.statusOnlyProjects", () => {
  it("holds the projects on a status identity, and every project on Default when Default is set to status", async () => {
    const r = await start()
    expect([...r.yard.identities.statusOnlyProjects()]).toEqual([r.secret.id])
    expect(r.yard.identities.statusOnly(r.open.id)).toBe(false)
    r.yard.identities.update(DEFAULT_IDENTITY_ID, { coordinatorSees: "status" })
    expect(r.yard.identities.statusOnlyProjects()).toEqual(new Set([r.secret.id, r.open.id]))
    // Cody can set it back in Settings (the HTTP routes call update directly).
    r.yard.identities.update(r.sealed.id, { coordinatorSees: "everything" })
    r.yard.identities.update(DEFAULT_IDENTITY_ID, { coordinatorSees: "everything" })
    expect(r.yard.identities.statusOnlyProjects().size).toBe(0)
  })
})

describe("the Coordinator's view of a status-only project", () => {
  it("lists and gets its tasks with title, state and PR, but no reply, question, error, summary or preview", async () => {
    const r = await start()
    const tool = await r.as({ kind: "coordinator" })
    const list = (await tool("list_tasks")).json() as Record<string, unknown>[]
    const h = list.find((t) => t.id === r.hidden.id)!
    expect(h).toMatchObject({ title: "Ship the private build", project: "secret", status: "needs_input", pr: "https://github.com/acme/secret/pull/9", statusOnly: true, question: "(status only: ask the project's Captain)", error: "(status only: ask the project's Captain)" })
    expect(h.summary).toBeUndefined()
    expect(h.previews).toBeUndefined()
    // The open project shows everything as before.
    expect(list.find((t) => t.id === r.visible.id)).toMatchObject({ question: "Which colour? QUESTION-WORDS", summary: "Did the thing. SUMMARY-WORDS" })

    const got = (await tool("get_task", { task: r.hidden.id })).json()
    expect(got).toMatchObject({ id: r.hidden.id, status: "needs_input", branch: "boxyard/build-1a2b", coordinatorSees: expect.stringMatching(/^status only: Cody set its identity/) })
    expect(got.lastReply).toBeUndefined()
    expect(got.lines).toBeUndefined()
    const waited = (await tool("wait_for_tasks", { tasks: [r.hidden.id], timeout_seconds: 5 })).text
    expect(waited).toContain(r.hidden.id)
    const inbox = (await tool("list_inbox")).json() as { id: string }[]
    for (const text of [JSON.stringify(got), waited, JSON.stringify(inbox.find((t) => t.id === r.hidden.id))]) {
      for (const w of CONTENT) expect(text, w).not.toContain(w)
    }

    // A query can't probe its prompt or summary: only the title and PR match.
    expect(((await tool("list_tasks", { query: "PROMPT-WORDS SUMMARY-WORDS" })).json() as { id: string }[]).map((t) => t.id)).toEqual([r.visible.id])
    expect(((await tool("list_tasks", { query: "private" })).json() as { id: string }[]).map((t) => t.id)).toEqual([r.hidden.id])

    const projects = (await tool("list_projects")).json() as { name: string; coordinatorSees?: string; notes: unknown }[]
    expect(projects.find((p) => p.name === "secret")).toMatchObject({ coordinatorSees: expect.stringMatching(/^status only/), notes: "1 (status only)" })
    expect(projects.find((p) => p.name === "open")!.coordinatorSees).toBeUndefined()
  })

  it("refuses its notes, artifacts, compactions and history, and points at its Captain", async () => {
    const r = await start()
    const tool = await r.as({ kind: "coordinator" })
    for (const [name, args] of [
      ["list_notes", { project: "secret" }],
      ["list_note_suggestions", { project: "secret" }],
      ["list_artifacts", { project: "secret" }],
      ["list_artifacts", { task: r.hidden.id }],
      ["read_artifact", { artifact: r.art.id }],
      ["list_compactions", { project: "secret" }],
      ["search_history", { project: "secret", query: "launch" }],
      ["list_queued_messages", { task: r.hidden.id }],
      ["get_preview_url", { task: r.hidden.id, port: 4230 }],
    ] as const) {
      const res = await tool(name, args)
      expect(res.ok, `${name} ${res.text}`).toBe(false)
      expect(res.text, name).toMatch(/Status only: [\s\S]*Its Captain sees everything: ask it with ask_captain or send_to_captain/)
    }
    // Lists across projects leave it out instead of failing.
    expect((await tool("list_artifacts")).text).not.toContain(r.art.id)
    const history = (await tool("search_history", { query: "launch quiet", sources: ["chat", "tasks"] })).json() as { hits: unknown[] }
    expect(history.hits).toEqual([])
    // The Coordinator chat keeps every task notice, even ones the Captain handled: a sealed task's are left out of
    // the hits and masked when a hit next to them is opened.
    r.yard.store.addChat("notice", "❓ **Ship the private build** asks: Which colour? QUESTION-WORDS", { taskId: r.hidden.id })
    const open = r.yard.store.addChat("notice", "❓ **Ship the open build** asks: Which colour?", { taskId: r.visible.id })
    const asked = r.yard.store.addChat("user", "How is the colour question going?")
    const found = (await tool("search_history", { query: "colour", sources: ["chat"] })).json() as { hits: { id: string }[] }
    expect(found.hits.map((h) => h.id)).toEqual([asked.id, open.id])
    const around = (await tool("search_history", { around: asked.id })).json() as { messages: { content: string }[] }
    expect(around.messages.map((m) => m.content)).toEqual([SEALED_NOTICE, "❓ **Ship the open build** asks: Which colour?", "How is the colour question going?"])
    // Writes and controls still work: Cody can have the Coordinator add a rule or stop a task.
    expect((await tool("save_note", { project: "secret", content: "Use the staging account." })).ok).toBe(true)
    r.sealedFromCoordinator()
  })

  it("leaves its content in the Captain's tools", async () => {
    const r = await start()
    const tool = await r.as({ kind: "captain", projectId: r.secret.id })
    expect((await tool("get_task", { task: r.hidden.id })).json()).toMatchObject({ question: "Which colour? QUESTION-WORDS", lastReply: expect.stringContaining("REPLY-WORDS") })
    expect((await tool("list_notes")).text).toContain("NOTE-WORDS")
    expect((await tool("read_artifact", { artifact: r.art.id })).text).toContain("ARTIFACT-WORDS")
    expect((await tool("search_history", { query: "launch quiet" })).text).toContain("CHAT-WORDS")
  })

  it("ask_captain and wait_for_captain return its Captain's reply to the Coordinator, not the rest of its chat", async () => {
    const r = await start()
    const tool = await r.as({ kind: "coordinator" })
    const asked = (await tool("ask_captain", { project: "secret", message: "status", timeout_seconds: 30 })).json()
    expect(asked.reply).toContain("Ship the private build")
    expect(asked).toMatchObject({ lastReply: asked.reply, statusOnly: expect.stringMatching(/^Status only: /) })
    expect(asked.messages).toBeUndefined()
    const waited = (await tool("wait_for_captain", { project: "secret", timeout_seconds: 5 })).json()
    expect(waited).toMatchObject({ lastReply: asked.reply, statusOnly: expect.stringMatching(/^Status only: /) })
    expect(waited.messages).toBeUndefined()
    r.sealedFromCoordinator()
    // An open project's Captain chat still comes back as before.
    r.yard.store.addCaptainMessage(r.open.id, "user", "An open aside")
    const open = (await tool("ask_captain", { project: "open", message: "status", timeout_seconds: 30 })).json()
    expect(open.messages.map((m: { content: string }) => m.content)).toContain("An open aside")
  })
})

describe("the seal is one-way through the tools", () => {
  it("lets the Coordinator set status, never back; nor move a sealed project to an open identity or delete into an open Default", async () => {
    const r = await start()
    const tool = await r.as({ kind: "coordinator" })
    const refused = /Only Cody can let the Coordinator see more: [\s\S]*Settings › Identities/
    const back = await tool("update_identity", { identity: "Private", coordinator_sees: "everything" })
    expect(back.ok).toBe(false)
    expect(back.text).toMatch(refused)
    const moved = await tool("assign_identity", { project: "secret", identity: "Default" })
    expect(moved.ok).toBe(false)
    expect(moved.text).toMatch(refused)
    const deleted = await tool("delete_identity", { identity: "Private", move_projects_to_default: true })
    expect(deleted.ok).toBe(false)
    expect(deleted.text).toMatch(refused)
    expect(r.yard.identities.of(r.secret.id).id).toBe(r.sealed.id)
    expect(r.yard.identities.require(r.sealed.id).coordinatorSees).toBe("status")

    // Tightening is fine: seal the open project's identity too, and another status identity can take a sealed project.
    expect((await tool("update_identity", { identity: "Default", coordinator_sees: "status" })).ok).toBe(true)
    expect(r.yard.identities.statusOnly(r.open.id)).toBe(true)
    const other = r.yard.identities.create({ name: "Also private", coordinatorSees: "status" })
    expect((await tool("assign_identity", { project: "secret", identity: other.id })).ok).toBe(true)

    // A Captain is no more Cody than the Coordinator is.
    const captain = await r.as({ kind: "captain", projectId: r.secret.id })
    const own = await captain("update_identity", { identity: other.id, coordinator_sees: "everything" })
    expect(own.ok).toBe(false)
    expect(own.text).toMatch(refused)
  })
})

describe("what else reaches the Coordinator", () => {
  it("its summary prompts and compaction snapshots keep a sealed task's status and drop its question and summary", async () => {
    const r = await start()
    const statusOnly = (projectId: string) => r.yard.identities.statusOnly(projectId)
    const lines = liveTaskLines(r.yard.store, [r.hidden.id, r.visible.id], { busy: true, statusOnly })
    expect(lines.find((l) => l.includes(r.hidden.id))).toBe(`- ${r.hidden.id} "Ship the private build" [secret] needs_input · PR https://github.com/acme/secret/pull/9 (open)`)
    expect(lines.find((l) => l.includes(r.visible.id))).toContain("asks: Which colour? QUESTION-WORDS")
    const snaps = compactionTaskSnapshots(r.yard.store, r.yard.store.listTasks(), 0, new Set(), statusOnly)
    expect(snaps.find((s) => s.taskId === r.hidden.id)).toMatchObject({ title: "Ship the private build", status: "needs_input", summary: STATUS_ONLY_SNAPSHOT })
    expect(snaps.find((s) => s.taskId === r.visible.id)!.summary).toContain("SUMMARY-WORDS")
    // The app wires the Coordinator to the identities.
    expect(r.yard.orchestrator.statusOnly(r.secret.id)).toBe(true)
    expect(r.yard.orchestrator.statusOnly(r.open.id)).toBe(false)
  })

  it("a hook withholds {summary} from its message to the Coordinator and from a new task's title, and its notices carry no prompt", async () => {
    const r = await start()
    r.yard.hooks.stop()
    const sent: { content: string; meta: HookMeta }[] = []
    const engine = new HookEngine({
      store: r.yard.store,
      hooks: new HookStore(r.yard.db),
      tasks: r.yard.tasks,
      hub: r.yard.hub,
      messageCaptain: () => {},
      messageCoordinator: (content, meta) => void sent.push({ content, meta }),
      statusOnly: (projectId) => r.yard.identities.statusOnly(projectId),
    })
    for (const projectId of [r.secret.id, r.open.id]) {
      engine.create({ name: "Tell", projectId, trigger: "task.needs_input", action: "message_coordinator", prompt: "{task_title} waits: {summary}", enabled: true, createdBy: "Cody" })
    }
    for (const t of [r.hidden, r.visible]) engine.handle({ type: "task.needs_input", taskId: t.id, turnId: `turn_${t.id}`, originHookIds: [], sawPr: false })
    expect(sent.map((s) => s.content)).toEqual([`Ship the private build waits: ${SUMMARY_WITHHELD}`, "Ship the open build waits: Did the thing. SUMMARY-WORDS"])
    const notice = (taskId: string) =>
      (r.yard.store.db.prepare("SELECT content FROM chat_messages WHERE role = 'notice' AND json_extract(meta_json, '$.taskId') = ?").get(taskId) as { content: string }).content
    expect(notice(r.hidden.id)).toBe('🪝 **Ship the private build** hook "Tell" (Needs input) messaged the Coordinator (PR #9)')
    expect(notice(r.visible.id)).toMatch(/messaged the Coordinator \(PR #9\): Ship the open build waits/)

    // A new task's title is status too: a create_task hook's {summary} stays out of it, and its prompt keeps it.
    for (const projectId of [r.secret.id, r.open.id]) {
      engine.create({ name: "Follow up", projectId, trigger: "task.needs_input", action: "create_task", taskTitle: "Follow up: {summary}", prompt: "Pick up: {summary}", enabled: true, createdBy: "Cody" })
    }
    for (const t of [r.hidden, r.visible]) engine.handle({ type: "task.needs_input", taskId: t.id, turnId: `turn2_${t.id}`, originHookIds: [], sawPr: false })
    const started = (projectId: string) => r.yard.store.listTasks({ projectId }).find((t) => t.title.startsWith("Follow up"))!
    expect(started(r.secret.id)).toMatchObject({ title: `Follow up: ${SUMMARY_WITHHELD}`, prompt: "Pick up: Did the thing. SUMMARY-WORDS" })
    expect(started(r.open.id).title).toBe("Follow up: Did the thing. SUMMARY-WORDS")
    const coordinator = await r.as({ kind: "coordinator" }, { hooks: engine })
    expect((await coordinator("list_tasks", { project: "secret" })).text).toContain(`Follow up: ${SUMMARY_WITHHELD}`)
    const runs = await coordinator("list_hook_runs", { project: "secret" })
    expect(runs.ok).toBe(true)
    expect(runs.text).toContain(`Started task \\"Follow up: ${SUMMARY_WITHHELD}\\"`)
    r.sealedFromCoordinator()
  })
})

describe("agents across the seal", () => {
  it("don't message between a sealed project and an open one; within either side they still do", async () => {
    const r = await start()
    const message = (from: string, to: string, text: string) =>
      r.yard.tasks.apply(from, { seq: 0, ts: Date.now(), turnId: null, t: "message_agent", to, message: text, expectReply: true })
    const words = (taskId: string) => [...r.yard.store.listTaskMessages(taskId).map((m) => m.content), ...r.yard.store.listQueuedInputs(taskId).map((q) => q.content)].join("\n")

    // Out of the sealed project: refused, and only the sender hears why.
    await message(r.hidden.id, r.visible.id, "What I found: CHAT-WORDS")
    expect(words(r.visible.id)).not.toContain("CHAT-WORDS")
    expect(words(r.hidden.id)).toMatch(/was not delivered: Cody set your project to show the Coordinator its status only[\s\S]*message_captain/)
    // Into it: refused too, since the reply would come back out.
    await message(r.visible.id, r.hidden.id, "Tell me what you found")
    expect(words(r.hidden.id)).not.toContain("Tell me what you found")
    expect(words(r.visible.id)).toMatch(/was not delivered: Cody set its project to show the Coordinator its status only/)

    // Inside the sealed project, and between two open projects, messages go through as before.
    const sibling = r.yard.store.createTask({ projectId: r.secret.id, title: "Private sibling", prompt: "x", branch: "boxyard/sib-1a2b" })
    await message(r.hidden.id, sibling.id, "Sibling note CHAT-WORDS")
    expect(words(sibling.id)).toContain("Sibling note CHAT-WORDS")
    const other = r.yard.store.createProject({ name: "other" })
    const otherTask = r.yard.store.createTask({ projectId: other.id, title: "Other build", prompt: "x", branch: "boxyard/other-1a2b" })
    await message(r.visible.id, otherTask.id, "Open note")
    expect(words(otherTask.id)).toContain("Open note")
  })
})

describe("status-only guidance in the prompts", () => {
  it("tells a sealed project's Captain to answer the Coordinator with state, and the Coordinator to ask that Captain", async () => {
    const r = await start()
    const sealedCaptain = captainPrompt(r.secret, "Ada", undefined, true)
    expect(sealedCaptain).toMatch(/Status only: Ada set this project's identity to show the Coordinator its status only/)
    expect(sealedCaptain).toMatch(/report the state of the work[\s\S]*not its content/)
    expect(captainPrompt(r.open, "Ada")).not.toMatch(/Status only/)
    const coordinator = withOwner(ORCHESTRATOR_PROMPT, "Ada")
    expect(coordinator).toMatch(/Some projects show you their status only[\s\S]*Ask that project's Captain \(ask_captain\)/)
    expect(coordinator).toMatch(/only Ada sets it back to everything/)
    for (const text of [sealedCaptain, coordinator]) expect(text).not.toMatch(/\bCody\b/)
  })
})

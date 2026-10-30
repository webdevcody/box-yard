import { afterEach, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { PR_REPORT_FRESH_MS } from "../server/prs.js"
import type { TaskEvent } from "../server/tasks.js"
import { badgeStatus } from "../web/src/lib/prState.js"
import type { Task } from "../shared/types.js"
import { testConfig, waitFor } from "./helpers.js"

// A PR merged outside Box Yard (on GitHub, by hand) while the tracker's poll missed it (#91 in survive-the-night):
// list_inbox, get_task and list_tasks ask GitHub before they report it, the task flips to merged (purple in the UI),
// and pr.merged hooks fire exactly once however many times it's asked about afterwards.

const yards: BoxYard[] = []
const clients: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const y of yards.splice(0)) y.stop()
})

type ToolRes = { content: { text: string }[]; isError?: boolean }

const PR_URL = "https://github.com/acme/site/pull/91"

function setup() {
  const config = testConfig()
  // GitHub as the tracker sees it: PR #91 is open until `gh.state` says otherwise.
  const gh = { state: "OPEN", requests: 0, down: false }
  const fetch = (async (url: string) => {
    // The tracker's GraphQL polls; a merge also reads the PR over REST for the issues it names.
    if (String(url).endsWith("/graphql")) gh.requests++
    if (gh.down) return new Response("unavailable", { status: 502 })
    const pr =
      gh.state === "MERGED"
        ? { state: "MERGED", isDraft: false, mergedAt: "2026-10-27T00:34:36Z", mergedBy: { login: "webdevcody" }, headRefOid: "a".repeat(40), labels: { nodes: [] } }
        : { state: gh.state, isDraft: false, mergedAt: null, mergedBy: null, headRefOid: "a".repeat(40), labels: { nodes: [] } }
    const data = { rateLimit: { remaining: 4000, resetAt: new Date(Date.now() + 3600_000).toISOString() }, p0: { pullRequest: pr } }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof globalThis.fetch
  const yard = createBoxYard(config, { webDir: "/nonexistent", github: { fetch, token: () => "test-token" } })
  yards.push(yard)
  // The hook below messages the Captain; it shouldn't wake and start a turn in this test.
  yard.captains.tuning.wakeDebounceMs = 10 * 60_000
  const project = yard.store.createProject({ name: "survive" })
  const as = async (caller: McpCaller) => {
    const deps = {
      store: yard.store,
      tasks: yard.tasks,
      hub: yard.hub,
      artifacts: null as never,
      publicUrl: () => "",
      scheduler: yard.scheduler,
      captains: yard.captains,
      settings: yard.settings,
      hooks: yard.hooks,
      uploads: new Uploads(uploadsDir(config.dataDir), 1024 * 1024),
    }
    const mcp = buildMcpServer(deps, caller)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await mcp.connect(a)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(b)
    clients.push({ close: async () => (await client.close(), await mcp.close()) })
    return async <T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const res = (await client.callTool({ name, arguments: args })) as ToolRes
      if (res.isError) throw new Error(res.content[0]!.text)
      return JSON.parse(res.content[0]!.text) as T
    }
  }
  /** A task resting with an open PR that Box Yard last saw as open, like task_db1a2aef762a and #91. */
  const prTask = (status: Task["status"]) => {
    const t = yard.store.createTask({ projectId: project.id, title: "Admin time and debug", prompt: "p" })
    yard.store.updateTask(t.id, { status, prUrl: PR_URL, prState: "open", prHeadSha: "a".repeat(40) }, { quiet: true })
    return t.id
  }
  return { yard, gh, project, as, prTask }
}

describe("PR states are checked before they're reported", () => {
  it("a manual merge the poll missed: list_inbox asks GitHub first, the task flips to merged and pr.merged fires once", async () => {
    const s = setup()
    const id = s.prTask("pr_ready")
    const events: TaskEvent[] = []
    s.yard.tasks.subscribe((e) => events.push(e))
    const broadcasts: Task[] = []
    const broadcast = s.yard.hub.broadcast.bind(s.yard.hub)
    s.yard.hub.broadcast = ((e: { type: string; task?: Task }) => {
      if (e.type === "task" && e.task?.id === id) broadcasts.push(e.task)
      return broadcast(e as never)
    }) as typeof s.yard.hub.broadcast
    const hook = s.yard.hooks.create({ projectId: s.project.id, name: "Merged", trigger: "pr.merged", action: "message_captain", prompt: "{task_title} merged", enabled: true, createdBy: "Cody" })

    // Box Yard's poll last saw it open (backing off, asleep, ...); then Cody merged it on GitHub.
    await s.yard.tasks.prs.pollAll()
    expect(s.yard.store.getTask(id)!.prState).toBe("open")
    s.gh.state = "MERGED"

    const coordinator = await s.as({ kind: "coordinator" })
    // Fresh (checked just now): reported as is, with when it was checked.
    const before = await coordinator<{ id: string; prState: string; prCheckedAt: string; prUnverified?: string }[]>("list_inbox")
    expect(before).toEqual([expect.objectContaining({ id, prState: "open", prCheckedAt: expect.any(String) })])
    expect(before[0]!.prUnverified).toBeUndefined()

    // Two minutes later the state is stale, so the inbox asks GitHub before answering: the merged task left it.
    const realNow = Date.now
    Date.now = () => realNow() + PR_REPORT_FRESH_MS + 1_000
    try {
      expect(await coordinator("list_inbox")).toEqual([])
    } finally {
      Date.now = realNow
    }
    const merged = s.yard.store.getTask(id)!
    expect(merged).toMatchObject({ status: "done", prState: "merged", prMergedBy: "webdevcody" })
    expect(badgeStatus(merged)).toBe("merged") // the purple Merged pill
    expect(broadcasts.at(-1)).toMatchObject({ status: "done", prState: "merged" })
    expect(s.yard.store.listTaskMessages(id, 20).map((m) => m.content)).toContain(`Pull request #91 was merged by webdevcody: ${PR_URL}`)

    // Asked about again and again (poll, refreshes, get_task): merged is final, nothing fires twice.
    await s.yard.tasks.prs.pollAll()
    await s.yard.tasks.prs.ensureFresh(null, { maxAgeMs: 0 })
    const got = await coordinator<{ prState: string; status: string }>("get_task", { task: id })
    expect(got).toMatchObject({ prState: "merged", status: "done" })
    expect(events.filter((e) => e.type === "pr.merged").map((e) => e.taskId)).toEqual([id])
    await waitFor(() => s.yard.hooks.runs({ hookId: hook.id }).length === 1, "the pr.merged hook to run")
    await new Promise((r) => setTimeout(r, 100))
    expect(s.yard.hooks.runs({ hookId: hook.id })).toHaveLength(1)
  })

  it("get_task and list_tasks refresh a done or idle task's stale PR, for a Captain too", async () => {
    const s = setup()
    const done = s.prTask("done")
    const idle = s.prTask("idle")
    // Never checked since this server started: stale.
    s.gh.state = "MERGED"
    const captain = await s.as({ kind: "captain", projectId: s.project.id })
    const one = await captain<{ prState: string; prCheckedAt: string }>("get_task", { task: done })
    expect(one).toMatchObject({ prState: "merged", prCheckedAt: expect.any(String) })
    const list = await captain<{ id: string; prState: string; status: string }[]>("list_tasks", {})
    // Resting with its PR merged: Settings › Done when its PR merges (on by default) moves it to done.
    expect(list.find((t) => t.id === idle)).toMatchObject({ prState: "merged", status: "done" })
    expect(s.gh.requests).toBe(2)
  })

  it("a PR GitHub can't confirm is reported as unverified, never just open", async () => {
    const s = setup()
    const id = s.prTask("pr_ready")
    s.gh.down = true
    const coordinator = await s.as({ kind: "coordinator" })
    const [t] = await coordinator<{ id: string; prState: string; prCheckedAt?: string; prUnverified?: string }[]>("list_inbox")
    expect(t).toMatchObject({ id, prState: "open" })
    expect(t!.prCheckedAt).toBeUndefined()
    expect(t!.prUnverified).toMatch(/hasn't confirmed this PR's state since Box Yard started \(GitHub GraphQL returned HTTP 502\).*don't tell Cody it's waiting on him/)
  })
})

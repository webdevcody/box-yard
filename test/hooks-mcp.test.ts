import { afterEach, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { MERGE_HOOK_PROMPT } from "../server/hookTemplates.js"
import { testConfig } from "./helpers.js"

// The hook tools over MCP: the Coordinator manages global hooks and any project's; a Captain only its own
// project's hooks and their runs (scoped on the server, #58).

const yards: BoxYard[] = []
const clients: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const y of yards.splice(0)) y.stop()
})

type ToolRes = { content: { text: string }[]; isError?: boolean }

function setup() {
  const config = testConfig()
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  yards.push(yard)
  yard.tasks.stop()
  const alpha = yard.store.createProject({ name: "alpha" })
  const beta = yard.store.createProject({ name: "beta" })
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
    const tool = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes
    const json = async <T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const res = await tool(name, args)
      if (res.isError) throw new Error(res.content[0]!.text)
      return JSON.parse(res.content[0]!.text) as T
    }
    return { client, tool, json }
  }
  return { yard, alpha, beta, as }
}

const HOOK_TOOLS = ["create_hook", "list_hooks", "update_hook", "delete_hook", "list_hook_runs"]

describe("hook tools", () => {
  it("are offered to both the Coordinator and Captains", async () => {
    const s = setup()
    for (const caller of [{ kind: "coordinator" } as const, { kind: "captain", projectId: s.alpha.id } as const]) {
      const names = (await (await s.as(caller)).client.listTools()).tools.map((t) => t.name)
      for (const n of HOOK_TOOLS) expect(names).toContain(n)
    }
  })

  it("let the Coordinator make global and project hooks, from a template too", async () => {
    const s = setup()
    const coord = await s.as({ kind: "coordinator" })
    const global = await coord.json("create_hook", { name: "Failures to me", trigger: "task.failed", action: "message_coordinator", prompt: "{task_title} failed" })
    expect(global).toMatchObject({ scope: "global", enabled: false, createdBy: "the Coordinator", on: "task.failed (Task failed)" })
    const merge = await coord.json("create_hook", { project: "alpha", template: "pr_merge", enabled: true })
    expect(merge).toMatchObject({ name: "On PR ready → merge", scope: "alpha", enabled: true, template: "pr_merge", prompt: MERGE_HOOK_PROMPT, filters: { excludeLabels: ["no-automerge"] } })
    const filtered = await coord.json("create_hook", {
      name: "Beta docs",
      trigger: "task.finished",
      action: "create_task",
      task_title: "Docs for {task_title}",
      prompt: "Write docs",
      filters: { project: "beta", title_regex: "^feat", sources: ["cody"] },
    })
    expect(filtered.filters).toEqual({ projectId: s.beta.id, titleRegex: "^feat", sources: ["cody"] })
    expect((await coord.json<any[]>("list_hooks")).map((h) => h.name)).toEqual(["Failures to me", "On PR ready → merge", "Beta docs"])
    expect((await coord.json<any[]>("list_hooks", { project: "global" })).map((h) => h.name)).toEqual(["Failures to me", "Beta docs"])
    expect((await coord.json<any[]>("list_hooks", { project: "alpha" })).map((h) => h.name)).toEqual(["On PR ready → merge"])
    // Filters given with a template add to its own: the no-automerge skip stays.
    const narrowed = await coord.json("create_hook", { project: "beta", template: "pr_merge", filters: { title_regex: "^feat" } })
    expect(narrowed.filters).toEqual({ titleRegex: "^feat", excludeLabels: ["no-automerge"] })
    // A bad override saves nothing (no half-made, enabled merge hook to retry into duplicates).
    const before = s.yard.hooks.list().length
    const broken = await coord.tool("create_hook", { project: "beta", template: "pr_merge", enabled: true, action: "create_task" })
    expect(broken.isError).toBe(true)
    expect(broken.content[0]!.text).toMatch(/needs a task title/)
    expect(s.yard.hooks.list()).toHaveLength(before)
    // A typo'd regex is refused with a reason.
    const bad = await coord.tool("create_hook", { name: "x", trigger: "task.failed", action: "message_coordinator", prompt: "p", filters: { title_regex: "(" } })
    expect(bad.isError).toBe(true)
    expect(bad.content[0]!.text).toMatch(/valid regular expression/)
  })

  it("keep a Captain to its own project's hooks: it can't read or change another project's, or global ones", async () => {
    const s = setup()
    const coord = await s.as({ kind: "coordinator" })
    const global = await coord.json("create_hook", { name: "Global", trigger: "task.failed", action: "message_coordinator", prompt: "g" })
    const theirs = await coord.json("create_hook", { project: "beta", name: "Beta hook", trigger: "task.failed", action: "message_captain", prompt: "b" })
    const captain = await s.as({ kind: "captain", projectId: s.alpha.id })

    // Its hooks always land in its project, made by it.
    const mine = await captain.json("create_hook", { name: "Mine", trigger: "task.finished", action: "send_to_task", prompt: "m" })
    expect(mine).toMatchObject({ scope: "alpha", createdBy: "the alpha Captain" })
    expect((await captain.json<any[]>("list_hooks")).map((h) => h.name)).toEqual(["Mine"])

    const denied: [string, Record<string, unknown>, RegExp][] = [
      ["create_hook", { project: "beta", name: "x", trigger: "task.failed", action: "message_captain", prompt: "x" }, /Out of scope: project "beta"/],
      ["create_hook", { name: "x", trigger: "task.failed", action: "message_captain", prompt: "x", filters: { project: "beta" } }, /Out of scope/],
      ["list_hooks", { project: "beta" }, /Out of scope/],
      ["list_hooks", { project: "global" }, /Out of scope: global hooks belong to the Coordinator/],
      ["update_hook", { hook: theirs.id, enabled: true }, /Out of scope: hook "Beta hook" belongs to another project/],
      ["update_hook", { hook: global.id, prompt: "pwned" }, /Out of scope: hook "Global" is a global \(Coordinator\) hook/],
      ["delete_hook", { hook: theirs.id }, /Out of scope/],
      ["delete_hook", { hook: global.id }, /Out of scope/],
      ["list_hook_runs", { hook: global.id }, /Out of scope/],
      // By name, other scopes' hooks don't even resolve.
      ["update_hook", { hook: "Beta hook", enabled: true }, /No hook "Beta hook" in this project/],
    ]
    for (const [name, args, message] of denied) {
      const res = await captain.tool(name, args)
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true)
      expect(res.content[0]!.text).toMatch(message)
    }
    // Nothing changed.
    expect(s.yard.hooks.get(theirs.id)).toMatchObject({ enabled: false, prompt: "b" })
    expect(s.yard.hooks.get(global.id)).toMatchObject({ prompt: "g" })

    // Its own hooks: update and delete work.
    expect(await captain.json("update_hook", { hook: "Mine", enabled: true })).toMatchObject({ enabled: true })
    expect((await captain.tool("delete_hook", { hook: mine.id })).content[0]!.text).toBe('Deleted hook "Mine".')
  })

  it("show a Captain only its own hooks' runs, not the global hooks' runs on its tasks", async () => {
    const s = setup()
    const coord = await s.as({ kind: "coordinator" })
    // send_to_task only queues here (the task manager is stopped), so no Captain or Coordinator turn starts.
    await coord.json("create_hook", { name: "Global", trigger: "task.finished", action: "send_to_task", prompt: "Global saw {task_title}", enabled: true })
    await coord.json("create_hook", { project: "alpha", name: "Alpha", trigger: "task.finished", action: "send_to_task", prompt: "Alpha saw {task_title}", enabled: true })
    const t = s.yard.store.createTask({ projectId: s.alpha.id, title: "Work", prompt: "w" })
    s.yard.store.updateTask(t.id, { status: "idle" }, { quiet: true })
    const runs = s.yard.hooks.handle({ type: "task.finished", taskId: t.id, turnId: "turn1", originHookIds: [] })
    expect(runs.map((r) => r.hookName)).toEqual(["Global", "Alpha"])

    expect((await coord.json<any[]>("list_hook_runs", { task: t.id })).map((r) => r.hook)).toEqual(["Alpha", "Global"])
    const captain = await s.as({ kind: "captain", projectId: s.alpha.id })
    const seen = await captain.json<any[]>("list_hook_runs", { task: t.id })
    expect(seen.map((r) => [r.hook, r.status, r.prompt])).toEqual([["Alpha", "fired", "Alpha saw Work"]])
  })
})

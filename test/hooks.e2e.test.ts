import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { TaskEvent } from "../server/tasks.js"
import { mergeRequestPrompt } from "../server/prompts.js"
import type { Hook, HookRun } from "../shared/hooks.js"
import type { Project, Task, TaskMessage } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// "On PR ready → merge" end to end: a real worker turn (fake-claude) opens a PR, the turn ends, the hook
// sends the Merge PR button's standard message, the agent merges with (mock) gh, and GitHub (faked) says
// the PR is merged. The fake GitHub reads the state file fake-claude's mock `gh pr merge` writes.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  gh: { requests: number; state: string }
}
const running: Running[] = []

const PR_URL = "https://github.com/acme/site/pull/7"
const HEAD = "c0ffee".padEnd(40, "0")

async function start(stateFile: string): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port })
  const gh = { requests: 0, state: "OPEN" }
  // GitHub's GraphQL API as the PR tracker sees it: PR #7 is open until the mock gh merges it.
  const fetch = (async () => {
    gh.requests++
    const merged = fs.existsSync(stateFile) && JSON.parse(fs.readFileSync(stateFile, "utf8")).state === "MERGED"
    gh.state = merged ? "MERGED" : "OPEN"
    const pr = merged
      ? { state: "MERGED", isDraft: false, mergedAt: new Date().toISOString(), mergedBy: { login: "fake-claude" }, headRefOid: HEAD, labels: { nodes: [] } }
      : { state: "OPEN", isDraft: false, mergedAt: null, mergedBy: null, headRefOid: HEAD, labels: { nodes: [{ name: "enhancement" }] } }
    const data = { rateLimit: { remaining: 4000, resetAt: new Date(Date.now() + 3600_000).toISOString() }, p0: { pullRequest: pr } }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof globalThis.fetch
  const yard = createBoxYard(config, { webDir: "/nonexistent", github: { fetch, token: () => "test-token" } })
  // Captains would wake on the task notices and start their own turns; this test is about the hook.
  yard.captains.tuning.wakeDebounceMs = 10 * 60_000
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, gh }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const resting = (r: Running, id: string, statuses: string[]) =>
  waitFor(async () => {
    const t = await call<Task>(r, "GET", `/api/tasks/${id}`)
    return statuses.includes(t.status) && !r.yard.store.getTaskRow(id)?.current_turn_id ? t : null
  }, `task ${id} to rest in ${statuses.join("/")}`, 30_000)

describe("On PR ready → merge, end to end", () => {
  it("merges an agent's PR once its turn ends, through the Merge button's path, and every step is visible", async () => {
    const stateFile = path.join(tmpDir(), "gh-state.json")
    const r = await start(stateFile)
    const events: TaskEvent[] = []
    r.yard.tasks.subscribe((e) => events.push(e))
    const project = await call<Project>(r, "POST", "/api/projects", { name: "site", env: { FAKE_GH_STATE: stateFile } })

    // One click: the template, then switch it on.
    const hook = await call<Hook>(r, "POST", "/api/hooks/from-template", { projectId: project.id, template: "pr_merge" })
    expect(hook).toMatchObject({ enabled: false, trigger: "task.pr_ready", action: "send_to_task", template: "pr_merge" })
    await call<Hook>(r, "PATCH", `/api/hooks/${hook.id}`, { enabled: true })

    // The agent works on it ([slow]: long enough to report a PR mid-turn) and ends its turn without mark_done ([pr]).
    const task = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Add a footer", prompt: "Add a footer [slow] [pr]" })
    await waitFor(() => r.yard.store.getTaskRow(task.id)?.status === "working", "the first turn to start")
    // What the runner reports after create_pull_request: the PR and the commit it pushed.
    await r.yard.tasks.apply(task.id, { seq: 0, ts: Date.now(), turnId: null, t: "pr", url: PR_URL, number: 7, branch: "boxyard/add-a-footer", headSha: HEAD })

    // The turn ends → pr_ready → the hook asks for the merge → a second turn merges → GitHub says merged → done.
    const done = await resting(r, task.id, ["done"])
    expect(done).toMatchObject({ prState: "merged", prMergedBy: "fake-claude", turnCount: 2, mergeRequest: null })
    expect(r.gh.state).toBe("MERGED")
    expect(events.filter((e) => e.taskId === task.id).map((e) => e.type)).toEqual(["task.finished", "task.pr_ready", "pr.merged", "task.finished"])

    // Fired exactly once, for this head commit, with the standard message.
    const runs = await call<HookRun[]>(r, "GET", `/api/hooks/runs?projectId=${project.id}`)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ hookId: hook.id, status: "fired", event: "task.pr_ready", headSha: HEAD, taskId: task.id, prompt: mergeRequestPrompt(7) })
    // The hook's own merge turn ended (task.finished), and the hook didn't fire on it.
    expect(r.yard.store.turnFlags(r.yard.store.getTaskRow(task.id)!).lastHookIds).toEqual([hook.id])

    // The transcript: the PR, the hook's message as "Hook: On PR ready → merge", the merge request, the merge.
    const transcript = await call<TaskMessage[]>(r, "GET", `/api/tasks/${task.id}/messages`)
    const hookLine = transcript.find((m) => m.role === "user" && m.meta?.source === "hook")!
    expect(hookLine).toMatchObject({ content: mergeRequestPrompt(7), meta: expect.objectContaining({ hookName: "On PR ready → merge" }) })
    expect(transcript.find((m) => m.meta?.kind === "merge_requested")!.content).toBe('The hook "On PR ready → merge" asked for a merge of PR #7.')
    expect(transcript.some((m) => m.role === "assistant" && m.content.includes("Merged PR #7"))).toBe(true)
    expect(transcript.some((m) => m.role === "event" && m.content.startsWith("Pull request #7 was merged by fake-claude"))).toBe(true)
    const order = ["Opened pull request", 'The hook "On PR ready → merge" asked', "Pull request #7 was merged"].map((p) => transcript.findIndex((m) => m.content.startsWith(p)))
    expect(order).toEqual([...order].sort((a, b) => a - b))

    // The agent got the message labelled as the hook, not as Cody.
    const turn = JSON.parse(fs.readFileSync(path.join(r.yard.tasks.taskDir(done.boxId!, task.id), "turn.json"), "utf8"))
    expect(turn.prompt).toMatch(/^Message from the Box Yard hook "On PR ready → merge" \(an automation that runs on "PR ready", set up by Cody; not a new message from Cody\):/)
    expect(turn.prompt).toContain(mergeRequestPrompt(7))

    // Both the Captain and the Coordinator were told, so neither merges it in parallel.
    const notice = '🚢 The hook "On PR ready → merge" asked **Add a footer** to merge PR #7: ' + PR_URL
    const captain = r.yard.store.listCaptainMessages(project.id).filter((m) => m.role === "notice").map((m) => m.content)
    expect(captain).toContain(notice)
    const coordinator = r.yard.store.db
      .prepare("SELECT content, seen_by_orchestrator AS seen FROM chat_messages WHERE role = 'notice' AND content = ?")
      .all(notice) as { content: string; seen: number }[]
    expect(coordinator).toEqual([{ content: notice, seen: 0 }])
  }, 60_000)

  it("leaves a PR labelled no-automerge alone", async () => {
    const stateFile = path.join(tmpDir(), "gh-state.json")
    const r = await start(stateFile)
    const project = await call<Project>(r, "POST", "/api/projects", { name: "site", env: { FAKE_GH_STATE: stateFile } })
    const hook = await call<Hook>(r, "POST", "/api/hooks/from-template", { projectId: project.id, template: "pr_merge", enabled: true })
    await call<Hook>(r, "PATCH", `/api/hooks/${hook.id}`, { filters: { excludeLabels: ["enhancement"] } })
    const task = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Tweak copy", prompt: "Tweak the copy [slow] [pr]" })
    await waitFor(() => r.yard.store.getTaskRow(task.id)?.status === "working", "the turn to start")
    await r.yard.tasks.apply(task.id, { seq: 0, ts: Date.now(), turnId: null, t: "pr", url: PR_URL, number: 7, branch: "boxyard/tweak", headSha: HEAD })
    const t = await resting(r, task.id, ["pr_ready"])
    // GitHub told the tracker about the label at turn end, so the hook saw it.
    expect(r.yard.store.getTaskRow(t.id)!.pr_labels_json).toBe('["enhancement"]')
    expect(t.turnCount).toBe(1)
    expect(await call<HookRun[]>(r, "GET", `/api/hooks/runs?projectId=${project.id}`)).toEqual([])
  }, 60_000)
})

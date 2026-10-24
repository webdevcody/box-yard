// The "Merge PR" button on the server: POST /api/tasks/:id/merge sends the standard merge message to the task's
// session (now, or queued while the agent is mid-turn), refuses duplicates while one is pending, and tells the
// project Captain (through its wake path) and the Coordinator (in its "[Box Yard updates]").
import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { MERGE_REQUEST_PROMPT, followupPrompt, mergeRequestPrompt } from "../server/prompts.js"
import { userMessageLabel } from "../shared/sender.js"
import type { CaptainState, Project, Task } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
}
const running: Running[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port })
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  yard.captains.tuning.wakeDebounceMs = 30
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, dataDir: config.dataDir }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    // Let agent, Captain and Coordinator turns finish before the database closes.
    await waitFor(() => r.yard.store.listTasks().every((t) => !["queued", "starting", "working"].includes(t.status) && !t.pendingCount), "agents idle", 30_000).catch(() => {})
    await waitFor(() => !r.yard.captains.anyBusy(), "Captains idle").catch(() => {})
    await waitFor(async () => !(await raw(r, "GET", "/api/orchestrator").then((x) => x.data as { busy: boolean })).busy, "Coordinator idle").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function raw(r: Running, method: string, p: string, body?: unknown) {
  const res = await fetch(r.base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: (await res.json()) as unknown }
}

async function call<T>(r: Running, method: string, p: string, body?: unknown): Promise<T> {
  const { status, data } = await raw(r, method, p, body)
  if (status >= 400) throw new Error(`${method} ${p} -> ${status}: ${JSON.stringify(data)}`)
  return data as T
}

const PR = "https://github.com/acme/shop/pull/12"
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const merge = (r: Running, id: string) => raw(r, "POST", `/api/tasks/${id}/merge`)

/** A task that has run its first turn and has an open PR. */
async function taskWithPr(r: Running, prompt = "build the cart") {
  const p = await call<Project>(r, "POST", "/api/projects", { name: "shop" })
  const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Cart page", prompt })
  return { p, t }
}

/** Every prompt a fake Claude session received (scripts/fake-claude.mjs keeps them in its session file). */
function sessionPrompts(r: Running, kvKey: string): string[] {
  const id = r.yard.store.getKv(kvKey)
  if (!id) return []
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude"), "fake-sessions", `${id}.json`)
  if (!fs.existsSync(file)) return []
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: { prompt: string }[] }).turns.map((t) => t.prompt)
}

/** Every state of a task the server broadcast (a mock turn can come and go between two polls). */
function recordTask(r: Running, taskId: string): Task[] {
  const seen: Task[] = []
  const broadcast = r.yard.hub.broadcast.bind(r.yard.hub)
  r.yard.hub.broadcast = (event) => {
    if (event.type === "task" && event.task.id === taskId) seen.push(event.task)
    broadcast(event)
  }
  return seen
}

const workerPrompt = (r: Running, task: Task) => fs.readFileSync(path.join(r.dataDir, "local-boxes", task.boxId!, "tasks", task.id, "work", "box-yard-demo.md"), "utf8")

describe("merge request message", () => {
  it("is one standard text with the PR number, labelled as Cody's Merge button", () => {
    const text = mergeRequestPrompt(12)
    expect(MERGE_REQUEST_PROMPT).toContain("{N}")
    expect(text).toContain("Merge your pull request #12.")
    expect(text).toContain("gh pr view 12 --json state")
    expect(text).toMatch(/MERGED, don't push anything to the branch/)
    expect(text).toContain("gh pr merge 12 --squash --delete-branch --match-head-commit <tested sha>")
    expect(text).toMatch(/If anything fails, don't merge: comment the exact error on the PR/)
    expect(text).toContain("Reply with the merge SHA or the error.")
    expect(followupPrompt([{ source: "cody:merge", content: "x" }])).toBe("Message from Cody (Merge button):\n\nx")
    expect(userMessageLabel({ source: "cody:merge" })).toBe("Cody (Merge button)")
  })
})

describe("POST /api/tasks/:id/merge", () => {
  it("delivers now to an idle task, refuses a duplicate while pending, and clears when the turn ends", async () => {
    const r = await start()
    const { t } = await taskWithPr(r)
    await waitFor(async () => (await getTask(r, t.id)).status === "done", "first turn")
    r.yard.store.updateTask(t.id, { prUrl: PR, prState: "open" })

    const first = await merge(r, t.id)
    expect(first.status).toBe(200)
    const sent = first.data as { task: Task; delivery: string }
    expect(sent.delivery).toBe("now")
    expect(sent.task.mergeRequest).toMatchObject({ prNumber: 12, prUrl: PR, deliveredAt: null })

    // Server-side duplicate guard: same PR, still pending.
    const again = await merge(r, t.id)
    expect(again.status).toBe(409)
    expect((again.data as { error: string }).error).toMatch(/already requested/)

    // The transcript has a merge_requested event.
    expect(r.yard.store.listTaskMessages(t.id, 100).filter((m) => m.meta?.kind === "merge_requested")).toHaveLength(1)

    // The agent gets it in its session, then the request clears with the turn.
    const done = await waitFor(async () => {
      const x = await getTask(r, t.id)
      return x.turnCount >= 2 && !["queued", "starting", "working"].includes(x.status) ? x : null
    }, "merge turn")
    // Delivered, Cody's message (labelled) is in the transcript, once.
    const user = r.yard.store.listTaskMessages(t.id, 100).filter((m) => m.role === "user" && m.meta?.source === "cody:merge")
    expect(user).toHaveLength(1)
    expect(user[0]!.content).toBe(mergeRequestPrompt(12))
    expect(done.mergeRequest).toBeNull()
    expect(workerPrompt(r, done)).toContain(`Message from Cody (Merge button):\n\n${mergeRequestPrompt(12)}`)
    expect((await merge(r, t.id)).status).toBe(200)
  })

  it("queues behind a busy agent's turn and shows queued until it goes out", async () => {
    const r = await start()
    const { t } = await taskWithPr(r, "build the cart [slow]")
    const states = recordTask(r, t.id)
    await waitFor(async () => (await getTask(r, t.id)).status === "working", "agent busy")
    r.yard.store.updateTask(t.id, { prUrl: PR, prState: "open" })

    const res = await merge(r, t.id)
    expect(res.status).toBe(200)
    const { task, delivery } = res.data as { task: Task; delivery: string }
    expect(delivery).toBe("queued")
    expect(task.mergeRequest).toMatchObject({ prNumber: 12, deliveredAt: null })
    expect(task.pendingCount).toBe(1)
    expect((await merge(r, t.id)).status).toBe(409)
    const event = r.yard.store.listTaskMessages(t.id, 100).find((m) => m.meta?.kind === "merge_requested")
    expect(event?.content).toMatch(/goes out when the current turn ends/)

    // The busy turn ends; the next one carries the request (delivered), and then it clears.
    await waitFor(() => states.some((x) => x.mergeRequest?.deliveredAt && x.status === "working"), "delivered in the next turn", 30_000)
    await waitFor(async () => {
      const x = await getTask(r, t.id)
      return x.turnCount >= 2 && x.mergeRequest === null && !["queued", "starting", "working"].includes(x.status)
    }, "merge turn done", 30_000)
  })

  it("refuses tasks without an open PR", async () => {
    const r = await start()
    const { t } = await taskWithPr(r)
    await waitFor(async () => (await getTask(r, t.id)).status === "done", "first turn")
    expect((await merge(r, t.id)).status).toBe(400)
    for (const prState of ["merged", "closed", "draft"] as const) {
      r.yard.store.updateTask(t.id, { prUrl: PR, prState })
      const res = await merge(r, t.id)
      expect(res.status).toBe(400)
      expect((res.data as { error: string }).error).toContain("PR #12")
    }
  })

  it("clears a pending request when the PR is merged", async () => {
    const r = await start()
    const { t } = await taskWithPr(r, "build the cart [slow]")
    await waitFor(async () => (await getTask(r, t.id)).status === "working", "agent busy")
    r.yard.store.updateTask(t.id, { prUrl: PR, prState: "open" })
    expect((await merge(r, t.id)).status).toBe(200)
    r.yard.tasks.prs.apply(t.id, PR, { state: "merged", mergedAt: Date.now(), mergedBy: "cody" })
    expect((await getTask(r, t.id)).mergeRequest).toBeNull()
  })
})

describe("Captain and Coordinator notices", () => {
  it("reach the Captain's wake path once the agent's turn ends, and the Coordinator's updates", async () => {
    const r = await start()
    const { p, t } = await taskWithPr(r, "build the cart [slow]")
    await waitFor(async () => (await getTask(r, t.id)).status === "working", "agent busy")
    r.yard.store.updateTask(t.id, { prUrl: PR, prState: "open" })
    expect((await merge(r, t.id)).status).toBe(200)
    const notice = "🚢 Cody asked **Cart page** to merge PR #12 (Merge button): " + PR

    // The Captain has it queued, and doesn't wake for it while the agent is busy.
    const captainNotice = r.yard.store.listCaptainMessages(p.id, 100).find((m) => m.role === "notice" && m.meta?.kind === "merge_requested")
    expect(captainNotice?.content).toBe(notice)
    expect(captainNotice?.meta).toMatchObject({ taskId: t.id, prNumber: 12, prUrl: PR })
    await new Promise((res) => setTimeout(res, 300))
    expect(r.yard.store.peekUnseenCaptainNotices(p.id)).toContain(notice)
    expect((r.yard.captains.state(p.id) as CaptainState).autoTurns).toBe(0)

    // When the turns end, one automatic wake-up (through the loop guard) carries it.
    await waitFor(async () => {
      const x = await getTask(r, t.id)
      return x.turnCount >= 2 && !["queued", "starting", "working"].includes(x.status)
    }, "merge turn done", 30_000)
    await waitFor(() => r.yard.store.peekUnseenCaptainNotices(p.id).length === 0 && !r.yard.captains.anyBusy(), "Captain woke", 30_000)
    const wake = sessionPrompts(r, `captain_session:${p.id}`).find((x) => x.includes(notice))
    expect(wake).toContain(`[Project updates since your last turn]\n- ${notice}`)
    expect(wake).toContain("(Automatic wake-up")
    expect((r.yard.captains.state(p.id) as CaptainState).autoTurns).toBeGreaterThanOrEqual(1)

    // The Coordinator: the Captain handled the task's other notices, but this one stays in its updates.
    const unseen = r.yard.store.db
      .prepare("SELECT content FROM chat_messages WHERE role = 'notice' AND seen_by_orchestrator = 0 AND json_extract(meta_json, '$.taskId') = ?")
      .all(t.id) as { content: string }[]
    expect(unseen.map((x) => x.content)).toEqual([notice])
    await call(r, "POST", "/api/chat", { content: "status" })
    await waitFor(async () => !((await call<{ busy: boolean }>(r, "GET", "/api/orchestrator")).busy) && sessionPrompts(r, "orchestrator_session").length > 0, "Coordinator turn")
    const coordinator = sessionPrompts(r, "orchestrator_session").at(-1)!
    expect(coordinator).toContain(`[Box Yard updates since your last turn]`)
    expect(coordinator).toContain(`- ${notice}`)
    expect(coordinator).not.toContain("is done:")
  })

  it("prompts tell the Captain and the Coordinator not to start a parallel merge", async () => {
    const { ORCHESTRATOR_PROMPT, captainPrompt } = await import("../server/prompts.js")
    const captain = captainPrompt({ id: "prj_x", name: "shop", description: "", repo: "acme/shop", baseBranch: "main" } as Project)
    for (const text of [ORCHESTRATOR_PROMPT, captain]) {
      expect(text).toContain('"Merge PR" button')
      expect(text).toContain("🚢 Cody asked <task> to merge PR #N")
      expect(text).toMatch(/don't start (a parallel|or ask for another) merge of that PR/)
    }
  })
})

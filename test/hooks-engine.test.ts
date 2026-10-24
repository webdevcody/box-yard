import { afterEach, describe, expect, it } from "vitest"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { HookStore, type HookInput } from "../server/hookStore.js"
import { HookEngine, type HookMeta } from "../server/hooks.js"
import type { TaskEvent } from "../server/tasks.js"
import { mergeRequestPrompt } from "../server/prompts.js"
import type { Project, Task } from "../shared/types.js"
import { testConfig } from "./helpers.js"

// The hook engine against a real store and task manager, with task events fed in directly. The task
// manager is stopped, so queued hook prompts stay queued instead of starting worker turns.

const yards: BoxYard[] = []
afterEach(() => {
  for (const y of yards.splice(0)) y.stop()
})

function setup() {
  const yard = createBoxYard(testConfig(), { webDir: "/nonexistent" })
  yards.push(yard)
  // Our own engine with recording stubs replaces the app's, and nothing launches.
  yard.hooks.stop()
  yard.tasks.stop()
  const sent = { captain: [] as { projectId: string; content: string; meta: HookMeta }[], coordinator: [] as { content: string; meta: HookMeta }[] }
  const engine = new HookEngine({
    store: yard.store,
    hooks: new HookStore(yard.db),
    tasks: yard.tasks,
    hub: yard.hub,
    messageCaptain: (projectId, content, meta) => void sent.captain.push({ projectId, content, meta }),
    messageCoordinator: (content, meta) => void sent.coordinator.push({ content, meta }),
  })
  const alpha = yard.store.createProject({ name: "alpha", repo: "acme/alpha" })
  const beta = yard.store.createProject({ name: "beta" })
  return { yard, engine, sent, alpha, beta }
}

type Setup = ReturnType<typeof setup>

/** A task resting with an open PR at a head commit, like after create_pull_request and a finished turn. */
function prTask(s: Setup, project: Project, opts: { title?: string; sha?: string; labels?: string[]; draft?: boolean; source?: string } = {}): Task {
  const t = s.yard.store.createTask({ projectId: project.id, title: opts.title ?? "Add dark mode", prompt: "Add a dark mode toggle", branch: "boxyard/dark-1a2b", startedBy: opts.source ?? "cody" })
  s.yard.store.updateTask(
    t.id,
    {
      status: "pr_ready",
      prUrl: "https://github.com/acme/alpha/pull/7",
      prState: opts.draft ? "draft" : "open",
      prHeadSha: opts.sha ?? "a".repeat(40),
      prLabels: opts.labels ?? [],
      summary: "Added the toggle.",
      turnCount: 1,
    },
    { quiet: true },
  )
  return s.yard.store.getTask(t.id)!
}

const setSha = (s: Setup, taskId: string, sha: string) => s.yard.store.updateTask(taskId, { prHeadSha: sha }, { quiet: true })

const ev = (taskId: string, over: Partial<TaskEvent> = {}): TaskEvent => ({ type: "task.pr_ready", taskId, turnId: `turn_${Math.random()}`, originHookIds: [], sawPr: true, ...over })

function hook(s: Setup, over: Partial<HookInput> = {}) {
  return s.engine.create({
    name: "Auto-merge",
    projectId: s.alpha.id,
    trigger: "task.pr_ready",
    action: "send_to_task",
    prompt: "Please merge {pr_url} (#{pr_number}) at {head_sha} for {task_title}.",
    enabled: true,
    createdBy: "Cody",
    ...over,
  })
}

const inputs = (s: Setup, taskId: string) => s.yard.store.peekInputs(taskId)

const notices = (s: Setup, taskId: string) => ({
  captain: s.yard.store.db
    .prepare("SELECT content, seen_by_captain AS seen FROM captain_messages WHERE role = 'notice' AND json_extract(meta_json, '$.taskId') = ?")
    .all(taskId) as { content: string; seen: number }[],
  coordinator: s.yard.store.db
    .prepare("SELECT content, seen_by_orchestrator AS seen FROM chat_messages WHERE role = 'notice' AND json_extract(meta_json, '$.taskId') = ?")
    .all(taskId) as { content: string; seen: number }[],
})

describe("hook engine: firing", () => {
  it("sends the rendered prompt to the task like send_to_task, labelled as the hook, and logs the run", () => {
    const s = setup()
    const h = hook(s)
    const t = prTask(s, s.alpha)
    const [run] = s.engine.handle(ev(t.id))
    expect(run).toMatchObject({ status: "fired", hookId: h.id, hookName: "Auto-merge", taskId: t.id, targetTaskId: t.id, headSha: "a".repeat(40), action: "send_to_task" })
    expect(run!.prompt).toBe(`Please merge https://github.com/acme/alpha/pull/7 (#7) at ${"a".repeat(40)} for Add dark mode.`)

    // Queued like any message: the agent gets it labelled as the hook, and the task wakes up.
    const queued = inputs(s, t.id)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.source).toBe(`hook:${h.id}`)
    expect(queued[0]!.content).toMatch(/^Message from the Box Yard hook "Auto-merge" \(an automation that runs on "PR ready", set up by Cody/)
    expect(queued[0]!.content).toContain(run!.prompt)
    expect(s.yard.store.getTask(t.id)!.status).toBe("queued")

    // Until a turn takes it, it's a Queued row "Hook: Auto-merge" holding just the prompt (the label is the agent's).
    expect(s.yard.tasks.listQueue(t.id)).toMatchObject([{ kind: "hook", sender: "Hook: Auto-merge", text: run!.prompt }])
    // Delivered, the transcript shows the prompt as "Hook: Auto-merge".
    s.yard.store.claimInputs(t.id, "turn-1")
    const [line] = s.yard.store.deliverInputs("turn-1")
    expect(line!.content).toBe(run!.prompt)
    expect(line!.meta).toMatchObject({ source: "hook", hookId: h.id, hookName: "Auto-merge" })
    expect(s.yard.store.listTaskMessages(t.id).find((m) => m.role === "user")).toEqual(line)
  })

  it("tells both the Captain and the Coordinator, without waking either", () => {
    const s = setup()
    hook(s)
    const t = prTask(s, s.alpha)
    s.engine.handle(ev(t.id))
    const n = notices(s, t.id)
    expect(n.captain).toHaveLength(1)
    expect(n.coordinator).toHaveLength(1)
    for (const x of [n.captain[0]!, n.coordinator[0]!]) {
      expect(x.content).toMatch(/^🪝 \*\*Add dark mode\*\* hook "Auto-merge" \(PR ready\) sent to the agent \(PR #7 at aaaaaaa\): Please merge/)
      // Unseen: both read it as "[Box Yard updates]" on their next turn.
      expect(x.seen).toBe(0)
    }
    expect(s.yard.store.takeUnseenNotices().some((c) => c.includes('hook "Auto-merge"'))).toBe(true)
    expect(s.yard.store.takeUnseenCaptainNotices(s.alpha.id).some((c) => c.includes('hook "Auto-merge"'))).toBe(true)
  })

  it("runs the other actions: message the Captain, message the Coordinator, create a task", () => {
    const s = setup()
    hook(s, { name: "Tell captain", action: "message_captain", prompt: "{task_title} is ready: {pr_url}" })
    hook(s, { name: "Tell coordinator", action: "message_coordinator", prompt: "Heads up: {task_title}" })
    const review = hook(s, { name: "Review", action: "create_task", taskTitle: "Review {task_title}", prompt: "Review PR {pr_url} on {branch}" })
    const t = prTask(s, s.alpha)
    const runs = s.engine.handle(ev(t.id))
    expect(runs.map((r) => [r.hookName, r.status])).toEqual([
      ["Tell captain", "fired"],
      ["Tell coordinator", "fired"],
      ["Review", "fired"],
    ])
    expect(s.sent.captain).toEqual([{ projectId: s.alpha.id, content: "Add dark mode is ready: https://github.com/acme/alpha/pull/7", meta: expect.objectContaining({ source: "hook", hookName: "Tell captain", taskId: t.id }) }])
    expect(s.sent.coordinator).toEqual([{ content: "Heads up: Add dark mode", meta: expect.objectContaining({ hookName: "Tell coordinator" }) }])
    const created = s.yard.store.getTask(runs[2]!.targetTaskId!)!
    expect(created).toMatchObject({ title: "Review Add dark mode", prompt: "Review PR https://github.com/acme/alpha/pull/7 on boxyard/dark-1a2b", projectId: s.alpha.id })
    expect(s.yard.store.getTaskRow(created.id)!.source).toBe(`hook:${review.id}`)
    // Each one is on the source task's transcript.
    const events = s.yard.store.listTaskMessages(t.id).filter((m) => m.meta?.kind === "hook").map((m) => m.content)
    expect(events[0]).toMatch(/^Hook "Tell captain" \(PR ready\) messaged the alpha Captain/)
    expect(events[1]).toMatch(/^Hook "Tell coordinator" \(PR ready\) messaged the Coordinator/)
    expect(events[2]).toBe(`Hook "Review" (PR ready) started [Review Add dark mode](/tasks/${created.id}).`)
  })

  it("project hooks see only their project; global hooks see every project unless filtered", () => {
    const s = setup()
    hook(s, { name: "alpha only" })
    hook(s, { name: "global", projectId: null })
    hook(s, { name: "global, beta only", projectId: null, filters: { projectId: s.beta.id } })
    hook(s, { name: "off", enabled: false })
    const a = prTask(s, s.alpha)
    const b = prTask(s, s.beta)
    expect(s.engine.handle(ev(a.id)).map((r) => r.hookName)).toEqual(["alpha only", "global"])
    expect(s.engine.handle(ev(b.id)).map((r) => r.hookName)).toEqual(["global", "global, beta only"])
  })

  it("applies the task and PR filters to real tasks", () => {
    const s = setup()
    hook(s, { name: "skip no-automerge", filters: { excludeLabels: ["no-automerge"] } })
    hook(s, { name: "only docs", filters: { titleRegex: "^docs" } })
    hook(s, { name: "only Captain's", filters: { sources: ["captain"] } })
    expect(s.engine.handle(ev(prTask(s, s.alpha, { labels: ["no-automerge"] }).id)).map((r) => r.hookName)).toEqual([])
    expect(s.engine.handle(ev(prTask(s, s.alpha, { title: "Docs: fix typo" }).id)).map((r) => r.hookName)).toEqual(["skip no-automerge", "only docs"])
    expect(s.engine.handle(ev(prTask(s, s.alpha, { source: "captain:x" }).id)).map((r) => r.hookName)).toEqual(["skip no-automerge", "only Captain's"])
    // Drafts are skipped by default.
    expect(s.engine.handle(ev(prTask(s, s.alpha, { draft: true }).id))).toEqual([])
  })
})

describe("hook engine: fire once", () => {
  it("fires once per head commit: the same commit doesn't fire again, a new push does", () => {
    const s = setup()
    const h = hook(s)
    const t = prTask(s, s.alpha, { sha: "1".repeat(40) })
    expect(s.engine.handle(ev(t.id))).toHaveLength(1)
    // Another turn ends (Cody asked a question) with the same commit: nothing.
    expect(s.engine.handle(ev(t.id, { sawPr: false }))).toEqual([])
    expect(s.engine.handle(ev(t.id))).toEqual([])
    setSha(s, t.id, "2".repeat(40))
    const [again] = s.engine.handle(ev(t.id))
    expect(again).toMatchObject({ status: "fired", headSha: "2".repeat(40) })
    expect(s.engine.runs({ hookId: h.id }).map((r) => r.headSha)).toEqual(["2".repeat(40), "1".repeat(40)])
    expect(inputs(s, t.id)).toHaveLength(2)
  })

  it("without a known commit, only a turn that pushed counts", () => {
    const s = setup()
    hook(s)
    const t = prTask(s, s.alpha)
    s.yard.store.updateTask(t.id, { prHeadSha: null }, { quiet: true })
    expect(s.engine.handle(ev(t.id, { sawPr: false }))).toEqual([])
    expect(s.engine.handle(ev(t.id, { turnId: "turn_x", sawPr: true }))).toHaveLength(1)
    expect(s.engine.handle(ev(t.id, { turnId: "turn_x", sawPr: true }))).toEqual([])
  })

  it("other events fire once per turn", () => {
    const s = setup()
    hook(s, { trigger: "task.finished", prompt: "Summarize {task_title}" })
    const t = prTask(s, s.alpha)
    expect(s.engine.handle(ev(t.id, { type: "task.finished", turnId: "t1" }))).toHaveLength(1)
    expect(s.engine.handle(ev(t.id, { type: "task.finished", turnId: "t1" }))).toEqual([])
    expect(s.engine.handle(ev(t.id, { type: "task.finished", turnId: "t2" }))).toHaveLength(1)
  })
})

describe("hook engine: loop guards and limits", () => {
  it("doesn't fire on a turn its own prompt started, unless it allows that", () => {
    const s = setup()
    const h = hook(s, { trigger: "task.finished" })
    const t = prTask(s, s.alpha)
    const [run] = s.engine.handle(ev(t.id, { type: "task.finished", originHookIds: [h.id] }))
    expect(run).toMatchObject({ status: "skipped", result: "Skipped by the loop guard: this hook's own prompt started this work." })
    expect(inputs(s, t.id)).toEqual([])
    // Noted on the transcript, and not logged again for the same event.
    expect(s.yard.store.listTaskMessages(t.id).some((m) => m.meta?.kind === "hook" && /didn't fire\. Skipped by the loop guard/.test(m.content))).toBe(true)
    expect(s.engine.handle(ev(t.id, { type: "task.finished", turnId: run!.id, originHookIds: [h.id] }))).toHaveLength(1) // another turn: logged once more
    // Another hook's turn is fine.
    expect(s.engine.handle(ev(t.id, { type: "task.finished", originHookIds: ["hook_other"] }))[0]).toMatchObject({ status: "fired" })

    s.engine.update(h.id, { allowSelfTrigger: true })
    expect(s.engine.handle(ev(t.id, { type: "task.finished", originHookIds: [h.id] }))[0]).toMatchObject({ status: "fired" })
  })

  it("never fires on tasks it created, even down a chain of hook-made tasks", () => {
    const s = setup()
    const a = hook(s, { name: "A", trigger: "task.finished", action: "create_task", taskTitle: "A after {task_title}", prompt: "a" })
    const b = hook(s, { name: "B", trigger: "task.finished", action: "create_task", taskTitle: "B after {task_title}", prompt: "b", filters: { titleRegex: "^A after" } })
    const t = prTask(s, s.alpha)
    const [first] = s.engine.handle(ev(t.id, { type: "task.finished" }))
    const t1 = first!.targetTaskId!
    // On A's task, A is held back by the loop guard and B fires.
    const second = s.engine.handle(ev(t1, { type: "task.finished" }))
    expect(second.map((r) => [r.hookId, r.status])).toEqual([
      [a.id, "skipped"],
      [b.id, "fired"],
    ])
    // On B's task (made from A's), neither A nor B fires again.
    const third = s.engine.handle(ev(second[1]!.targetTaskId!, { type: "task.finished" }))
    expect(third.map((r) => r.status)).toEqual(["skipped"])
    expect(third[0]!.hookId).toBe(a.id)
  })

  it("caps fires per task for each hook", () => {
    const s = setup()
    hook(s, { maxFiresPerTask: 2 })
    const t = prTask(s, s.alpha)
    for (const sha of ["1", "2"]) {
      setSha(s, t.id, sha.repeat(40))
      expect(s.engine.handle(ev(t.id))[0]!.status).toBe("fired")
    }
    setSha(s, t.id, "3".repeat(40))
    expect(s.engine.handle(ev(t.id))[0]).toMatchObject({ status: "skipped", result: "Skipped: this hook already fired 2 times for this task, its limit." })
  })

  it("caps fires per task across all hooks", () => {
    const s = setup()
    s.engine.tuning.taskCap = { max: 2, windowMs: 60_000 }
    for (const name of ["one", "two", "three"]) hook(s, { name })
    const t = prTask(s, s.alpha)
    expect(s.engine.handle(ev(t.id)).map((r) => r.status)).toEqual(["fired", "fired", "skipped"])
  })

  it("rate-limits fires across the yard", () => {
    const s = setup()
    s.engine.tuning.rateLimit = { max: 2, windowMs: 60_000 }
    hook(s)
    const runs = [1, 2, 3].map(() => s.engine.handle(ev(prTask(s, s.alpha).id))[0]!)
    expect(runs.map((r) => r.status)).toEqual(["fired", "fired", "skipped"])
    expect(runs[2]!.result).toBe("Skipped by the rate limit: hooks fired 2 times across the yard in 1 min.")
    // Skipped runs don't count toward the limit, and a later event fires once the window allows.
    s.engine.tuning.rateLimit = { max: 3, windowMs: 60_000 }
    expect(s.engine.handle(ev(prTask(s, s.alpha).id))[0]!.status).toBe("fired")
  })

  it("logs a failed action instead of throwing, and failures count toward the caps", () => {
    const s = setup()
    hook(s, { action: "message_captain", trigger: "task.finished", maxFiresPerTask: 2 })
    const engine = new HookEngine({ ...(s.engine as unknown as { deps: ConstructorParameters<typeof HookEngine>[0] }).deps, messageCaptain: () => { throw new Error("Captain is gone") } })
    const t = prTask(s, s.alpha)
    const runs = ["t1", "t2", "t3"].map((turnId) => engine.handle(ev(t.id, { type: "task.finished", turnId }))[0]!)
    expect(runs.map((r) => r.status)).toEqual(["failed", "failed", "skipped"])
    expect(runs[0]!.result).toBe("Failed: Captain is gone")
    expect(runs[2]!.guard).toBe("hook_cap")
  })
})

describe("the On PR ready → merge template", () => {
  function mergeHook(s: Setup) {
    const h = s.engine.fromTemplate("pr_merge", { projectId: s.alpha.id, createdBy: "Cody" })
    return s.engine.update(h.id, { enabled: true })
  }

  it("sends the Merge PR button's standard message through the button's path, labelled as the hook", () => {
    const s = setup()
    const h = mergeHook(s)
    const t = prTask(s, s.alpha)
    const [run] = s.engine.handle(ev(t.id))
    expect(run).toMatchObject({ status: "fired", result: "Asked the agent to merge (PR #7 at aaaaaaa).", targetTaskId: t.id })
    // The same message the button sends, with the PR number filled in.
    expect(run!.prompt).toBe(mergeRequestPrompt(7))
    const [queued] = inputs(s, t.id)
    expect(queued!.source).toBe(`hook:${h.id}`)
    expect(queued!.content).toContain(mergeRequestPrompt(7))
    // The button's pending guard, merge_requested event and notices, naming the hook instead of Cody.
    expect(s.yard.store.getTask(t.id)!.mergeRequest).toMatchObject({ prNumber: 7, deliveredAt: null, requestedBy: 'hook "On PR ready → merge"' })
    expect(s.yard.tasks.listQueue(t.id)).toMatchObject([{ kind: "hook", sender: "Hook: On PR ready → merge", text: mergeRequestPrompt(7) }])
    s.yard.store.claimInputs(t.id, "turn-1")
    s.yard.store.deliverInputs("turn-1")
    const msgs = s.yard.store.listTaskMessages(t.id)
    expect(msgs.find((m) => m.role === "user")).toMatchObject({ content: mergeRequestPrompt(7), meta: expect.objectContaining({ source: "hook", hookName: "On PR ready → merge" }) })
    expect(msgs.find((m) => m.meta?.kind === "merge_requested")!.content).toBe('The hook "On PR ready → merge" asked for a merge of PR #7.')
    const n = notices(s, t.id)
    expect(n.captain.map((x) => x.content)).toEqual(['🚢 The hook "On PR ready → merge" asked **Add dark mode** to merge PR #7: https://github.com/acme/alpha/pull/7'])
    expect(n.coordinator.map((x) => [x.content, x.seen])).toEqual([[n.captain[0]!.content, 0]])
  })

  it("doesn't ask while a merge of the PR is pending, and an edited prompt is sent as written", () => {
    const s = setup()
    const h = mergeHook(s)
    const t = prTask(s, s.alpha)
    s.yard.tasks.requestMerge(t.id) // Cody pressed Merge PR first
    const [run] = s.engine.handle(ev(t.id))
    expect(run).toMatchObject({ status: "skipped", guard: null })
    expect(run!.result).toMatch(/^Skipped: A merge of PR #7 was already requested/)
    expect(inputs(s, t.id)).toHaveLength(1) // only the button's message
    // Settled for this commit: the same commit won't ask again.
    expect(s.engine.handle(ev(t.id))).toEqual([])

    s.engine.update(h.id, { prompt: "Squash-merge #{pr_number} once CI is green." })
    const other = prTask(s, s.alpha, { title: "Other" })
    expect(s.engine.handle(ev(other.id))[0]!.prompt).toBe("Squash-merge #7 once CI is green.")
    expect(s.yard.store.getTask(other.id)!.mergeRequest?.requestedBy).toBe('hook "On PR ready → merge"')
  })
})

describe("hook management", () => {
  it("keeps a stable order, validates, and starts templates off", () => {
    const s = setup()
    const a = hook(s, { name: "first" })
    const b = hook(s, { name: "second" })
    s.engine.update(a.id, { prompt: "edited" })
    expect(s.engine.list({ projectId: s.alpha.id }).map((h) => h.name)).toEqual(["first", "second"])
    expect(() => hook(s, { filters: { titleRegex: "(" } })).toThrow(/valid regular expression/)
    expect(() => hook(s, { projectId: s.alpha.id, filters: { projectId: s.beta.id } })).toThrow(/own project/)
    const merge = s.engine.fromTemplate("pr_merge", { projectId: s.alpha.id, createdBy: "Cody" })
    expect(merge).toMatchObject({ name: "On PR ready → merge", trigger: "task.pr_ready", action: "send_to_task", enabled: false, template: "pr_merge", filters: { excludeLabels: ["no-automerge"] } })
    // Off until enabled: it doesn't fire.
    expect(s.engine.handle(ev(prTask(s, s.alpha).id)).map((r) => r.hookName)).toEqual(["first", "second"])
    s.engine.remove(b.id)
    expect(s.engine.list({ projectId: s.alpha.id }).map((h) => h.name)).toEqual(["first", "On PR ready → merge"])
  })
})

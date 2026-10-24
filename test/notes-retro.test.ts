import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { NotesRetro, retroNotice, retroTrigger } from "../server/retro.js"
import { WakeLoopGuard } from "../server/loopGuard.js"
import type { TaskEvent, TaskEventListener } from "../server/tasks.js"
import type { Task } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

// The notes retro on its own: a fake task event bus and a real store. The Captain side (the wake, the
// loop guard) is the ordinary Captain notice path, covered in notes-curation.e2e.

interface Sent {
  projectId: string
  content: string
  meta: Record<string, unknown>
}

function setup() {
  const store = new Store(openDb(tmpDir(), ":memory:"))
  const listeners = new Set<TaskEventListener>()
  const sent: Sent[] = []
  let enabled = true
  const retro = new NotesRetro({
    store,
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    enabled: () => enabled,
    deliver: (projectId, content, meta) => sent.push({ projectId, content, meta }),
    budget: () => ({ line: "2 of 25 notes, ~40 of 4k tokens", over: false }),
    ownerName: () => "Ana",
  })
  retro.tuning.debounceMs = 1000
  retro.tuning.maxWaitMs = 5000
  retro.start()
  const project = store.createProject({ name: "site" })
  const emit = (type: TaskEvent["type"], taskId: string) => {
    for (const l of listeners) l({ type, taskId, turnId: null, originHookIds: [] })
  }
  const task = (title: string, patch: Partial<Task> = {}, projectId = project.id) => {
    const t = store.createTask({ projectId, title, prompt: title })
    return store.updateTask(t.id, { status: "done", ...patch } as never)
  }
  const suggest = (t: Task, content: string, why = "so the next agent knows") =>
    store.addNoteSuggestion({ projectId: t.projectId, taskId: t.id, taskTitle: t.title, content, why })
  return { store, retro, sent, project, emit, task, suggest, disable: () => void (enabled = false), listeners }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("retroTrigger", () => {
  const ev = (type: TaskEvent["type"]): TaskEvent => ({ type, taskId: "t", turnId: null, originHookIds: [] })
  it("fires on a merged PR and on done without an open PR", () => {
    expect(retroTrigger(ev("pr.merged"), { status: "pr_ready", prUrl: "u", prState: "merged" })).toBe("merged")
    expect(retroTrigger(ev("task.finished"), { status: "done", prUrl: null, prState: null })).toBe("done")
    expect(retroTrigger(ev("task.finished"), { status: "done", prUrl: "u", prState: "closed" })).toBe("done")
    expect(retroTrigger(ev("task.finished"), { status: "done", prUrl: "u", prState: "merged" })).toBe("merged")
  })
  it("waits for an open PR to merge, and ignores turns that didn't end done", () => {
    expect(retroTrigger(ev("task.finished"), { status: "done", prUrl: "u", prState: "open" })).toBeNull()
    expect(retroTrigger(ev("task.finished"), { status: "done", prUrl: "u", prState: "draft" })).toBeNull()
    expect(retroTrigger(ev("task.finished"), { status: "idle", prUrl: null, prState: null })).toBeNull()
    expect(retroTrigger(ev("task.pr_ready"), { status: "pr_ready", prUrl: "u", prState: "open" })).toBeNull()
    expect(retroTrigger(ev("pr.merged"), null)).toBeNull()
  })
})

describe("NotesRetro", () => {
  it("hands the Captain a merged task's suggestions, summary and PR link once", () => {
    const { retro, sent, emit, task, suggest, store, project } = setup()
    const t = task("Fix login", { status: "pr_ready", prUrl: "https://github.com/acme/site/pull/3", prState: "merged", summary: "Fixed the login redirect.\n\n<!-- boxyard-next-steps\n[\"x\"]\n-->" })
    const s = suggest(t, "Login tests need REDIS_URL set", "they hang without it")
    emit("pr.merged", t.id)
    expect(sent).toHaveLength(0)
    expect(retro.queued(project.id)).toEqual([t.id])
    vi.advanceTimersByTime(1000)
    expect(sent).toHaveLength(1)
    const { content, meta } = sent[0]!
    expect(content.split("\n")[0]).toBe("📝 **Notes retro**: 1 finished task left 1 note suggestion to curate.")
    expect(content).toContain("Notes now: 2 of 25 notes, ~40 of 4k tokens.")
    expect(content).toContain(`**[Fix login](/tasks/${t.id})** (${t.id}) · PR merged: https://github.com/acme/site/pull/3`)
    expect(content).toContain("Summary: Fixed the login redirect.")
    expect(content).not.toContain("boxyard-next-steps")
    expect(content).toContain(`- \`${s.id}\`: Login tests need REDIS_URL set\n  Why: they hang without it`)
    expect(content).toContain("unless Ana needs to hear about it")
    expect(content).not.toMatch(/\bCody\b/)
    expect(meta).toEqual({ kind: "retro", taskIds: [t.id], suggestionIds: [s.id], loopKey: `retro:${t.id}` })
    expect(store.getNoteSuggestion(s.id)!.retroAt).not.toBeNull()

    // The same task again (it marked itself done after the merge) has nothing new: no second retro.
    emit("task.finished", t.id)
    vi.advanceTimersByTime(5000)
    expect(sent).toHaveLength(1)
    expect(retro.queued(project.id)).toEqual([])
  })

  it("runs for a task that ends done without a PR, and skips one with an open PR until it merges", () => {
    const { sent, emit, task, suggest, store } = setup()
    const plain = task("Write docs")
    suggest(plain, "Docs live in /site/docs")
    emit("task.finished", plain.id)
    vi.advanceTimersByTime(1000)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.content).toContain("· done, no PR")

    const withPr = task("Add footer", { prUrl: "https://github.com/acme/site/pull/9", prState: "open" })
    suggest(withPr, "The footer is in Layout.tsx")
    emit("task.finished", withPr.id)
    vi.advanceTimersByTime(5000)
    expect(sent).toHaveLength(1)
    store.updateTask(withPr.id, { prState: "merged" })
    emit("pr.merged", withPr.id)
    vi.advanceTimersByTime(1000)
    expect(sent).toHaveLength(2)
    expect(sent[1]!.content).toContain("PR merged: https://github.com/acme/site/pull/9")
  })

  it("skips tasks with no suggestions and turns that didn't end done", () => {
    const { retro, sent, emit, task, suggest, project } = setup()
    const quiet = task("Nothing to note")
    emit("task.finished", quiet.id)
    const idle = task("Still going", { status: "idle" })
    suggest(idle, "Something")
    emit("task.finished", idle.id)
    emit("task.pr_ready", idle.id)
    expect(retro.queued(project.id)).toEqual([])
    vi.advanceTimersByTime(10_000)
    expect(sent).toHaveLength(0)
  })

  it("batches tasks that finish close together into one wake per project", () => {
    const { sent, emit, task, suggest, store, project } = setup()
    const other = store.createProject({ name: "api" })
    const a = task("A")
    const b = task("B", { prUrl: "https://github.com/acme/site/pull/1", prState: "merged" })
    const c = task("C", {}, other.id)
    suggest(a, "a1")
    suggest(a, "a2")
    suggest(b, "b1")
    suggest(c, "c1")
    emit("task.finished", a.id)
    vi.advanceTimersByTime(600)
    emit("pr.merged", b.id)
    vi.advanceTimersByTime(600)
    emit("task.finished", c.id)
    // The trailing debounce restarted with B, so A waits for it.
    expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(400)
    expect(sent.map((s) => s.projectId)).toEqual([project.id])
    expect(sent[0]!.content.split("\n")[0]).toBe("📝 **Notes retro**: 2 finished tasks left 3 note suggestions to curate.")
    expect(sent[0]!.meta.taskIds).toEqual([a.id, b.id])
    expect(sent[0]!.meta.loopKey).toBe(`retro:${[a.id, b.id].sort().join(",")}`)
    vi.advanceTimersByTime(600)
    expect(sent.map((s) => s.projectId)).toEqual([project.id, other.id])
  })

  it("never waits longer than maxWait, even while tasks keep finishing", () => {
    const { sent, emit, task, suggest } = setup()
    for (let i = 0; i < 8; i++) {
      const t = task(`T${i}`)
      suggest(t, `rule ${i}`)
      emit("task.finished", t.id)
      vi.advanceTimersByTime(800)
    }
    // 8 × 800ms: past the 5s cap, so the first batch went out without waiting for a quiet second.
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect((sent[0]!.meta.taskIds as string[]).length).toBeGreaterThanOrEqual(6)
  })

  it("holds back a task that's working again, and drops suggestions resolved meanwhile", () => {
    const { sent, emit, task, suggest, store } = setup()
    const busy = task("Busy")
    suggest(busy, "busy rule")
    const handled = task("Handled")
    const s = suggest(handled, "already handled")
    emit("task.finished", busy.id)
    emit("task.finished", handled.id)
    store.updateTask(busy.id, { status: "working" })
    store.resolveNoteSuggestion(s.id, { status: "rejected", by: "Ana" })
    vi.advanceTimersByTime(1000)
    expect(sent).toHaveLength(0)
    store.updateTask(busy.id, { status: "done" })
    vi.advanceTimersByTime(1000)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.meta.taskIds).toEqual([busy.id])
  })

  it("mentions older suggestions still pending from earlier retros", () => {
    const { sent, emit, task, suggest } = setup()
    const first = task("First")
    suggest(first, "first rule")
    emit("task.finished", first.id)
    vi.advanceTimersByTime(1000)
    const second = task("Second")
    suggest(second, "second rule")
    emit("task.finished", second.id)
    vi.advanceTimersByTime(1000)
    expect(sent[1]!.content).toContain("1 older suggestion from earlier retros is still pending (list_note_suggestions).")
  })

  it("does nothing while Settings › Notes retro is off, and stops listening on stop()", () => {
    const { sent, emit, task, suggest, disable, retro, listeners } = setup()
    disable()
    const t = task("Off")
    suggest(t, "rule")
    emit("task.finished", t.id)
    vi.advanceTimersByTime(5000)
    expect(sent).toHaveLength(0)
    retro.stop()
    expect(listeners.size).toBe(0)
  })
})

describe("retro loop safety", () => {
  it("the Captain's loop guard treats a task that keeps coming back to the retro as the same update, and never drops it", () => {
    // A task that keeps getting reopened and suggesting again would wake the Captain with a new retro text each
    // time; the loopKey names the task, so the guard sees the repeat.
    const guard = new WakeLoopGuard({ maxRepeats: 2, windowMs: 60_000, throttleMs: 1000, maxThrottleMs: 4000 })
    const key = "retro:task_1"
    for (let i = 0; i < 2; i++) {
      expect(guard.check([key]).wake).toBe(true)
      guard.record([key])
    }
    const held = guard.check([key])
    expect(held).toMatchObject({ wake: false, started: true })
    // Another task's retro is new: it goes through at once.
    expect(guard.check(["retro:task_2"]).wake).toBe(true)
  })

  it("the notice reads the same shape the Captain tab parses", () => {
    const t = { id: "task_1", title: "T", summary: null, prUrl: null, prState: null } as unknown as Task
    const text = retroNotice([{ task: t, trigger: "done", suggestions: [] }], { budget: { line: "0 of 25 notes, ~0 of 4k tokens", over: true, prune: "Prune them." }, olderPending: 0 })
    expect(text).toMatch(/^📝 \*\*Notes retro\*\*: /)
    expect(text).toContain("Notes now: 0 of 25 notes, ~0 of 4k tokens. Prune them.")
  })
})

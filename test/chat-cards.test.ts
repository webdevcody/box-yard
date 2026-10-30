import { describe, expect, it } from "vitest"
import { jumpDirection, nextJump } from "../web/src/lib/cardJump.js"
import { arrangeCards, batchTaskName, batchTitle, batchesOf, chatCards, newSince, stableCards, CARD_WINDOW_MS, type CardTask, type ChatCard } from "../web/src/lib/chatCards.js"
import { chatProvenance, filterByTasks } from "../web/src/lib/chatProvenance.js"
import { coordinatorRows } from "../web/src/lib/chatUpdates.js"
import { buildEntityIndex } from "../web/src/lib/linkify.js"
import type { BadgeStatus } from "../web/src/lib/prState.js"
import type { ChatMessage, Project, Task, TaskStatus } from "../shared/types.js"

// The Coordinator chat as task cards: which card each update and reply goes to, the Coordinator card for the rest,
// the cards' order, a batch's one card, and which cards show.

const project = (id: string, name: string) => ({ id, name, repo: null, createdAt: 1, color: null }) as Project
const task = (id: string, projectId: string, title: string, extra: Partial<Task> = {}) => ({ id, projectId, title, status: "idle" as TaskStatus, createdAt: 1, ...extra }) as Task

const YARD = project("prj_yard0001", "box-yard")
const MAP = project("prj_map00001", "Map 3")
const LOGIN = task("task_login001", YARD.id, "Fix login")
const CARDS = task("task_cards001", YARD.id, "Coordinator cards")
const B = "batch_aaaabbbbcccc"
const HOLLOW = task("task_hollow01", MAP.id, "Map 3 PR #406: The Hollow cave", { batchId: B, createdAt: 5 })
const DAM = task("task_dam00001", MAP.id, "Map 3 PR #409: Dam powerhouse", { batchId: B, createdAt: 5 })
const CAMP = task("task_camp0001", MAP.id, "Map 3 PR #399: Dam Hamlet camp", { batchId: B, createdAt: 5 })
const PAIR = "batch_pair00000000"
const DOCS = task("task_docs0001", YARD.id, "Write the docs", { batchId: PAIR })
const TWEET = task("task_tweet001", YARD.id, "Draft a tweet", { batchId: PAIR })
const ALL = [LOGIN, CARDS, HOLLOW, DAM, CAMP, DOCS, TWEET]
const index = buildEntityIndex({ projects: [YARD, MAP], tasks: ALL })
const known = (tasks: Task[] = ALL) => new Map<string, CardTask>(tasks.map((t) => [t.id, { id: t.id, title: t.title, batchId: t.batchId ?? null, createdAt: t.createdAt }]))

let seq = 0
const msg = (role: ChatMessage["role"], content: string, meta?: Record<string, unknown>): ChatMessage => {
  seq++
  return { id: `chat_${String(seq).padStart(4, "0")}`, role, content, meta: meta ?? null, createdAt: seq * 1000 }
}
const user = (text: string) => msg("user", text)
const reply = (text: string) => msg("assistant", text)
const tool = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => msg("tool", name, { input, ...extra })
const notice = (t: Task, text: string) => msg("notice", text, { taskId: t.id, projectId: t.projectId })
const captain = (p: Project, text: string) => msg("notice", `Captain for ${p.name}: ${text}`, { projectId: p.id, captain: true })

const model = (messages: ChatMessage[], tasks = known()) => chatCards(coordinatorRows(messages), index, tasks)
const ids = (entries: readonly { id: string }[]) => entries.map((e) => e.id)
const cardOf = (cards: readonly ChatCard[], key: string) => cards.find((c) => c.key === key)!

describe("chatCards", () => {
  it("puts a task's updates in its card, and Cody's messages and the replies to them in the Coordinator card", () => {
    const ask = user("Fix the login page")
    const call = tool("create_task", { project: "box-yard", title: "Fix login" }, { resultId: LOGIN.id })
    const answer = reply(`Started [Fix login](/tasks/${LOGIN.id}).`)
    const started = notice(LOGIN, "▶️ **Fix login** started")
    const pr = notice(LOGIN, "🔀 **Fix login** opened a pull request: https://github.com/o/r/pull/7")
    const ask2 = user("Thanks")
    const answer2 = reply("You're welcome.")
    const m = model([ask, call, answer, started, pr, ask2, answer2])
    expect(m.cards.map((c) => c.key)).toEqual([LOGIN.id])
    expect(ids(m.cards[0]!.entries)).toEqual([started.id, pr.id])
    expect(m.cards[0]!.entries.every((e) => e.type === "update" && e.tasks[0] === LOGIN.id)).toBe(true)
    // Tool calls show only in the timeline.
    expect(ids(m.coordinator)).toEqual([ask.id, answer.id, ask2.id, answer2.id])
  })

  it("places a card where the chat first named its task, and says which message started it", () => {
    const ask = user("Fix login, then build the cards")
    const call = tool("create_task", { project: "box-yard", title: "Fix login" }, { resultId: LOGIN.id })
    const call2 = tool("create_task", { project: "box-yard", title: "Coordinator cards" }, { resultId: CARDS.id })
    const answer = reply("Both started.")
    const later = notice(LOGIN, "✅ **Fix login** is done")
    const m = model([ask, call, call2, answer, notice(CARDS, "▶️ **Coordinator cards** started"), later])
    expect(m.cards.map((c) => c.key)).toEqual([LOGIN.id, CARDS.id])
    expect(m.cards.map((c) => c.origin?.id)).toEqual([ask.id, ask.id])
    expect(cardOf(m.cards, LOGIN.id).first).toBe(call.createdAt)
    expect(cardOf(m.cards, LOGIN.id).last).toBe(later.createdAt)
    // A card the Coordinator just started has no updates yet, but it's there.
    const fresh = model([ask, call])
    expect(fresh.cards.map((c) => [c.key, c.entries.length, c.origin])).toEqual([[LOGIN.id, 0, ask]])
    // A task first named by a notice came from no message here.
    expect(model([notice(LOGIN, "❓ **Fix login** needs input: which page?")]).cards[0]!.origin).toBeNull()
    // Named in the same millisecond: still in chat order, not by id.
    const same = { ...call, createdAt: call2.createdAt }
    expect(model([ask, call2, same, answer]).cards.map((c) => c.key)).toEqual([CARDS.id, LOGIN.id])
    expect(model([ask, same, call2, answer]).cards.map((c) => c.key)).toEqual([LOGIN.id, CARDS.id])
  })

  it("gives a reply the Coordinator wrote on its own to the cards of the tasks it names", () => {
    // A hook firing is the Coordinator's to read; a Captain's report is about the tasks it names.
    const hook = notice(LOGIN, "🪝 **Fix login** hook fired: Review")
    const report = captain(YARD, `**Coordinator cards** opened PR #9 (${CARDS.id}).`)
    const own = reply(`[Fix login](/tasks/${LOGIN.id}) has a review queued, and the **Coordinator cards** PR is up.`)
    const m = model([hook, report, own])
    expect(ids(cardOf(m.cards, LOGIN.id).entries)).toEqual([hook.id, own.id])
    expect(ids(cardOf(m.cards, CARDS.id).entries)).toEqual([report.id, own.id])
    expect(cardOf(m.cards, LOGIN.id).entries[1]!.tasks).toEqual([LOGIN.id, CARDS.id])
    expect(m.coordinator).toEqual([])

    // It read both, but names only one: only that card gets it. Naming none, it's the Coordinator card's.
    const one = model([notice(LOGIN, "🪝 **Fix login** hook fired: Review"), captain(YARD, `**Coordinator cards** opened PR #9.`), reply(`**Fix login** has a review queued.`)])
    expect(cardOf(one.cards, LOGIN.id).entries.map((e) => e.type)).toEqual(["update", "message"])
    expect(cardOf(one.cards, CARDS.id).entries.map((e) => e.type)).toEqual(["update"])
    const none = reply("Login has a review queued, and the cards PR is up.")
    const vague = model([notice(LOGIN, "🪝 **Fix login** hook fired: Review"), none])
    expect(cardOf(vague.cards, LOGIN.id).entries.map((e) => e.type)).toEqual(["update"])
    expect(ids(vague.coordinator)).toEqual([none.id])

    // The same updates read by a turn Cody started: the reply answers him, so it stays with his message.
    const hook2 = notice(LOGIN, "🪝 **Fix login** hook fired: Review")
    const ask = user("What's new?")
    const answer = reply("Login has a review queued.")
    const asked = model([hook2, ask, answer])
    expect(ids(asked.coordinator)).toEqual([ask.id, answer.id])
    expect(ids(cardOf(asked.cards, LOGIN.id).entries)).toEqual([hook2.id])
  })

  it("never puts a reply linking only survive-the-night tasks on a box-yard task's card", () => {
    const STN = project("prj_stn00001", "survive-the-night")
    const MARK = task("task_mark0001", YARD.id, "Cards view: mark done, bulk clear idle tasks")
    const GLACIER = task("task_glacier1", STN.id, "Map 4 #520: Glacier Lodge")
    const CHECK = task("task_checkd01", STN.id, "Map 4 Checkpoint D: Wave 3 places review")
    const tasks = [MARK, GLACIER, CHECK]
    const stnIndex = buildEntityIndex({ projects: [YARD, STN], tasks })
    const cards = (messages: ChatMessage[]) => chatCards(coordinatorRows(messages), stnIndex, known(tasks))
    const merge = notice(MARK, "🪝 **Cards view: mark done, bulk clear idle tasks** hook fired: box-yard: auto-merge ready PRs")
    const report = captain(STN, `[Map 4 #520: Glacier Lodge](/tasks/${GLACIER.id}) merged; Checkpoint D is reviewing (${CHECK.id}).`)
    const status = (text: string) => reply(`${text} [Glacier Lodge](/tasks/${GLACIER.id}) has merged (#520, #523); [Checkpoint D](/tasks/${CHECK.id}) is next.`)
    const onMark = (m: ReturnType<typeof cards>) => cardOf(m.cards, MARK.id)?.entries.filter((e) => e.type === "message") ?? []

    // One turn read both projects' updates and replied about survive-the-night only.
    const mixed = cards([merge, report, status("Map 4:")])
    expect(onMark(mixed)).toEqual([])
    expect(cardOf(mixed.cards, GLACIER.id).entries.map((e) => e.type)).toEqual(["update", "message"])

    // A turn handled the merge with tool calls and said nothing ("(no update)" isn't stored); the next turn's reply is
    // about Map 4. Stamped turns: the reply covers only its own turn's updates. Unstamped (older rows): still not on the card.
    for (const stamped of [true, false]) {
      const t1 = stamped ? { turn: 1 } : {}
      const t2 = stamped ? { turn: 2 } : {}
      const merge2 = notice(MARK, "🪝 **Cards view: mark done, bulk clear idle tasks** hook fired: box-yard: auto-merge ready PRs")
      const silent = tool("Bash", { command: "gh pr merge 198 --squash" }, t1)
      const report2 = captain(STN, `Glacier Lodge merged (${GLACIER.id}).`)
      const look = tool("list_tasks", { project: "survive-the-night" }, t2)
      const answer = { ...status("Map 4 status:"), meta: stamped ? t2 : null }
      const rows = coordinatorRows([merge2, silent, report2, look, answer])
      const sources = rows.find((r) => r.type === "message" && r.id === answer.id)
      if (stamped) expect(sources?.type === "message" && sources.sources?.map((s) => s.id)).toEqual([report2.id])
      const m = cards([merge2, silent, report2, look, answer])
      expect(onMark(m)).toEqual([])
      expect(cardOf(m.cards, GLACIER.id).entries.map((e) => e.id)).toEqual([report2.id, answer.id])
    }
  })

  it("keeps a Captain's report about no task, and notices about none, in the Coordinator card", () => {
    const report = captain(MAP, "All quiet.")
    const warning = msg("notice", "⚠️ Disk is nearly full on box-1")
    const own = reply("Map 3 is quiet.")
    const m = model([report, warning, own])
    expect(m.cards).toEqual([])
    expect(ids(m.coordinator)).toEqual([report.id, warning.id, own.id])
  })

  it("shows an update about a task that's gone only in the timeline", () => {
    const gone = notice(LOGIN, "✅ **Fix login** is done")
    const m = model([gone], known([CARDS]))
    expect(m.cards).toEqual([])
    expect(m.coordinator).toEqual([])
  })

  it("gives a create_tasks batch of BATCH_MIN or more one card, and smaller ones a card each", () => {
    const ask = user("Shoot every Map 3 area")
    const call = tool("create_tasks", { project: "Map 3", tasks: [HOLLOW, DAM, CAMP].map((t) => ({ title: t.title, prompt: "x" })) })
    const answer = reply("3 tasks started.")
    const q = notice(HOLLOW, "❓ **Map 3 PR #406: The Hollow cave** needs input: which entrance?")
    const pr = notice(DAM, "🔀 **Map 3 PR #409: Dam powerhouse** opened a pull request: https://github.com/o/r/pull/409")
    // A Captain's report naming two of them is one entry on the batch card, not two.
    const report = captain(MAP, `${HOLLOW.id} and ${DAM.id} are moving.`)
    const pair = tool("create_tasks", { project: "box-yard", tasks: [{ title: "Write the docs", prompt: "a" }, { title: "Draft a tweet", prompt: "b" }] })
    const m = model([ask, call, answer, q, pr, report, user("And docs plus a tweet"), pair, reply("Both started.")])
    expect(m.cards.map((c) => c.key)).toEqual([`batch:${B}`, DOCS.id, TWEET.id])
    const batch = m.cards[0]!
    // In the order they were made: one call shares a timestamp, so by title.
    expect(batch.taskIds).toEqual([CAMP.id, HOLLOW.id, DAM.id])
    expect(batch.batchId).toBe(B)
    expect(batch.origin).toBe(ask)
    expect(ids(batch.entries)).toEqual([q.id, pr.id, report.id])
    expect(batch.entries[2]!.tasks).toEqual([HOLLOW.id, DAM.id])
    expect(batchesOf(known()).get(B)).toEqual([CAMP.id, HOLLOW.id, DAM.id])
    expect(batchesOf(known()).has(PAIR)).toBe(false)
  })

  it("keeps what Cody sends to a task from its card in it, and the agent's answer", () => {
    const ask = user("Fix login")
    const call = tool("create_task", { project: "box-yard", title: "Fix login" }, { resultId: LOGIN.id })
    const answer = reply("Started.")
    // "This task": a sent notice, a message of its own (not a chip), in the task's card.
    const sent = msg("notice", "✉️ **Fix login** got a message from Cody: use the new form", { taskId: LOGIN.id, projectId: YARD.id, sent: true })
    const turn = notice(LOGIN, "💬 **Fix login** finished its turn: switched to the new form")
    // Cody's questions to the Coordinator from a card are its side thread, not the chat: what's here is the main chat's.
    const later = user("thanks")
    const answer2 = reply("Any time.")
    const rows = coordinatorRows([ask, call, answer, sent, turn, later, answer2])
    expect(rows.find((r) => r.id === sent.id)?.type).toBe("message")
    const m = chatCards(rows, index, known())
    const card = cardOf(m.cards, LOGIN.id)
    expect(ids(card.entries)).toEqual([sent.id, turn.id])
    expect(card.entries.map((e) => e.type)).toEqual(["message", "update"])
    expect(ids(m.coordinator)).toEqual([ask.id, answer.id, later.id, answer2.id])
  })
})

describe("stableCards", () => {
  it("keeps every card and entry that didn't change, so only the card with news re-renders", () => {
    const base = [notice(LOGIN, "▶️ **Fix login** started"), notice(CARDS, "▶️ **Coordinator cards** started"), user("hi"), reply("Hello.")]
    const before = stableCards(null, model(base))
    const same = stableCards(before, model([...base]))
    expect(same).not.toBe(before)
    expect(same.cards).toBe(before.cards)
    expect(same.coordinator).toBe(before.coordinator)

    const news = notice(CARDS, "✅ **Coordinator cards** is done")
    const after = stableCards(before, model([...base, news]))
    expect(cardOf(after.cards, LOGIN.id)).toBe(cardOf(before.cards, LOGIN.id))
    expect(cardOf(after.cards, CARDS.id)).not.toBe(cardOf(before.cards, CARDS.id))
    expect(cardOf(after.cards, CARDS.id).entries[0]).toBe(cardOf(before.cards, CARDS.id).entries[0])
    expect(after.coordinator).toBe(before.coordinator)
  })
})

describe("arrangeCards", () => {
  const now = 10 * CARD_WINDOW_MS
  const card = (key: string, taskIds: string[], last: number): ChatCard => ({ key, taskIds, batchId: null, entries: [], first: 0, last, origin: null })
  const statuses: Record<string, BadgeStatus> = {}
  const projects: Record<string, string> = {}
  const arrange = (cards: ChatCard[], filter: string | null = null, stay?: (c: ChatCard) => boolean) => {
    const r = arrangeCards(cards, (id) => statuses[id], (id) => projects[id], now, filter, stay)
    return { live: r.live.map((c) => c.key), done: r.done.map((c) => c.key) }
  }

  it("shows work going on or waiting on Cody however old, the rest for a day, and folds what's finished", () => {
    Object.assign(statuses, { a: "working", b: "pr_ready", c: "idle", d: "idle", e: "merged", f: "done", g: "failed" })
    const old = now - CARD_WINDOW_MS - 1
    const recent = now - 60_000
    const cards = [card("a", ["a"], old), card("b", ["b"], old), card("c", ["c"], old), card("d", ["d"], recent), card("e", ["e"], recent), card("f", ["f"], old), card("g", ["g"], recent), card("x", ["x"], recent)]
    expect(arrange(cards)).toEqual({ live: ["a", "b", "d", "g"], done: ["e"] })
  })

  it("keeps a batch up while any of its tasks is, and folds it once all are finished", () => {
    Object.assign(statuses, { k1: "merged", k2: "queued", k3: "done" })
    const recent = now - 1
    expect(arrange([card("batch:x", ["k1", "k2", "k3"], recent)])).toEqual({ live: ["batch:x"], done: [] })
    statuses.k2 = "done"
    expect(arrange([card("batch:x", ["k1", "k2", "k3"], recent)])).toEqual({ live: [], done: ["batch:x"] })
  })

  it("keeps a card it's told to where it is, finished or quiet", () => {
    Object.assign(statuses, { s1: "done", s2: "idle", s3: "done" })
    const cards = [card("s1", ["s1"], now - 1), card("s2", ["s2"], now - CARD_WINDOW_MS - 1), card("s3", ["s3"], now - 1)]
    expect(arrange(cards)).toEqual({ live: [], done: ["s1", "s3"] })
    expect(arrange(cards, null, (c) => c.key !== "s3")).toEqual({ live: ["s1", "s2"], done: ["s3"] })
  })

  it("folds resting cards with no news for idleMs into idle, never ones at work, waiting on Cody, finished or kept", () => {
    Object.assign(statuses, { i1: "idle", i2: "pr_ready", i3: "failed", i4: "needs_input", i5: "working", i6: "done", i7: "idle" })
    const quiet = now - 3 * 3600_000 - 1
    const cards = ["i1", "i2", "i3", "i4", "i5", "i6"].map((id) => card(id, [id], quiet)).concat(card("i7", ["i7"], now - 60_000))
    const r = arrangeCards(cards, (id) => statuses[id], () => YARD.id, now, null, (c) => c.key === "i3", 3 * 3600_000)
    expect({ live: r.live.map((c) => c.key), idle: r.idle.map((c) => c.key), done: r.done.map((c) => c.key) }).toEqual({ live: ["i3", "i4", "i5", "i7"], idle: ["i1", "i2"], done: ["i6"] })
    // 0 is never.
    expect(arrangeCards(cards, (id) => statuses[id], () => YARD.id, now, null, undefined, 0).idle).toEqual([])
  })

  it("keeps one project's cards", () => {
    Object.assign(statuses, { p1: "working", p2: "working" })
    Object.assign(projects, { p1: YARD.id, p2: MAP.id })
    expect(arrange([card("p1", ["p1"], now), card("p2", ["p2"], now)], MAP.id)).toEqual({ live: ["p2"], done: [] })
  })
})

describe("card helpers", () => {
  it("counts what came in since a card was last seen", () => {
    const m = model([notice(LOGIN, "a"), notice(LOGIN, "b"), notice(LOGIN, "c")])
    const entries = m.cards[0]!.entries
    expect(newSince(entries, 0)).toBe(3)
    expect(newSince(entries, entries[1]!.at)).toBe(1)
  })

  it("titles a batch by the words its tasks start with", () => {
    const titles = [CAMP.title, HOLLOW.title, DAM.title]
    expect(batchTitle(titles)).toBe("Map 3 PR")
    expect(batchTaskName(HOLLOW.title, "Map 3 PR")).toBe("#406: The Hollow cave")
    expect(batchTitle(["Research pricing", "Write a summary", "Draft a tweet"])).toBeNull()
    expect(batchTitle(["Fix: login", "Fix: logout"])).toBe("Fix")
    // Not on a dangling "the".
    expect(batchTitle(["Level 7: the Hollow cave", "Level 7: the dam"])).toBe("Level 7")
    expect(batchTaskName("Level 7: the dam", "Level 7")).toBe("the dam")
    expect(batchTitle(["The cave", "The dam"])).toBeNull()
    // Never a whole title.
    expect(batchTitle(["Ship it", "Ship it now"])).toBe("Ship")
    expect(batchTaskName("Draft a tweet", null)).toBe("Draft a tweet")
  })
})

describe("filterByTasks", () => {
  it("keeps one card's part of the timeline: the turns that name its tasks, its notices, and the turn still waiting", () => {
    const ask = user("Fix login")
    const call = tool("create_task", { project: "box-yard", title: "Fix login" }, { resultId: LOGIN.id })
    const answer = reply("Started.")
    const other = notice(CARDS, "▶️ **Coordinator cards** started")
    const own = notice(LOGIN, "✅ **Fix login** is done")
    const waiting = user("And now?")
    const all = [ask, call, answer, other, own, waiting]
    const prov = chatProvenance(all, index)
    expect(ids(filterByTasks(all, prov, [LOGIN.id]))).toEqual([ask.id, call.id, answer.id, own.id, waiting.id])
    expect(filterByTasks(all, prov, null)).toBe(all)
  })
})

describe("the new-cards pill's next card and arrow", () => {
  const order = ["a", "b", "c", "d"]
  it("goes top to bottom through the cards with news, after the one it went to, round to the first", () => {
    expect(nextJump(order, [], null)).toBeNull()
    expect(nextJump(order, ["b", "d"], null)).toBe("b")
    expect(nextJump(order, ["b", "d"], "b")).toBe("d")
    expect(nextJump(order, ["b", "d"], "d")).toBe("b")
    // The one it went to was opened (no news now): on from where it was.
    expect(nextJump(order, ["b", "d"], "c")).toBe("d")
    expect(nextJump(order, ["b"], "b")).toBe("b")
  })

  it("points up at a card above the screen, down at one below or under the pill, and says here for one on screen", () => {
    const view = { top: 100, bottom: 600 }
    expect(jumpDirection({ top: 0, bottom: 100 }, view)).toBe("up")
    expect(jumpDirection({ top: 50, bottom: 150 }, view)).toBe("here")
    expect(jumpDirection({ top: 600, bottom: 700 }, view)).toBe("down")
    expect(jumpDirection({ top: 570, bottom: 700 }, view, 48)).toBe("down")
    expect(jumpDirection({ top: 540, bottom: 700 }, view, 48)).toBe("here")
  })
})

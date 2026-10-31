import { describe, expect, it } from "vitest"
import { chatCards, type CardEntry, type CardTask } from "../web/src/lib/chatCards.js"
import { coordinatorRows } from "../web/src/lib/chatUpdates.js"
import { digestEntries, digestOf, digestSummary, eventLine, isEvent } from "../web/src/lib/cardDigest.js"
import { buildEntityIndex } from "../web/src/lib/linkify.js"
import type { ChatMessage, Project, Task } from "../shared/types.js"

// A task card's event digest: runs of hook, merge, done, PR and Captain report lines fold into one line; replies,
// questions, failures and Cody's own messages stay whole.

const YARD = { id: "prj_yard0001", name: "box-yard", repo: null, createdAt: 1, color: null } as Project
const CARDS = { id: "task_cards001", projectId: YARD.id, title: "Cards: open a folded card", status: "idle", createdAt: 1 } as Task
const index = buildEntityIndex({ projects: [YARD], tasks: [CARDS] })
const known = new Map<string, CardTask>([[CARDS.id, { id: CARDS.id, title: CARDS.title, batchId: null, createdAt: 1 }]])

let seq = 0
const msg = (role: ChatMessage["role"], content: string, meta?: Record<string, unknown>): ChatMessage => {
  seq++
  return { id: `chat_${String(seq).padStart(4, "0")}`, role, content, meta: meta ?? null, createdAt: seq * 1000 }
}
const notice = (text: string, extra: Record<string, unknown> = {}) => msg("notice", text, { taskId: CARDS.id, projectId: YARD.id, ...extra })
const captain = (text: string) => msg("notice", `Captain for box-yard: ${text}`, { projectId: YARD.id, captain: true })
const reply = (text: string) => msg("assistant", text)
const SHA = "ff8fc2305ab9c31e61cfc78f89fadf6c2d5d42ee"

const entriesOf = (messages: ChatMessage[]): readonly CardEntry[] => chatCards(coordinatorRows(messages), index, known).cards[0]!.entries
const NONE = new Set<string>()

describe("digestEntries", () => {
  // The moment in the design: a hook's merge request, the task's "done", the Captain's report, then its reply.
  const hook = notice(`🚢 The Captain asked **${CARDS.title}** to merge PR #221: https://github.com/o/r/pull/221`)
  const done = notice(`✅ **${CARDS.title}** is done: PR #221 is merged into main as squash commit ${SHA}. Typecheck passed.`)
  const report = captain(`I merged PR #221 ([task](/tasks/${CARDS.id})), so a prompt opens a folded card.`)
  const answer = reply(`Sending a prompt to a folded card now opens it ([${CARDS.title}](/tasks/${CARDS.id})). Shall I restart Box Yard?`)

  it("folds the events before a reply into one digest, and keeps the reply whole", () => {
    const entries = entriesOf([hook, done, report, answer])
    expect(entries.map((e) => e.id)).toEqual([hook.id, done.id, report.id, answer.id])
    const pieces = digestEntries(entries, NONE)
    expect(pieces.map((p) => p.type)).toEqual(["digest", "entry"])
    const digest = pieces[0]!
    expect(digest.type === "digest" && digest.id).toBe(hook.id)
    expect(digest.type === "digest" && digest.entries.map((e) => e.id)).toEqual([hook.id, done.id, report.id])
    expect(digestOf(pieces, report.id)?.id).toBe(hook.id)
    expect(digestOf(pieces, answer.id)).toBeNull()
  })

  it("says what a merge made, in a short SHA, and whether a hook or auto-merge asked for it", () => {
    const entries = entriesOf([hook, done, report])
    expect(digestSummary(entries)).toBe("Merged as ff8fc23")
    const auto = notice(`🪝 **${CARDS.title}** hook "box-yard: auto-merge ready PRs" (PR ready) sent to the agent: Please merge`)
    expect(digestSummary(entriesOf([auto, done]))).toBe("Auto-merged as ff8fc23")
  })

  it("else says its newest event's line", () => {
    const pr = notice(`🔀 **${CARDS.title}** opened a pull request: https://github.com/o/r/pull/9`)
    const started = notice(`▶️ **${CARDS.title}** started`)
    const entries = entriesOf([started, pr])
    expect(digestSummary(entries)).toBe(eventLine(entries[1]!))
    expect(digestSummary(entries)).toContain("PR #9")
  })

  it("never folds a lone event, a question, a failure, Cody's message or an update that answers Cody", () => {
    const pr = notice(`🔀 **${CARDS.title}** opened a pull request: https://github.com/o/r/pull/9`)
    const ask = notice(`🙋 **${CARDS.title}** needs input: Which page?`)
    const failed = notice(`❌ **${CARDS.title}** failed: Out of memory`)
    const sent = notice(`✉️ **${CARDS.title}** got a message from Cody: The new one`, { sent: true })
    const turn = notice(`💬 **${CARDS.title}** finished its turn: Switched.`)
        const says = notice(`💬 **${CARDS.title}** says: step 2`)
    const entries = entriesOf([pr, ask, done, failed, sent, turn, says, report])
    // An agent's own words stay whole, answer or not; a Captain's report is an event.
    expect(entries.map((e) => isEvent(e, new Set([turn.id])))).toEqual([true, false, true, false, false, false, false, true])
    expect(digestEntries(entries, new Set([turn.id])).every((p) => p.type === "entry")).toBe(true)
  })
})

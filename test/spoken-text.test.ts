import { describe, expect, it, vi } from "vitest"
import type { AppNotification } from "../shared/types.js"
import { MAX_TITLE_WORDS, spokenText, spokenTitle } from "../web/src/lib/spokenText.js"
import { VOICE_DEFAULTS, eventsLine, spokenSummary } from "../web/src/lib/voice.js"
import { Announcer, EVENT_BATCH_MS, SpeechQueue, type SynthLike, type UtteranceLike } from "../web/src/lib/speech.js"

const note = (extra: Partial<AppNotification> = {}): AppNotification => ({
  id: "ntf_1a2b3c4d5e6f",
  taskId: "task_a244bbb653b0",
  projectId: "prj_1a2b3c4d5e6f",
  title: "Voice: speak task titles instead of task ids",
  projectName: "box-yard",
  status: "done",
  summary: null,
  createdAt: 1,
  readAt: null,
  ...extra,
})

/** No spoken line may carry an id, a URL or a SHA. */
const NOT_SPEAKABLE = /\b[a-z]{2,6}_[A-Za-z0-9-]{4,}|https?:|www\.|`|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/

describe("spokenText", () => {
  it("strips markdown but keeps the words", () => {
    expect(spokenText("**PR 30 merged.** Task cards now have _equal_ heights.")).toBe("PR 30 merged. Task cards now have equal heights.")
    expect(spokenText("## Done\n- one\n- two")).toBe("Done one two")
    expect(spokenText("> quoted ~~old~~ text")).toBe("quoted old text")
  })

  it("reads only a markdown link's text", () => {
    expect(spokenText("Started [Voice announcements](/tasks/task_8df1468eb1dc) and [docs](https://example.com/a?b=1).")).toBe(
      "Started Voice announcements and docs.",
    )
    expect(spokenText("[PR #216](https://github.com/webdevcody/box-yard/pull/216) merged")).toBe("PR 216 merged")
    expect(spokenText("See ![shot](https://x.y/a.png) here")).toBe("See here")
  })

  it("never reads Box Yard ids", () => {
    expect(spokenText("task_a244bbb653b0 finished.")).toBe("finished.")
    expect(spokenText("**task_a244bbb653b0** finished")).toBe("finished")
    expect(spokenText("Task task_8df1468eb1dc in prj_1a2b3c4d5e6f is done")).toBe("Task in is done")
    expect(spokenText("Saved art_96efb3c6cbea, up_3f9a1c2b7d4e and hook_747090f35247.")).toBe("Saved, and.")
    expect(spokenText("Box vastai-prj_1a2b3c4d5e6f is up")).not.toMatch(/prj_|1a2b/)
    expect(spokenText("The id is 'task_a244bbb653b0'.")).toBe("The id is.")
  })

  it("turns URLs into words: GitHub PRs by number, anything else 'a link'", () => {
    expect(spokenText("See https://github.com/webdevcody/box-yard/pull/216 now")).toBe("See PR 216 now")
    expect(spokenText("Filed https://github.com/webdevcody/box-yard/issues/12.")).toBe("Filed issue 12.")
    expect(spokenText("Preview at https://abc.upstash.app/x ready")).toBe("Preview at a link ready")
    expect(spokenText("Docs: <https://example.com/docs>")).toBe("Docs: a link")
    expect(spokenText("The preview is up (https://abc.upstash.app/x).")).toBe("The preview is up.")
    expect(spokenText("Open /artifacts/art_96efb3c6cbea/report.html now")).toBe("Open now")
  })

  it("reads PR numbers without the #", () => {
    expect(spokenText("PR #216 is ready")).toBe("PR 216 is ready")
    expect(spokenText("PRs #1, #2 and #3 merged")).toBe("PRs 1, 2 and 3 merged")
    expect(spokenText("PR #30 merged (#29 too)")).toBe("PR 30 merged (number 29 too)")
    expect(spokenText("Closes webdevcody/box-yard#154")).toBe("Closes number 154")
    expect(spokenText("Fixed issue#5")).toBe("Fixed issue 5")
  })

  it("drops code and SHAs, and reads snake_case as words", () => {
    expect(spokenText("Run `npm test` then\n```\nnpm run build\n```\ndone")).toBe("Run then done")
    expect(spokenText("Merged at 6715385 and d631f30 🎉✅")).toBe("Merged at 6715385 and")
    expect(spokenText("Raised agents_per_box to 3")).toBe("Raised agents per box to 3")
  })

  it("is idempotent, so the queue can clean an already-clean line", () => {
    for (const md of ["PR #216 merged, see https://github.com/o/r/pull/216", "**Voice** (task_a244bbb653b0) done: #30", "Preview at https://x.y ready"]) {
      expect(spokenText(spokenText(md))).toBe(spokenText(md))
    }
  })
})

describe("spokenTitle", () => {
  it("keeps a short title whole", () => {
    expect(spokenTitle("Voice: speak task titles instead of task ids")).toBe("Voice: speak task titles instead of task ids")
    expect(spokenTitle("Map 4 #611 W5.10: loading art")).toBe("Map 4 number 611 W5.10: loading art")
  })

  it(`cuts a long title at a word boundary, about ${MAX_TITLE_WORDS} words (a little more to reach a comma)`, () => {
    const t = spokenTitle("Finished tasks free their disk on this computer and SSH machines, with settings of their own")!
    expect(t).toBe("Finished tasks free their disk on this computer and SSH machines")
    expect(t.split(" ").length).toBeLessThanOrEqual(MAX_TITLE_WORDS + 2)
    expect(spokenTitle("Make the yard page load much faster on slow phones over the cellular network")).toBe(
      "Make the yard page load much faster on slow phones",
    )
    // No dangling filler word at the cut.
    expect(spokenTitle("Show the box history log for every box size in the Boxes page")).toBe("Show the box history log for every box size")
  })

  it("drops asides, ids, URLs and code", () => {
    expect(spokenTitle("Voice announcements (browser text-to-speech) for orchestrator updates")).toBe("Voice announcements for orchestrator updates")
    expect(spokenTitle("Fix `parseNotice` for task_a244bbb653b0 per https://github.com/o/r/pull/216")).toBe("Fix for per PR 216")
    expect(spokenTitle("Review [PR #216](https://github.com/o/r/pull/216)")).toBe("Review PR 216")
  })

  it("is null when nothing speakable is left", () => {
    expect(spokenTitle("task_a244bbb653b0")).toBeNull()
    expect(spokenTitle("🎉")).toBeNull()
  })
})

describe("spoken announcements", () => {
  it("a finished task is announced by its title, never its id", () => {
    vi.useFakeTimers()
    const said: string[] = []
    const a = new Announcer({ settings: () => ({ ...VOICE_DEFAULTS, orchestrator: false }), speak: (line) => said.push(line) })
    a.notification(note())
    vi.advanceTimersByTime(EVENT_BATCH_MS)
    expect(said).toEqual(["Task Voice: speak task titles instead of task ids finished."])
    vi.useRealTimers()
  })

  it("every event line reads a title, or 'A task' when the title is only an id", () => {
    for (const status of ["done", "pr_ready", "needs_input", "failed"] as const) {
      const line = eventsLine([note({ status, title: "Deploy task_a244bbb653b0 to https://x.y/z" })])!
      expect(line).toMatch(/^(Task )?Deploy to a link /)
      expect(line).not.toMatch(NOT_SPEAKABLE)
    }
    expect(eventsLine([note({ title: "task_a244bbb653b0" })])).toBe("A task finished.")
    expect(eventsLine([note({ status: "failed", title: "`task_a244bbb653b0`" })])).toBe("A task failed.")
  })

  it("a Coordinator reply is summarised without ids, URLs or SHAs", () => {
    const line = spokenSummary(
      "[Voice: speak task titles](/tasks/task_a244bbb653b0) (task_a244bbb653b0) finished: PR #217 (https://github.com/webdevcody/box-yard/pull/217), head a1b2c3d.",
    )!
    expect(line).toBe("Voice: speak task titles finished: PR 217, head.")
    expect(line).not.toMatch(NOT_SPEAKABLE)
  })

  it("the speech queue cleans every line it is handed", () => {
    const spoken: string[] = []
    const synth: SynthLike = { speak: (u) => spoken.push(u.text), cancel() {}, pause() {}, resume() {}, speaking: false, paused: false }
    const utter = (text: string): UtteranceLike => ({ text, voice: null, lang: "", rate: 1, pitch: 1, volume: 1, onstart: null, onend: null, onerror: null })
    const timers = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} }
    new SpeechQueue(synth, utter, timers).say("task_a244bbb653b0 finished: see https://github.com/o/r/pull/216", { rate: 1, pitch: 1, volume: 1 })
    expect(spoken).toEqual(["finished: see PR 216"])
  })
})

import { describe, expect, it, vi } from "vitest"
import type { AppNotification, ChatMessage } from "../shared/types.js"
import {
  MAX_SPOKEN,
  MAX_SUMMARY,
  VOICE_DEFAULTS,
  chunkForSpeech,
  cleanForSpeech,
  eventsLine,
  inQuietHours,
  parseVoiceSettings,
  pickVoice,
  shortTitle,
  speakableEvents,
  splitSentences,
  spokenSummary,
  voiceAllowed,
  voiceEvent,
  type VoiceLike,
  type VoiceSettings,
} from "../web/src/lib/voice.js"
import { Announcer, DEDUPE_MS, EVENT_BATCH_MS, HOLD_MS, MAX_HOLD_MS, MAX_QUEUE, SpeechQueue, type UtteranceLike } from "../web/src/lib/speech.js"

const on = (patch: Partial<VoiceSettings> = {}): VoiceSettings => ({ ...VOICE_DEFAULTS, enabled: true, ...patch })

const note = (id: string, taskId: string, status: AppNotification["status"], createdAt = 1, extra: Partial<AppNotification> = {}): AppNotification => ({
  id,
  taskId,
  projectId: "prj_1",
  title: `Build ${taskId}`,
  projectName: "site",
  status,
  summary: null,
  createdAt,
  readAt: null,
  ...extra,
})

const reply = (id: string, content: string): ChatMessage => ({ id, role: "assistant", content, meta: null, createdAt: 1 })

describe("cleanForSpeech", () => {
  it("strips markdown but keeps the words", () => {
    expect(cleanForSpeech("**PR 30 merged.** Task cards now have _equal_ heights.")).toBe("PR 30 merged. Task cards now have equal heights.")
    expect(cleanForSpeech("## Done\n- one\n- two")).toBe("Done one two")
    expect(cleanForSpeech("> quoted ~~old~~ text")).toBe("quoted old text")
  })

  it("keeps link text and drops the URL", () => {
    expect(cleanForSpeech("Started [Voice announcements](/tasks/task_8df1468eb1dc) and [docs](https://example.com/a?b=1).")).toBe(
      "Started Voice announcements and docs.",
    )
    expect(cleanForSpeech("See ![shot](https://x.y/a.png) here")).toBe("See here")
  })

  it("drops bare URLs, app paths, ids, commit shas, code and emoji", () => {
    expect(cleanForSpeech("Preview at https://abc.upstash.app/x ready")).toBe("Preview at ready")
    expect(cleanForSpeech("Task task_8df1468eb1dc in prj_1a2b3c4d5e6f is done")).toBe("Task in is done")
    expect(cleanForSpeech("Merged at 6715385 and d631f30 🎉✅")).toBe("Merged at 6715385 and")
    expect(cleanForSpeech("Run `npm test` then\n```\nnpm run build\n```\ndone")).toBe("Run then done")
    expect(cleanForSpeech("Open /artifacts/art_96efb3c6cbea/report.html now")).toBe("Open now")
  })

  it("reads #30 as number 30", () => {
    expect(cleanForSpeech("PR #30 merged (#29 too)")).toBe("PR number 30 merged (number 29 too)")
    expect(cleanForSpeech("Fixed issue#5")).toBe("Fixed issue#5")
  })
})

describe("spokenSummary", () => {
  it("speaks the opening sentence, cleaned", () => {
    expect(spokenSummary("Three tasks finished and the docs PR is ready for review. Details below.")).toBe("Three tasks finished and the docs PR is ready for review.")
    expect(spokenSummary("Started **3 agents** on [pricing research](/projects/prj_abcdef) for the box. More soon.")).toBe(
      "Started 3 agents on pricing research for the box.",
    )
  })

  it("tops up a short opener with the next sentence", () => {
    expect(
      spokenSummary(
        "Partly. Leftover build files are one cause, but the bigger ones are how heavy the game's repo is and how Box Yard clones it for every task.\n\nDetails:",
      ),
    ).toBe("Partly. Leftover build files are one cause, but the bigger ones are how heavy the game's repo is and how Box Yard clones it for every task.")
    expect(spokenSummary("Yes. The build passed on the first try, and the PR is up.")).toBe("Yes. The build passed on the first try, and the PR is up.")
    expect(spokenSummary("Yes.")).toBe("Yes.")
    expect(spokenSummary("Yes.\n\nThe retry worked and both boxes are healthy again.")).toBe("Yes. The retry worked and both boxes are healthy again.")
    expect(spokenSummary("PR #30 merged. Task cards now have equal heights. Nothing else changed.")).toBe(
      "PR number 30 merged. Task cards now have equal heights.",
    )
  })

  it("keeps a dash-led answer whole", () => {
    expect(spokenSummary("No — because the repo is 2 GB and every task clones it fresh. I'll fix the cache next.")).toBe(
      "No — because the repo is 2 GB and every task clones it fresh.",
    )
  })

  it("stops at three sentences or the length cap", () => {
    expect(spokenSummary("Yes. Ok. Done. Fine. More.")).toBe("Yes. Ok. Done.")
    const long = `Partly. Word ${"word ".repeat(100)}end.`
    const out = spokenSummary(long)!
    expect(out.length).toBeLessThanOrEqual(MAX_SUMMARY)
    expect(out.startsWith("Partly. Word word")).toBe(true)
  })

  it("doesn't split on abbreviations, initials, decimals or versions", () => {
    expect(spokenSummary("Small boxes, e.g. The pricing tier, cost less vs. Medium ones. Next.")).toBe("Small boxes, e.g. The pricing tier, cost less vs. Medium ones.")
    expect(spokenSummary("Bumped to v1.2.3 in 2.5 minutes for $0.003 each. Next up docs.")).toBe("Bumped to v1.2.3 in 2.5 minutes for $0.003 each.")
    expect(spokenSummary("Merged #45. Then #46 and #47 went in after the rebase. Done.")).toBe("Merged number 45. Then number 46 and number 47 went in after the rebase.")
  })

  it("ignores dots inside code spans, links and URLs", () => {
    expect(spokenSummary("Set `config.ts` and see https://docs.example.com/a.b. It's live now on every box.")).toBe("Set and see. It's live now on every box.")
    expect(spokenSummary("[Box resize](https://github.com/x/y/pull/75)\n\nResizing works on Upstash by moving workspaces to a new box.")).toBe(
      "Box resize Resizing works on Upstash by moving workspaces to a new box.",
    )
  })

  it("skips headings, code and lines with no words", () => {
    expect(spokenSummary("## Status\n\nTwo tasks finished overnight and one needs your input.")).toBe("Two tasks finished overnight and one needs your input.")
    expect(spokenSummary("```\nlog\n```\n\nBuild passed.")).toBe("Build passed.")
    expect(spokenSummary("🎉\n\nAll green.")).toBe("All green.")
  })

  it("uses the first prose line when the reply opens with a list", () => {
    expect(spokenSummary("Here's the yard:\n- **Haiku** (demo): done\n- **Limerick** (demo): done")).toBe("Here's the yard")
    expect(spokenSummary("- Merged #30\n- Started docs\n\nBoth are on track and nothing needs you right now.")).toBe("Both are on track and nothing needs you right now.")
    expect(spokenSummary("- Merged #30\n- Started docs")).toBe("Merged number 30")
    expect(spokenSummary("# Report\n1. First thing\n2. Second")).toBe("First thing")
  })

  it("never reads the hidden next-steps block", () => {
    expect(spokenSummary('Yes.\n\n<!-- boxyard-next-steps\n["Run tests"]\n-->')).toBe("Yes.")
  })

  it("never speaks (no update) or empty replies", () => {
    expect(spokenSummary("(no update)")).toBeNull()
    expect(spokenSummary("  (no update)\n")).toBeNull()
    expect(spokenSummary("")).toBeNull()
    expect(spokenSummary("```\nonly code\n```")).toBeNull()
  })

  it("caps long sentences at a word boundary", () => {
    const long = `The ${"very ".repeat(80)}long sentence ends here.`
    const out = spokenSummary(long)!
    expect(out.length).toBeLessThanOrEqual(MAX_SUMMARY)
    expect(out.endsWith("very")).toBe(true)
  })
})

describe("splitSentences", () => {
  it("splits on real sentence ends only", () => {
    expect(splitSentences("Partly. Leftover files. Done!")).toEqual(["Partly.", "Leftover files.", "Done!"])
    expect(splitSentences("See e.g. Box Yard, i.e. The app. Then go.")).toEqual(["See e.g. Box Yard, i.e. The app.", "Then go."])
    expect(splitSentences("J. Smith wrote v2.0. It works.")).toEqual(["J. Smith wrote v2.0.", "It works."])
    expect(splitSentences("No. It failed.")).toEqual(["No.", "It failed."])
  })
})

describe("task event lines", () => {
  it("names one event", () => {
    expect(eventsLine([note("n1", "t1", "done", 1, { title: "Workout log" })])).toBe("Task Workout log finished.")
    expect(eventsLine([note("n1", "t1", "done", 1, { title: "Task cards: equal heights" })])).toBe("Task cards: equal heights finished.")
    expect(eventsLine([note("n1", "t1", "needs_input", 1, { title: "Find the nebula repo" })])).toBe("Find the nebula repo needs your input.")
    expect(eventsLine([note("n1", "t1", "failed", 1, { title: "Deploy" })])).toBe("Deploy failed.")
    expect(eventsLine([note("n1", "t1", "done", 1, { summary: "PR #30 merged by cody" })])).toBe("PR 30 merged.")
    expect(eventsLine([note("n1", "t1", "pr_ready", 1, { title: "Dark mode" })])).toBe("Dark mode has a PR ready.")
  })

  it("batches a burst into one line, most urgent first", () => {
    expect(eventsLine([note("a", "t1", "done"), note("b", "t2", "done"), note("c", "t3", "done")])).toBe("3 tasks finished.")
    expect(eventsLine([note("a", "t1", "done"), note("b", "t2", "failed"), note("c", "t3", "done")])).toBe("1 task failed, 2 tasks finished.")
  })

  it("shortens titles", () => {
    expect(shortTitle("Voice announcements (browser text-to-speech) for orchestrator updates, configurable in Settings")).toBe(
      "Voice announcements for orchestrator updates",
    )
    expect(shortTitle("Inbox: mark card as reviewed directly from the card")).toBe("Inbox: mark card as reviewed directly")
    expect(shortTitle("UI performance deep dive: long orchestrator/task threads, laggy typing")).toBe("UI performance deep dive")
    expect(shortTitle("🎉")).toBe("A task")
  })

  it("maps notifications to voice events and filters by the per-status toggles", () => {
    expect(voiceEvent(note("a", "t", "done", 1, { summary: "PR #7 merged" }))).toBe("merged")
    expect(voiceEvent(note("a", "t", "done", 1, { summary: "All done" }))).toBe("done")
    expect(voiceEvent(note("a", "t", "idle"))).toBeNull()
    const burst = [note("a", "t1", "done"), note("b", "t2", "failed"), note("c", "t1", "needs_input", 2), note("d", "t3", "idle")]
    const s = on({ events: { ...VOICE_DEFAULTS.events, failed: false } })
    expect(speakableEvents(burst, s).map((n) => n.id)).toEqual(["c"])
  })
})

describe("voice settings", () => {
  it("defaults: on, both sources and every event on, system voice, normal speed", () => {
    expect(parseVoiceSettings(null)).toEqual(VOICE_DEFAULTS)
    expect(VOICE_DEFAULTS.enabled).toBe(true)
    expect(VOICE_DEFAULTS.orchestrator && VOICE_DEFAULTS.taskEvents).toBe(true)
    expect(Object.values(VOICE_DEFAULTS.events).every(Boolean)).toBe(true)
    expect(VOICE_DEFAULTS).toMatchObject({ voiceURI: "", rate: 1, pitch: 1, volume: 1, backgroundOnly: false })
    expect(VOICE_DEFAULTS.quietHours.enabled).toBe(false)
  })

  it("a saved choice wins over the default, on or off", () => {
    expect(parseVoiceSettings(JSON.stringify({ ...VOICE_DEFAULTS, enabled: false })).enabled).toBe(false)
    expect(parseVoiceSettings(JSON.stringify({ enabled: false })).enabled).toBe(false)
    expect(parseVoiceSettings(JSON.stringify({ enabled: true, rate: 1.5 }))).toMatchObject({ enabled: true, rate: 1.5 })
    // Saved settings from before the default changed, with no `enabled` at all, get the new default.
    expect(parseVoiceSettings(JSON.stringify({ rate: 1.5 })).enabled).toBe(true)
  })

  it("survives garbage and clamps values", () => {
    expect(parseVoiceSettings("{nope")).toEqual(VOICE_DEFAULTS)
    expect(parseVoiceSettings("42")).toEqual(VOICE_DEFAULTS)
    const s = parseVoiceSettings(JSON.stringify({ enabled: true, rate: 9, volume: -1, events: { failed: false }, quietHours: { start: "25:00", enabled: true } }))
    expect(s.enabled).toBe(true)
    expect(s.rate).toBe(2)
    expect(s.volume).toBe(0)
    expect(s.events).toEqual({ ...VOICE_DEFAULTS.events, failed: false })
    expect(s.quietHours).toEqual({ enabled: true, start: "22:00", end: "07:00" })
  })

  it("quiet hours, including windows past midnight", () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 22, h, m)
    const night = { enabled: true, start: "22:00", end: "07:00" }
    expect(inQuietHours(night, at(23))).toBe(true)
    expect(inQuietHours(night, at(3))).toBe(true)
    expect(inQuietHours(night, at(7))).toBe(false)
    expect(inQuietHours(night, at(12))).toBe(false)
    expect(inQuietHours({ enabled: true, start: "12:00", end: "13:30" }, at(13, 29))).toBe(true)
    expect(inQuietHours({ ...night, enabled: false }, at(23))).toBe(false)
    expect(inQuietHours({ enabled: true, start: "09:00", end: "09:00" }, at(9))).toBe(false)
  })

  it("voiceAllowed: enabled, outside quiet hours, background-only respected", () => {
    const noon = new Date(2026, 9, 22, 12)
    expect(voiceAllowed({ ...VOICE_DEFAULTS, enabled: false }, noon, true)).toBe(false)
    expect(voiceAllowed(VOICE_DEFAULTS, noon, false)).toBe(true)
    expect(voiceAllowed(on(), noon, false)).toBe(true)
    expect(voiceAllowed(on({ backgroundOnly: true }), noon, false)).toBe(false)
    expect(voiceAllowed(on({ backgroundOnly: true }), noon, true)).toBe(true)
    expect(voiceAllowed(on({ quietHours: { enabled: true, start: "11:00", end: "13:00" } }), noon, true)).toBe(false)
  })
})

describe("pickVoice", () => {
  const v = (voiceURI: string, lang: string, localService = true, def = false): VoiceLike => ({ voiceURI, name: voiceURI, lang, localService, default: def })

  it("uses the chosen voice when present", () => {
    const voices = [v("a", "en-US", true, true), v("b", "de-DE")]
    expect(pickVoice(voices, "b")?.voiceURI).toBe("b")
    expect(pickVoice(voices, "missing")?.voiceURI).toBe("a")
  })

  it("prefers the system default when it's local English, else a local English voice", () => {
    expect(pickVoice([v("g", "en-US", false, true), v("l", "en-GB"), v("u", "en-US")], "", "en-US")?.voiceURI).toBe("u")
    expect(pickVoice([v("d", "de-DE", true, true), v("l", "en-GB")], "")?.voiceURI).toBe("l")
    expect(pickVoice([v("d", "de-DE", true, true)], "")?.voiceURI).toBe("d")
    expect(pickVoice([], "")).toBeUndefined()
  })
})

describe("chunkForSpeech", () => {
  it("keeps short lines whole and splits long ones at boundaries", () => {
    expect(chunkForSpeech("Short line.")).toEqual(["Short line."])
    const text = "First part is here, and it keeps going for a while. Second sentence follows right after it, with more words."
    const chunks = chunkForSpeech(text, 60)
    expect(chunks.every((c) => c.length <= 60)).toBe(true)
    expect(chunks.join(" ")).toBe(text)
  })
})

// ------------------------------------------------------------------ queue

class FakeSynth {
  spoken: UtteranceLike[] = []
  current: UtteranceLike | null = null
  paused = false
  cancels = 0
  get speaking() {
    return this.current !== null
  }
  speak(u: UtteranceLike) {
    if (this.current) throw new Error("overlapping utterance") // the queue must never speak over itself
    this.current = u
    this.spoken.push(u)
    u.onstart?.({})
  }
  cancel() {
    this.cancels++
    this.current = null
  }
  pause() {
    this.paused = true
  }
  resume() {
    this.paused = false
  }
  /** Finish the current utterance. */
  end(error?: string) {
    const u = this.current!
    this.current = null
    if (error) u.onerror?.({ error })
    else u.onend?.({})
  }
}

const utter = (text: string): UtteranceLike => ({ text, voice: null, lang: "", rate: 1, pitch: 1, volume: 1, onstart: null, onend: null, onerror: null })
const OPTS = { rate: 1, pitch: 1, volume: 1 }

describe("SpeechQueue", () => {
  it("speaks one line at a time, in order", () => {
    vi.useFakeTimers()
    const synth = new FakeSynth()
    const q = new SpeechQueue(synth, utter)
    q.say("one", OPTS)
    q.say("two", OPTS)
    expect(synth.spoken.map((u) => u.text)).toEqual(["one"])
    synth.end()
    expect(synth.spoken.map((u) => u.text)).toEqual(["one", "two"])
    synth.end()
    expect(q.speaking).toBe(false)
    vi.useRealTimers()
  })

  it(`caps the waiting queue at ${MAX_QUEUE}, dropping the oldest`, () => {
    vi.useFakeTimers()
    const synth = new FakeSynth()
    const q = new SpeechQueue(synth, utter)
    for (const t of ["a", "b", "c", "d", "e"]) q.say(t, OPTS)
    expect(q.pending).toBe(MAX_QUEUE)
    while (synth.current) synth.end()
    expect(synth.spoken.map((u) => u.text)).toEqual(["a", "c", "d", "e"])
    vi.useRealTimers()
  })

  it("stop() cancels at once and forgets the queue; late callbacks are ignored", () => {
    vi.useFakeTimers()
    const synth = new FakeSynth()
    const q = new SpeechQueue(synth, utter)
    q.say("a", OPTS)
    q.say("b", OPTS)
    const first = synth.current!
    q.stop()
    expect(synth.cancels).toBe(1)
    expect(q.speaking).toBe(false)
    first.onend?.({})
    expect(synth.spoken).toHaveLength(1)
    vi.useRealTimers()
  })

  it("chunks long lines, moves on if onend never fires, and resumes a paused synth", () => {
    vi.useFakeTimers()
    const synth = new FakeSynth()
    const q = new SpeechQueue(synth, utter)
    q.say(`${"word ".repeat(50)}end.`, OPTS)
    q.say("next", OPTS)
    expect(synth.spoken[0]!.text.length).toBeLessThanOrEqual(160)
    synth.paused = true
    vi.advanceTimersByTime(5000)
    expect(synth.paused).toBe(false)
    // Chrome sometimes never fires onend: the watchdog cancels the stuck utterance and moves on.
    vi.advanceTimersByTime(60_000)
    expect(synth.spoken).toHaveLength(3)
    expect(synth.cancels).toBe(3) // each stuck utterance is cancelled before the next
    expect(synth.spoken.map((u) => u.text).at(-1)).toBe("next")
    vi.useRealTimers()
  })

  it("reports a blocked synth (no user gesture) and drops the queue", () => {
    vi.useFakeTimers()
    const synth = new FakeSynth()
    const onBlocked = vi.fn()
    const q = new SpeechQueue(synth, utter, globalThis, { onBlocked })
    q.say("a", OPTS)
    q.say("b", OPTS)
    synth.end("not-allowed")
    expect(onBlocked).toHaveBeenCalledOnce()
    expect(q.pending).toBe(0)
    expect(synth.spoken).toHaveLength(1)
    vi.useRealTimers()
  })
})

// ------------------------------------------------------------------ announcer

function setup(settings: VoiceSettings = on()) {
  vi.useFakeTimers()
  const said: string[] = []
  const a = new Announcer({ settings: () => settings, speak: (line) => said.push(line), now: () => Date.now() })
  return { a, said, done: () => vi.useRealTimers() }
}

describe("Announcer", () => {
  it("with the defaults (a fresh browser), reads the Coordinator's first reply aloud", () => {
    const { a, said, done } = setup(parseVoiceSettings(null))
    a.chatMessage(reply("c1", "Project added. Three open issues."))
    a.chatTurn({ startedAt: 0, replyId: "c1" })
    expect(said).toEqual(["Project added. Three open issues."])
    done()
  })

  it("speaks a turn's final reply once, and nothing for silent turns", () => {
    const { a, said, done } = setup()
    a.chatMessage(reply("c1", "PR #30 merged. Cards are equal height now."))
    a.chatTurn({ startedAt: 0, replyId: "c1" })
    a.chatTurn({ startedAt: 0, replyId: null })
    expect(said).toEqual(["PR number 30 merged. Cards are equal height now."])
    done()
  })

  it("respects the orchestrator toggle and the master switch", () => {
    for (const s of [on({ orchestrator: false }), on({ enabled: false })]) {
      const { a, said, done } = setup(s)
      a.chatMessage(reply("c1", "Hello there."))
      a.chatTurn({ startedAt: 0, replyId: "c1" })
      expect(said).toEqual([])
      done()
    }
  })

  it("batches task events when orchestrator summaries are off", () => {
    const { a, said, done } = setup(on({ orchestrator: false }))
    a.notification(note("n1", "t1", "done", 1))
    a.notification(note("n2", "t2", "done", 2))
    a.notification(note("n2", "t2", "done", 2)) // duplicate delivery
    a.notification(note("n3", "t3", "done", 3))
    expect(said).toEqual([])
    vi.advanceTimersByTime(EVENT_BATCH_MS)
    expect(said).toEqual(["3 tasks finished."])
    done()
  })

  it("drops held task events when the orchestrator's turn reported them", () => {
    const { a, said, done } = setup()
    a.notification(note("n1", "t1", "done", 100, { title: "Workout log" }))
    a.chatBusy(true)
    vi.advanceTimersByTime(HOLD_MS)
    expect(said).toEqual([])
    a.chatMessage(reply("c1", "Workout log is done. Here's the summary."))
    a.chatTurn({ startedAt: 200, replyId: "c1" })
    a.chatBusy(false)
    vi.advanceTimersByTime(MAX_HOLD_MS)
    expect(said).toEqual(["Workout log is done. Here's the summary."])
    done()
  })

  it("speaks held task events when the orchestrator says (no update) or never runs", () => {
    const { a, said, done } = setup()
    a.notification(note("n1", "t1", "failed", 100, { title: "Deploy" }))
    a.chatBusy(true)
    a.chatTurn({ startedAt: 150, replyId: null })
    expect(said).toEqual(["Deploy failed."])

    a.notification(note("n2", "t2", "needs_input", 300, { title: "Find the nebula repo" }))
    a.chatBusy(false)
    vi.advanceTimersByTime(HOLD_MS)
    expect(said).toEqual(["Deploy failed.", "Find the nebula repo needs your input."])
    done()
  })

  it("keeps events that arrived mid-turn for the next turn", () => {
    const { a, said, done } = setup()
    a.chatBusy(true)
    a.notification(note("n1", "t1", "done", 500))
    a.chatMessage(reply("c1", "Answering your question."))
    a.chatTurn({ startedAt: 100, replyId: "c1" }) // started before the event: doesn't cover it
    a.chatTurn({ startedAt: 600, replyId: null }) // the auto turn said nothing
    expect(said).toEqual(["Answering your question.", "Task Build t1 finished."])
    done()
  })

  it("gives up holding after MAX_HOLD_MS even while the orchestrator stays busy", () => {
    const { a, said, done } = setup()
    a.chatBusy(true)
    a.notification(note("n1", "t1", "done", 500))
    vi.advanceTimersByTime(MAX_HOLD_MS)
    expect(said).toEqual(["Task Build t1 finished."])
    done()
  })

  it("dedupes the same line within a few seconds", () => {
    const { a, said, done } = setup(on({ orchestrator: false }))
    a.notification(note("n1", "t1", "done", 1, { summary: "PR #5 merged" }))
    vi.advanceTimersByTime(EVENT_BATCH_MS)
    a.notification(note("n2", "t1", "done", 2, { summary: "PR #5 merged by cody" }))
    vi.advanceTimersByTime(EVENT_BATCH_MS)
    expect(said).toEqual(["PR 5 merged."])
    vi.advanceTimersByTime(DEDUPE_MS)
    a.notification(note("n3", "t1", "done", 3, { summary: "PR #5 merged" }))
    vi.advanceTimersByTime(EVENT_BATCH_MS)
    expect(said).toEqual(["PR 5 merged.", "PR 5 merged."])
    done()
  })

  it("ignores task events when they're off or their status is off", () => {
    const { a, said, done } = setup(on({ orchestrator: false, events: { ...VOICE_DEFAULTS.events, done: false } }))
    a.notification(note("n1", "t1", "done", 1))
    a.notification(note("n2", "t2", "idle", 1))
    vi.advanceTimersByTime(EVENT_BATCH_MS)
    expect(said).toEqual([])
    done()
  })
})

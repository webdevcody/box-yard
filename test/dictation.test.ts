import { describe, expect, it, vi } from "vitest"
import {
  DictationMachine,
  TAP_MS,
  defaultDictationKey,
  dictationDefaults,
  errorKind,
  insertTranscript,
  isHotkeyDown,
  isHotkeyUp,
  keyLabel,
  parseDictationSettings,
  type RecognitionLike,
} from "../web/src/lib/dictation.js"
import { SpeechQueue, type UtteranceLike } from "../web/src/lib/speech.js"

describe("insertTranscript", () => {
  it("inserts at the caret without replacing the draft, with spaces where needed", () => {
    expect(insertTranscript("fix the bug", 3, 3, "quickly")).toEqual({ value: "fix quickly the bug", caret: 11 })
    expect(insertTranscript("hello", 5, 5, "world")).toEqual({ value: "hello world", caret: 11 })
    expect(insertTranscript("hello ", 6, 6, "world")).toEqual({ value: "hello world", caret: 11 })
  })

  it("capitalizes at the start of the box or a sentence, not mid-sentence", () => {
    expect(insertTranscript("", 0, 0, "start a task")).toEqual({ value: "Start a task", caret: 12 })
    expect(insertTranscript("Done.", 5, 5, "next one")).toEqual({ value: "Done. Next one", caret: 14 })
    expect(insertTranscript("first line\n", 11, 11, "second")).toEqual({ value: "first line\nSecond", caret: 17 })
    expect(insertTranscript("please", 6, 6, "merge it")).toEqual({ value: "please merge it", caret: 15 })
  })

  it("replaces a selection", () => {
    expect(insertTranscript("merge PR 30 now", 6, 11, "the docs PR")).toEqual({ value: "merge the docs PR now", caret: 17 })
  })

  it("no space before punctuation or after an opening bracket, none doubled", () => {
    expect(insertTranscript("hi", 2, 2, ", there")).toEqual({ value: "hi, there", caret: 9 })
    expect(insertTranscript("(", 1, 1, "aside")).toEqual({ value: "(aside", caret: 6 })
    expect(insertTranscript("say  now", 4, 4, "it")).toEqual({ value: "say it now", caret: 6 })
    expect(insertTranscript("end.", 0, 0, "the")).toEqual({ value: "The end.", caret: 3 })
    expect(insertTranscript("word", 0, 0, "a")).toEqual({ value: "A word", caret: 1 })
    expect(insertTranscript("a.", 1, 1, "b")).toEqual({ value: "a b.", caret: 3 })
  })

  it("normalizes whitespace and ignores empty transcripts", () => {
    expect(insertTranscript("x", 1, 1, "  two   words ")).toEqual({ value: "x two words", caret: 11 })
    expect(insertTranscript("keep", 2, 2, "   ")).toEqual({ value: "keep", caret: 2 })
  })

  it("clamps an out-of-range selection", () => {
    expect(insertTranscript("ab", 9, 12, "c")).toEqual({ value: "ab c", caret: 4 })
  })
})

describe("dictation settings and hotkeys", () => {
  it("defaults: on, browser language, Option+Space on a Mac, Ctrl+Space elsewhere, no auto-send", () => {
    expect(dictationDefaults("MacIntel")).toEqual({ enabled: true, lang: "", key: "alt+space", sendOnRelease: false })
    expect(dictationDefaults("Win32").key).toBe("ctrl+space")
    expect(defaultDictationKey("macOS")).toBe("alt+space")
    expect(parseDictationSettings(null, "Linux x86_64")).toEqual(dictationDefaults("Linux"))
  })

  it("parses stored values and ignores junk", () => {
    expect(parseDictationSettings('{"enabled":false,"lang":"de-DE","key":"ctrl+shift+space","sendOnRelease":true}')).toEqual({
      enabled: false,
      lang: "de-DE",
      key: "ctrl+shift+space",
      sendOnRelease: true,
    })
    expect(parseDictationSettings('{"lang":"<b>","key":"f13"}', "MacIntel")).toEqual(dictationDefaults("MacIntel"))
    expect(parseDictationSettings("not json")).toEqual(dictationDefaults())
  })

  const ev = (code: string, mods: Partial<Record<"altKey" | "ctrlKey" | "shiftKey" | "metaKey", boolean>> = {}, key = code === "Space" ? " " : code) => ({
    code,
    key,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  })

  it("matches the chord exactly", () => {
    expect(isHotkeyDown(ev("Space", { altKey: true }), "alt+space")).toBe(true)
    expect(isHotkeyDown(ev("Space", { altKey: true, shiftKey: true }), "alt+space")).toBe(false)
    expect(isHotkeyDown(ev("Space", { ctrlKey: true }), "alt+space")).toBe(false)
    expect(isHotkeyDown(ev("Space"), "ctrl+space")).toBe(false)
    expect(isHotkeyDown(ev("Space", { ctrlKey: true, shiftKey: true }), "ctrl+shift+space")).toBe(true)
    expect(isHotkeyDown(ev("Space", { ctrlKey: true, metaKey: true }), "ctrl+space")).toBe(false)
    expect(isHotkeyDown(ev("Space", { ctrlKey: true }), "off")).toBe(false)
  })

  it("ends on Space or a chord modifier going up", () => {
    expect(isHotkeyUp(ev("Space"), "alt+space")).toBe(true)
    expect(isHotkeyUp(ev("AltLeft", {}, "Alt"), "alt+space")).toBe(true)
    expect(isHotkeyUp(ev("ControlLeft", {}, "Control"), "alt+space")).toBe(false)
    expect(isHotkeyUp(ev("KeyA", {}, "a"), "ctrl+space")).toBe(false)
  })

  it("labels keys per platform", () => {
    expect(keyLabel("alt+space", true)).toBe("Option+Space")
    expect(keyLabel("alt+space", false)).toBe("Alt+Space")
    expect(keyLabel("ctrl+shift+space", false)).toBe("Ctrl+Shift+Space")
  })

  it("classifies recognition errors", () => {
    expect(errorKind("not-allowed")).toBe("denied")
    expect(errorKind("service-not-allowed")).toBe("denied")
    expect(errorKind("audio-capture")).toBe("no-mic")
    expect(errorKind("no-speech")).toBeNull()
    expect(errorKind("aborted")).toBeNull()
    expect(errorKind("weird")).toBe("failed")
  })
})

// ------------------------------------------------------------------ state machine with a mocked SpeechRecognition

class FakeRecognition implements RecognitionLike {
  static all: FakeRecognition[] = []
  lang = ""
  continuous = false
  interimResults = false
  onresult: RecognitionLike["onresult"] = null
  onerror: RecognitionLike["onerror"] = null
  onend: RecognitionLike["onend"] = null
  started = 0
  stopped = 0
  aborted = 0
  running = false
  constructor() {
    FakeRecognition.all.push(this)
  }
  start() {
    if (this.running) throw new Error("already started")
    this.running = true
    this.started++
  }
  stop() {
    this.stopped++
  }
  abort() {
    this.aborted++
    this.running = false
  }
  /** Results so far in this session: [text, isFinal][] from `index` on. */
  emit(index: number, results: [string, boolean][]) {
    const list = results.map(([t, isFinal]) => ({ isFinal, 0: { transcript: t } }))
    this.onresult?.({ resultIndex: index, results: [...Array(index).fill({ isFinal: true, 0: { transcript: "" } }), ...list] })
  }
  end() {
    this.running = false
    this.onend?.()
  }
}

function setup(opts: { sendOnRelease?: boolean } = {}) {
  FakeRecognition.all = []
  let now = 1000
  const finals: string[] = []
  const send = vi.fn()
  const active: boolean[] = []
  const m = new DictationMachine({
    create: () => new FakeRecognition(),
    lang: () => "en-GB",
    onFinal: (t) => finals.push(t),
    onSend: send,
    sendOnRelease: () => Boolean(opts.sendOnRelease),
    onActive: (a) => active.push(a),
    now: () => now,
  })
  return { m, finals, send, active, rec: () => FakeRecognition.all.at(-1)!, tick: (ms: number) => (now += ms) }
}

describe("DictationMachine", () => {
  it("hold: press starts, release after TAP_MS stops; final words land and interim shows meanwhile", () => {
    const { m, finals, active, rec, tick } = setup()
    m.press()
    expect(m.state.phase).toBe("listening")
    expect(rec()).toMatchObject({ lang: "en-GB", continuous: true, interimResults: true, started: 1 })
    rec().emit(0, [["hello wor", false]])
    expect(m.state.interim).toBe("hello wor")
    expect(finals).toEqual([])
    rec().emit(0, [["hello world", true]])
    expect(finals).toEqual(["hello world"])
    expect(m.state.interim).toBe("")
    tick(TAP_MS + 200)
    m.release()
    expect(m.state.phase).toBe("stopping")
    expect(rec().stopped).toBe(1)
    rec().end()
    expect(m.state.phase).toBe("idle")
    expect(active).toEqual([true, false])
  })

  it("tap: a quick press-release keeps listening (toggle), the next press stops and its release is ignored", () => {
    const { m, rec, tick } = setup()
    m.press()
    tick(100)
    m.release()
    expect(m.state).toMatchObject({ phase: "listening", mode: "toggle" })
    tick(5000)
    m.press()
    expect(m.state.phase).toBe("stopping")
    tick(1000)
    m.release()
    rec().end()
    expect(m.state.phase).toBe("idle")
    // The release after the stopping press must not start anything.
    expect(FakeRecognition.all).toHaveLength(1)
  })

  it("toggle() (keyboard click) turns it on and off", () => {
    const { m, rec } = setup()
    m.toggle()
    expect(m.state).toMatchObject({ phase: "listening", mode: "toggle" })
    m.toggle()
    expect(rec().stopped).toBe(1)
    rec().end()
    expect(m.state.phase).toBe("idle")
  })

  it("keeps interim words that never became final when the session ends", () => {
    const { m, finals, rec, tick } = setup()
    m.press()
    rec().emit(0, [["half a thought", false]])
    tick(TAP_MS + 1)
    m.release()
    rec().end()
    expect(finals).toEqual(["half a thought"])
  })

  it("send when released: only for a held press, and only after the last words are in", () => {
    const { m, finals, send, rec, tick } = setup({ sendOnRelease: true })
    m.press()
    tick(TAP_MS + 1)
    m.release()
    expect(send).not.toHaveBeenCalled()
    rec().emit(0, [["ship it", true]])
    rec().end()
    expect(finals).toEqual(["ship it"])
    expect(send).toHaveBeenCalledOnce()

    // A tap toggles instead, and stopping a toggle never sends.
    m.press()
    tick(50)
    m.release()
    m.toggle()
    rec().end()
    expect(send).toHaveBeenCalledOnce()
  })

  it("stopAndSend (Enter while listening) waits for the end, then sends", () => {
    const { m, send, rec } = setup()
    m.toggle()
    m.stopAndSend()
    expect(send).not.toHaveBeenCalled()
    rec().end()
    expect(send).toHaveBeenCalledOnce()
  })

  it("restarts when the browser ends the session while still wanted, up to a limit", () => {
    const { m, rec } = setup()
    m.toggle()
    const r = rec()
    for (let i = 0; i < 5; i++) {
      r.running = false
      r.onend?.()
    }
    expect(r.started).toBe(6)
    expect(m.state.phase).toBe("listening")
    r.running = false
    r.onend?.()
    expect(m.state.phase).toBe("idle")
  })

  it("permission denied: stops with a clear error; no-speech is ignored", () => {
    const { m, rec } = setup()
    m.toggle()
    rec().onerror?.({ error: "no-speech" })
    expect(m.state.error).toBeNull()
    rec().onerror?.({ error: "not-allowed" })
    rec().end()
    expect(m.state).toMatchObject({ phase: "idle", error: "denied" })
    expect(rec().started).toBe(1) // no restart after a denial
    m.clearError()
    expect(m.state.error).toBeNull()
  })

  it("abort() (unmount) drops everything at once and ignores late events", () => {
    const { m, finals, active, rec } = setup()
    m.toggle()
    const r = rec()
    r.emit(0, [["pending", false]])
    m.abort()
    expect(r.aborted).toBe(1)
    expect(m.state.phase).toBe("idle")
    r.emit(0, [["late", true]])
    r.end()
    expect(finals).toEqual([])
    expect(active).toEqual([true, false])
  })

  it("stop() (tab hidden, Escape) keeps what was heard", () => {
    const { m, finals, rec } = setup()
    m.toggle()
    rec().emit(0, [["keep me", false]])
    m.stop()
    rec().end()
    expect(finals).toEqual(["keep me"])
  })

  it("does nothing when recognition can't be created", () => {
    const m = new DictationMachine({ create: () => null, lang: () => "en", onFinal: () => {} })
    m.press()
    m.toggle()
    expect(m.state.phase).toBe("idle")
  })

  it("notifies subscribers on state changes", () => {
    const { m, rec } = setup()
    const seen: string[] = []
    m.subscribe(() => seen.push(`${m.state.phase}:${m.state.interim}`))
    m.toggle()
    rec().emit(0, [["a", false]])
    rec().emit(0, [["a", false]]) // unchanged: no notification
    expect(seen).toEqual(["listening:", "listening:a"])
  })
})

// ------------------------------------------------------------------ announcements pause while dictating

describe("SpeechQueue hold/release", () => {
  const utter = (text: string): UtteranceLike => ({ text, voice: null, lang: "", rate: 1, pitch: 1, volume: 1, onstart: null, onend: null, onerror: null })
  const OPTS = { rate: 1, pitch: 1, volume: 1 }
  function synth() {
    const s = {
      spoken: [] as string[],
      current: null as UtteranceLike | null,
      paused: false,
      get speaking() {
        return s.current !== null
      },
      speak(u: UtteranceLike) {
        s.current = u
        s.spoken.push(u.text)
      },
      cancel() {
        s.current = null
      },
      pause() {},
      resume() {},
      end() {
        const u = s.current!
        s.current = null
        u.onend?.({})
      },
    }
    return s
  }

  it("cuts the current line, holds new ones, and replays from that line on release", () => {
    vi.useFakeTimers()
    const s = synth()
    const q = new SpeechQueue(s, utter)
    q.say("first", OPTS)
    q.hold()
    expect(s.current).toBeNull()
    q.say("second", OPTS)
    expect(s.spoken).toEqual(["first"])
    q.release()
    expect(s.spoken).toEqual(["first", "first"])
    s.end()
    expect(s.spoken).toEqual(["first", "first", "second"])
    vi.useRealTimers()
  })
})

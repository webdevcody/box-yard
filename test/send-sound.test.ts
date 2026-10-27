import { describe, expect, it, vi } from "vitest"
import { CUES, DEFAULT_SEND_SOUND, GAP_MS, UNDER_VOICE, createSendSound, cueLength, parseSendSound, type SendSoundSettings, type ToneContext } from "../web/src/lib/sendSound.js"

/** An AudioContext stand-in that records the tones scheduled on it. */
class FakeCtx implements ToneContext {
  currentTime = 0
  state = "running"
  destination = {}
  resumes = 0
  tones: { freq: number; start: number; stop: number; peak: number }[] = []
  resumeImpl = async () => {
    this.state = "running"
  }
  resume() {
    this.resumes++
    return this.resumeImpl()
  }
  createOscillator() {
    const tone = { freq: 0, start: 0, stop: 0, peak: 0 }
    const ctx = this
    return {
      type: "",
      frequency: {
        setValueAtTime: (v: number) => (tone.freq = v),
        exponentialRampToValueAtTime: () => {},
      },
      connect: (gain: { peak: () => number }) => {
        ctx.tones.push(tone)
        tone.peak = gain.peak()
      },
      start: (t: number) => (tone.start = t),
      stop: (t: number) => (tone.stop = t),
      onended: null,
      disconnect: () => {},
    }
  }
  createGain() {
    let peak = 0
    return {
      gain: {
        setValueAtTime: () => {},
        linearRampToValueAtTime: (v: number) => (peak = v),
        exponentialRampToValueAtTime: () => {},
      },
      // The fake oscillator reads the peak through this when it's connected.
      peak: () => peak,
      connect: () => {},
      disconnect: () => {},
    }
  }
}

function setup(o: { settings?: Partial<SendSoundSettings>; ctx?: FakeCtx | null; speaking?: boolean } = {}) {
  const ctx = o.ctx === undefined ? new FakeCtx() : o.ctx
  const clock = { now: 1000 }
  const settings = { ...DEFAULT_SEND_SOUND, ...o.settings }
  const vibrate = vi.fn()
  const state = { speaking: o.speaking ?? false }
  const unlock = vi.fn()
  const sound = createSendSound({
    context: () => ctx as unknown as ToneContext,
    unlock,
    settings: () => settings,
    speaking: () => state.speaking,
    now: () => clock.now,
    vibrate,
  })
  return { sound, ctx: ctx!, clock, settings, vibrate, state, unlock }
}

describe("send sound: settings", () => {
  it("is on by default, at a moderate volume", () => {
    expect(parseSendSound(null)).toEqual({ enabled: true, volume: 0.6 })
    expect(parseSendSound("not json")).toEqual(DEFAULT_SEND_SOUND)
  })

  it("keeps saved values and clamps the volume", () => {
    expect(parseSendSound(JSON.stringify({ enabled: false, volume: 0.3 }))).toEqual({ enabled: false, volume: 0.3 })
    expect(parseSendSound(JSON.stringify({ volume: 4 })).volume).toBe(1)
    expect(parseSendSound(JSON.stringify({ volume: -1 })).volume).toBe(0)
    expect(parseSendSound(JSON.stringify({ enabled: "yes", volume: "loud" }))).toEqual(DEFAULT_SEND_SOUND)
  })
})

describe("send sound: the cues", () => {
  it("are short, quiet and soft", () => {
    for (const cue of ["sent", "failed"] as const) {
      expect(cueLength(cue)).toBeGreaterThanOrEqual(0.08)
      expect(cueLength(cue)).toBeLessThanOrEqual(0.2)
      for (const t of CUES[cue]) {
        // No harsh highs, and well under full scale even at volume 1.
        expect(Math.max(t.freq, t.to ?? 0)).toBeLessThan(1000)
        expect(t.peak).toBeLessThanOrEqual(0.2)
      }
    }
  })

  it("sound different: sent rises, failed falls and sits lower", () => {
    const pitches = (cue: "sent" | "failed") => CUES[cue].map((t) => t.freq)
    const [s1, s2] = pitches("sent")
    const [f1, f2] = pitches("failed")
    expect(s2!).toBeGreaterThan(s1!)
    expect(f2!).toBeLessThan(f1!)
    expect(Math.max(...pitches("failed"))).toBeLessThan(Math.min(...pitches("sent")))
  })
})

describe("send sound: when it plays", () => {
  it("plays the two tones of the cue, scaled by the volume, and taps on phones", () => {
    const { sound, ctx, vibrate } = setup({ settings: { volume: 0.5 } })
    expect(sound.play("sent")).toBe(true)
    expect(ctx.tones.map((t) => t.freq)).toEqual(CUES.sent.map((t) => t.freq))
    expect(ctx.tones[0]!.peak).toBeCloseTo(CUES.sent[0]!.peak * 0.5)
    expect(vibrate).toHaveBeenCalledWith(10)
  })

  it("plays the failed cue on a failed send, without the tap", () => {
    const { sound, ctx, vibrate } = setup()
    expect(sound.play("failed")).toBe(true)
    expect(ctx.tones.map((t) => t.freq)).toEqual(CUES.failed.map((t) => t.freq))
    expect(vibrate).not.toHaveBeenCalled()
  })

  it("is silent with the setting off, and doesn't even prime", () => {
    const { sound, ctx, vibrate, unlock } = setup({ settings: { enabled: false } })
    ctx.state = "suspended"
    sound.prime()
    expect(ctx.resumes).toBe(0)
    expect(unlock).not.toHaveBeenCalled()
    ctx.state = "running"
    expect(sound.play("sent")).toBe(false)
    expect(sound.play("failed")).toBe(false)
    expect(ctx.tones).toEqual([])
    expect(vibrate).not.toHaveBeenCalled()
  })

  it("is silent at volume 0", () => {
    const { sound, ctx } = setup({ settings: { volume: 0 } })
    expect(sound.play("sent")).toBe(false)
    expect(ctx.tones).toEqual([])
  })

  it("plays the draft settings the preview passes, not the saved ones", () => {
    const { sound, ctx } = setup({ settings: { enabled: false } })
    expect(sound.play("sent", { settings: { enabled: true, volume: 1 } })).toBe(true)
    expect(ctx.tones[0]!.peak).toBeCloseTo(CUES.sent[0]!.peak)
  })

  it("makes one sound for a burst of sends, then plays again after a gap", () => {
    const { sound, ctx, clock, vibrate } = setup()
    expect(sound.play("sent")).toBe(true)
    clock.now += 40
    expect(sound.play("sent")).toBe(false)
    clock.now += 100
    expect(sound.play("failed")).toBe(false)
    expect(ctx.tones).toHaveLength(2)
    expect(vibrate).toHaveBeenCalledTimes(1)
    clock.now += GAP_MS
    expect(sound.play("sent")).toBe(true)
    expect(ctx.tones).toHaveLength(4)
  })

  it("mixes in quieter while a voice line is playing, instead of talking over it", () => {
    const { sound, ctx } = setup({ speaking: true, settings: { volume: 1 } })
    sound.play("sent")
    expect(ctx.tones[0]!.peak).toBeCloseTo(CUES.sent[0]!.peak * UNDER_VOICE)
  })

  it("does nothing without Web Audio", () => {
    const { sound } = setup({ ctx: null })
    sound.prime()
    expect(sound.play("sent")).toBe(false)
  })
})

describe("send sound: locked audio (phones, first visit)", () => {
  it("stays quiet when the context was never unlocked, so it can't play late", () => {
    const { sound, ctx } = setup()
    ctx.state = "suspended"
    expect(sound.play("sent")).toBe(false)
    expect(ctx.tones).toEqual([])
  })

  it("prime() inside the tap runs the page's audio unlock and resumes the context; the answer then plays", async () => {
    const { sound, ctx, clock, unlock } = setup()
    ctx.state = "suspended"
    sound.prime()
    expect(unlock).toHaveBeenCalledOnce()
    expect(ctx.resumes).toBe(1)
    await Promise.resolve()
    clock.now += 120
    expect(ctx.state).toBe("running")
    expect(sound.play("sent")).toBe(true)
    expect(ctx.tones).toHaveLength(2)
  })

  it("a send answered before resume() finishes plays once it has", async () => {
    const { sound, ctx, clock } = setup()
    ctx.state = "suspended"
    let finish!: () => void
    ctx.resumeImpl = () =>
      new Promise<void>((r) => {
        finish = () => {
          ctx.state = "running"
          r()
        }
      })
    sound.prime()
    clock.now += 5
    expect(sound.play("sent")).toBe(true)
    expect(ctx.tones).toEqual([])
    finish()
    await vi.waitFor(() => expect(ctx.tones).toHaveLength(2))
  })

  it("drops it when resume() takes too long, rather than playing it late", async () => {
    const { sound, ctx, clock } = setup()
    ctx.state = "suspended"
    let finish!: () => void
    ctx.resumeImpl = () =>
      new Promise<void>((r) => {
        finish = () => {
          ctx.state = "running"
          r()
        }
      })
    sound.prime()
    sound.play("sent")
    clock.now += 2000
    finish()
    await new Promise((r) => setTimeout(r, 0))
    expect(ctx.tones).toEqual([])
  })

  it("doesn't resume a running context again", () => {
    const { sound, ctx } = setup()
    sound.prime()
    expect(ctx.resumes).toBe(0)
  })
})

// OpenAI's Realtime voice streams raw 16-bit PCM, which no <audio> element plays as it arrives. So
// CloudSynth hands it to PcmPlayer: each chunk becomes an AudioBuffer queued right after the last
// one on a shared AudioContext, so speech starts with the first chunk instead of the whole clip.
// Where Web Audio is missing, pcmToWav() wraps the finished clip for the <audio> element instead.

/** POST /api/tts answered `audio/pcm;rate=…`: the body is still streaming. */
export interface PcmStream {
  kind: "pcm"
  sampleRate: number
  body: ReadableStream<Uint8Array>
}

export const isPcm = (x: unknown): x is PcmStream => typeof x === "object" && x !== null && (x as PcmStream).kind === "pcm"

/** `audio/pcm;rate=24000` → 24000; null for anything else. */
export function pcmRate(contentType: string | null): number | null {
  const m = /^audio\/pcm\b(?:.*?;\s*rate=(\d+))?/i.exec(contentType ?? "")
  return m ? Number(m[1] ?? 24_000) : null
}

/** Little-endian 16-bit samples → floats. `carry` is an odd byte left over from the last chunk. */
export function pcm16ToFloat(bytes: Uint8Array, carry: number | null): { samples: Float32Array; carry: number | null } {
  const joined = carry === null ? bytes : new Uint8Array([carry, ...bytes])
  const n = joined.length >> 1
  const view = new DataView(joined.buffer, joined.byteOffset, n * 2)
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000
  return { samples, carry: joined.length % 2 ? joined[joined.length - 1]! : null }
}

/** The whole clip as a playable WAV, for browsers without Web Audio (and the Settings previews). */
export async function pcmToWav(pcm: PcmStream): Promise<Blob> {
  const parts: Uint8Array[] = []
  let size = 0
  const reader = pcm.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    size += value.length
  }
  size -= size % 2
  const head = new DataView(new ArrayBuffer(44))
  const str = (at: number, s: string) => [...s].forEach((ch, i) => head.setUint8(at + i, ch.charCodeAt(0)))
  str(0, "RIFF")
  head.setUint32(4, 36 + size, true)
  str(8, "WAVEfmt ")
  head.setUint32(16, 16, true)
  head.setUint16(20, 1, true) // PCM
  head.setUint16(22, 1, true) // mono
  head.setUint32(24, pcm.sampleRate, true)
  head.setUint32(28, pcm.sampleRate * 2, true)
  head.setUint16(32, 2, true)
  head.setUint16(34, 16, true)
  str(36, "data")
  head.setUint32(40, size, true)
  return new Blob([head.buffer, ...parts.map((p) => p.slice())], { type: "audio/wav" })
}

// ------------------------------------------------------------------ the player

/** The parts of AudioContext the player uses, so tests can fake it. */
export interface AudioContextLike {
  readonly currentTime: number
  readonly state: string
  readonly destination: unknown
  resume(): Promise<void>
  createBuffer(channels: number, length: number, sampleRate: number): { duration: number; copyToChannel(source: Float32Array, channel: number): void }
  createBufferSource(): {
    buffer: unknown
    onended: (() => void) | null
    connect(node: unknown): unknown
    start(when: number): void
    stop(): void
  }
  createGain(): { gain: { value: number }; connect(node: unknown): unknown; disconnect(): void }
}

export interface PcmCallbacks {
  volume: number
  onstart(): void
  onend(): void
  /** Autoplay is blocked: no tap yet. */
  onblocked(): void
  onerror(message: string): void
}

export interface PcmPlayback {
  stop(): void
}

export interface PcmPlayerLike {
  play(pcm: PcmStream, cb: PcmCallbacks): PcmPlayback
}

/** Lead time before the first chunk, so a slightly late second chunk doesn't leave a gap. */
const LEAD_S = 0.08
/** How long resume() may take before we call it an autoplay block. */
const RESUME_WAIT_MS = 400

export class PcmPlayer implements PcmPlayerLike {
  constructor(private readonly context: () => AudioContextLike | null) {}

  play(pcm: PcmStream, cb: PcmCallbacks): PcmPlayback {
    let stopped = false
    const sources = new Set<ReturnType<AudioContextLike["createBufferSource"]>>()
    const reader = pcm.body.getReader()
    let gain: ReturnType<AudioContextLike["createGain"]> | null = null
    const stop = () => {
      if (stopped) return
      stopped = true
      void reader.cancel().catch(() => {})
      for (const s of sources) {
        s.onended = null
        try {
          s.stop()
        } catch {}
      }
      sources.clear()
      gain?.disconnect()
    }
    const done = (fn: () => void) => {
      if (stopped) return
      stop()
      fn()
    }

    void (async () => {
      const ctx = this.context()
      if (!ctx) return done(() => cb.onerror("This browser can't play streamed audio."))
      if (ctx.state !== "running") {
        const ok = await Promise.race([
          ctx.resume().then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((r) => setTimeout(() => r(false), RESUME_WAIT_MS)),
        ])
        if (stopped) return
        if (!ok || ctx.state !== "running") return done(() => cb.onblocked())
      }
      gain = ctx.createGain()
      gain.gain.value = cb.volume
      gain.connect(ctx.destination)
      let at = 0
      let carry: number | null = null
      let started = false
      let streamDone = false
      const maybeEnd = () => {
        if (streamDone && !sources.size) done(() => cb.onend())
      }
      try {
        for (;;) {
          const { done: eof, value } = await reader.read()
          if (stopped) return
          if (eof) break
          const next = pcm16ToFloat(value, carry)
          carry = next.carry
          if (!next.samples.length) continue
          const buf = ctx.createBuffer(1, next.samples.length, pcm.sampleRate)
          buf.copyToChannel(next.samples, 0)
          const src = ctx.createBufferSource()
          src.buffer = buf
          src.connect(gain)
          // Ran dry (a slow chunk): start again a moment from now rather than in the past.
          at = Math.max(at, ctx.currentTime + LEAD_S)
          src.start(at)
          at += buf.duration
          sources.add(src)
          src.onended = () => {
            sources.delete(src)
            maybeEnd()
          }
          if (!started) {
            started = true
            cb.onstart()
          }
        }
      } catch (err) {
        return done(() => cb.onerror((err as Error)?.message || "The audio stream broke off."))
      }
      if (!started) return done(() => cb.onerror("The server sent no audio."))
      streamDone = true
      maybeEnd()
    })()

    return { stop }
  }
}

let sharedContext: AudioContextLike | null = null
/** One AudioContext for every clip; primeAudio() resumes it inside a tap so later lines may play. */
export function audioContext(): AudioContextLike | null {
  if (typeof window === "undefined") return null
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!sharedContext) {
    // iOS: play through the ringer switch, like the <audio> element does.
    const session = (navigator as { audioSession?: { type: string } }).audioSession
    if (session) session.type = "playback"
    sharedContext = new Ctor() as unknown as AudioContextLike
  }
  return sharedContext
}

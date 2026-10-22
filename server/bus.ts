import type { BoxProvider } from "./providers/types.js"
import type { Redis } from "./redis.js"

/** One event written by the worker runner (see runner/box-runner.mjs). */
export interface WorkerEvent {
  seq: number
  ts: number
  turnId: string | null
  t: string
  [key: string]: unknown
}

/** Where we are in a task's event log. `seq` dedupes across sources. */
export interface Cursor {
  seq: number
  offset: number
  rid: string | null
}

export const emptyCursor = (): Cursor => ({ seq: 0, offset: 0, rid: null })

export function parseCursor(raw: string | null): Cursor {
  if (!raw) return emptyCursor()
  try {
    const c = JSON.parse(raw) as Partial<Cursor>
    return { seq: c.seq ?? 0, offset: c.offset ?? 0, rid: c.rid ?? null }
  } catch {
    return emptyCursor()
  }
}

export const redisEventsKey = (taskId: string) => `boxyard:events:${taskId}`

const MAX_READ = 512 * 1024

/**
 * Split a chunk of JSONL into complete events. Returns how many bytes were
 * consumed so a partial last line is read again next time.
 */
export function parseJsonl(chunk: string): { events: WorkerEvent[]; consumed: number } {
  const lastNewline = chunk.lastIndexOf("\n")
  if (lastNewline < 0) return { events: [], consumed: 0 }
  const complete = chunk.slice(0, lastNewline + 1)
  const events: WorkerEvent[] = []
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line) as WorkerEvent
      if (typeof ev.seq === "number" && typeof ev.t === "string") events.push(ev)
    } catch {
      // A torn or corrupt line: skip it rather than stall the task.
    }
  }
  return { events, consumed: Buffer.byteLength(complete, "utf8") }
}

/** Reads worker events from Redis (fast) or from the box's events.jsonl (no Redis needed). */
export class EventReader {
  constructor(
    private readonly provider: BoxProvider,
    private readonly redis: Redis | null,
  ) {}

  get mode(): "redis" | "file" {
    return this.redis ? "redis" : "file"
  }

  async read(taskId: string, boxId: string, taskDir: string, cursor: Cursor): Promise<{ events: WorkerEvent[]; cursor: Cursor }> {
    if (this.redis) return this.readRedis(taskId, cursor)
    return this.readFile(boxId, taskDir, cursor)
  }

  private async readRedis(taskId: string, cursor: Cursor) {
    const start = cursor.rid ? `(${cursor.rid}` : "-"
    const rows = (await this.redis!.cmd<[string, string[]][]>("XRANGE", redisEventsKey(taskId), start, "+", "COUNT", 500)) ?? []
    const events: WorkerEvent[] = []
    let rid = cursor.rid
    for (const [id, fields] of rows) {
      rid = id
      const idx = fields.indexOf("e")
      if (idx < 0) continue
      try {
        events.push(JSON.parse(fields[idx + 1]!) as WorkerEvent)
      } catch {}
    }
    return this.dedupe(events, { ...cursor, rid })
  }

  /** Read new lines from events.jsonl by byte offset. */
  async readFile(boxId: string, taskDir: string, cursor: Cursor) {
    const file = `${taskDir}/events.jsonl`
    const res = await this.provider.exec(
      boxId,
      `[ -f '${file}' ] && tail -c +${cursor.offset + 1} '${file}' | head -c ${MAX_READ} || true`,
    )
    if (res.exitCode !== 0) throw new Error(`reading events failed: ${res.stderr.slice(-500)}`)
    const { events, consumed } = parseJsonl(res.stdout)
    return this.dedupe(events, { ...cursor, offset: cursor.offset + consumed })
  }

  /**
   * Fallback used when Redis may have missed events: scan the end of the file
   * for anything newer than `cursor.seq`.
   */
  async readFileTail(boxId: string, taskDir: string, cursor: Cursor) {
    const file = `${taskDir}/events.jsonl`
    const res = await this.provider.exec(boxId, `[ -f '${file}' ] && tail -c ${MAX_READ} '${file}' || true`)
    // The first line may be cut in half; parseJsonl drops lines that don't parse.
    const { events } = parseJsonl(res.stdout)
    return this.dedupe(events, cursor)
  }

  private dedupe(events: WorkerEvent[], cursor: Cursor) {
    const fresh = events.filter((e) => e.seq > cursor.seq).sort((a, b) => a.seq - b.seq)
    const seq = fresh.length ? fresh[fresh.length - 1]!.seq : cursor.seq
    return { events: fresh, cursor: { ...cursor, seq } }
  }
}

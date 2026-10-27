import { q, type BoxProvider } from "./providers/types.js"
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
  /** The inode of the events.jsonl `offset` is in: a different one means the file was replaced. */
  ino: string | null
}

export const emptyCursor = (): Cursor => ({ seq: 0, offset: 0, rid: null, ino: null })

export function parseCursor(raw: string | null): Cursor {
  if (!raw) return emptyCursor()
  try {
    const c = JSON.parse(raw) as Partial<Cursor>
    return { seq: c.seq ?? 0, offset: c.offset ?? 0, rid: c.rid ?? null, ino: c.ino ?? null }
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

/**
 * Shell that prints "<offset> <inode>" and then up to `max` bytes of `file` from that offset: the cursor's own, or 0
 * when the file is now shorter than it or isn't the same file. Prints nothing when there is no file yet.
 */
export function readEventsScript(file: string, cursor: Pick<Cursor, "offset" | "ino">, max: number): string {
  const ino = cursor.ino && /^\d+$/.test(cursor.ino) ? cursor.ino : ""
  return [
    `f=${q(file)}; [ -f "$f" ] || exit 0`,
    `s=$(wc -c < "$f" | tr -d ' '); i=$(ls -i "$f" | awk '{print $1}'); o=${Math.max(0, Math.floor(cursor.offset))}`,
    `if [ "$s" -lt "$o" ] || { [ -n "${ino}" ] && [ "$i" != "${ino}" ]; }; then o=0; fi`,
    `printf '%s %s\\n' "$o" "$i"`,
    `tail -c +$((o + 1)) "$f" | head -c ${max}`,
  ].join("\n")
}

/** readEventsScript's output: where the chunk starts, the file's inode, and the chunk. Null: no file yet. */
export function parseEventsRead(stdout: string): { offset: number; ino: string | null; chunk: string } | null {
  const nl = stdout.indexOf("\n")
  if (nl < 0) return null
  const [offset, ino] = stdout.slice(0, nl).trim().split(/\s+/)
  const at = Number(offset)
  if (!Number.isFinite(at)) return null
  return { offset: at, ino: ino || null, chunk: stdout.slice(nl + 1) }
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

  /**
   * Read new lines from events.jsonl by byte offset. A file shorter than the offset (truncated) or a different file
   * (rotated: another inode) is read again from its start; seq numbers keep what was already applied from coming back.
   */
  async readFile(boxId: string, taskDir: string, cursor: Cursor) {
    const res = await this.provider.exec(boxId, readEventsScript(`${taskDir}/events.jsonl`, cursor, MAX_READ))
    if (res.exitCode !== 0) throw new Error(`reading events failed: ${res.stderr.slice(-500)}`)
    const read = parseEventsRead(res.stdout)
    if (!read) return { events: [], cursor }
    const { events, consumed } = parseJsonl(read.chunk)
    return this.dedupe(events, { ...cursor, offset: read.offset + consumed, ino: read.ino })
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

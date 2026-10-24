import type { WorkerSize } from "../../shared/types.js"

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type BoxHealth = "running" | "paused" | "gone" | "error" | "unknown"

export interface BoxUsageProbe {
  size?: "small" | "medium" | "large"
  keepAlive?: boolean
  diskBytes?: number | null
  /** Actual provider CPU/active time if the API exposes it. */
  activeMs?: number | null
  /** Actual provider uptime if the API exposes it. */
  uptimeMs?: number | null
  source: "actual" | "estimated"
}

/**
 * Where worker boxes come from. `upstash` uses Upstash Box; `local` uses
 * folders on this machine so Box Yard runs with no Box account at all.
 */
export interface BoxProvider {
  readonly name: string
  /** Node binary inside the box, used to run the worker runner. */
  readonly nodeBin: string
  /** Claude binary inside the box. */
  readonly claudeBin: string
  /** Folder inside a box that holds `.boxyard/` and `tasks/`. */
  root(boxId: string): string
  /** Create a worker box with Claude Code and git ready. Returns its id. */
  create(opts: { labels: string[]; size?: WorkerSize }): Promise<string>
  health(boxId: string): Promise<BoxHealth>
  /** Wake a paused box. No-op when it is already running. */
  wake(boxId: string): Promise<void>
  exec(boxId: string, command: string): Promise<ExecResult>
  /**
   * Run a command and hand its output to `onOutput` as it arrives, without buffering it all (archives stream off
   * the box this way, so they need no scratch space there). On Upstash stdout and stderr arrive merged, so send
   * stderr elsewhere. Resolves with the exit code; rejects if the connection fails.
   */
  execStream(boxId: string, command: string, onOutput: (chunk: string) => void): Promise<{ exitCode: number }>
  /**
   * Run a long command and keep the box busy while it runs. Resolves when the
   * command ends or the connection drops; never rejects.
   */
  hold(boxId: string, command: string, signal: AbortSignal): Promise<void>
  writeFile(boxId: string, filePath: string, content: string | Buffer): Promise<void>
  readFile(boxId: string, filePath: string): Promise<Buffer>
  uploadFile(boxId: string, localPath: string, destination: string): Promise<void>
  publicUrl(boxId: string, port: number): Promise<string>
  destroy(boxId: string): Promise<void>
  /**
   * Change a box's size in place, keeping its disk. Optional: Upstash Box (0.7.10) sets the size only at
   * creation, so without this Box Yard resizes by moving the box's work to a new box of the target size.
   */
  resize?(boxId: string, size: WorkerSize): Promise<void>
  /** Ids of boxes carrying a label, to clean up boxes a crash left behind. */
  listIds?(label: string): Promise<string[]>
  /** Best-effort provider/disk usage metadata. Missing fields are estimated by Box Yard. */
  usage?(boxId: string): Promise<BoxUsageProbe>
  /** The provider that runs this box, when one provider fronts several (AutoProvider). */
  of?(boxId: string): BoxProvider
}

/** The provider behind one box: its name, node and claude binaries can differ from the one new boxes come from. */
export const providerOf = (p: BoxProvider, boxId: string): BoxProvider => p.of?.(boxId) ?? p

/** Quote a string for a POSIX shell. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

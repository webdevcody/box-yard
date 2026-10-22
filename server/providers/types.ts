export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type BoxHealth = "running" | "paused" | "gone" | "error" | "unknown"

/**
 * Where worker boxes come from. `upstash` uses Upstash Box; `local` uses
 * folders on this machine so Box Yard runs with no Box account at all.
 */
export interface BoxProvider {
  readonly name: string
  /** Folder inside a box that holds `.boxyard/` and `tasks/`. */
  root(boxId: string): string
  /** Create a worker box with Claude Code and git ready. Returns its id. */
  create(opts: { labels: string[] }): Promise<string>
  health(boxId: string): Promise<BoxHealth>
  /** Wake a paused box. No-op when it is already running. */
  wake(boxId: string): Promise<void>
  exec(boxId: string, command: string): Promise<ExecResult>
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
}

/** Quote a string for a POSIX shell. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

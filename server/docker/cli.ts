import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { Readable } from "node:stream"

/** Where Docker's CLI may be when it isn't on the server's PATH (Docker Desktop doesn't always link it). */
export const DOCKER_PATHS = ["docker", "/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"]

export interface DockerResult {
  code: number
  stdout: Buffer
  stderr: string
}

/** Docker Desktop's credential and compose helpers live beside its CLI, which may not be on the server's PATH. */
export function dockerEnv(bin: string): NodeJS.ProcessEnv {
  const dir = bin.includes("/") ? path.dirname(bin) : "/usr/local/bin"
  return { ...process.env, PATH: `${process.env.PATH ?? ""}:${dir}:/usr/local/bin:/opt/homebrew/bin` }
}

/**
 * Run the docker CLI. Secrets never go on its command line or in `-e`: they'd show in `ps`, in `docker events` and
 * in `docker inspect`. They go through `input` (stdin) instead. Never rejects; a CLI that won't start is code 127.
 */
export function docker(
  bin: string,
  args: string[],
  opts: {
    input?: string | Buffer | Readable
    timeoutMs?: number
    /** Output as it arrives, instead of in the result (archives stream off a container this way). */
    onStdout?: (chunk: Buffer) => void
    onStderr?: (chunk: string) => void
    signal?: AbortSignal
  } = {},
): Promise<DockerResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(bin, args, { env: dockerEnv(bin), stdio: ["pipe", "pipe", "pipe"] })
    } catch (err) {
      resolve({ code: 127, stdout: Buffer.alloc(0), stderr: (err as Error).message })
      return
    }
    const out: Buffer[] = []
    let err = ""
    let done = false
    const finish = (r: DockerResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      resolve(r)
    }
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined
    const onAbort = () => child.kill("SIGTERM")
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout!.on("data", (d: Buffer) => {
      if (opts.onStdout) opts.onStdout(d)
      else out.push(d)
    })
    child.stderr!.on("data", (d: Buffer) => {
      const s = d.toString("utf8")
      opts.onStderr?.(s)
      err = (err + s).slice(-64_000)
    })
    child.on("error", (e) => finish({ code: 127, stdout: Buffer.alloc(0), stderr: e.message }))
    child.on("close", (code, sig) => finish({ code: code ?? (sig ? 137 : 1), stdout: Buffer.concat(out), stderr: err }))
    // A command that exits before reading all its input closes the pipe: that's its answer, not ours to throw.
    child.stdin!.on("error", () => {})
    const input = opts.input
    if (input === undefined) child.stdin!.end()
    else if (typeof input === "string" || Buffer.isBuffer(input)) child.stdin!.end(input)
    else input.on("error", () => child.kill("SIGTERM")).pipe(child.stdin!)
  })
}

/** Is a file runnable as the docker CLI (an absolute path that exists, or a bare name found on PATH at spawn)? */
export function plausibleBin(bin: string): boolean {
  return !bin.includes("/") || fs.existsSync(bin)
}

/** "a=1,b=2" (docker ps's Labels column) → { a: "1", b: "2" }. */
export function parseLabels(s: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (s ?? "").split(",")) {
    const i = part.indexOf("=")
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1)
  }
  return out
}

/** One JSON object per line (docker's --format '{{json .}}'); lines that don't parse are skipped. */
export function jsonLines<T>(s: string): T[] {
  const out: T[] = []
  for (const line of s.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as T)
    } catch {}
  }
  return out
}

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { BoxHealth, BoxProvider, ExecResult } from "./types.js"

/**
 * "Boxes" that are folders on this machine. Good for trying Box Yard with no
 * Upstash account, for tests, and for running everything on one VPS.
 * There is no isolation between local boxes, so only run agents you trust.
 */
export class LocalProvider implements BoxProvider {
  readonly name = "local"
  constructor(private readonly baseDir: string) {
    fs.mkdirSync(baseDir, { recursive: true })
  }

  root(boxId: string) {
    return path.join(this.baseDir, boxId)
  }

  async create(): Promise<string> {
    const id = `local-${randomUUID().slice(0, 8)}`
    fs.mkdirSync(path.join(this.root(id), ".boxyard"), { recursive: true })
    fs.mkdirSync(path.join(this.root(id), "tasks"), { recursive: true })
    return id
  }

  async health(boxId: string): Promise<BoxHealth> {
    return fs.existsSync(this.root(boxId)) ? "running" : "gone"
  }

  async wake() {}

  exec(boxId: string, command: string): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", command], { cwd: this.root(boxId), env: process.env })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.stderr.on("data", (d) => (stderr += d))
      child.on("error", (err) => resolve({ exitCode: 127, stdout, stderr: stderr + err.message }))
      child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }))
    })
  }

  hold(boxId: string, command: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", command], { cwd: this.root(boxId), env: process.env, stdio: "ignore" })
      const onAbort = () => child.kill("SIGTERM")
      signal.addEventListener("abort", onAbort, { once: true })
      child.on("error", () => resolve())
      child.on("close", () => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      })
    })
  }

  async writeFile(_boxId: string, filePath: string, content: string | Buffer) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
  }

  async readFile(_boxId: string, filePath: string) {
    return fs.readFileSync(filePath)
  }

  async uploadFile(_boxId: string, localPath: string, destination: string) {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(localPath, destination)
  }

  async publicUrl(_boxId: string, port: number) {
    return `http://localhost:${port}`
  }

  async destroy(boxId: string) {
    // Stop any turn still running in this box before removing its folder.
    await this.exec(boxId, `for f in tasks/*/turn.pid; do [ -f "$f" ] && kill -TERM -- -$(cat "$f") 2>/dev/null; kill -TERM $(cat "$f") 2>/dev/null; done; true`)
    fs.rmSync(this.root(boxId), { recursive: true, force: true })
  }
}

// What the computer running Box Yard has for "Runs on: This computer" agents (#120): Node, claude, gh and Chrome,
// and whether its own claude and gh are signed in. Commands run with the env local agents get (agentEnv), so Box
// Yard's own tokens don't make a login look present. Nothing here is logged; the gh token never leaves the server.
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { agentEnv } from "./providers/local.js"
import type { LocalCheck, LocalTool, LocalToolKey } from "../shared/setup.js"

export interface LocalCheckResult {
  check: LocalCheck
  /** `gh auth token`, or "" when gh isn't signed in. Server-side only. */
  ghToken: string
}

export const LOCAL_CHECK_TIMEOUT_MS = 10_000

interface Run {
  ok: boolean
  stdout: string
}

function run(bin: string, args: string[], timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout: timeoutMs, env: { ...agentEnv(process.env), DISABLE_AUTOUPDATER: "1" }, windowsHide: true }, (err, stdout) =>
        resolve({ ok: !err, stdout: String(stdout ?? "") }),
      )
    } catch {
      resolve({ ok: false, stdout: "" })
    }
  })
}

const firstLine = (s: string) => s.trim().split("\n")[0]?.trim() || null

async function tool(key: LocalToolKey, bin: string, args: string[], timeoutMs: number): Promise<LocalTool> {
  const r = await run(bin, [...args, "--version"], timeoutMs)
  return { key, found: r.ok, version: r.ok ? firstLine(r.stdout) : null }
}

/** Chrome or Chromium, wherever this OS keeps it. */
async function chrome(timeoutMs: number): Promise<LocalTool> {
  const candidates =
    process.platform === "darwin"
      ? ["/Applications/Google Chrome.app", path.join(os.homedir(), "Applications/Google Chrome.app")].map((app) => path.join(app, "Contents/MacOS/Google Chrome"))
      : process.platform === "win32"
        ? []
        : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
  for (const bin of candidates) {
    if (path.isAbsolute(bin) && !fs.existsSync(bin)) continue
    const t = await tool("chrome", bin, [], timeoutMs)
    if (t.found) return t
  }
  return { key: "chrome", found: false, version: null }
}

/**
 * Look once. `claudeBin` is the command agents run (CLAUDE_BIN, possibly "node fake-claude.mjs"); with `fakeClaude`
 * its login isn't asked about, since a stand-in has none.
 */
export async function checkLocal(opts: { claudeBin: string; fakeClaude: boolean; timeoutMs?: number; now?: () => number }): Promise<LocalCheckResult> {
  const timeoutMs = opts.timeoutMs ?? LOCAL_CHECK_TIMEOUT_MS
  const [claudeBin, ...claudePre] = opts.claudeBin.split(" ")
  const [node, claude, gh, chromeTool, ghStatus] = await Promise.all([
    tool("node", "node", [], timeoutMs),
    tool("claude", claudeBin!, claudePre, timeoutMs),
    tool("gh", "gh", [], timeoutMs),
    chrome(timeoutMs),
    run("gh", ["auth", "status"], timeoutMs),
  ])
  let claudeLogin: boolean | null = null
  if (claude.found && !opts.fakeClaude) {
    const r = await run(claudeBin!, [...claudePre, "auth", "status"], timeoutMs)
    try {
      const loggedIn = JSON.parse(r.stdout)?.loggedIn
      if (typeof loggedIn === "boolean") claudeLogin = loggedIn
    } catch {}
  }
  const ghLogin = gh.found && ghStatus.ok
  const ghToken = ghLogin ? ((await run("gh", ["auth", "token"], timeoutMs)).stdout.trim().split("\n")[0] ?? "") : ""
  return {
    check: { tools: [node, claude, gh, chromeTool], claudeLogin, ghLogin, checkedAt: (opts.now ?? Date.now)() },
    ghToken: /^[\x21-\x7e]{8,2000}$/.test(ghToken) ? ghToken : "",
  }
}

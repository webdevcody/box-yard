import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** When this process started: a server that wasn't restarted after a merge still runs the older build. */
const STARTED_AT = Date.now()

let cached: { commit: string | null; commitDate: string | null } | null = null

/**
 * The commit this server runs, for /api/health: BOXYARD_BUILD_COMMIT when set (an image without .git), else the
 * checkout's HEAD read once, at the first call after startup (so a later `git pull` without a restart doesn't
 * change it). Null when neither is there.
 */
export function buildInfo(): { commit: string | null; commitDate: string | null; startedAt: number } {
  if (!cached) {
    const env = process.env.BOXYARD_BUILD_COMMIT?.trim()
    if (env) cached = { commit: env, commitDate: null }
    else {
      const dir = path.dirname(fileURLToPath(import.meta.url))
      try {
        const out = execFileSync("git", ["-C", dir, "log", "-1", "--format=%H %cI"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim()
        const [commit, date] = out.split(" ")
        cached = { commit: commit || null, commitDate: date || null }
      } catch {
        cached = { commit: null, commitDate: null }
      }
    }
  }
  return { ...cached, startedAt: STARTED_AT }
}

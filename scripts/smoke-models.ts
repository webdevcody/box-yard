/**
 * Smoke test every model the pickers offer against the real claude CLI: one tiny turn each (a one-line system prompt,
 * no tools, no MCP), at the highest effort level the model takes, so Settings' list matches what the CLI and the
 * account can run. Uses the CLI's own login (or CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY). About a cent per model.
 *
 *   npx tsx scripts/smoke-models.ts                  # every model in the list the pickers show (CLI's over built-in)
 *   npx tsx scripts/smoke-models.ts opus claude-x    # just these
 *   CLAUDE_BIN=/path/to/claude npx tsx scripts/smoke-models.ts
 */
import { execFile, execFileSync } from "node:child_process"
import os from "node:os"
import { probeCliModels } from "../server/claudeModels.js"
import { BUILTIN_MODELS, mergeCliModels } from "../shared/models.js"

const bin = process.env.CLAUDE_BIN || "claude"
const env: NodeJS.ProcessEnv = { ...process.env, DISABLE_AUTOUPDATER: "1" }
for (const k of Object.keys(env)) if (k === "CLAUDECODE" || /^CLAUDE_CODE_(SESSION|CHILD|ENTRYPOINT|MESSAGING)/.test(k)) delete env[k]

const version = execFileSync(bin, ["--version"], { env }).toString().trim()
const rows = await probeCliModels(bin, env).catch((e: Error) => (console.log(`! The CLI didn't list its models (${e.message}); using the built-in list.`), []))
const models = mergeCliModels(BUILTIN_MODELS, rows)
const wanted = process.argv.slice(2)
const list = wanted.length ? wanted.map((id) => models.find((m) => m.id === id) ?? { id, label: id, efforts: [] as string[] }) : models
console.log(`claude ${version}: ${list.length} models\n`)

type Result = { result?: string; is_error?: boolean; modelUsage?: Record<string, unknown> }
function turn(model: string, effort: string | undefined): Promise<{ ok: boolean; text: string; ran: string }> {
  const args = ["-p", "--system-prompt", "Reply with the single word OK.", "--tools", "", "--strict-mcp-config", "--output-format", "json", "--model", model]
  if (effort) args.push("--effort", effort)
  args.push("hi")
  return new Promise((resolve) => {
    execFile(bin, args, { env, cwd: os.tmpdir(), timeout: 120_000 }, (err, stdout, stderr) => {
      let r: Result | null = null
      try {
        r = JSON.parse(stdout) as Result
      } catch {}
      const text = (r?.result ?? stderr ?? err?.message ?? "").trim().replace(/\s+/g, " ").slice(0, 160)
      resolve({ ok: Boolean(r && !r.is_error), text, ran: Object.keys(r?.modelUsage ?? {}).join(", ") })
    })
  })
}

const results: { id: string; ok: boolean }[] = []
for (const m of list) {
  const effort = m.efforts.at(-1)
  const t = Date.now()
  const r = await turn(m.id, effort)
  results.push({ id: m.id, ok: r.ok })
  console.log(`${r.ok ? "✓" : "✗"} ${m.id.padEnd(24)} ${(effort ?? "no effort").padEnd(9)} ${String(Date.now() - t).padStart(6)} ms  ${r.ok ? `ran on ${r.ran || "?"}` : r.text}`)
  if (!r.ok && /not logged in|\/login/i.test(r.text)) {
    console.log("\nThe CLI isn't signed in here: run `claude` and /login, or set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.")
    process.exit(2)
  }
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} ran${failed.length ? `; failed: ${failed.map((r) => r.id).join(", ")}` : ""}`)
process.exit(failed.length ? 1 : 0)

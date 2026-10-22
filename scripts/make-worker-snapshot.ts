/**
 * Make a worker snapshot with Claude Code and git already installed, so new
 * worker boxes start in seconds. Prints WORKER_SNAPSHOT_ID for your .env.
 *
 *   npm run worker-snapshot
 */
import { Box } from "@upstash/box"
import { config } from "../server/config.js"
import { workerSetupScript } from "../server/providers/upstash.js"

if (!config.upstashBoxApiKey) {
  console.error("Set UPSTASH_BOX_API_KEY in .env first.")
  process.exit(1)
}

const box = await Box.create({ apiKey: config.upstashBoxApiKey, runtime: "node", size: config.workerSize, labels: ["box-yard-snap"] })
try {
  console.log(`Preparing ${box.id}…`)
  const run = await box.exec.command(`bash -c ${JSON.stringify(workerSetupScript(config))}`)
  if (run.exitCode !== 0) throw new Error(run.stderr || run.result)
  console.log(run.stdout.trim())
  const snap = await box.snapshot({ name: `box-yard-worker-${Date.now()}` })
  console.log(`\nAdd this to .env:\nWORKER_SNAPSHOT_ID=${snap.id}\n`)
} finally {
  await box.delete().catch(() => {})
}

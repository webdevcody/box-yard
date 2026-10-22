/**
 * Deploy Box Yard into its own Upstash Box, so it keeps running (and keeps
 * your agents going) while your laptop is closed.
 *
 *   npm run deploy:box                       # create or update the box, print its URL
 *   npm run deploy:box -- --logs             # tail the server log
 *   npm run deploy:box -- --restart          # restart the server without redeploying
 *   npm run deploy:box -- --from-snapshot ID # rebuild the box from a snapshot
 *   npm run deploy:box -- --destroy          # delete the orchestrator box (workers stay)
 *
 * Where the SQLite data lives: on the box's own disk
 * (/workspace/home/box-yard-data), which survives pauses and redeploys. The
 * server also snapshots its box every few hours (BOXYARD_SELF_SNAPSHOT_HOURS),
 * which is the copy you restore from with --from-snapshot if the box is lost.
 */
import { Box } from "@upstash/box"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { config } from "../server/config.js"

const NAME = process.env.BOXYARD_BOX_NAME ?? "box-yard-orchestrator"
const HOME = "/workspace/home"
const APP = `${HOME}/box-yard`
const DATA = `${HOME}/box-yard-data`
const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? "") : undefined
}

const log = (msg: string) => console.log(`\x1b[33m▸\x1b[0m ${msg}`)
const die = (msg: string): never => {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}

if (!config.upstashBoxApiKey) die("Set UPSTASH_BOX_API_KEY in .env first.")
const apiKey = config.upstashBoxApiKey

async function sh(box: Box, cmd: string, label: string) {
  const run = await box.exec.command(`bash -c ${JSON.stringify(cmd)}`)
  if ((run.exitCode ?? (run.status === "completed" ? 0 : 1)) !== 0) {
    die(`${label} failed:\n${(run.stderr || run.stdout || run.result).slice(-3000)}`)
  }
  return run.stdout || run.result
}

async function findBox(): Promise<Box | null> {
  const boxes = await Box.list({ apiKey })
  const hit = boxes.find((b) => b.name === NAME && b.status !== "deleted")
  return hit ? Box.get(hit.id, { apiKey }) : null
}

/** Pack tracked + new (not ignored) files, like `git archive` but with local edits. */
function packApp(): string {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && fs.existsSync(f) && !f.startsWith("data/") && f !== ".env")
  const out = path.join(os.tmpdir(), `box-yard-${Date.now()}.tgz`)
  const list = path.join(os.tmpdir(), `box-yard-files-${Date.now()}.txt`)
  fs.writeFileSync(list, files.join("\n"))
  execFileSync("tar", ["czf", out, "-T", list])
  fs.rmSync(list)
  return out
}

function envFile(boxId: string, password: string, publicUrl: string, keepAlive: boolean) {
  const keep = [
    "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "UPSTASH_BOX_API_KEY", "WORKER_SNAPSHOT_ID", "WORKER_RUNTIME", "WORKER_SIZE",
    "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "GITHUB_TOKEN", "GIT_USER_NAME", "GIT_USER_EMAIL",
    "BOX_POOL_MAX", "BOX_SLOTS", "BOX_MAX_RESIDENT", "BOX_IDLE_DELETE_MINUTES", "ORCHESTRATOR_MODEL", "WORKER_MODEL",
    "BOXYARD_SELF_SNAPSHOT_HOURS", "BOXYARD_ARCHIVE", "BOXYARD_ARCHIVE_MAX_MB", "BOXYARD_ORCHESTRATOR_AUTOWAKE",
    "BOXYARD_TIMEZONE", "QSTASH_TOKEN", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY",
  ]
  const lines = keep.filter((k) => process.env[k]).map((k) => `${k}=${JSON.stringify(process.env[k])}`)
  lines.push(
    `BOX_PROVIDER=upstash`,
    `PORT=3000`,
    `BOXYARD_DATA_DIR=${DATA}`,
    `BOXYARD_PASSWORD=${JSON.stringify(password)}`,
    `BOXYARD_SELF_BOX_ID=${boxId}`,
    `BOXYARD_PUBLIC_URL=${process.env.BOXYARD_PUBLIC_URL || publicUrl}`,
    // Without keep-alive the box would pause mid-work; the server holds it awake while busy.
    `BOXYARD_SELF_HOLD=${keepAlive ? "0" : "1"}`,
  )
  // Schedules should fire in Cody's time zone, not the box's (UTC).
  if (!process.env.BOXYARD_TIMEZONE) lines.push(`BOXYARD_TIMEZONE=${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
  return lines.join("\n") + "\n"
}

/** Wait until the server we just started (not an old one) answers. */
async function waitHealthy(box: Box) {
  for (let i = 0; i < 40; i++) {
    const out = await box.exec.command(`bash -c "echo pid=\$(cat ${HOME}/box-yard.pid 2>/dev/null); curl -fs http://localhost:3000/healthz || true"`)
    const text = out.stdout || out.result
    const pid = /pid=(\d+)/.exec(text)?.[1]
    if (pid && text.includes(`"pid":${pid}`)) return
    await new Promise((r) => setTimeout(r, 1500))
  }
  const tail = await box.exec.command(`tail -n 40 ${HOME}/box-yard.log`)
  die(`Box Yard did not come up. Last log lines:\n${tail.stdout || tail.result}`)
}

async function main() {
  if (args.includes("--logs")) {
    const box = (await findBox()) ?? die(`No box named ${NAME}.`)
    const run = await box.exec.stream(`tail -n 200 -f ${HOME}/box-yard.log`)
    for await (const chunk of run) if (chunk.type === "output") process.stdout.write(chunk.data)
    return
  }
  if (args.includes("--restart")) {
    const box = (await findBox()) ?? die(`No box named ${NAME}.`)
    await box.resume().catch(() => {})
    await sh(box, `bash ${APP}/scripts/box-start.sh`, "restart")
    await waitHealthy(box)
    log(`Restarted Box Yard on ${box.id}.`)
    return
  }
  if (args.includes("--destroy")) {
    const box = (await findBox()) ?? die(`No box named ${NAME}.`)
    await box.delete()
    log(`Deleted ${box.id}. Worker boxes were left alone; delete them in the Upstash console if you want.`)
    return
  }

  const snapshot = flag("--from-snapshot")
  let box = snapshot === undefined ? await findBox() : null
  // Keep the password a redeploy found on the box, unless .env sets one.
  const existingPassword = box
    ? await box.files
        .read(`${APP}/.env`)
        .then((env) => /^BOXYARD_PASSWORD=(.*)$/m.exec(env)?.[1]?.replace(/^"|"$/g, "") ?? "")
        .catch(() => "")
    : ""
  const password = config.password || existingPassword || randomBytes(9).toString("base64url")
  const initCommand = `bash ${APP}/scripts/box-start.sh`

  if (!box) {
    if (snapshot) {
      log(`Restoring ${NAME} from snapshot ${snapshot}…`)
      box = await Box.fromSnapshot(snapshot, { apiKey, name: NAME, runtime: "node", size: "small", keepAlive: true, initCommand })
    } else {
      log(`Creating box ${NAME} (keep-alive, so agents keep running while you're away)…`)
      try {
        box = await Box.create({ apiKey, name: NAME, runtime: "node", size: "small", keepAlive: true, labels: ["box-yard"] })
      } catch (err) {
        if (!/keep-alive|paid plan/i.test(String((err as Error).message))) throw err
        // Free plan: a normal box. It stays awake while work is in flight and
        // pauses when idle; opening its URL wakes it again.
        log("Keep-alive needs a paid plan, so using a normal box that pauses when idle and wakes on its URL…")
        box = await Box.create({ apiKey, name: NAME, runtime: "node", size: "small", labels: ["box-yard"] })
      }
    }
  } else {
    log(`Updating existing box ${box.id}…`)
    await box.resume().catch(() => {})
  }

  log("Packing the app…")
  const tgz = packApp()
  await box.files.upload([{ path: tgz, destination: `${HOME}/box-yard.tgz` }])
  fs.rmSync(tgz)

  log("Unpacking (data in box-yard-data is never touched)…")
  await sh(
    box,
    `set -e; cd ${HOME}; rm -rf box-yard.new; mkdir -p box-yard.new ${DATA}; tar xzf box-yard.tgz -C box-yard.new; ` +
      `if [ -d box-yard/node_modules ]; then mv box-yard/node_modules box-yard.new/; fi; ` +
      `rm -rf box-yard.old; [ -d box-yard ] && mv box-yard box-yard.old; mv box-yard.new box-yard; rm -rf box-yard.old box-yard.tgz`,
    "unpack",
  )
  const publicUrl = (await box.getPublicURL(3000)).url
  await box.files.write({ path: `${APP}/.env`, content: envFile(box.id, password, publicUrl, box.keepAlive) })

  log("Installing dependencies, Claude Code and building (a few minutes the first time)…")
  await sh(
    box,
    `set -e; cd ${APP}; command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git curl >/dev/null); ` +
      `command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code --no-audit --no-fund >/dev/null 2>&1; ` +
      `npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null; npm run build >/dev/null; claude --version`,
    "build",
  )

  log("Starting Box Yard (and restarting it on every resume)…")
  await box.setInitCommand(initCommand)
  await sh(box, initCommand, "start")
  await waitHealthy(box)

  console.log(`
\x1b[32m✓ Box Yard is live\x1b[0m
  URL:       ${publicUrl}
  Password:  ${password}${config.password ? " (from your .env)" : existingPassword ? " (kept from the last deploy)" : "  ← generated; it's kept on redeploys"}
  Box:       ${box.id}
  Data:      ${DATA} on the box disk, plus automatic box snapshots

Close your laptop: the yard keeps running. Logs: npm run deploy:box -- --logs
`)
}

main().catch((err) => die(err?.stack ?? String(err)))

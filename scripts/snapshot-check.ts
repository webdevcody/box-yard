/**
 * Check project snapshots against real Upstash Box, with Box Yard's own provider code (server/providers/upstash.ts)
 * and strip script (server/boxSnapshot.ts):
 *
 *   1. create one throwaway box and put a marker file on it, plus a fake workspace and a fake login
 *   2. snapshot it
 *   3. create a box from the snapshot and check the marker is there
 *   4. strip that copy the way a project snapshot's scratch box is stripped: the workspace and the login go, the
 *      marker (like a toolchain or cache in $HOME) stays
 *   5. delete both boxes and the snapshot
 *
 * It only ever touches the two boxes and the one snapshot it made itself (by the ids it got back), never an existing
 * box or snapshot, and step 5 runs even when a check fails. Costs a few minutes of two small boxes.
 *
 *   npx tsx scripts/snapshot-check.ts                         # small box, restored as small
 *   npx tsx scripts/snapshot-check.ts --restore-size medium   # restore onto a bigger box, as a medium project would
 *
 * The API key comes from UPSTASH_BOX_API_KEY, or else from Settings › Credentials in Box Yard's database (read-only).
 */
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import Database from "better-sqlite3"
import { config } from "../server/config.js"
import { UpstashProvider } from "../server/providers/upstash.js"
import { q } from "../server/providers/types.js"
import { SCRATCH_MARKER, stripCounts, stripScript } from "../server/boxSnapshot.js"
import { BOX_SIZE_ORDER } from "../shared/boxSizes.js"
import type { BoxSize } from "../shared/types.js"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const restoreSize = (arg("--restore-size") ?? "small") as BoxSize
if (!BOX_SIZE_ORDER.includes(restoreSize)) {
  console.error(`--restore-size must be one of ${BOX_SIZE_ORDER.join(", ")}`)
  process.exit(1)
}

/** Settings › Credentials, read without opening (or migrating) Box Yard's database for writing. */
function savedKey(): string {
  const file = path.join(config.dataDir, "box-yard.sqlite")
  if (!fs.existsSync(file)) return ""
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'credentials'").get() as { value: string } | undefined
    const key = row ? (JSON.parse(row.value) as { upstashBoxApiKey?: unknown }).upstashBoxApiKey : undefined
    return typeof key === "string" ? key : ""
  } catch {
    return ""
  } finally {
    db.close()
  }
}

const apiKey = config.upstashBoxApiKey || savedKey()
if (!apiKey) {
  console.error("No Upstash Box API key: set UPSTASH_BOX_API_KEY, or save one in Box Yard's Settings › Credentials.")
  process.exit(1)
}

const provider = new UpstashProvider({ ...config, upstashBoxApiKey: apiKey, workerSize: "small" })
const run = randomUUID().slice(0, 8)
const label = `snapcheck-${run}`
const token = `box-yard-snapshot-check ${run}`
const root = provider.root()
const madeBoxes: string[] = []
const madeSnapshots: string[] = []
const failures: string[] = []

const step = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = Date.now()
  process.stdout.write(`${what}… `)
  try {
    const out = await fn()
    console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    return out
  } catch (err) {
    console.log("FAILED")
    throw err
  }
}
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${what}`)
  if (!ok) failures.push(what)
}
const sh = async (boxId: string, command: string) => {
  const res = await provider.exec(boxId, command)
  if (res.exitCode !== 0) throw new Error(`exit ${res.exitCode}: ${(res.stderr || res.stdout).trim().slice(-500)}`)
  return res.stdout
}

try {
  const a = await step("Creating a throwaway small box", async () => {
    const id = await provider.create({ labels: ["box-yard", label], size: "small" })
    madeBoxes.push(id)
    return id
  })
  console.log(`  box ${a}`)
  await step("Writing the marker, a fake workspace and a fake login", () =>
    sh(
      a,
      [
        `mkdir -p "$HOME/.cache/box-yard-snapcheck" ${q(`${root}/tasks/task_snapcheck/work`)}`,
        `printf '%s' ${q(token)} > "$HOME/.cache/box-yard-snapcheck/marker"`,
        `printf '%s' ${q(token)} > ${q(`${root}/tasks/task_snapcheck/work/uncommitted.txt`)}`,
        `printf 'machine example.invalid login snapcheck password not-a-secret\\n' > "$HOME/.netrc.snapcheck"`,
      ].join(" && "),
    ),
  )

  const snap = await step("Snapshotting it", async () => {
    const info = await provider.snapshot(a, `boxyard-${label}`)
    madeSnapshots.push(info.id)
    return info
  })
  console.log(`  snapshot ${snap.id}${snap.bytes ? ` (${(snap.bytes / 1024 / 1024).toFixed(0)} MB)` : ""}`)

  const b = await step(`Creating a ${restoreSize} box from the snapshot`, async () => {
    const id = await provider.create({ labels: ["box-yard", label], size: restoreSize, snapshotId: snap.id })
    madeBoxes.push(id)
    return id
  })
  console.log(`  box ${b}`)
  const marker = await sh(b, `cat "$HOME/.cache/box-yard-snapcheck/marker" 2>/dev/null || true`)
  check(marker === token, "the marker file is on the restored box")
  const work = await sh(b, `cat ${q(`${root}/tasks/task_snapcheck/work/uncommitted.txt`)} 2>/dev/null || true`)
  check(work === token, "the fake workspace came along too (before stripping)")
  const usage = await provider.usage?.(b).catch(() => null)
  if (usage?.size) check(usage.size === restoreSize, `the restored box is ${restoreSize} (Upstash says ${usage.size})`)

  // The strip a project snapshot's scratch box gets, on this throwaway copy (never on the first box, and never on
  // this computer: it runs on box b). The fake login goes in as ~/.netrc, a file the strip removes.
  await step("Stripping the restored copy like a scratch box", async () => {
    const jobId = `snp_check_${run}`
    await sh(b, `cp "$HOME/.netrc.snapcheck" "$HOME/.netrc" && mkdir -p ${q(`${root}/.boxyard`)} && printf '%s' ${q(jobId)} > ${q(`${root}/${SCRATCH_MARKER}`)}`)
    const out = await sh(b, stripScript({ root, tasks: `${root}/tasks`, home: "$HOME", tmp: "/tmp", keepMirror: null, jobId }))
    console.log(`\n  ${JSON.stringify(stripCounts(out))}`)
  })
  const after = await sh(
    b,
    `for f in ${q(`${root}/tasks/task_snapcheck`)} "$HOME/.netrc" "$HOME/.cache/box-yard-snapcheck/marker" ${q(`${root}/${SCRATCH_MARKER}`)}; do [ -e "$f" ] && echo "present $f" || echo "absent $f"; done`,
  )
  check(after.includes(`absent ${root}/tasks/task_snapcheck`), "the strip removed the workspace")
  check(/absent .*\/\.netrc\n/.test(after), "the strip removed ~/.netrc")
  check(/present .*\/\.cache\/box-yard-snapcheck\/marker/.test(after), "the strip kept ~/.cache (toolchains, browsers)")
  check(after.includes(`absent ${root}/${SCRATCH_MARKER}`), "the strip removed its scratch marker")
  const refused = await provider.exec(b, stripScript({ root, tasks: `${root}/tasks`, home: "$HOME", tmp: "/tmp", keepMirror: null, jobId: "snp_other" }))
  check(refused.exitCode === 3, "the strip refuses a box without its scratch marker")
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err))
  console.error(`\n${err instanceof Error ? err.message : String(err)}`)
} finally {
  // Only what this run made, by id.
  for (const id of madeBoxes) {
    await provider.destroy(id).then(
      () => console.log(`Deleted box ${id}`),
      (err: unknown) => console.error(`Couldn't delete box ${id}: ${String(err)} (delete it in the Upstash console; it's labeled ${label})`),
    )
  }
  for (const id of madeSnapshots) {
    await provider.deleteSnapshot(id).then(
      () => console.log(`Deleted snapshot ${id}`),
      (err: unknown) => console.error(`Couldn't delete snapshot ${id}: ${String(err)} (delete it in the Upstash console)`),
    )
  }
}

console.log(failures.length ? `\n${failures.length} check(s) failed.` : "\nAll checks passed.")
process.exit(failures.length ? 1 : 0)

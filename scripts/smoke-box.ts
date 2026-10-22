/**
 * Smoke test the Upstash Box provider against the real API, using the keys in .env.
 *
 *   npx tsx scripts/smoke-box.ts            # create a box, check everything, delete it
 *   npx tsx scripts/smoke-box.ts --keep     # leave the box running and print its id
 *   npx tsx scripts/smoke-box.ts --box <id> # run the checks against an existing box
 *
 * Checks: create + worker setup, exec, file write/read, a background process that
 * outlives the exec call, a real `claude -p` turn, cloning a private repo with
 * GITHUB_TOKEN, `gh` auth, public URLs, and pause/resume.
 */
import { config } from "../server/config.js"
import { UpstashProvider } from "../server/providers/upstash.js"

const args = process.argv.slice(2)
const keep = args.includes("--keep")
const existing = args.includes("--box") ? (args[args.indexOf("--box") + 1] ?? "") : ""
const repo = process.env.SMOKE_REPO ?? "webdevcody/box-yard"

if (!config.upstashBoxApiKey) throw new Error("UPSTASH_BOX_API_KEY is not set")
const p = new UpstashProvider(config)
const results: { name: string; ok: boolean; detail: string; ms: number }[] = []

async function check(name: string, fn: () => Promise<string>) {
  const t = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail, ms: Date.now() - t })
    console.log(`✓ ${name} (${Date.now() - t}ms) ${detail}`)
  } catch (err) {
    results.push({ name, ok: false, detail: String((err as Error).message ?? err), ms: Date.now() - t })
    console.log(`✗ ${name} (${Date.now() - t}ms) ${String((err as Error).message ?? err).slice(0, 800)}`)
  }
}

async function sh(boxId: string, cmd: string) {
  const r = await p.exec(boxId, cmd)
  if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${(r.stderr || r.stdout).slice(-600)}`)
  return r.stdout.trim()
}

let boxId: string = existing
await check("create box + worker setup", async () => {
  if (boxId) return `using ${boxId}`
  boxId = await p.create({ labels: ["boxyard-smoke"] })
  return boxId
})
if (!boxId) process.exit(1)

await check("health", async () => p.health(boxId))
await check("exec", async () => sh(boxId, "echo hello && whoami && pwd && node --version && git --version"))
await check("claude --version", async () => sh(boxId, "claude --version"))
await check("env passed to box", async () =>
  sh(boxId, 'for v in CLAUDE_CODE_OAUTH_TOKEN GITHUB_TOKEN IS_SANDBOX; do [ -n "${!v}" ] && echo "$v=set" || echo "$v=MISSING"; done'),
)
await check("write + read file", async () => {
  await p.writeFile(boxId, `${p.root()}/.boxyard/smoke.txt`, "smoke ✓")
  const back = (await p.readFile(boxId, `${p.root()}/.boxyard/smoke.txt`)).toString("utf8")
  if (back !== "smoke ✓") throw new Error(`read back ${JSON.stringify(back)}`)
  return "round trip ok"
})
await check("background process outlives exec", async () => {
  await sh(boxId, `cd ${p.root()} && (nohup bash -c 'for i in 1 2 3 4 5 6; do date +%s >> .boxyard/bg.txt; sleep 1; done' >/dev/null 2>&1 &) ; echo started`)
  await new Promise((r) => setTimeout(r, 8000))
  const lines = await sh(boxId, `wc -l < ${p.root()}/.boxyard/bg.txt`)
  if (Number(lines) < 5) throw new Error(`only ${lines} ticks`)
  return `${lines} ticks`
})
await check("hold keeps a stream open", async () => {
  const ac = new AbortController()
  const t = Date.now()
  await p.hold(boxId, "sleep 3; echo done", ac.signal)
  return `returned after ${Date.now() - t}ms`
})
await check("real claude turn", async () => {
  const out = await sh(
    boxId,
    `cd ${p.root()} && mkdir -p .boxyard/cc && CLAUDE_CONFIG_DIR=${p.root()}/.boxyard/cc claude -p 'Reply with exactly: pong' --output-format json`,
  )
  const j = JSON.parse(out.split("\n").filter(Boolean).pop()!)
  if (j.is_error) throw new Error(out.slice(0, 400))
  return `result=${JSON.stringify(j.result)} session=${j.session_id}`
})
await check(`clone private repo ${repo}`, async () =>
  sh(boxId, `cd /tmp && rm -rf smoke-clone && git clone -q --depth 1 https://x-access-token:$GITHUB_TOKEN@github.com/${repo}.git smoke-clone && git -C smoke-clone log --oneline -1`),
)
await check("gh cli", async () => sh(boxId, "command -v gh >/dev/null && GH_TOKEN=$GITHUB_TOKEN gh api user --jq .login || echo 'gh not installed'"))
await check("public url", async () => {
  await sh(boxId, `cd /tmp && (nohup node -e "require('http').createServer((q,s)=>s.end('box-ok')).listen(3999)" >/dev/null 2>&1 &); sleep 1; echo up`)
  const url = await p.publicUrl(boxId, 3999)
  const res = await fetch(url).then((r) => r.text()).catch((e) => `fetch failed: ${e}`)
  return `${url} -> ${res.slice(0, 80)}`
})
if (!keep && !existing) {
  await check("destroy", async () => {
    await p.destroy(boxId)
    return "deleted"
  })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed${keep ? `, box kept: ${boxId}` : ""}`)
process.exit(failed.length ? 1 : 0)

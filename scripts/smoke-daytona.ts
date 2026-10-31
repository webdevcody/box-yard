/**
 * Smoke test the Daytona provider against the real API, using DAYTONA_API_KEY from the env or .env.
 * Spends money: one GPU sandbox (about $2/hr at most) for about ten minutes, deleted at the end (its disk goes with it).
 * Only run it with Cody's OK.
 *
 *   npx tsx scripts/smoke-daytona.ts           # start a GPU sandbox, check everything, delete it
 *   npx tsx scripts/smoke-daytona.ts --cpu     # a CPU-only sandbox instead (about $0.33/hr), GPU checks skipped
 *   npx tsx scripts/smoke-daytona.ts --keep    # leave the sandbox up and print its id
 *   SMOKE_IMAGE=docker.io/you/boxyard-gpu:bx-… npx tsx scripts/smoke-daytona.ts   # try your built image
 *
 * Checks: the key lists sandboxes, a sandbox of the defaults of Settings › Daytona starts (tools built into its image,
 * else installed after), commands run as root (else with passwordless sudo), nvidia-smi, the tools, WebGL in headless
 * Chrome on the NVIDIA GPU, file write/read, a 64 MB upload, streamed output, a command longer than two minutes, a
 * detached process outliving the command that started it, a server reachable on the port's signed preview URL, and
 * the auto-stop (dead-man switch) Box Yard set. Sandboxes are labelled boxyard-install=smoketest, apart from any Box
 * Yard's own.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { config } from "../server/config.js"
import { DaytonaApi } from "../server/daytona/api.js"
import { daytonaDir } from "../server/daytona/service.js"
import { runpodDir } from "../server/runpod/image.js"
import { DaytonaProvider } from "../server/providers/daytona.js"
import { POD_HTTP_PORTS } from "../server/providers/runpod.js"
import { gpuBoxIdOn } from "../shared/gpu.js"
import { RUNPOD_STOCK_IMAGE } from "../shared/runpod.js"
import { DAYTONA_CPU, DAYTONA_CPU_IMAGE, DEFAULT_DAYTONA_SETTINGS } from "../shared/daytona.js"

const keep = process.argv.includes("--keep")
const cpu = process.argv.includes("--cpu")
const box = gpuBoxIdOn("daytona", "smoke")
if (!config.daytonaApiKey) throw new Error("DAYTONA_API_KEY is not set")
const api = new DaytonaApi(() => config.daytonaApiKey)
const settings = {
  ...DEFAULT_DAYTONA_SETTINGS,
  ...(cpu ? { gpuTypes: [DAYTONA_CPU], cpuImage: process.env.SMOKE_IMAGE || DAYTONA_CPU_IMAGE } : {}),
  maxHourlyUsd: 2.5,
  totalMaxHourlyUsd: 2.5,
  watchdogMinutes: 20,
}
const p = new DaytonaProvider({
  api,
  settings: () => settings,
  image: () => process.env.SMOKE_IMAGE || RUNPOD_STOCK_IMAGE,
  install: () => "smoketest",
  bootstrapDir: runpodDir(),
  scriptsDir: daytonaDir(),
  onEvent: (e) => console.log(`  · ${e.kind}: ${e.detail}`),
  onProgress: (_box, m) => console.log(`  · ${m}`),
})
const results: { name: string; ok: boolean }[] = []

async function check(name: string, fn: () => Promise<string>) {
  const t = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true })
    console.log(`✓ ${name} (${Date.now() - t}ms) ${detail}`)
  } catch (err) {
    results.push({ name, ok: false })
    console.log(`✗ ${name} (${Date.now() - t}ms) ${String((err as Error).message ?? err).slice(0, 800)}`)
  }
}

async function sh(cmd: string) {
  const r = await p.exec(box, cmd)
  if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${(r.stderr || r.stdout).slice(-600)}`)
  return r.stdout.trim()
}

// A page that prints its WebGL renderer; Chrome dumps the DOM once it has run. "GL"+"=" keeps the marker out of
// the script's own text, which the dump holds too.
const GL_PAGE = `<script>const c=document.createElement("canvas").getContext("webgl2"),d=c&&c.getExtension("WEBGL_debug_renderer_info");document.write("GL"+"="+(d?c.getParameter(d.UNMASKED_RENDERER_WEBGL):"none"))</script>`

try {
  await check("key", async () => `lists sandboxes (${(await api.listSandboxes({ "boxyard-install": "smoketest" })).length} left from earlier smoke runs)`)
  await check("sandbox starts", async () => {
    await p.wake(box)
    const pod = p.cached(box)
    return `sandbox ${pod?.id}: ${pod?.gpu?.id} at about $${pod?.cost}/hr`
  })
  await check("runs as root", async () => {
    const who = await sh("id -un")
    if (who === "root") return "root"
    await sh("sudo -n true")
    return `${who}, with passwordless sudo (Daytona didn't honour user: root)`
  })
  if (!cpu) await check("GPU", () => sh("nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader"))
  await check("tools", () => sh("node --version && git --version && gh --version | head -1 && claude --version && google-chrome --version"))
  if (!cpu) {
    await check("WebGL on the GPU", async () => {
      await p.writeFile(box, "/box/smoke/gl.html", GL_PAGE)
      const out = await sh(
        "google-chrome --headless=new --no-sandbox --use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --enable-gpu --virtual-time-budget=5000 --dump-dom file:///box/smoke/gl.html 2>/dev/null",
      )
      const renderer = /GL=([^<]*)/.exec(out)?.[1] ?? out.slice(0, 200)
      if (!/nvidia/i.test(renderer)) throw new Error(`WebGL isn't on the NVIDIA GPU: ${renderer}`)
      return renderer
    })
  }
  await check("file write/read", async () => {
    await p.writeFile(box, "/box/smoke/x.txt", "hello")
    const back = (await p.readFile(box, "/box/smoke/x.txt")).toString("utf8")
    if (back !== "hello") throw new Error(`read back ${JSON.stringify(back)}`)
    return "ok"
  })
  await check("64 MB upload", async () => {
    // Workspace archives go up this way: a size limit in the toolbox would show here.
    const local = path.join(os.tmpdir(), `box-yard-daytona-smoke-${process.pid}.bin`)
    const data = randomBytes(64 * 1024 * 1024)
    fs.writeFileSync(local, data)
    try {
      await p.uploadFile(box, local, "/box/smoke/big.bin")
    } finally {
      fs.rmSync(local, { force: true })
    }
    const want = createHash("sha256").update(data).digest("hex")
    const got = (await sh("sha256sum /box/smoke/big.bin")).split(/\s/)[0]
    if (got !== want) throw new Error(`sha256 ${got}, expected ${want}`)
    return "sha256 matches"
  })
  await check("streamed output", async () => {
    let out = ""
    const r = await p.execStream(box, "seq 1 200000; echo oops >&2", (chunk) => (out += chunk))
    const lines = out.trim().split("\n")
    if (r.exitCode !== 0 || lines.length !== 200001 || lines.at(-1) !== "oops") throw new Error(`exit ${r.exitCode}, ${lines.length} lines, last ${JSON.stringify(lines.at(-1))}`)
    return `${out.length} bytes`
  })
  await check("command longer than two minutes", async () => {
    // A turn's hold and long installs keep one toolbox call open for minutes: a proxy that cuts idle calls shows here.
    const out = await sh("sleep 130 && echo done")
    if (out !== "done") throw new Error(`printed ${JSON.stringify(out)}`)
    return "done"
  })
  await check("detached process survives", async () => {
    await sh("(setsid nohup sleep 600 > /dev/null 2>&1 &) && echo started")
    await new Promise((r) => setTimeout(r, 3000))
    return `pid ${await sh("pgrep -x sleep | head -1")}`
  })
  await check("signed preview URL", async () => {
    const port = POD_HTTP_PORTS[0]!
    await sh(`cd /box/smoke && (nohup python3 -m http.server ${port} --bind 0.0.0.0 > http.log 2>&1 &) && sleep 1`)
    const url = await p.publicUrl(box, port)
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${url}/x.txt`).catch(() => null)
      if (res?.ok && (await res.text()) === "hello") return url
      await new Promise((r) => setTimeout(r, 3000))
    }
    throw new Error(`${url} never served the file`)
  })
  await check("auto-stop set", async () => {
    const id = p.cached(box)?.id
    const sb = id ? await api.getSandbox(id) : null
    if (sb?.autoStopInterval !== settings.watchdogMinutes) throw new Error(`autoStopInterval ${sb?.autoStopInterval}, expected ${settings.watchdogMinutes}`)
    return `${sb.autoStopInterval} min, ephemeral: ${sb.state}`
  })
} finally {
  if (keep) console.log(`\nKept the sandbox: ${p.cached(box)?.id}. Daytona deletes it ${settings.watchdogMinutes} minutes after the last contact, or delete it at app.daytona.io › Sandboxes.`)
  else {
    await p.destroy(box).catch((e) => console.log(`✗ delete: ${(e as Error).message}. Delete it at app.daytona.io › Sandboxes.`))
    // Any other smoke sandbox (a start that failed half way) goes too.
    for (const left of await api.listSandboxes({ "boxyard-install": "smoketest" }).catch(() => [])) {
      await api.deleteSandbox(left.id).catch((e) => console.log(`✗ delete ${left.id}: ${(e as Error).message}`))
    }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

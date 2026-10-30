/**
 * Smoke test the Vast.ai GPU provider against the real API, using VAST_API_KEY from the env or .env.
 * Costs a few cents: one instance for about five minutes, destroyed at the end (its disk goes with it).
 *
 *   npx tsx scripts/smoke-vast.ts           # rent an instance, check everything, destroy it
 *   npx tsx scripts/smoke-vast.ts --keep    # leave the instance up and print its id
 *   SMOKE_IMAGE=docker.io/you/boxyard-gpu:bx-… npx tsx scripts/smoke-vast.ts   # try your built image
 *
 * Checks: an instance of the first GPU type with an offer (the defaults of Settings › Vast.ai GPU, at most $0.60/hr),
 * SSH and the tools, nvidia-smi, WebGL in headless Chrome on the NVIDIA GPU, file write/read, and a server reachable
 * on the instance's published port. Instances are labelled boxyard-smoketest-…, apart from any Box Yard's own.
 */
import path from "node:path"
import os from "node:os"
import { config } from "../server/config.js"
import { VastApi } from "../server/vast/api.js"
import { vastDir } from "../server/vast/service.js"
import { SshPool } from "../server/runpod/ssh.js"
import { runpodDir } from "../server/runpod/image.js"
import { VastProvider } from "../server/providers/vast.js"
import { POD_HTTP_PORTS } from "../server/providers/runpod.js"
import { gpuBoxIdOn } from "../shared/gpu.js"
import { RUNPOD_STOCK_IMAGE } from "../shared/runpod.js"
import { DEFAULT_VAST_SETTINGS } from "../shared/vast.js"

const keep = process.argv.includes("--keep")
const box = gpuBoxIdOn("vast", "smoke")
if (!config.vastApiKey) throw new Error("VAST_API_KEY is not set")
const api = new VastApi(() => config.vastApiKey)
const p = new VastProvider({
  api,
  ssh: new SshPool(path.join(os.tmpdir(), "box-yard-vast-smoke")),
  settings: () => ({ ...DEFAULT_VAST_SETTINGS, maxHourlyUsd: 0.6, totalMaxHourlyUsd: 0.6, watchdogMinutes: 20 }),
  image: () => process.env.SMOKE_IMAGE || RUNPOD_STOCK_IMAGE,
  install: () => "smoketest",
  bootstrapDir: runpodDir(),
  scriptsDir: vastDir(),
  git: { name: "Box Yard", email: "boxyard@example.com" },
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
  await check("credit", async () => `$${(await api.balance())?.toFixed(2) ?? "?"}`)
  await check("instance starts", async () => {
    await p.wake(box)
    const pod = p.cached(box)
    return `instance ${pod?.id}: ${pod?.gpu?.id} in ${pod?.dataCenterId} at $${pod?.cost}/hr`
  })
  await check("GPU", () => sh("nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader"))
  await check("tools", () => sh("node --version && git --version && gh --version | head -1 && claude --version && google-chrome --version"))
  await check("WebGL on the GPU", async () => {
    await p.writeFile(box, "/box/smoke/gl.html", GL_PAGE)
    const out = await sh(
      "google-chrome --headless=new --no-sandbox --use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --enable-gpu --virtual-time-budget=5000 --dump-dom file:///box/smoke/gl.html 2>/dev/null",
    )
    const renderer = /GL=([^<]*)/.exec(out)?.[1] ?? out.slice(0, 200)
    if (!/nvidia/i.test(renderer)) throw new Error(`WebGL isn't on the NVIDIA GPU: ${renderer}`)
    return renderer
  })
  await check("file write/read", async () => {
    await p.writeFile(box, "/box/smoke/x.txt", "hello")
    const back = (await p.readFile(box, "/box/smoke/x.txt")).toString("utf8")
    if (back !== "hello") throw new Error(`read back ${JSON.stringify(back)}`)
    return "ok"
  })
  await check("published port", async () => {
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
} finally {
  if (keep) console.log(`\nKept the instance: ${p.cached(box)?.id}. Destroy it at cloud.vast.ai › Instances when you're done.`)
  else await p.destroy(box).catch((e) => console.log(`✗ destroy: ${(e as Error).message}. Destroy it at cloud.vast.ai › Instances.`))
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

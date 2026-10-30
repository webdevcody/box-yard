/**
 * Smoke test the RunPod GPU provider against the real API, using RUNPOD_API_KEY from the env or .env.
 * Costs a few cents: one pod for about three minutes, and a small volume deleted at the end.
 *
 *   npx tsx scripts/smoke-runpod.ts           # start a pod, check everything, terminate it, delete its volume
 *   npx tsx scripts/smoke-runpod.ts --keep    # leave the pod and volume up and print the pod id
 *   SMOKE_IMAGE=docker.io/you/boxyard-gpu:bx-… npx tsx scripts/smoke-runpod.ts   # try your built image
 *
 * Checks: the pod starts on the first GPU type with stock (the defaults of Settings › RunPod GPU), SSH and the
 * tools, nvidia-smi, WebGL in headless Chrome on the NVIDIA GPU, file write/read, and a server reachable through
 * the pod's public proxy URL. Pods and volumes are named boxyard-smoketest-…, apart from any Box Yard's own.
 */
import path from "node:path"
import os from "node:os"
import { config } from "../server/config.js"
import { RunPodApi } from "../server/runpod/api.js"
import { SshPool } from "../server/runpod/ssh.js"
import { runpodDir } from "../server/runpod/image.js"
import { RunPodProvider } from "../server/providers/runpod.js"
import { DEFAULT_RUNPOD_SETTINGS, gpuBoxId } from "../shared/runpod.js"

const keep = process.argv.includes("--keep")
const box = gpuBoxId("smoke")
if (!config.runpodApiKey) throw new Error("RUNPOD_API_KEY is not set")
const api = new RunPodApi(() => config.runpodApiKey)
const p = new RunPodProvider({
  api,
  ssh: new SshPool(path.join(os.tmpdir(), "box-yard-runpod-smoke")),
  settings: () => ({ ...DEFAULT_RUNPOD_SETTINGS, image: process.env.SMOKE_IMAGE || null, volumeGb: 10 }),
  install: () => "smoketest",
  scriptsDir: runpodDir(),
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
  await check("pod starts", async () => {
    await p.wake(box)
    const pod = p.cached(box)
    return `${pod?.id} ${pod?.gpu?.id} in ${pod?.dataCenterId} at $${pod?.cost}/hr`
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
  await check("public URL", async () => {
    await sh("cd /box/smoke && (nohup python3 -m http.server 4000 --bind 0.0.0.0 > http.log 2>&1 &) && sleep 1")
    const url = await p.publicUrl(box, 4000)
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${url}/x.txt`).catch(() => null)
      if (res?.ok && (await res.text()) === "hello") return url
      await new Promise((r) => setTimeout(r, 3000))
    }
    throw new Error(`${url} never served the file`)
  })
} finally {
  if (keep) console.log(`\nKept the pod: ${p.cached(box)?.id}. Stop it in RunPod's console when you're done.`)
  else {
    await p.destroy(box).catch((e) => console.log(`✗ terminate: ${(e as Error).message}`))
    for (const v of (await api.listVolumes()).filter((v) => v.name === p.resourceName(box))) {
      // A volume is busy for a few seconds after its pod goes.
      for (let i = 0; i < 12; i++) {
        if (await api.deleteVolume(v.id).then(() => true, () => false)) break
        await new Promise((r) => setTimeout(r, 10_000))
      }
      console.log(`  · deleted volume ${v.id}`)
    }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

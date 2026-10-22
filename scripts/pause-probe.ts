/**
 * Measure when non-keep-alive boxes pause: one idle, one with only a background
 * process, one with an exec stream held open. Prints status every 30s.
 *   npx tsx scripts/pause-probe.ts [minutes]
 */
import { Box } from "@upstash/box"
import { config } from "../server/config.js"

const apiKey = config.upstashBoxApiKey
const minutes = Number(process.argv[2] ?? 20)
const mk = () => Box.create({ apiKey, runtime: "node", size: "small", labels: ["boxyard-probe"] })
const [idle, bg, held] = await Promise.all([mk(), mk(), mk()])
console.log(`idle=${idle.id} bg=${bg.id} held=${held.id}`)
await bg.exec.command(`bash -c "(nohup bash -c 'while true; do date >> /tmp/tick; sleep 5; done' >/dev/null 2>&1 &); echo ok"`)
const stream = await held.exec.stream(`bash -c "while true; do sleep 15; echo .; done"`)
let streamEnded = false
void (async () => {
  try {
    for await (const _ of stream) {
    }
  } catch (e) {
    console.log(`held stream error: ${e}`)
  }
  streamEnded = true
  console.log(`[${new Date().toLocaleTimeString()}] held stream ended`)
})()
const t0 = Date.now()
while (Date.now() - t0 < minutes * 60_000) {
  const s = await Promise.all([idle, bg, held].map((b) => b.getStatus().then((x) => x.status).catch((e) => `err:${e.message}`)))
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s] idle=${s[0]} bg=${s[1]} held=${s[2]}${streamEnded ? " (stream ended)" : ""}`)
  await new Promise((r) => setTimeout(r, 30_000))
}
const ticks = await bg.exec.command("bash -c 'wc -l < /tmp/tick; tail -1 /tmp/tick; date'")
console.log(`bg ticks: ${ticks.stdout || ticks.result}`)
await Box.delete({ apiKey, boxIds: [idle.id, bg.id, held.id] })
console.log("deleted probe boxes")
process.exit(0)

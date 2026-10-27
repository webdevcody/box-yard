import { config, configProblems } from "./config.js"
import { createBoxYard } from "./app.js"
import { bindProblem, isLoopback, listenUrls } from "./bind.js"

const refused = bindProblem(config)
if (refused) {
  console.error(`\n[box-yard] Not starting.\n${refused.replace(/^/gm, "  ")}\n`)
  process.exit(1)
}

const yard = createBoxYard(config)

const server = yard.app.listen(config.port, config.host, () => {
  console.log(`\n  Box Yard is running on:`)
  for (const u of listenUrls(config.host, config.port)) console.log(`    ${`${u.label}:`.padEnd(11)} ${u.url}`)
  if (isLoopback(config.host)) console.log(`  (this computer only: set BOXYARD_PASSWORD to open it to your network and Tailscale)`)
  else if (!config.password) console.log(`  ! No BOXYARD_PASSWORD (BOXYARD_ALLOW_OPEN=1): anyone who can reach these addresses can use Box Yard.`)
  console.log(`  boxes: ${config.provider} (default max ${config.maxBoxes} boxes × ${config.slotsPerBox} tasks at once) · data: ${config.dataDir}`)
  for (const p of configProblems(config)) console.log(`  ! ${p}`)
  console.log("")
})
server.on("error", (err) => {
  console.error(`[box-yard] can't listen on ${config.host}:${config.port}: ${err.message}`)
  process.exit(1)
})

await yard.start()

let shuttingDown = false
const shutdown = (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[box-yard] ${signal}: shutting down. Running agents keep working in their boxes and are picked up on restart.`)
  server.close()
  yard.stop()
  setTimeout(() => process.exit(0), 500).unref()
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("unhandledRejection", (err) => console.error("[box-yard] unhandled rejection", err))

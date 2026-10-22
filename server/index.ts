import { config, configProblems } from "./config.js"
import { createBoxYard } from "./app.js"

const yard = createBoxYard(config)

const server = yard.app.listen(config.port, config.host, () => {
  console.log(`\n  Box Yard is running on http://localhost:${config.port}`)
  console.log(`  boxes: ${config.provider} (default max ${config.maxBoxes} boxes × ${config.slotsPerBox} agents) · data: ${config.dataDir}`)
  for (const p of configProblems(config)) console.log(`  ! ${p}`)
  console.log("")
})
server.on("error", (err) => {
  console.error(`[box-yard] can't listen on port ${config.port}: ${err.message}`)
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

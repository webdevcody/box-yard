/**
 * Talk to a running Box Yard from the terminal (local or deployed).
 *
 *   npx tsx scripts/yardctl.ts say "open an issue on webdevcody/box-yard"   # send, wait for the reply
 *   npx tsx scripts/yardctl.ts status                                       # projects, tasks, boxes
 *   npx tsx scripts/yardctl.ts wait [seconds]                                # until no agent is busy
 *   npx tsx scripts/yardctl.ts task <id> [lines]                             # a task's transcript
 *   npx tsx scripts/yardctl.ts chat [lines]                                  # recent orchestrator chat
 *
 * YARD_URL (default http://localhost:3000) and YARD_PASSWORD pick the server.
 */
const base = (process.env.YARD_URL ?? "http://localhost:3000").replace(/\/$/, "")
const password = process.env.YARD_PASSWORD ?? ""
let cookie = ""

async function login() {
  if (!password || cookie) return
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  await login()
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : (undefined as T)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const time = (ts: number) => new Date(ts).toLocaleTimeString()

function printChat(m: any) {
  const tag = { user: "YOU", assistant: "ORCH", tool: "tool", notice: "notice", error: "ERROR" }[m.role as string] ?? m.role
  const body = m.role === "tool" ? `${m.content} ${JSON.stringify(m.meta?.input ?? {}).slice(0, 400)}` : m.content
  console.log(`[${time(m.createdAt)}] ${tag}: ${body}`)
}

async function status() {
  const [projects, tasks, boxes, health] = await Promise.all([api("GET", "/projects"), api("GET", "/tasks"), api("GET", "/boxes"), api("GET", "/health")])
  console.log(`health: ok=${health.ok} provider=${health.provider} orchestratorBusy=${health.orchestratorBusy}${health.problems.length ? ` problems=${JSON.stringify(health.problems)}` : ""}`)
  console.log(`\nboxes (${boxes.length}):`)
  for (const b of boxes) console.log(`  ${b.id} ${b.status} running=${b.runningTurns}/${b.slots} residents=${b.residentTasks.join(",") || "-"}`)
  console.log(`\nprojects (${projects.length}):`)
  for (const p of projects) {
    console.log(`  ${p.id} ${p.name}${p.repo ? ` (${p.repo})` : ""}`)
    for (const t of tasks.filter((t: any) => t.projectId === p.id)) {
      console.log(
        `    ${t.id} [${t.status}] ${t.title} box=${t.boxId ?? "-"} turns=${t.turnCount ?? "?"}${t.pendingCount ? ` queued=${t.pendingCount}` : ""}${t.question ? ` Q="${t.question}"` : ""}${t.error ? ` ERR="${String(t.error).slice(0, 200)}"` : ""}`,
      )
    }
  }
}

async function waitIdle(seconds: number) {
  const until = Date.now() + seconds * 1000
  let last = ""
  while (Date.now() < until) {
    const [tasks, health] = await Promise.all([api("GET", "/tasks"), api("GET", "/health")])
    const busy = tasks.filter((t: any) => ["queued", "starting", "working"].includes(t.status))
    const line = `orch=${health.orchestratorBusy ? "busy" : "idle"} busy=${busy.map((t: any) => `${t.id}:${t.status}`).join(",") || "none"}`
    if (line !== last) console.log(`[${time(Date.now())}] ${line}`)
    last = line
    if (!busy.length && !health.orchestratorBusy) return true
    await sleep(3000)
  }
  console.log("timed out waiting")
  return false
}

async function say(content: string, seconds = 900) {
  const before = await api<any[]>("GET", "/chat")
  const seen = new Set(before.map((m) => m.id))
  await api("POST", "/chat", { content })
  const until = Date.now() + seconds * 1000
  await sleep(1500)
  while (Date.now() < until) {
    const [chat, health] = await Promise.all([api<any[]>("GET", "/chat"), api("GET", "/health")])
    for (const m of chat) if (!seen.has(m.id)) (seen.add(m.id), printChat(m))
    if (!health.orchestratorBusy) return
    await sleep(2000)
  }
  console.log("timed out waiting for the orchestrator")
}

const [cmd, ...rest] = process.argv.slice(2)
switch (cmd) {
  case "say":
    await say(rest.join(" "))
    break
  case "status":
    await status()
    break
  case "wait":
    await waitIdle(Number(rest[0] ?? 900))
    break
  case "task": {
    const msgs = await api<any[]>("GET", `/tasks/${rest[0]}/messages`)
    for (const m of msgs.slice(-Number(rest[1] ?? 60))) console.log(`[${time(m.createdAt)}] ${m.role}: ${String(m.content).slice(0, 1500)}`)
    break
  }
  case "chat": {
    const chat = await api<any[]>("GET", "/chat")
    for (const m of chat.slice(-Number(rest[0] ?? 40))) printChat(m)
    break
  }
  default:
    console.log("usage: yardctl say <msg> | status | wait [s] | task <id> [n] | chat [n]")
    process.exit(1)
}

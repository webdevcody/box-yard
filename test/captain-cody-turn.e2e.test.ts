import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import type { Server } from "node:http"
import os from "node:os"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import type { CaptainMessage, Project } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// A message Cody sends a Captain (Captain tab, the Coordinator's bottom panel and a task chat's forward all go
// through Captain.send) is the prompt of a turn of its own, triggered "cody", even when it arrives mid-turn or a
// restart kills the turn that took it. The bug: Box Yard restarted 6 s into the turn answering Cody's message; the
// turn died before replying, the message counted as answered, and the next wake-up said no one had written.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  config: Config
}
const running: Running[] = []

async function listen(config: Config): Promise<Running> {
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  yard.captains.tuning.wakeDebounceMs = 100
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(config.port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${config.port}`, config }
  running.push(r)
  return r
}

/** Box Yard stops (a restart, an upgrade): a Captain turn running now is killed. */
async function shutdown(r: Running) {
  running.splice(running.indexOf(r), 1)
  r.yard.stop()
  await new Promise((res) => r.server.close(() => res(null)))
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const fromCody = (r: Running, p: Project, id: string, content: string) =>
  call<CaptainMessage>(r, "POST", `/api/projects/${p.id}/captain/messages`, { id, content })
const captainBusy = async (r: Running, p: Project) => (await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy
const captainIdle = (r: Running, p: Project) => waitFor(async () => !(await captainBusy(r, p)), "Captain idle", 30_000)
/** The triggers of the project's Captain turns, oldest first. */
const triggers = (r: Running, p: Project) =>
  r.yard.store
    .listTurnTimings({ since: 0, role: "captain", projectId: p.id, kind: "turn", limit: 100 })
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((t) => t.trigger)

/** Every prompt the Captain's fake Claude session received. */
function captainPrompts(r: Running, p: Project): string[] {
  const id = r.yard.store.getKv(`captain_session:${p.id}`)
  if (!id) return []
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude"), "fake-sessions", `${id}.json`)
  if (!fs.existsSync(file)) return []
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: { prompt: string }[] }).turns.map((t) => t.prompt)
}

describe("Cody's messages to a Captain", () => {
  it("sent during an automatic wake-up, get the next turn as Cody's request", async () => {
    const r = await listen(testConfig({ port: await freePort() }))
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    // A task update wakes the Captain for an "updates" turn that takes a while.
    r.yard.captains.projectNotice(p.id, "✅ **Spruce trees** is done: merged [slow:3]")
    await waitFor(() => captainBusy(r, p), "the wake-up to start", 10_000)
    const sent = await fromCody(r, p, "chat_buymenu0001", "Generate artwork for the buy menu")
    expect(sent.meta).toMatchObject({ source: "cody", queued: true })
    await waitFor(async () => !(await captainBusy(r, p)) && triggers(r, p).length >= 2, "both turns", 30_000)

    expect(triggers(r, p)).toEqual(["updates", "cody"])
    const last = captainPrompts(r, p).at(-1)!
    expect(last).toContain("[From Cody]\nGenerate artwork for the buy menu")
    expect(last).not.toContain("Automatic wake-up")
  })

  it("whose turn a restart killed before it replied, get a turn of their own on the next start", async () => {
    const config = testConfig({ port: await freePort() })
    const r = await listen(config)
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await fromCody(r, p, "chat_buymenu0002", "Generate artwork for the buy menu [slow:4]")
    await waitFor(() => captainBusy(r, p), "Cody's turn to start", 10_000)
    // Mid-turn, a second message waits for the next turn.
    const queued = await fromCody(r, p, "chat_buymenu0003", "And a 3D-model toggle")
    expect(queued.meta).toMatchObject({ queued: true })
    await new Promise((res) => setTimeout(res, 1000))
    await shutdown(r)

    const again = await listen(config)
    await waitFor(() => triggers(again, p).length >= 1, "a Captain turn after the restart", 30_000)
    await captainIdle(again, p)
    expect(triggers(again, p)).toEqual(["cody"])
    const last = captainPrompts(again, p).at(-1)!
    expect(last).toContain("Box Yard restarted while you were answering the messages below")
    expect(last).toContain("[From Cody]\nGenerate artwork for the buy menu")
    expect(last).toContain("[From Cody]\nAnd a 3D-model toggle")
    expect(last).not.toContain("Automatic wake-up")
    expect(again.yard.store.getKv(`captain_open_turn:${p.id}`)).toBeNull()
    const replies = (await call<CaptainMessage[]>(again, "GET", `/api/projects/${p.id}/captain/messages`)).filter((m) => m.role === "assistant")
    expect(replies.length).toBeGreaterThan(0)
  })

  it("answered before the stop aren't answered again on the next start", async () => {
    const config = testConfig({ port: await freePort() })
    const r = await listen(config)
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await fromCody(r, p, "chat_status00001", "status")
    await waitFor(async () => !(await captainBusy(r, p)) && triggers(r, p).length >= 1, "the turn", 30_000)
    await shutdown(r)

    const again = await listen(config)
    await new Promise((res) => setTimeout(res, 1500))
    expect(await captainBusy(again, p)).toBe(false)
    expect(triggers(again, p)).toEqual(["cody"])
  })
})

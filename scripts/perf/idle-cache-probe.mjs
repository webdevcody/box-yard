#!/usr/bin/env node
// The first model step after an idle gap, on the real Claude CLI, with the prompt cache's TTL at 5 minutes vs 1 hour.
// Each session sends a large first message (unique, so sessions never share a cache prefix), waits, then resumes
// with a one-line message. That resume's first step reads the context from the cache if it's still there, or writes
// it all again if it expired. It prints the step's time and the usage's cache read / 5m write / 1h write.
//
//   CLAUDE_CODE_OAUTH_TOKEN=… (or ANTHROPIC_API_KEY=…) node scripts/perf/idle-cache-probe.mjs \
//     [--idle-min 6.5] [--kb 240] [--reps 2] [--model claude-opus-5-5] [--claude claude] [--json out.json]
//
// Scenarios: "5m, idle" and "1h, idle" wait --idle-min; "5m, warm" resumes after 20 s as a control. Calls run one
// at a time, so they don't slow each other down. It makes real API calls: reps × 3 × 2 steps over a context of
// --kb kB of code (Opus 5.5 counts ~240 kB as ~112k tokens).
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}
const idleMs = Number(opt("--idle-min", "6.5")) * 60_000
const kb = Number(opt("--kb", "240"))
const reps = Number(opt("--reps", "2"))
const model = opt("--model", "claude-opus-5-5")
const claude = opt("--claude", "claude")
const jsonOut = opt("--json")

const login = Object.fromEntries(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
if (!Object.keys(login).length) {
  console.error("Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.")
  process.exit(2)
}

// Filler: this checkout's own source, so the model sees ordinary code, not a repeated pattern.
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..")
let filler = ""
for (const f of fs.readdirSync(path.join(root, "server")).filter((f) => f.endsWith(".ts")).sort()) {
  if (filler.length >= kb * 1024) break
  filler += `\n\n// ===== server/${f}\n` + fs.readFileSync(path.join(root, "server", f), "utf8")
}
filler = filler.slice(0, kb * 1024)


/** One CLI run; resolves with the first assistant step's time and usage, and the result's. */
function run(cwd, cfg, ttl, sessionArgs, prompt) {
  return new Promise((resolve) => {
    const env = { HOME: os.homedir(), PATH: process.env.PATH, CLAUDE_CONFIG_DIR: cfg, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_PROMPT_CACHE_TTL: ttl, ...login }
    const t0 = Date.now()
    const child = spawn(claude, ["-p", "--output-format", "stream-json", "--verbose", "--model", model, "--max-turns", "1", "--tools", "", "--include-partial-messages", ...sessionArgs], { cwd, env })
    let buf = ""
    let first = null
    let result = null
    let initAt = null
    let tokenAt = null
    child.stdout.on("data", (d) => {
      buf += d
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.type === "system" && ev.subtype === "init") initAt ??= Date.now()
        if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") tokenAt ??= Date.now()
        if (ev.type === "assistant" && !first) first = { at: Date.now(), usage: ev.message?.usage }
        if (ev.type === "result") result = { at: Date.now(), usage: ev.usage, error: ev.is_error ? ev.result : null, apiMs: ev.duration_api_ms }
      }
    })
    child.stderr.on("data", () => {})
    child.stdin.end(prompt)
    child.on("close", () =>
      resolve({
        ttftMs: tokenAt && initAt ? tokenAt - initAt : null,
        stepMs: first && initAt ? first.at - initAt : null,
        totalMs: (result?.at ?? Date.now()) - t0,
        apiMs: result?.apiMs ?? null,
        usage: result?.usage ?? first?.usage ?? null,
        error: result?.error ?? (result ? null : "no result"),
      }),
    )
  })
}

const split = (u) => ({
  read: u?.cache_read_input_tokens ?? 0,
  w5m: u?.cache_creation?.ephemeral_5m_input_tokens ?? 0,
  w1h: u?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  input: u?.input_tokens ?? 0,
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A session's first, large message. */
async function open(name, ttl, rep) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-cache-probe-"))
  const cfg = path.join(dir, "cfg")
  fs.mkdirSync(cfg)
  const id = randomUUID()
  const a = await run(dir, cfg, ttl, ["--session-id", id], `Probe ${name} #${rep} ${id}. Here is some code to keep in mind; I'll ask about it later. Reply with just OK.\n${filler}`)
  return { name, ttl, rep, dir, cfg, id, a, openedAt: Date.now() }
}

/** Its one-line follow-up, the step the cache decides. */
async function resume(s) {
  const b = await run(s.dir, s.cfg, s.ttl, ["--resume", s.id], "Reply with just OK again.")
  fs.rmSync(s.dir, { recursive: true, force: true })
  return { scenario: s.name, rep: s.rep, idleMs: Date.now() - s.openedAt, first: { ...s.a, ...split(s.a.usage) }, resume: { ...b, ...split(b.usage) } }
}

console.error(`model ${model}, ${kb} kB of code, idle ${idleMs / 60_000} min, ${reps} rep(s); one call at a time…`)
const idle = []
for (let r = 1; r <= reps; r++) for (const ttl of ["5m", "1h"]) idle.push(await open(`${ttl}, idle`, ttl, r))
const rows = []
// The warm control fills the idle wait.
for (let r = 1; r <= reps; r++) {
  const s = await open("5m, warm", "5m", r)
  await sleep(20_000)
  rows.push(await resume(s))
}
for (const s of idle) {
  await sleep(Math.max(0, s.openedAt + idleMs - Date.now()))
  rows.push(await resume(s))
}
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const s = (ms) => (ms == null ? "?" : `${(ms / 1000).toFixed(1)} s`)
console.log("| Scenario | Rep | Idle | Context written (5m / 1h) | Resume: first token | Resume: step | Cache read | 5m write | 1h write |")
console.log("|---|---:|---:|---|---:|---:|---:|---:|---:|")
for (const r of rows)
  console.log(
    `| ${r.scenario} | ${r.rep} | ${(r.idleMs / 60_000).toFixed(1)} min | ${k(r.first.w5m)} / ${k(r.first.w1h)} | ${s(r.resume.ttftMs)} | ${s(r.resume.stepMs)} | ${k(r.resume.read)} | ${k(r.resume.w5m)} | ${k(r.resume.w1h)} |${r.resume.error ? ` ⚠ ${r.resume.error}` : ""}`,
  )
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ model, kb, idleMs, rows }, null, 2))

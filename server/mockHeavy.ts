// A heavy, realistic dataset for testing the web UI under load (BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1):
// a ~150k-token orchestrator chat, a task thread with ~2000 events and 60 tasks across 6 projects.
// Seeded once into an empty data dir. `POST /api/dev/pulse` replays live SSE traffic against it.
import express from "express"
import type { DB } from "./db.js"
import type { Hub } from "./hub.js"
import type { Store } from "./store.js"
import type { ChatMessage, TaskMessage, TaskStatus } from "../shared/types.js"

export const HEAVY_TASK_ID = "task_heavy-thread"

const PROJECTS = [
  { id: "prj_heavy-yard", name: "box-yard", repo: "webdevcody/box-yard" },
  { id: "prj_heavy-nebula", name: "nebula", repo: "webdevcody/nebula" },
  { id: "prj_heavy-survive", name: "survive-the-night", repo: "webdevcody/survive-the-night" },
  { id: "prj_heavy-workouts", name: "workouts", repo: null },
  { id: "prj_heavy-research", name: "research", repo: null },
  { id: "prj_heavy-site", name: "marketing-site", repo: "webdevcody/site" },
]

const STATUSES: TaskStatus[] = ["idle", "done", "pr_ready", "needs_input", "failed", "idle", "done", "pr_ready", "waiting", "idle"]

/** Small deterministic PRNG so every seeded yard looks the same. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const WORDS =
  "the orchestrator box agent task branch worker snapshot preview schedule queue merge review compact context stream token session resume archive deploy commit test build lint render scroll virtual list memo cache sidebar composer markdown table code thread event status inbox palette upload attachment drop zone keyboard latency frame paint layout"
    .split(" ")

function sentence(r: () => number, min = 8, max = 22) {
  const n = min + Math.floor(r() * (max - min))
  const w = Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)])
  w[0] = w[0]!.charAt(0).toUpperCase() + w[0]!.slice(1)
  return w.join(" ") + "."
}

function paragraph(r: () => number) {
  return Array.from({ length: 2 + Math.floor(r() * 4) }, () => sentence(r)).join(" ")
}

const CODE = [
  "```ts\nexport function upsert<T extends { id: string }>(list: T[] | undefined, item: T): T[] {\n  if (!list) return [item]\n  const idx = list.findIndex((x) => x.id === item.id)\n  if (idx === -1) return [...list, item]\n  const next = list.slice()\n  next[idx] = item\n  return next\n}\n```",
  "```bash\nnpm run typecheck && npx vitest run\ngit checkout -b boxyard/fix-scroll\ngit commit -am \"Fix sticky scroll\" && gh pr create --fill\n```",
  "```tsx\nconst ChatLine = memo(function ChatLine({ m }: { m: ChatMessage }) {\n  return (\n    <div className=\"text-sm text-zinc-200\">\n      <Markdown>{m.content}</Markdown>\n    </div>\n  )\n})\n```",
  "```json\n{\n  \"id\": \"task_8f2a91c0\",\n  \"status\": \"pr_ready\",\n  \"branch\": \"boxyard/dark-mode\",\n  \"previews\": [{ \"port\": 4000, \"label\": \"web\" }]\n}\n```",
]

function table(r: () => number) {
  const rows = Array.from({ length: 3 + Math.floor(r() * 5) }, (_, i) => {
    const p = PROJECTS[Math.floor(r() * PROJECTS.length)]!
    return `| task_${(i * 7919 + Math.floor(r() * 1e6)).toString(36)} | ${p.name} | ${STATUSES[Math.floor(r() * STATUSES.length)]} | ${Math.floor(r() * 40)} turns |`
  })
  return ["| Task | Project | Status | Turns |", "| --- | --- | --- | --- |", ...rows].join("\n")
}

/** A long assistant reply: headings, prose, lists, a table and a code block. */
function reply(r: () => number) {
  const parts = [`### ${sentence(r, 3, 6).slice(0, -1)}`, paragraph(r)]
  if (r() < 0.6) parts.push(Array.from({ length: 3 + Math.floor(r() * 4) }, () => `- **${WORDS[Math.floor(r() * WORDS.length)]}**: ${sentence(r, 5, 12)}`).join("\n"))
  if (r() < 0.45) parts.push(table(r))
  if (r() < 0.5) parts.push(CODE[Math.floor(r() * CODE.length)]!)
  parts.push(paragraph(r))
  if (r() < 0.3) parts.push(`See [the PR](https://github.com/webdevcody/box-yard/pull/${10 + Math.floor(r() * 90)}) and \`task_${Math.floor(r() * 1e8).toString(36)}\`.`)
  return parts.join("\n\n")
}

const TOOLS = ["mcp__boxyard__list_tasks", "mcp__boxyard__create_task", "mcp__boxyard__message_task", "mcp__boxyard__read_task", "mcp__boxyard__save_note"]
const WORKER_TOOLS = ["Read web/src/components/ChatPanel.tsx", "Bash npm run typecheck", "Edit web/src/components/ui.tsx", "Grep useChat", "Bash npx vitest run", "Write server/mockHeavy.ts", "Bash git status"]

/** Seed the heavy dataset if the yard is empty. Returns false when there was already data. */
export function seedHeavy(db: DB, store: Store): boolean {
  if (store.listProjects().length) return false
  const r = rng(42)
  const now = Date.now()
  const insertChat = db.prepare("INSERT INTO chat_messages (id, role, content, meta_json, seen_by_orchestrator, created_at) VALUES (?, ?, ?, ?, 1, ?)")
  const insertTaskMsg = db.prepare("INSERT INTO task_messages (id, task_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")

  db.transaction(() => {
    for (const p of PROJECTS) store.createProject({ ...p, description: `Heavy fixture project ${p.name}` })
    const taskIds: string[] = []
    for (let i = 0; i < 60; i++) {
      const p = PROJECTS[i % PROJECTS.length]!
      const id = i === 0 ? HEAVY_TASK_ID : `task_heavy-${String(i).padStart(3, "0")}`
      taskIds.push(id)
      store.createTask({ id, projectId: p.id, title: i === 0 ? "Heavy thread: 2000 events" : sentence(r, 4, 9).slice(0, -1), prompt: paragraph(r) })
      const status = i === 0 ? "idle" : STATUSES[i % STATUSES.length]!
      store.updateTask(id, {
        status,
        turnCount: 1 + Math.floor(r() * 40),
        summary: paragraph(r),
        question: status === "needs_input" ? "Should the sidebar group tasks by project or by status?" : null,
        error: status === "failed" ? "Turn failed: npm ERR! code ELIFECYCLE" : null,
        prUrl: status === "pr_ready" ? `https://github.com/${p.repo ?? "webdevcody/box-yard"}/pull/${100 + i}` : null,
        branch: p.repo ? `boxyard/heavy-${i}` : null,
        contextTokens: 20_000 + Math.floor(r() * 150_000),
        contextWindow: 200_000,
      })
    }

    // Orchestrator chat: 1200 messages, ~600k characters (~150k tokens).
    const start = now - 14 * 24 * 3600_000
    const total = 1200
    for (let i = 0; i < total; i++) {
      const at = start + Math.floor((i / total) * (now - start - 60_000))
      const roll = r()
      const id = `chat_heavy${String(i).padStart(5, "0")}`
      let role: ChatMessage["role"]
      let content: string
      let meta: Record<string, unknown> | null = null
      if (roll < 0.18) {
        role = "user"
        content = r() < 0.3 ? `${sentence(r)}\n${sentence(r)}` : sentence(r, 5, 25)
      } else if (roll < 0.58) {
        role = "assistant"
        content = reply(r)
      } else if (roll < 0.9) {
        role = "tool"
        content = TOOLS[Math.floor(r() * TOOLS.length)]!
        meta = { input: { title: sentence(r, 3, 8) } }
      } else {
        role = "notice"
        const taskId = taskIds[Math.floor(r() * taskIds.length)]!
        content = `**${taskId}** finished: ${sentence(r)}`
        meta = { taskId }
      }
      insertChat.run(id, role, content, meta ? JSON.stringify(meta) : null, at)
    }

    // One very long task thread: 2000 events.
    const tStart = now - 2 * 24 * 3600_000
    for (let i = 0; i < 2000; i++) {
      const at = tStart + Math.floor((i / 2000) * (now - tStart - 60_000))
      const roll = r()
      let role: TaskMessage["role"]
      let content: string
      let meta: Record<string, unknown> | null = null
      if (i === 0) {
        role = "user"
        content = paragraph(r)
        meta = { kind: "task_prompt" }
      } else if (roll < 0.08) {
        role = "user"
        content = sentence(r)
      } else if (roll < 0.33) {
        role = "assistant"
        content = r() < 0.5 ? reply(r) : paragraph(r)
      } else if (roll < 0.9) {
        role = "tool"
        content = WORKER_TOOLS[Math.floor(r() * WORKER_TOOLS.length)]!
        if (r() < 0.05) meta = { error: true }
      } else if (roll < 0.95) {
        role = "event"
        content = r() < 0.5 ? "Turn finished" : "Preview ready on port 4000"
      } else {
        role = "agent"
        content = sentence(r)
        meta = { from: taskIds[1 + Math.floor(r() * 10)], fromTitle: "Another agent" }
      }
      insertTaskMsg.run(`tm_heavy${String(i).padStart(5, "0")}`, HEAVY_TASK_ID, role, content, meta ? JSON.stringify(meta) : null, at)
    }

    store.setKv("orchestrator_usage", JSON.stringify({ tokens: 150_000, window: 200_000, updatedAt: now }))
  })()
  return true
}

/**
 * Dev-only routes for measuring live-update cost. `POST /api/dev/pulse` with
 * `{ kind: "task" | "task.message" | "chat.delta" | "chat.message", count?, intervalMs? }`
 * broadcasts that many synthetic events.
 */
export function heavyDevRoutes(store: Store, hub: Hub) {
  const router = express.Router()
  let seq = 0
  router.post("/dev/pulse", (req, res) => {
    const { kind = "task", count = 1, intervalMs = 0 } = (req.body ?? {}) as { kind?: string; count?: number; intervalMs?: number }
    const n = Math.min(Math.max(1, Number(count) || 1), 1000)
    const fire = () => {
      const i = seq++
      if (kind === "task") {
        const task = store.listTasks().find((t) => t.id === `task_heavy-${String(1 + (i % 59)).padStart(3, "0")}`)
        if (task) hub.broadcast({ type: "task", task: { ...task, updatedAt: Date.now() } })
      } else if (kind === "task.message") {
        hub.broadcast({ type: "task.message", message: { id: `tm_pulse${i}`, taskId: HEAVY_TASK_ID, role: "tool", content: `Bash echo pulse ${i}`, meta: null, createdAt: Date.now() } })
      } else if (kind === "chat.delta") {
        hub.broadcast({ type: "chat.delta", text: `word${i} ` })
      } else if (kind === "chat.message") {
        hub.broadcast({ type: "chat.message", message: { id: `chat_pulse${i}`, role: "tool", content: "mcp__boxyard__list_tasks", meta: null, createdAt: Date.now() } })
      }
    }
    if (!intervalMs) for (let i = 0; i < n; i++) fire()
    else {
      let left = n
      const t = setInterval(() => {
        fire()
        if (--left <= 0) clearInterval(t)
      }, intervalMs)
    }
    res.json({ ok: true, sent: n })
  })
  return router
}

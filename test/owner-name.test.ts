import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import { captainPrompt, firstTurnPrompt, followupPrompt, ORCHESTRATOR_PROMPT, workerSystemPrompt } from "../server/prompts.js"
import { routingInstructions } from "../server/routing.js"
import { buildMcpServer, type McpDeps } from "../server/mcp.js"
import { DEFAULT_OWNER_NAME, withOwner } from "../shared/owner.js"
import { userMessageLabel } from "../shared/sender.js"
import type { Project } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const noEnv = { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" as const }

const project = {
  id: "prj_1",
  name: "Cody's site",
  description: "Built for Cody",
  repo: "acme/site",
  baseBranch: "main",
} as Project

describe("withOwner", () => {
  it("leaves text alone for the default or an empty name", () => {
    expect(withOwner("Ask Cody.", undefined)).toBe("Ask Cody.")
    expect(withOwner("Ask Cody.", " ")).toBe("Ask Cody.")
    expect(withOwner("Ask Cody.", DEFAULT_OWNER_NAME)).toBe("Ask Cody.")
  })

  it("swaps whole-word mentions, possessives included", () => {
    expect(withOwner("Ask Cody; Cody's UI. Codyish stays.", "Ana")).toBe("Ask Ana; Ana's UI. Codyish stays.")
    // Replacement patterns like $& are inserted literally.
    expect(withOwner("Ask Cody.", "$&")).toBe("Ask $&.")
  })
})

describe("ownerName setting", () => {
  it("defaults to Cody, takes BOXYARD_OWNER_NAME, and the UI value wins", () => {
    expect(new SettingsStore(memStore(), noEnv).info().settings.ownerName).toBe("Cody")
    const settings = new SettingsStore(memStore(), { ...noEnv, ownerName: "Ana" })
    expect(settings.info().settings.ownerName).toBe("Ana")
    expect(settings.info().sources.ownerName).toBe("env")
    const info = settings.update({ ownerName: "  Sam  " })
    expect(info.settings.ownerName).toBe("Sam")
    expect(info.sources.ownerName).toBe("ui")
  })

  it("rejects empty or markup-like names", () => {
    const settings = new SettingsStore(memStore(), noEnv)
    expect(() => settings.update({ ownerName: "" })).toThrow()
    expect(() => settings.update({ ownerName: "<b>x</b>" })).toThrow()
    expect(() => settings.update({ ownerName: "x".repeat(41) })).toThrow()
  })
})

describe("prompts with an owner name", () => {
  it("worker system prompt uses the name but keeps the task title and project text as written", () => {
    const prompt = workerSystemPrompt({ project, task: { id: "task_1", title: "Fix Cody's bug" }, branch: "b", port: 4000, ownerName: "Ana" })
    expect(prompt).toContain("ask_user: ask Ana (the human)")
    expect(prompt).toContain("hidden next-step block for Ana's UI")
    expect(prompt).toContain(`"Fix Cody's bug"`)
    expect(prompt).toContain("Project description: Built for Cody")
    expect(prompt.replace(/Fix Cody's bug|Cody's site|Built for Cody/g, "")).not.toMatch(/\bCody\b/)
  })

  it("is unchanged without a name", () => {
    const base = { project, task: { id: "task_1", title: "T" }, branch: "b", port: 4000 }
    expect(workerSystemPrompt({ ...base, ownerName: "Cody" })).toBe(workerSystemPrompt(base))
  })

  it("labels follow-ups and notes with the name, not message content", () => {
    const text = followupPrompt(
      [
        { source: "cody", content: "Cody here" },
        { source: "orchestrator", content: "x" },
        { source: "captain:prj_1", content: "y" },
      ],
      () => "site",
      "Ana",
    )
    expect(text).toContain("Message from Ana:\n\nCody here")
    expect(text).toContain("Coordinator (on Ana's behalf)")
    expect(text).toContain("Message from the site Captain (on Ana's behalf)")
    const first = firstTurnPrompt({
      task: { title: "T", prompt: "p" },
      notes: [{ author: "Cody", content: "Cody likes tabs" }],
      hiddenNotes: 2,
      directory: [],
      extraInputs: [],
      ownerName: "Ana",
    })
    expect(first).toContain("lasting rules from Ana and the project's Captain")
    expect(first).toContain("(Cody) Cody likes tabs")
    expect(first).toContain("2 older notes don't fit the notes budget")
  })

  it("Coordinator, Captain and routing prompts have no Cody left", () => {
    expect(withOwner(ORCHESTRATOR_PROMPT, "Ana")).not.toMatch(/\bCody\b/)
    expect(captainPrompt(project, "Ana").replace(/Cody's site|Built for Cody/g, "")).not.toMatch(/\bCody\b/)
    expect(routingInstructions(tmpDir(), { agentRoutingConfig: "", ownerName: "Ana" })).not.toMatch(/\bCody\b/)
  })

  it("transcript labels use the name", () => {
    expect(userMessageLabel({}, "Ana")).toBe("Ana")
    expect(userMessageLabel({})).toBe("Cody")
  })
})

describe("box runner MCP tools", () => {
  it("name the owner from task.json in tool descriptions", async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ taskId: "task_1", ownerName: "Ana", env: {} }))
    const runner = path.resolve(import.meta.dirname, "../runner/box-runner.mjs")
    const child = spawn(process.execPath, [runner, "mcp", dir], { stdio: ["pipe", "pipe", "inherit"] })
    const reply = new Promise<string>((resolve) => {
      let out = ""
      child.stdout.on("data", (d) => {
        out += d
        if (out.includes("\n")) resolve(out)
      })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n")
    const text = await reply
    child.kill()
    const tools = JSON.parse(text.split("\n")[0]!).result.tools as { name: string; description: string }[]
    expect(tools.find((t) => t.name === "ask_user")!.description).toContain("Ask Ana (the human)")
    expect(JSON.stringify(tools)).not.toMatch(/\bCody\b/)
  })
})

describe("Box Yard MCP tools", () => {
  it("name the owner in tool and parameter descriptions", () => {
    const deps = { settings: { get: () => ({ ownerName: "Ana" }) } } as unknown as McpDeps
    // Registered tools aren't public API; read them to check the descriptions without a transport.
    const tools = Object.values((buildMcpServer(deps) as unknown as { _registeredTools: Record<string, { description?: string; inputSchema?: { shape?: Record<string, { description?: string }> } }> })._registeredTools)
    const text = JSON.stringify(tools.map((t) => [t.description, Object.values(t.inputSchema?.shape ?? {}).map((v) => v.description)]))
    expect(text).toContain("when Ana explicitly asks")
    expect(text).toContain("paths Ana attached")
    expect(text).not.toMatch(/\bCody\b/)
  })
})

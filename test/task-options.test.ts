import { describe, expect, it } from "vitest"
import { buildMcpServer, type McpDeps } from "../server/mcp.js"
import { captainPrompt, ORCHESTRATOR_PROMPT, TASK_OPTIONS } from "../server/prompts.js"
import { withOwner } from "../shared/owner.js"
import type { Project } from "../shared/types.js"

// runs_on, priority, effort, model, agent and attachments are explained once, in the system prompts' "Task options",
// and the task tools' parameters point there instead of each repeating it.

type Registered = Record<string, { description?: string; inputSchema?: { shape?: Record<string, { description?: string }> } }>
const project = { id: "prj_1", name: "site", repo: "acme/site", baseBranch: "main" } as Project

function tools(kind: "coordinator" | "captain"): Registered {
  const deps = { settings: { get: () => ({}) } } as unknown as McpDeps
  const caller = kind === "captain" ? { kind, projectId: project.id } : { kind }
  return (buildMcpServer(deps, caller as never) as unknown as { _registeredTools: Registered })._registeredTools
}

describe("Task options", () => {
  it("are in the Coordinator's and every Captain's system prompt, once", () => {
    for (const text of [ORCHESTRATOR_PROMPT, captainPrompt(project)]) expect(text.split(TASK_OPTIONS)).toHaveLength(2)
    expect(captainPrompt(project, "Ana")).toContain(withOwner(TASK_OPTIONS, "Ana"))
    for (const term of ['"local" = this computer', 'priority "high"', "low = one-command chores", "claude-opus-5-5", '"codex" (OpenAI Codex)', "attachments/"]) expect(TASK_OPTIONS).toContain(term)
  })

  it("are what the task tools' shared parameters point to, for both callers", () => {
    for (const kind of ["coordinator", "captain"] as const) {
      const registered = tools(kind)
      for (const name of ["create_task", "create_tasks", "send_to_task"]) {
        const shape = registered[name]!.inputSchema!.shape!
        for (const param of ["runs_on", "priority", "effort", "model", "attachments"]) expect(shape[param]?.description, `${kind} ${name}.${param}`).toMatch(/Task options/)
      }
      // The long explanations live only in the prompts now.
      expect(JSON.stringify(registered)).not.toMatch(/one-command chores|first in, first out among the high ones/)
    }
  })
})

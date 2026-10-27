/**
 * The projects' own limits on where agents run, the same on an Upstash box, a GPU pod and this computer (the local
 * runner). The box's own limit (Settings › Tasks running at once per box, or › on this computer) caps every agent
 * there and is checked apart. On top of it:
 *
 * - A project's Tasks running at once (projects.agents_per_box) caps only its own agents on one box or this computer.
 *   Other projects' agents never wait for it.
 * - A project set to Needs the whole machine (projects.whole_machine, off by default) keeps every other project's
 *   agents off the box or computer while one of its agents runs there, and its own wait for the others to finish.
 *
 * Store.claimTurnSlot checks this rule in the slot claim's transaction; TaskManager says why a task waits.
 */

/** An agent running on a box (or a task that wants to), with its project's limits. */
export interface BoxAgent {
  taskId: string
  title: string
  projectId: string
  projectName: string
  /** The project's Tasks running at once (the old heavy_tasks counted as 1), or null: only the box's limit. */
  agentsPerBox: number | null
  wholeMachine: boolean
}

/** Why a task can't start next to the agents running on a box, and which of them hold it back. */
export type LimitBlock =
  /** Its project's Tasks running at once (`cap`) is full: `by` are its project's agents there. */
  | { kind: "own"; cap: number; by: BoxAgent[] }
  /** `project` needs the whole machine: `by` are its running agents, or the other projects' when it's the task's own. */
  | { kind: "whole"; project: Pick<BoxAgent, "projectId" | "projectName">; by: BoxAgent[] }

/** Is `agent` held back by `running` (every agent on the box, `agent` left out)? Null: it may start, if the box has a free slot. */
export function limitBlock(agent: BoxAgent, running: BoxAgent[]): LimitBlock | null {
  const whole = running.find((r) => r.wholeMachine && r.projectId !== agent.projectId)
  if (whole) return { kind: "whole", project: whole, by: running.filter((r) => r.projectId === whole.projectId) }
  const others = running.filter((r) => r.projectId !== agent.projectId)
  if (agent.wholeMachine && others.length) return { kind: "whole", project: agent, by: others }
  const mine = running.filter((r) => r.projectId === agent.projectId)
  if (agent.agentsPerBox !== null && mine.length >= agent.agentsPerBox) return { kind: "own", cap: agent.agentsPerBox, by: mine }
  return null
}

/**
 * How a wait reason names the tasks that hold it back: "Merge PR #78", with "(survive-the-night)" when it's not
 * `ownProject`'s; "A and B", or "A, B and 3 more". Only the first two are named (and linked: `named`).
 */
export function agentRefs(agents: Pick<BoxAgent, "title" | "projectName">[], ownProject?: string): string {
  const named = agents.slice(0, 2).map((a) => (a.projectName === ownProject ? a.title : `${a.title} (${a.projectName})`))
  const more = agents.length - named.length
  return more > 0 ? `${named.join(", ")} and ${more} more` : named.join(" and ")
}

/** The tasks `agentRefs` names. */
export const named = <T>(agents: T[]): T[] => agents.slice(0, 2)

/** "1 of its tasks", "3 of its tasks". */
const ofIts = (n: number) => `${n} of its tasks`

/**
 * The wait reason for a block on this computer. It names the blocking tasks first, so a task card's two lines show
 * them: "Waiting for Merge PR #78: survive-the-night allows 1 of its tasks at a time on this computer".
 */
export function localBlockReason(agent: BoxAgent, b: LimitBlock): string {
  if (b.kind === "own") return `Waiting for ${agentRefs(b.by, agent.projectName)}: ${agent.projectName} allows ${ofIts(b.cap)} at a time on this computer`
  return `Waiting for ${agentRefs(b.by, b.project.projectName)}: ${b.project.projectName} needs the whole machine`
}

/**
 * The reason for a block on a box or pod (`where`: "box box-1", "GPU pod #2"), for "Waiting: …" or "Waiting for a
 * new box: …": "heavy allows 1 of its tasks at a time on a box, and Merge PR #78 is running on box box-1".
 */
export function boxBlockReason(agent: BoxAgent, b: LimitBlock, where: string): string {
  const one = where.startsWith("GPU pod") ? "a pod" : "a box"
  const running = (own: string) => `${agentRefs(b.by, own)} ${b.by.length === 1 ? "is" : "are"} running on ${where}`
  if (b.kind === "own") return `${agent.projectName} allows ${ofIts(b.cap)} at a time on ${one}, and ${running(agent.projectName)}`
  return `${b.project.projectName} needs the whole machine, and ${running(b.project.projectName)}`
}

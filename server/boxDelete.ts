// The delete safety check (delete_box, delete_idle_boxes, Delete box and Terminate pod): one exec per box reads each
// workspace's git state with the janitor's pushedCheck, and each task gets a verdict. The Coordinator and Captains are
// refused by any verdict but "ok"; Cody can stop running agents, or delete anyway once every workspace is archived.

import { q } from "./providers/types.js"
import { pushedCheck, pushedVerdict } from "./janitor.js"
import type { BoxContents, BoxDeleteVerdict, PrState, TaskStatus } from "../shared/types.js"

const TASK_MARK = "boxyard-task="
const CHANGED_MARK = "boxyard-changed="

/** What the check script read in one workspace: git status lines, and pushedCheck's verdicts (full, then commits only). */
export interface WorkspaceGit {
  changed: number | null
  full: string | null
  committed: string | null
}

/**
 * One script for every workspace on a box: per task its id, the number of changed files, pushedCheck, then
 * pushedCheck of commits only (is every branch pushed, whatever is uncommitted). Always exits 0.
 */
export function deleteCheckScript(workspaces: { id: string; work: string }[]): string {
  return [
    ...workspaces.flatMap(({ id, work }) => [
      `echo ${q(TASK_MARK + id)}`,
      `[ -d ${q(`${work}/.git`)} ] && echo "${CHANGED_MARK}$(git -C ${q(work)} status --porcelain 2>/dev/null | wc -l)"`,
      `( ${pushedCheck(work)} )`,
      `( ${pushedCheck(work, { committedOnly: true })} )`,
    ]),
    "true",
  ].join("\n")
}

/** deleteCheckScript's output, by task id. A task missing from it (the exec failed) has nothing known. */
export function parseDeleteCheck(stdout: string): Map<string, WorkspaceGit> {
  const out = new Map<string, WorkspaceGit>()
  let current: { id: string; lines: string[] } | null = null
  const flush = () => {
    if (!current) return
    const verdicts = current.lines.filter((l) => l.startsWith("boxyard-pushed="))
    const changed = current.lines.find((l) => l.startsWith(CHANGED_MARK))?.slice(CHANGED_MARK.length).trim()
    out.set(current.id, {
      changed: changed && /^\d+$/.test(changed) ? Number(changed) : null,
      full: verdicts[0] ? pushedVerdict(verdicts[0]) : null,
      committed: verdicts[1] ? pushedVerdict(verdicts[1]) : null,
    })
  }
  for (const line of stdout.split("\n").map((l) => l.trim())) {
    if (line.startsWith(TASK_MARK)) {
      flush()
      current = { id: line.slice(TASK_MARK.length), lines: [] }
    } else current?.lines.push(line)
  }
  flush()
  return out
}

export interface VerdictInput {
  status: TaskStatus
  /** A turn is running or setting up on the box. */
  running: boolean
  /** Queued, or resting with queued messages or a compaction to run (TaskManager.wantsTurn). */
  wantsTurn: boolean
  prState: PrState | null
  /** Its project has a repo (a project without one has no git to push: its archive is its only copy). */
  hasRepo: boolean
  /** The box answered the check; false when it couldn't be reached. */
  reachable: boolean
  git: WorkspaceGit | null
  /** Its archive is newer than its last activity. */
  archived: boolean
}

const UNPUSHED = /^no (\d+) unpushed commits?$/

/**
 * A task's verdict, the same rules as the janitor and the failed-resize cleanup: no running agent, no queued turn,
 * and nothing only the box has, unless its PR is merged and its branch fully pushed (then stray uncommitted files
 * are archived with the rest). A workspace that can't be checked holds the box too.
 */
export function deleteVerdict(t: VerdictInput): { verdict: BoxDeleteVerdict; detail: string } {
  if (t.running || t.status === "starting" || t.status === "working") return { verdict: "running", detail: "an agent is running on it" }
  if (t.wantsTurn) return { verdict: "queued", detail: t.status === "queued" ? "queued for its next turn" : "has queued messages waiting for a turn" }
  const merged = t.prState === "merged"
  const archive = t.archived ? "its archive is up to date" : "archived first"
  if (!t.reachable) return { verdict: "unchecked", detail: "the box didn't answer, so its workspace couldn't be checked" }
  const full = t.git?.full ?? null
  if (!full) return { verdict: "unchecked", detail: "its workspace couldn't be checked" }
  if (full === "yes") return { verdict: "ok", detail: merged ? "PR merged and nothing unpushed: needs no archive" : `nothing uncommitted or unpushed; ${archive}` }
  if (full === "no no work folder") return { verdict: "ok", detail: "no workspace on the box" }
  if (full === "no not a git repo" && !t.hasRepo) return { verdict: "ok", detail: `no repo, so its folder only lives on the box; ${archive}` }
  const commits = UNPUSHED.exec(full) ?? UNPUSHED.exec(t.git?.committed ?? "")
  const n = commits ? Number(commits[1]) : 0
  const unpushed = `${n} unpushed ${n === 1 ? "commit" : "commits"}`
  if (full === "no uncommitted changes" || full === "no stashed changes") {
    const what = full === "no stashed changes" ? "stashed changes" : "uncommitted changes"
    if (commits) return { verdict: "unpushed", detail: `${unpushed} and ${what}` }
    if (merged && t.git?.committed === "yes") return { verdict: "ok", detail: `PR merged and its branch fully pushed; the leftover ${what} are ${t.archived ? "in its archive" : "archived first"}` }
    return { verdict: "dirty", detail: `${what}${t.git?.changed ? ` (${t.git.changed} ${t.git.changed === 1 ? "file" : "files"})` : ""} and ${t.prState ? `its PR is ${t.prState}` : "no PR"}` }
  }
  if (commits) return { verdict: "unpushed", detail: unpushed }
  return { verdict: "unchecked", detail: `can't tell what's unpushed: ${full.replace(/^no /, "")}` }
}

type CheckedTask = BoxContents["tasks"][number]

/** What TaskManager.destroyBox did. */
export interface BoxDeleteResult {
  boxId: string
  kind: "box" | "pod"
  label: string
  /** Tasks whose workspace went into (or already had) a fresh archive. */
  archived: string[]
  /** Merged and fully pushed: GitHub has all of it, so no archive (their next message starts from a recap). */
  fromGitHub: string[]
  /** It was already deleted or gone at the provider: only Box Yard's records were dropped. */
  alreadyGone?: boolean
}

/** One refusal line per task that holds the box: `task_x "Title": 2 unpushed commits`. */
export const refusalLine = (t: Pick<CheckedTask, "id" | "title" | "detail">) => `${t.id} "${t.title}": ${t.detail}`

/** Every reason delete_box refuses a box: what keeps it busy, then each task that isn't "ok". */
export function refusalsOf(busy: string | null, tasks: Pick<CheckedTask, "id" | "title" | "detail" | "verdict">[]): string[] {
  return [...(busy ? [busy] : []), ...tasks.filter((t) => t.verdict !== "ok").map(refusalLine)]
}

/** Tasks Cody can delete past with "Delete anyway" (running agents are stopped instead, never overridden). */
export const atRisk = (c: Pick<BoxContents, "tasks">) => c.tasks.filter((t) => t.verdict !== "ok" && t.verdict !== "running")

/** "box_x · tiny-town" or "GPU pod #1 · vision · runpod-prj_x · vision": what a box is and whose work is on it. */
export function boxHead(c: Pick<BoxContents, "boxId" | "label" | "tasks">, projectName: (id: string) => string): string {
  const projects = [...new Set(c.tasks.map((t) => t.projectId))].map(projectName)
  return [c.label, ...(c.label !== c.boxId ? [c.boxId] : []), ...(projects.length ? [projects.join(", ")] : [])].join(" · ")
}

/**
 * One line for a box in delete_idle_boxes: label, projects, and its tasks grouped by what happens to them.
 * "box_x · tiny-town · 3 tasks: 2 PR merged and nothing unpushed: needs no archive; 1 archived first".
 */
export function boxSummary(c: BoxContents, projectName: (id: string) => string): string {
  const head = boxHead(c, projectName)
  if (!c.tasks.length) return `${head} · no tasks`
  const groups = new Map<string, number>()
  for (const t of c.tasks) groups.set(t.detail, (groups.get(t.detail) ?? 0) + 1)
  return `${head} · ${c.tasks.length} ${c.tasks.length === 1 ? "task" : "tasks"}: ${[...groups].map(([d, n]) => `${n} ${d}`).join("; ")}`
}

/** Run `fn` over `items`, at most `limit` at a time, in order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// Items for the command palette (Cmd+K), built from data the app already has. Ranking lives in paletteRank.ts.
import { describeCron } from "../../../shared/cron"
import type { Artifact, BoxInfo, Project, Schedule, Task, TaskStatus } from "../../../shared/types"
import { badgeStatus, prNumber, prStateOf, type BadgeStatus } from "./prState"
import type { PreviewItem } from "./filePreview"
import { ZEN_SHORTCUT_LABEL } from "./zen"

export type PaletteKind = "action" | "page" | "task" | "pr" | "project" | "schedule" | "artifact" | "box"

/** Dialogs the palette opens itself instead of navigating. */
export type PaletteCommand = "settings" | "new-project" | "zen"

export interface PaletteItem {
  /** Unique across kinds: `<kind>:<id>`. */
  key: string
  kind: PaletteKind
  title: string
  subtitle?: string
  /** Matched as strongly as the title (a file's name, a PR's number). */
  names?: string[]
  /** Matched like the title, ranked lower (ids, repos). */
  aliases?: string[]
  /** Matched without fuzzy hits, ranked lowest (project name, summary). */
  details?: string[]
  /** Matched only by multi-word queries, e.g. "box-yard failed" (project name, status). */
  keywords?: string[]
  /** In-app route to open. */
  href?: string
  /** Absolute URL to open in a new tab (artifact files). */
  url?: string
  /** Another site the row links to on the side, e.g. the PR on GitHub. */
  externalUrl?: string
  /** The file behind `url`, so Enter can open it in the preview modal. */
  file?: PreviewItem
  command?: PaletteCommand
  /** A task's pill: its status, or "merged" when it is done because its PR merged. */
  status?: BadgeStatus
  /** A task's raw status, for the empty-query sections and the active boost. */
  taskStatus?: TaskStatus
  /** Last activity, for the recency boost and tie-breaks. */
  at?: number
}

const STATUS_WORDS: Record<TaskStatus, string> = {
  queued: "queued",
  starting: "starting",
  working: "working",
  needs_input: "needs you input question",
  waiting: "waiting",
  idle: "idle",
  pr_ready: "pr ready review",
  done: "done",
  failed: "failed error",
}

export interface PaletteData {
  tasks?: Task[]
  projects?: Project[]
  schedules?: Schedule[]
  artifacts?: Artifact[]
  boxes?: BoxInfo[]
}

export const PAGES: PaletteItem[] = [
  { key: "page:yard", kind: "page", title: "Yard", subtitle: "Every task, grouped by status", href: "/", aliases: ["home"] },
  { key: "page:inbox", kind: "page", title: "Inbox", subtitle: "Questions, PRs to review, failures", href: "/inbox" },
  { key: "page:boxes", kind: "page", title: "Boxes", subtitle: "The box pool and what runs where", href: "/boxes" },
  { key: "page:schedules", kind: "page", title: "Schedules", subtitle: "Recurring jobs", href: "/schedules", aliases: ["cron"] },
  { key: "page:usage", kind: "page", title: "$ Usage", names: ["Usage"], subtitle: "Spend by agent, project and box", href: "/usage", aliases: ["cost", "spend"] },
  { key: "page:settings", kind: "page", title: "Settings", subtitle: "Models, effort, compaction, pool limits", command: "settings", aliases: ["preferences"] },
]

/** Everything the palette can find, built from data the app already has in its query cache. */
export function buildItems(data: PaletteData): PaletteItem[] {
  const projects = data.projects ?? []
  const projectName = new Map(projects.map((p) => [p.id, p.name]))
  const items: PaletteItem[] = [...PAGES]

  for (const t of data.tasks ?? []) {
    const project = projectName.get(t.projectId)
    items.push({
      key: `task:${t.id}`,
      kind: "task",
      title: t.title,
      subtitle: project,
      aliases: [t.id],
      details: [project ?? "", t.summary ?? ""],
      keywords: [project ?? "", STATUS_WORDS[t.status], ...(t.prUrl ? [`pr ${t.prState ?? "open"}`] : [])],
      href: `/tasks/${t.id}`,
      status: badgeStatus(t),
      taskStatus: t.status,
      at: t.updatedAt,
    })
    const n = prNumber(t.prUrl)
    if (t.prUrl && n) {
      // PRs are only searched with the # prefix; a task's own row already covers it otherwise.
      items.push({
        key: `pr:${t.id}`,
        kind: "pr",
        title: t.title,
        subtitle: [`#${n}`, project, prStateOf(t)].filter(Boolean).join(" · "),
        names: [n, `#${n}`],
        aliases: [t.id],
        details: [project ?? ""],
        href: `/tasks/${t.id}`,
        externalUrl: t.prUrl,
        status: badgeStatus(t),
        taskStatus: t.status,
        at: t.updatedAt,
      })
    }
  }

  for (const p of projects) {
    items.push({
      key: `project:${p.id}`,
      kind: "project",
      title: p.name,
      subtitle: p.repo ?? p.description,
      aliases: [p.id, ...(p.repo ? [p.repo, p.repo.split("/").pop()!] : [])],
      details: [p.description],
      keywords: [p.description],
      href: `/projects/${p.id}`,
      at: p.updatedAt,
    })
  }

  for (const s of data.schedules ?? []) {
    const target = s.target === "orchestrator" ? "Coordinator" : (projectName.get(s.projectId ?? "") ?? "Project")
    items.push({
      key: `schedule:${s.id}`,
      kind: "schedule",
      title: s.name,
      subtitle: `${target} · ${describeCron(s.cron)}${s.enabled ? "" : " · paused"}`,
      aliases: [s.id],
      keywords: [target],
      href: s.target === "project" && s.projectId ? `/projects/${s.projectId}?tab=schedules#${s.id}` : `/schedules#${s.id}`,
      at: s.lastRunAt ?? s.updatedAt,
    })
  }

  for (const a of data.artifacts ?? []) {
    items.push({
      key: `artifact:${a.id}`,
      kind: "artifact",
      title: a.title,
      subtitle: [a.projectId ? projectName.get(a.projectId) : null, a.filename].filter(Boolean).join(" · "),
      names: [a.filename],
      details: [a.projectId ? (projectName.get(a.projectId) ?? "") : ""],
      url: a.url,
      file: { url: a.url, name: a.filename, size: a.size, mime: a.mime, title: a.title },
      at: a.createdAt,
    })
  }

  for (const b of data.boxes ?? []) {
    items.push({
      key: `box:${b.id}`,
      kind: "box",
      title: b.id,
      subtitle: `${b.status} · ${b.runningTurns}/${b.slots} running${b.projects.length ? ` · ${b.projects.join(", ")}` : ""}`,
      keywords: b.projects,
      href: `/boxes#${b.id}`,
      at: b.lastUsedAt,
    })
  }

  items.push(...buildActions(projects))
  return items
}

export function buildActions(projects: Project[]): PaletteItem[] {
  return [
    ...projects.map<PaletteItem>((p) => ({
      key: `action:new-task:${p.id}`,
      kind: "action",
      title: `New task in ${p.name}…`,
      href: `/projects/${p.id}?new=task`,
    })),
    { key: "action:new-schedule", kind: "action", title: "New schedule…", href: "/schedules?new=schedule" },
    { key: "action:new-project", kind: "action", title: "New project…", command: "new-project" },
    { key: "action:settings", kind: "action", title: "Open settings", command: "settings" },
    {
      key: "action:zen",
      kind: "action",
      title: "Zen mode",
      subtitle: `Just the Coordinator chat, full screen · ${ZEN_SHORTCUT_LABEL} toggles, Esc leaves`,
      command: "zen",
      aliases: ["focus", "fullscreen", "coordinator"],
    },
  ]
}

/** Item key for a route the user viewed, if it is one the palette remembers. */
export function recentKeyFor(path: string): string | null {
  const m = /^\/(tasks|projects)\/([^/?#]+)/.exec(path)
  if (!m) return null
  return `${m[1] === "tasks" ? "task" : "project"}:${decodeURIComponent(m[2]!)}`
}

/** Moves `key` to the front of the recent list, keeping it short. */
export function pushRecent(list: string[], key: string, max = 20): string[] {
  return [key, ...list.filter((k) => k !== key)].slice(0, max)
}

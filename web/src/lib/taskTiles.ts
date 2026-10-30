// What a task's tile and a project's dot need (components/TaskIcon.tsx): each task's title, icon and project, and
// each project's colour (shared/projectColors.ts). One store for the whole app, fed by the query cache, so a chat
// with hundreds of tiles has one listener on it rather than one query each, and a tile re-renders only when a task
// is added or renamed, gets an icon, or a project is renamed or recoloured: never on a status update.
import { useSyncExternalStore } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { keys } from "./queries"
import { projectColors, type ProjectColor } from "../../../shared/projectColors"
import { taskIcon, type TaskIconName } from "../../../shared/taskIcons"
import type { Project, Task } from "../../../shared/types"

export interface TileInfo {
  id: string
  title: string
  projectId: string
  projectName: string
  icon: TaskIconName
  color: ProjectColor
}

export interface Tiles {
  tasks: ReadonlyMap<string, TileInfo>
  colors: ReadonlyMap<string, ProjectColor>
}

/** Every task's tile and every project's colour, from the lists as they are. Pure, so it is unit tested. */
export function buildTiles(tasks: readonly Task[], projects: readonly Project[]): Tiles {
  const colors = projectColors(projects)
  const names = new Map(projects.map((p) => [p.id, p.name]))
  const out = new Map<string, TileInfo>()
  for (const t of tasks) {
    const color = colors.get(t.projectId)
    if (!color) continue
    out.set(t.id, { id: t.id, title: t.title, projectId: t.projectId, projectName: names.get(t.projectId) ?? "", icon: taskIcon(t), color })
  }
  return { tasks: out, colors }
}

/** What the tiles depend on: a status update leaves it the same. */
const signature = (tasks: readonly Task[], projects: readonly Project[]) =>
  projects.map((p) => `${p.id}\t${p.name}\t${p.color ?? ""}\t${p.createdAt}`).join("\n") + "\u0000" + tasks.map((t) => `${t.id}\t${t.projectId}\t${t.title}\t${t.icon ?? ""}`).join("\n")

const EMPTY: Tiles = { tasks: new Map(), colors: new Map() }
const NO_TASKS: Task[] = []
const NO_PROJECTS: Project[] = []

let client: QueryClient | null = null
let unsubscribe: (() => void) | null = null
let seen: { tasks: unknown; projects: unknown } = { tasks: undefined, projects: undefined }
let sig = ""
let current: Tiles = EMPTY
const listeners = new Set<() => void>()

/** Rebuild when the lists' signature changes; tell the tiles. */
function refresh(): boolean {
  if (!client) return false
  const tasks = client.getQueryData<Task[]>(keys.tasks) ?? NO_TASKS
  const projects = client.getQueryData<Project[]>(keys.projects) ?? NO_PROJECTS
  if (tasks === seen.tasks && projects === seen.projects) return false
  seen = { tasks, projects }
  const next = signature(tasks, projects)
  if (next === sig) return false
  sig = next
  current = buildTiles(tasks, projects)
  return true
}

function attach(qc: QueryClient) {
  if (client === qc) return
  unsubscribe?.()
  client = qc
  seen = { tasks: undefined, projects: undefined }
  sig = ""
  current = EMPTY
  refresh()
  unsubscribe = qc.getQueryCache().subscribe((e) => {
    const key = e.query.queryKey[0]
    if (key !== keys.tasks[0] && key !== keys.projects[0]) return
    if (refresh()) for (const l of listeners) l()
  })
}

const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
const snapshot = () => current

/** Every task's tile and every project's colour; the same object until one of them changes. */
export function useTiles(): Tiles {
  attach(useQueryClient())
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** One task's tile, or undefined for a task the app doesn't have (yet). */
export function useTaskTile(id: string | null | undefined): TileInfo | undefined {
  const tiles = useTiles()
  return id ? tiles.tasks.get(id) : undefined
}

/** One project's colour. */
export function useProjectColor(projectId: string | null | undefined): ProjectColor | undefined {
  const tiles = useTiles()
  return projectId ? tiles.colors.get(projectId) : undefined
}

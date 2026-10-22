// The entity index behind chat deep links, kept cheap for long threads: components re-render only when an entity
// is added, removed or renamed (not on every status update), and hover hints are read from the cache on demand.
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api } from "./api"
import { keys } from "./queries"
import { buildEntityIndex, refForHref, type EntityIndex } from "./linkify"
import type { Artifact, BoxInfo, Project, Schedule, Task, TaskStatus } from "../../../shared/types"

type Entity = { id: string }
const sources = [
  { key: keys.tasks, url: "/api/tasks", sig: (t: Entity) => `${t.id}\t${(t as Task).title}` },
  { key: keys.projects, url: "/api/projects", sig: (p: Entity) => `${p.id}\t${(p as Project).name}` },
  { key: keys.schedules, url: "/api/schedules", sig: (s: Entity) => `${s.id}\t${(s as Schedule).name}` },
  { key: keys.artifacts, url: "/api/artifacts", sig: (a: Entity) => `${a.id}\t${(a as Artifact).url}` },
  { key: keys.boxes, url: "/api/boxes", sig: (b: Entity) => b.id },
] as const
// Stable select functions, so react-query only re-renders when a signature string changes.
const selects = sources.map((s) => (list: Entity[]) => list.map(s.sig).join("\n"))

function cached(qc: QueryClient) {
  const [tasks, projects, schedules, artifacts, boxes] = sources.map((s) => qc.getQueryData<Entity[]>(s.key))
  return { tasks, projects, schedules, artifacts, boxes } as {
    tasks?: Task[]
    projects?: Project[]
    schedules?: Schedule[]
    artifacts?: Artifact[]
    boxes?: BoxInfo[]
  }
}

let shared: { sig: string; index: EntityIndex } | null = null

/**
 * One index for every message on screen; the same object until an entity is added, removed or renamed.
 * Its hints may be stale (status changes don't rebuild it), so show hintForHref instead.
 */
export function useEntityIndex(): EntityIndex {
  const qc = useQueryClient()
  const sig = sources
    .map((s, i) => useQuery({ queryKey: s.key, queryFn: () => api<Entity[]>(s.url), select: selects[i] }).data ?? "")
    .join("\u0000")
  if (!shared || shared.sig !== sig) shared = { sig, index: buildEntityIndex(cached(qc)) }
  return shared.index
}

let fresh: { inputs: unknown[]; index: EntityIndex } | null = null

/** The hover hint for an in-app href, from what is in the cache right now (e.g. the task's current status). */
export function hintForHref(qc: QueryClient, href: string, statusLabel: (s: TaskStatus) => string): string | null {
  const data = cached(qc)
  const inputs = Object.values(data)
  if (!fresh || inputs.some((v, i) => v !== fresh!.inputs[i])) fresh = { inputs, index: buildEntityIndex(data, statusLabel) }
  const ref = refForHref(href, fresh.index)
  return ref ? `${ref.hint}\n${ref.id}` : null
}

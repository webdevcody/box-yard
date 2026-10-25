// Turns mentions of Box Yard entities (task, project, schedule and artifact ids, box ids, artifact paths, and
// bold task titles) in rendered markdown into in-app links. Pure, so it is unit tested.
import type { InlineCode, Link, Nodes, Parent, PhrasingContent, Root, Strong, Text } from "mdast"
import type { Artifact, BoxInfo, Project, Schedule, Task, TaskStatus } from "../../../shared/types"

export type EntityKind = "task" | "project" | "schedule" | "artifact" | "box"

export interface EntityRef {
  kind: EntityKind
  id: string
  href: string
  /** Title or name, for showing instead of the id. */
  label: string
  /** Hover hint, e.g. the task title and status. */
  hint: string
  /** A task's project. */
  projectId?: string
}

export interface EntityIndex {
  byId: Map<string, EntityRef>
  /** Task titles that exactly one task has, so a bold title can link to it. */
  byTitle: Map<string, EntityRef>
  /** Project and schedule names (`project:<name>`, `schedule:<name>`) that only one has. Tools accept names for ids. */
  byName: Map<string, EntityRef>
  /** Global regex for every token worth a look: prefixed ids, known box ids and /artifacts/ paths. */
  pattern: RegExp
}

/** The app's routes for each kind of entity. Schedules and boxes are anchors on their list pages. */
export const routes = {
  task: (id: string) => `/tasks/${id}`,
  project: (id: string) => `/projects/${id}`,
  schedule: (id: string) => `/schedules#${id}`,
  box: (id: string) => `/boxes#${encodeURIComponent(id)}`,
}

const PREFIXED_ID = "(?:task|prj|sch|art)_[A-Za-z0-9-]{6,40}"
// A server-hosted file. Trailing punctuation is left out so "see /artifacts/art_x/a.html." works.
const ARTIFACT_PATH = "/artifacts/[A-Za-z0-9_-]+/(?:[^\\s<>()\"'`]*[^\\s<>()\"'`.,;:!?])?"

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function buildEntityIndex(
  data: { tasks?: Task[]; projects?: Project[]; schedules?: Schedule[]; artifacts?: Artifact[]; boxes?: BoxInfo[] },
  statusLabel: (s: TaskStatus) => string = (s) => s,
): EntityIndex {
  const byId = new Map<string, EntityRef>()
  const projectNames = new Map((data.projects ?? []).map((p) => [p.id, p.name]))
  for (const p of data.projects ?? []) {
    byId.set(p.id, { kind: "project", id: p.id, href: routes.project(p.id), label: p.name, hint: `Project: ${p.name}${p.repo ? ` (${p.repo})` : ""}` })
  }
  const titleCounts = new Map<string, number>()
  for (const t of data.tasks ?? []) {
    const project = projectNames.get(t.projectId)
    byId.set(t.id, { kind: "task", id: t.id, href: routes.task(t.id), label: t.title, hint: [t.title, statusLabel(t.status), project].filter(Boolean).join(" · "), projectId: t.projectId })
    const title = t.title.trim()
    if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
  }
  for (const s of data.schedules ?? []) {
    byId.set(s.id, { kind: "schedule", id: s.id, href: routes.schedule(s.id), label: s.name, hint: `Schedule: ${s.name} · ${s.enabled ? s.cron : "paused"}` })
  }
  for (const a of data.artifacts ?? []) {
    byId.set(a.id, { kind: "artifact", id: a.id, href: a.url, label: a.title || a.filename, hint: `Artifact: ${a.title || a.filename}` })
  }
  const boxIds: string[] = []
  for (const b of data.boxes ?? []) {
    if (b.id.length < 6 || byId.has(b.id)) continue
    boxIds.push(b.id)
    const tasks = b.residentTasks.length
    byId.set(b.id, { kind: "box", id: b.id, href: routes.box(b.id), label: b.id, hint: `Box · ${b.status} · ${tasks} task${tasks === 1 ? "" : "s"}` })
  }
  const byTitle = new Map<string, EntityRef>()
  for (const t of data.tasks ?? []) {
    const title = t.title.trim()
    if (titleCounts.get(title) === 1) byTitle.set(title, byId.get(t.id)!)
  }
  const byName = new Map<string, EntityRef>()
  const names = new Map<string, number>()
  const named = [...(data.projects ?? []).map((p) => ["project", p.id, p.name]), ...(data.schedules ?? []).map((s) => ["schedule", s.id, s.name])]
  for (const [kind, , name] of named) names.set(`${kind}:${name}`, (names.get(`${kind}:${name}`) ?? 0) + 1)
  for (const [kind, id, name] of named) if (names.get(`${kind}:${name}`) === 1) byName.set(`${kind}:${name}`, byId.get(id!)!)
  // Longest box ids first so one id that prefixes another can't win early.
  const ids = [PREFIXED_ID, ...boxIds.sort((a, b) => b.length - a.length).map(escapeRegExp)].join("|")
  const pattern = new RegExp(`${ARTIFACT_PATH}|(?<![\\w-])(?:${ids})(?![\\w-])`, "g")
  return { byId, byTitle, byName, pattern }
}

/** What a matched token links to, or null for ids nobody knows (those stay plain text). */
export function resolveToken(token: string, index: EntityIndex): EntityRef | null {
  if (token.startsWith("/artifacts/")) {
    const id = token.split("/")[2] ?? ""
    const known = index.byId.get(id)
    return { kind: "artifact", id, href: token, label: known?.label ?? token, hint: known?.kind === "artifact" ? known.hint : "Artifact" }
  }
  return index.byId.get(token) ?? null
}

export type Segment = { text: string; ref?: EntityRef }

/** Split text into plain runs and linkable entity mentions. */
export function splitText(value: string, index: EntityIndex): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of value.matchAll(index.pattern)) {
    const ref = resolveToken(m[0], index)
    if (!ref) continue
    if (m.index > last) out.push({ text: value.slice(last, m.index) })
    out.push({ text: m[0], ref })
    last = m.index + m[0].length
  }
  if (last < value.length) out.push({ text: value.slice(last) })
  return out
}

/** The entity an in-app href points at, for hover hints on links the model wrote itself. */
export function refForHref(href: string, index: EntityIndex): EntityRef | null {
  const m = /^\/(?:(?:tasks|projects|artifacts)\/([^/?#]+)|(?:schedules|boxes)\/?(?:\?[^#]*)?#(.+))/.exec(href)
  const id = m?.[1] ?? m?.[2]
  if (!id) return null
  return index.byId.get(decodeURIComponent(id)) ?? null
}

/**
 * Where a link should go: "app" for SPA routes, "file" for server-hosted paths, "external" for anything else.
 * Absolute links to Box Yard's own origin count as in-app; every other site opens in a new tab (see NewTabLink).
 */
export function linkTarget(href: string, origin?: string): { kind: "app" | "file" | "external"; href: string } {
  let path = href
  if (origin && sameOrigin(href, origin)) {
    path = href.slice(origin.length)
    if (!path.startsWith("/")) path = "/" + path
  }
  if (!path.startsWith("/") || path.startsWith("//")) return { kind: "external", href }
  if (/^\/(?:artifacts|api|uploads)\//.test(path)) return { kind: "file", href: path }
  return { kind: "app", href: path }
}

/** `href` is on `origin` itself: "http://yard.test", "http://yard.test/x", "?q" or "#h" after it, not "http://yard.test.evil". */
function sameOrigin(href: string, origin: string): boolean {
  if (!href.toLowerCase().startsWith(origin.toLowerCase())) return false
  const next = href[origin.length]
  return next === undefined || next === "/" || next === "?" || next === "#"
}

// No title here: hover hints are read fresh from the cache (status changes often), see refForHref.
export interface ClickLike {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
  preventDefault(): void
}

/**
 * Click on a link: in-app hrefs go through the router (no reload). Modified or middle clicks, files and other
 * sites are left to the browser. Returns whether it navigated.
 */
export function followAppLink(e: ClickLike, href: string, navigate: (to: string) => void, origin?: string): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
  const target = linkTarget(href, origin)
  if (target.kind !== "app") return false
  e.preventDefault()
  navigate(target.href)
  return true
}

export type ToolMention = { text: string; ref: EntityRef | null }

/**
 * What an orchestrator tool call is about, for its line in the chat: the tasks, schedules or projects in its
 * input (ids or names), or the entity it created (`resultId`, recorded by the server from the tool result).
 */
export function toolMentions(tool: string, input: Record<string, unknown>, resultId: string | null, index: EntityIndex): ToolMention[] {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  const mention = (kind: EntityKind, ref: string | null): ToolMention | null => {
    if (!ref) return null
    const byId = index.byId.get(ref)
    const found = byId?.kind === kind ? byId : kind === "task" ? index.byTitle.get(ref) : index.byName.get(`${kind}:${ref}`)
    return { text: found?.label ?? ref, ref: found ?? null }
  }
  const created = resultId ? index.byId.get(resultId) : undefined
  const out: (ToolMention | null)[] = []
  if (tool === "create_task") out.push(created ? { text: created.label, ref: created } : mention("task", str(input.title)))
  else if (tool === "create_schedule") out.push(created ? { text: created.label, ref: created } : mention("schedule", str(input.name)))
  else if (tool === "create_project") out.push(created ? { text: created.label, ref: created } : mention("project", str(input.name)))
  else {
    out.push(mention("task", str(input.task)))
    if (Array.isArray(input.tasks)) for (const t of input.tasks) out.push(mention("task", str(t)))
    out.push(mention("schedule", str(input.schedule)))
  }
  const found = out.filter((m): m is ToolMention => m !== null)
  // The project only when the call isn't about something more specific (save_note, list_tasks, update_project…).
  if (!found.length) {
    const p = mention("project", str(input.project))
    if (p) found.push(p)
  }
  return found
}

const linkNode = (ref: EntityRef, children: PhrasingContent[]): Link => ({
  type: "link",
  url: ref.href,
  children,
  data: { hProperties: { "data-entity": ref.kind } },
})

function plainText(node: Strong): string | null {
  let s = ""
  for (const c of node.children) {
    if (c.type !== "text") return null
    s += c.value
  }
  return s.trim()
}

function linkChildren(parent: Parent, index: EntityIndex) {
  const next: Nodes[] = []
  for (const node of parent.children as Nodes[]) {
    switch (node.type) {
      // Already links, or raw content: leave alone.
      case "link":
      case "linkReference":
      case "definition":
      case "code":
      case "html":
        next.push(node)
        break
      case "text": {
        const parts = splitText((node as Text).value, index)
        for (const p of parts) next.push(p.ref ? linkNode(p.ref, [{ type: "text", value: p.text }]) : { type: "text", value: p.text })
        break
      }
      case "inlineCode": {
        // `task_…` links when the whole code span is one known id or artifact path.
        const token = (node as InlineCode).value.trim()
        const m = splitText(token, index)
        next.push(m.length === 1 && m[0]?.ref ? linkNode(m[0].ref, [node as InlineCode]) : node)
        break
      }
      case "strong": {
        const title = plainText(node as Strong)
        const ref = title ? index.byTitle.get(title) : undefined
        if (ref) {
          next.push(linkNode(ref, [node as Strong]))
          break
        }
        linkChildren(node as Parent, index)
        next.push(node)
        break
      }
      default:
        if ("children" in node) linkChildren(node as Parent, index)
        next.push(node)
    }
  }
  parent.children = next as Parent["children"]
}

/** remark plugin: `remarkPlugins={[remarkGfm, [remarkEntityLinks, index]]}`. */
export function remarkEntityLinks(index: EntityIndex) {
  return (tree: Root) => {
    linkChildren(tree, index)
  }
}

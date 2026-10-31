// Turns mentions of Box Yard entities (task, project, schedule and artifact ids, box ids, artifact paths, and
// bold task titles) in rendered markdown into in-app links, and GitHub references ("PR #406", "#12",
// "owner/repo#5", "head 8269e827") into links to the repo the text is about. Pure, so it is unit tested.
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
  /** A project's GitHub repo ("owner/repo"), or its project's for a task. */
  repo?: string | null
}

export interface EntityIndex {
  byId: Map<string, EntityRef>
  /** Task titles that exactly one task has, so a bold title can link to it. */
  byTitle: Map<string, EntityRef>
  /** Project and schedule names (`project:<name>`, `schedule:<name>`) that only one has. Tools accept names for ids. */
  byName: Map<string, EntityRef>
  /** Global regex for every token worth a look: prefixed ids, known box ids and /artifacts/ paths. */
  pattern: RegExp
  /** Projects with a GitHub repo, and the words that name them in text (see inferRepo). */
  repos: ProjectRepo[]
}

export interface ProjectRepo {
  repo: string
  /**
   * Its name and the repo's own name, as whole-word patterns. `distinctive` names ("box-yard", "map3") say which
   * project the text is about; a plain word ("health") might just be a word, so it only makes the repo ambiguous.
   */
  names: { pattern: RegExp; distinctive: boolean }[]
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
  const projectRepos = new Map((data.projects ?? []).map((p) => [p.id, githubRepo(p.repo)]))
  const repos: ProjectRepo[] = []
  for (const p of data.projects ?? []) {
    const repo = projectRepos.get(p.id) ?? null
    byId.set(p.id, { kind: "project", id: p.id, href: routes.project(p.id), label: p.name, hint: `Project: ${p.name}${p.repo ? ` (${p.repo})` : ""}`, repo })
    if (repo) {
      const words = [...new Set([p.name.trim(), repo.split("/")[1]!].filter((w) => w.length >= 3))]
      repos.push({ repo, names: words.map((w) => ({ pattern: new RegExp(`(?<![\\w-])${escapeRegExp(w)}(?![\\w-])`), distinctive: /[^A-Za-z]/.test(w) })) })
    }
  }
  const titleCounts = new Map<string, number>()
  for (const t of data.tasks ?? []) {
    const project = projectNames.get(t.projectId)
    byId.set(t.id, { kind: "task", id: t.id, href: routes.task(t.id), label: t.title, hint: [t.title, statusLabel(t.status), project].filter(Boolean).join(" · "), projectId: t.projectId, repo: projectRepos.get(t.projectId) ?? null })
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
  return { byId, byTitle, byName, pattern, repos }
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

/** Whether a link leaves Box Yard: it opens in a new tab and shows the ↗ mark (ExternalMark in ui.tsx). */
export const isExternal = (href: string, origin?: string) => linkTarget(href, origin).kind === "external"

export interface GithubRef {
  owner: string
  repo: string
  kind: "pull" | "issue"
  number: number
}

/** A GitHub pull request or issue URL ("https://github.com/o/r/pull/154/files#x" too), else null. */
export function githubRef(href: string): GithubRef | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:[/?#]|$)/i.exec(href)
  if (!m) return null
  return { owner: m[1]!, repo: m[2]!, kind: m[3]!.toLowerCase() === "pull" ? "pull" : "issue", number: Number(m[4]) }
}

/** How many characters of a commit SHA show: git's own short form. The link and its tooltip keep the whole SHA. */
export const SHORT_SHA = 7

/** A whole SHA-1 or SHA-256 in prose (40 or 64 hex digits, with a digit and a letter, so a hex word doesn't count). */
const LONG_SHA = /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])([0-9a-f]{40}|[0-9a-f]{64})(?![\w-])/g

/** A commit SHA as it reads: its first SHORT_SHA characters. */
export const shortSha = (sha: string) => sha.slice(0, SHORT_SHA)

/** Plain text with every whole commit SHA cut to its short form ("ff8fc2305ab9…" → "ff8fc23"). */
export const shortShas = (text: string) => text.replace(LONG_SHA, (sha) => shortSha(sha))

/** How a raw GitHub PR, issue or commit URL reads: "PR #154", "owner/repo#154", "ff8fc23". Null for every other link. */
export function shortGithubLabel(href: string): string | null {
  const ref = githubRef(href)
  if (!ref) {
    const commit = /^https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/commit\/([0-9a-f]{7,64})(?:[/?#]|$)/i.exec(href)
    return commit ? shortSha(commit[1]!) : null
  }
  return ref.kind === "pull" ? `PR #${ref.number}` : `${ref.owner}/${ref.repo}#${ref.number}`
}

/** A project's repo as "owner/repo" when it's on github.com ("owner/repo", an https or git@ URL), else null. */
export function githubRepo(repo: string | null | undefined): string | null {
  const m = /^(?:(?:https?:\/\/(?:www\.)?|git@)github\.com[/:])?([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(repo?.trim() ?? "")
  return m ? `${m[1]}/${m[2]}` : null
}

// GitHub references in prose, in the order a match is tried at one spot:
// "owner/repo#12" (always its own repo); "PR #406", "PR#406", "pull request #406"; a bare "#12"; a commit SHA right
// after "head", "commit", "as", "squash"... ("(head 8269e827)", "squash-merged as 1a2b3c4"). Numbers start at 1,
// so "#0f0" or "#000" (colours) never match; neither do "#abc" anchors, "C#1", "/#12" or "&#123".
const GH_TEXT = new RegExp(
  [
    String.raw`(?<![\w./-])(?<owner>[A-Za-z0-9][A-Za-z0-9-]{0,38})/(?<name>[\w.-]{1,100})#(?<xn>[1-9]\d{0,6})(?![\w-])`,
    String.raw`(?<![\w-])(?:PRs?|[Pp]ull [Rr]equests?) ?#(?<pn>[1-9]\d{0,6})(?![\w-])`,
    String.raw`(?<![\w&#/\\-])#(?<n>[1-9]\d{0,6})(?![\w-])`,
    String.raw`(?<=(?<![\w-])(?:[Hh]ead|HEAD|[Cc]ommits?|as|[Ss]quash(?:ed|-merged)?|SHA|sha)(?::? +))(?<sha>[0-9a-f]{7,40})(?![\w-])`,
  ].join("|"),
  "g",
)
// "color: #123", "fill #333": a digits-only hex colour.
const COLOUR_BEFORE = /(?:colou?r|background|fill|stroke|border)[\w-]*\s*[:=]?\s*$/i

/** A cheap first look: false means splitGithubRefs would find nothing in `text`. */
export const mayHaveGithubRef = (text: string) => /#[1-9]|[0-9a-f]{7}/.test(text)

/** `label`: how a long commit SHA reads (its short form); `text` is what it stands for in the prose. */
export type GithubSegment = { text: string; url?: string; kind?: "pull" | "issue" | "commit"; label?: string }

/**
 * Splits prose into plain runs and GitHub references, linked to `repo` ("owner/repo"). With no repo (unknown or
 * ambiguous) only explicit "owner/repo#12" links; "#12", "PR #12" and SHAs stay text, since a guess could be wrong.
 * "PR #12" goes to /pull/12; a bare "#12" to /issues/12, which GitHub redirects when it's a PR.
 */
export function splitGithubRefs(text: string, repo: string | null): GithubSegment[] {
  const out: GithubSegment[] = []
  let last = 0
  const push = (start: number, seg: GithubSegment) => {
    if (start > last) out.push({ text: text.slice(last, start) })
    out.push(seg)
    last = start + seg.text.length
  }
  for (const m of text.matchAll(GH_TEXT)) {
    const g = m.groups!
    if (g.xn) {
      if (g.owner === "www" || /^\d+$/.test(g.owner!)) continue
      push(m.index, { text: m[0], url: `https://github.com/${g.owner}/${g.name}/issues/${g.xn}`, kind: "issue" })
    } else if (!repo) continue
    else if (g.pn) push(m.index, { text: m[0], url: `https://github.com/${repo}/pull/${g.pn}`, kind: "pull" })
    else if (g.n) {
      if (COLOUR_BEFORE.test(text.slice(Math.max(0, m.index - 24), m.index))) continue
      push(m.index, { text: m[0], url: `https://github.com/${repo}/issues/${g.n}`, kind: "issue" })
    } else if (g.sha && /\d/.test(g.sha) && /[a-f]/.test(g.sha)) {
      push(m.index, { text: m[0], url: `https://github.com/${repo}/commit/${g.sha}`, kind: "commit", ...(g.sha.length > 12 ? { label: shortSha(g.sha) } : {}) })
    }
  }
  if (!out.length) return [{ text }]
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/**
 * The one repo some text is about, from the Box Yard entities it links (a task, a project) and the projects it names
 * ("box-yard"), or null when there's none or more than one. A plain-word project name ("health") can't pick a repo
 * on its own, only rule one out.
 */
export function inferRepo(refs: EntityRef[], text: string, index: EntityIndex): string | null {
  const picked = new Set<string>()
  const named = new Set<string>()
  for (const r of refs) if (r.repo) picked.add(r.repo)
  for (const p of index.repos) {
    for (const n of p.names) {
      if (!n.pattern.test(text)) continue
      ;(n.distinctive ? picked : named).add(p.repo)
    }
  }
  if (picked.size !== 1) return null
  const [repo] = picked
  return [...named].every((r) => r === repo) ? repo! : null
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

function linkChildren(parent: Parent, index: EntityIndex, found: EntityRef[]) {
  const next: Nodes[] = []
  const link = (ref: EntityRef, children: PhrasingContent[]) => {
    found.push(ref)
    return linkNode(ref, children)
  }
  for (const node of parent.children as Nodes[]) {
    switch (node.type) {
      // Already links, or raw content: leave alone.
      case "link": {
        const ref = refForHref((node as Link).url, index)
        if (ref) found.push(ref)
        next.push(node)
        break
      }
      case "linkReference":
      case "definition":
      case "code":
      case "html":
        next.push(node)
        break
      case "text": {
        const parts = splitText((node as Text).value, index)
        for (const p of parts) next.push(p.ref ? link(p.ref, [{ type: "text", value: p.text }]) : { type: "text", value: p.text })
        break
      }
      case "inlineCode": {
        // `task_…` links when the whole code span is one known id or artifact path.
        const token = (node as InlineCode).value.trim()
        const m = splitText(token, index)
        next.push(m.length === 1 && m[0]?.ref ? link(m[0].ref, [node as InlineCode]) : node)
        break
      }
      case "strong": {
        const title = plainText(node as Strong)
        const ref = title ? index.byTitle.get(title) : undefined
        if (ref) {
          next.push(link(ref, [node as Strong]))
          break
        }
        linkChildren(node as Parent, index, found)
        next.push(node)
        break
      }
      default:
        if ("children" in node) linkChildren(node as Parent, index, found)
        next.push(node)
    }
  }
  parent.children = next as Parent["children"]
}

const githubLinkNode = (seg: GithubSegment): Link => ({
  type: "link",
  url: seg.url!,
  // A short SHA keeps the whole one in its tooltip.
  title: seg.label ? seg.text : null,
  children: [{ type: "text", value: seg.label ?? seg.text }],
  data: { hProperties: { "data-github": seg.kind } },
})

/** GitHub references in a subtree's prose: never in code, raw HTML or a link (entity links included). */
function linkGithub(parent: Parent, repo: string | null) {
  const next: Nodes[] = []
  for (const node of parent.children as Nodes[]) {
    if (node.type === "text") {
      for (const seg of splitGithubRefs(node.value, repo)) next.push(seg.url ? githubLinkNode(seg) : { type: "text", value: seg.text })
      continue
    }
    if ("children" in node && node.type !== "link" && node.type !== "linkReference") linkGithub(node as Parent, repo)
    next.push(node)
  }
  parent.children = next as Parent["children"]
}

const proseText = (node: Nodes): string =>
  node.type === "text" ? node.value : "children" in node && node.type !== "link" ? (node.children as Nodes[]).map(proseText).join(" ") : ""

/**
 * The parts of a message whose repo is worked out on their own when it's "mentions" (a Coordinator reply spans
 * projects): each paragraph, heading, list item and table row. A list item takes its nested lists with it.
 */
function repoUnits(node: Nodes, out: Parent[]) {
  if (node.type === "root" || node.type === "list" || node.type === "blockquote" || node.type === "table" || node.type === "footnoteDefinition") {
    for (const c of node.children as Nodes[]) repoUnits(c, out)
  } else if ("children" in node) out.push(node as Parent)
}

/** Which repo bare "#12", "PR #12" and SHAs link to: a repo ("owner/repo"), MENTIONS, or null to leave them as text. */
export type RepoScope = string | null
/** Work the repo out per paragraph from what it mentions (inferRepo), for text that isn't about one project. */
export const MENTIONS = "mentions"

/**
 * remark plugin: `remarkPlugins={[remarkGfm, [remarkEntityLinks, index, repo]]}`. Links entity mentions, then GitHub
 * references (see splitGithubRefs) to `repo`, a scope's own repo when it's MENTIONS.
 */
export function remarkEntityLinks(index: EntityIndex, repo: RepoScope = null) {
  return (tree: Root) => {
    if (repo !== MENTIONS) {
      linkChildren(tree, index, [])
      linkGithub(tree, repo)
      return
    }
    const units: Parent[] = []
    repoUnits(tree, units)
    for (const unit of units) {
      const found: EntityRef[] = []
      linkChildren(unit, index, found)
      linkGithub(unit, inferRepo(found, proseText(unit as Nodes), index))
    }
  }
}

/**
 * The GitHub repo of what some text belongs to: the task's project's repo, else the project's (a task the index
 * doesn't know, e.g. deleted). Null when neither has a GitHub repo.
 */
export function repoOf(taskId: string | null | undefined, projectId: string | null | undefined, index: EntityIndex): string | null {
  const task = taskId ? index.byId.get(taskId) : undefined
  if (task?.kind === "task") return task.repo ?? null
  const project = projectId ? index.byId.get(projectId) : undefined
  return project?.kind === "project" ? (project.repo ?? null) : null
}

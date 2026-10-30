// Which repo the text under a component is about, so <Markdown> can link "PR #406", "#12" and "head 8269e827" to it
// (lib/linkify.ts splitGithubRefs). Set with <RepoScope> (ui.tsx) where a chat, card or notice knows its task or
// project; with none set, only an explicit "owner/repo#12" links.
import { createContext, useContext } from "react"
import { MENTIONS, repoOf, type EntityIndex, type RepoScope } from "./linkify"

/** "task:<id>", "project:<id>" (both, space separated, when a notice has both), MENTIONS, or null. A string, so it's stable. */
export const RepoContext = createContext<string | null>(null)

export function repoScopeKey(scope: { taskId?: string | null; projectId?: string | null; mentions?: boolean }): string | null {
  if (scope.mentions) return MENTIONS
  const parts = [scope.taskId && `task:${scope.taskId}`, scope.projectId && `project:${scope.projectId}`].filter(Boolean)
  return parts.length ? parts.join(" ") : null
}

/** The scope key as linkify's RepoScope: a repo, MENTIONS, or null. */
export function resolveRepoScope(key: string | null, index: EntityIndex): RepoScope {
  if (!key || key === MENTIONS) return key
  const id = (kind: string) => key.split(" ").find((p) => p.startsWith(`${kind}:`))?.slice(kind.length + 1)
  return repoOf(id("task"), id("project"), index)
}

export const useRepoScopeKey = () => useContext(RepoContext)

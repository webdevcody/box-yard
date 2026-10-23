// The task page breadcrumb ("box-yard › task_…"): where the project link goes (back to the project tab used last)
// and what clicking the task id does (copy it). Pure apart from the injected storage/clipboard, so it is unit tested.
import { isPlainClick } from "./filePreview"
import type { ClickLike } from "./linkify"

/** Project tabs a breadcrumb may return to. "tasks" is the default and stays out of the URL. */
export const PROJECT_TABS = ["tasks", "captain", "schedules", "notes", "files", "settings"] as const
export type ProjectTab = (typeof PROJECT_TABS)[number]

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">

export const projectTabKey = (projectId: string) => `boxyard:project-tab:${projectId}`

/** Remembers the tab a project page shows, so the breadcrumb can return to it. */
export function rememberProjectTab(projectId: string, tab: string, store: KV = localStorage) {
  try {
    if (tab === "tasks" || !(PROJECT_TABS as readonly string[]).includes(tab)) store.removeItem(projectTabKey(projectId))
    else store.setItem(projectTabKey(projectId), tab)
  } catch {
    // Storage can be full or blocked; the breadcrumb then goes to the default tab.
  }
}

export function lastProjectTab(projectId: string, store: KV = localStorage): ProjectTab {
  let tab: string | null = null
  try {
    tab = store.getItem(projectTabKey(projectId))
  } catch {
    tab = null
  }
  return (PROJECT_TABS as readonly string[]).includes(tab ?? "") ? (tab as ProjectTab) : "tasks"
}

/** The project page, on `tab` when it isn't the default. */
export function projectCrumbHref(projectId: string, tab: ProjectTab = "tasks"): string {
  const base = `/projects/${encodeURIComponent(projectId)}`
  return tab === "tasks" ? base : `${base}?tab=${tab}`
}

/**
 * Click on the task id: a plain click copies it (and cancels the navigation); Cmd/Ctrl, Shift and middle clicks
 * keep the link's new-tab behavior ("skipped").
 */
export async function copyIdOnClick(
  e: ClickLike,
  id: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined = navigator.clipboard,
): Promise<"copied" | "failed" | "skipped"> {
  if (!isPlainClick(e)) return "skipped"
  e.preventDefault()
  if (!clipboard) return "failed"
  try {
    await clipboard.writeText(id)
    return "copied"
  } catch {
    return "failed"
  }
}

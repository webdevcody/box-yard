// Zen's side panel: in Zen, a link to a task, a Captain or a project opens that page in a panel on the right
// instead of leaving Zen (components/ZenPanel.tsx). Artifacts, files and other sites keep their usual behavior,
// and Cmd/Ctrl, Shift, Alt and middle clicks still open a new tab (wouter's Link and AppLink never navigate on those).
//
// Two wouter seams do it, so every link and card in the chat goes through the same check without each one knowing:
// - the Zen chat sits in a <Router aroundNav={zenAroundNav}>: a navigation to a panel page opens the panel;
// - the panel's pages sit in a <Router hook={useZenPanelLocation}>: their location is the panel's path, so their
//   tabs, filters and links move the panel, and only a link to any other page leaves Zen for it.
//
// One right panel at a time, the newest winning: opening the panel closes the Coordinator's side thread (#167), and
// a side thread opening closes the panel (ZenPanel). A Captain's side thread inside the panel stays inside it.
import { useSyncExternalStore } from "react"
import { navigate as browserNavigate } from "wouter/use-browser-location"
import { linkTarget } from "./linkify"
import { isZenPath } from "./zen"
import { COORDINATOR_CHAT, closeThread } from "./threads"

/** The pages the panel shows: a task, or a project (any tab, the Captain's included). */
const PANEL_PAGE = /^\/(?:tasks|projects)\/[^/?#]+\/?(?:[?#].*)?$/

/** The in-app path an href opens in the panel, or null when it goes anywhere else (the Yard, a file, another site). */
export function panelPath(href: string, origin?: string): string | null {
  const target = linkTarget(href, origin)
  return target.kind === "app" && PANEL_PAGE.test(target.href) ? target.href : null
}

export type PanelPage = { kind: "task" | "project"; id: string; tab: string | null }

/** What a panel path shows: `/projects/prj_x?tab=captain` is the project prj_x on its Captain tab. */
export function panelPage(path: string): PanelPage | null {
  const m = /^\/(tasks|projects)\/([^/?#]+)/.exec(path)
  if (!m) return null
  let id = m[2]!
  try {
    id = decodeURIComponent(id)
  } catch {}
  const tab = new URLSearchParams(/\?([^#]*)/.exec(path)?.[1] ?? "").get("tab")
  return { kind: m[1] === "tasks" ? "task" : "project", id, tab: m[1] === "projects" ? tab : null }
}

// ---------------------------------------------------------------- the open page

/** The panel's page: its path, query and hash, like a URL in the app. */
export interface ZenPanelState {
  path: string
}

let state: ZenPanelState | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export const zenPanelState = () => state

/** Show `path` in the panel (it swaps whatever the panel showed), and close the Coordinator's side thread. */
export function openZenPanel(path: string) {
  state = { path }
  emit()
  closeThread(COORDINATOR_CHAT)
}

export function closeZenPanel() {
  if (!state) return
  state = null
  emit()
}

export function useZenPanel(): ZenPanelState | null {
  return useSyncExternalStore(subscribe, zenPanelState, () => null)
}

/** The task the panel shows, if any (a notification about it counts as seen). */
export function zenPanelTaskId(): string | null {
  const page = state && panelPage(state.path)
  return page?.kind === "task" ? page.id : null
}

/** In Zen, opens a panel page there. Returns whether it did; otherwise navigate as usual. */
export function openInZenPanel(href: string): boolean {
  if (typeof location === "undefined" || !isZenPath(location.pathname)) return false
  const path = panelPath(href, location.origin)
  if (!path) return false
  openZenPanel(path)
  return true
}

type Navigate = (to: string, options?: { replace?: boolean; state?: unknown }) => void

/** The Zen chat's Router `aroundNav`: in Zen, task, Captain and project links open the panel. */
export function zenAroundNav(nav: Navigate, to: string, options?: { replace?: boolean; state?: unknown }) {
  if (!openInZenPanel(to)) nav(to, options)
}

// ---------------------------------------------------------------- the panel pages' location

const pathOf = (p: string) => p.split(/[?#]/)[0]!
const searchOf = (p: string) => /\?([^#]*)/.exec(p)?.[1] ?? ""

/** Inside the panel, a page's own navigation: another panel page stays in the panel, any other page leaves Zen for it. */
export function navigatePanel(to: string, options?: { replace?: boolean; state?: unknown }) {
  const path = panelPath(to, location.origin)
  if (path) return openZenPanel(path)
  closeZenPanel()
  browserNavigate(to, options)
}

/** The panel's open page in full view: leaves Zen for it (back returns to Zen). */
export function openPanelFullView() {
  const path = state?.path
  if (!path) return
  closeZenPanel()
  browserNavigate(path)
}

const currentPath = () => (state ? pathOf(state.path) : "/")
const currentSearch = () => (state ? searchOf(state.path) : "")

/** wouter location hook for the panel's pages: the panel's path in place of the window's. */
export function useZenPanelLocation(): [string, typeof navigatePanel] {
  return [useSyncExternalStore(subscribe, currentPath, currentPath), navigatePanel]
}

export function useZenPanelSearch(): string {
  return useSyncExternalStore(subscribe, currentSearch, currentSearch)
}

useZenPanelLocation.searchHook = useZenPanelSearch

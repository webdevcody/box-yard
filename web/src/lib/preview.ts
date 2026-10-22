// Which file the preview modal shows. The URL is the source of truth (`?preview=art_…` or `?preview=/api/uploads/…`),
// so back closes it and a link can be shared; this store only adds the gallery (the other images next to the
// clicked one) for ←/→. Plain functions, no hooks, so any click handler can open a preview without re-rendering
// the list it sits in.
import { useSyncExternalStore } from "react"
import { previewKey, stepIndex, type PreviewItem } from "./filePreview"

export const PREVIEW_PARAM = "preview"

export interface PreviewState {
  items: PreviewItem[]
  index: number
}

let state: PreviewState | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Marks the history entry openPreview pushed, so closing can go back instead of stacking another entry. */
const MARK = "boxyardPreview"

function urlWith(key: string | null) {
  const url = new URL(window.location.href)
  if (key) url.searchParams.set(PREVIEW_PARAM, key)
  else url.searchParams.delete(PREVIEW_PARAM)
  return url.pathname + url.search + url.hash
}

const marked = () => Boolean((history.state as Record<string, unknown> | null)?.[MARK])

/** Opens `item` in the preview; `gallery` is what ←/→ step through (it should include `item`). */
export function openPreview(item: PreviewItem, gallery: PreviewItem[] = [item]) {
  let index = gallery.findIndex((g) => g.url === item.url)
  const items = index < 0 ? [item] : gallery
  if (index < 0) index = 0
  state = { items, index }
  emit()
  const to = urlWith(previewKey(item.url))
  // Already previewing (a link inside a previewed file): swap in place, so one back still closes it.
  if (new URL(window.location.href).searchParams.has(PREVIEW_PARAM)) history.replaceState(history.state, "", to)
  else history.pushState({ ...(history.state as object | null), [MARK]: true }, "", to)
}

export function closePreview() {
  state = null
  emit()
  if (marked()) history.back()
  else history.replaceState(history.state, "", urlWith(null))
}

/** ←/→ through the gallery, wrapping around. Replaces the URL, so back still closes the preview. */
export function stepPreview(delta: number) {
  if (!state || state.items.length < 2) return
  state = { ...state, index: stepIndex(state.index, delta, state.items.length) }
  emit()
  history.replaceState(history.state, "", urlWith(previewKey(state.items[state.index]!.url)))
}

export function previewState(): PreviewState | null {
  return state
}

export function usePreviewState() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    previewState,
  )
}

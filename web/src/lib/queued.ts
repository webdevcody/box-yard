// Messages sent while the Coordinator, a Captain or an agent is mid-turn (meta.queued, see Store.deliverQueued
// on the server). They show at the bottom, under the live turn, labelled "Queued", until the turn that reads
// them starts. The server then moves them to that moment (new createdAt, meta.queuedAt = when sent), so they
// sit right before that turn's output, after the reply they were typed over, here and after a reload.

type Meta = { meta: Record<string, unknown> | null }

const NONE: never[] = []

export const isQueued = (m: Meta) => m.meta?.queued === true
/** Deleted while queued (Undo can still restore it): not shown. */
const isCancelled = (m: Meta) => m.meta?.cancelled === true

/**
 * The thread without its queued messages, and those; deleted ones are in neither. `settled` is `items` itself
 * when nothing is queued or deleted, so memos hold.
 */
export function splitQueued<T extends Meta>(items: T[]): { settled: T[]; queued: T[] } {
  if (!items.some((m) => isQueued(m) || isCancelled(m))) return { settled: items, queued: NONE }
  const queued = items.filter(isQueued)
  return { settled: items.filter((m) => !isQueued(m) && !isCancelled(m)), queued: queued.length ? queued : NONE }
}

/**
 * Add a message from the server, or update the one with its id. One whose createdAt changed (a queued message
 * being delivered, or our optimistic copy getting the server's time) moves to its place by time.
 */
export function placeMessage<T extends { id: string; createdAt: number }>(list: T[], msg: T): T[] {
  const idx = list.findIndex((m) => m.id === msg.id)
  if (idx === -1) return [...list, msg]
  const next = list.slice()
  if (list[idx]!.createdAt === msg.createdAt) {
    next[idx] = msg
    return next
  }
  next.splice(idx, 1)
  let at = next.length
  while (at > 0 && next[at - 1]!.createdAt > msg.createdAt) at--
  next.splice(at, 0, msg)
  return next
}

/** Our POST's answer replaces only the optimistic copy: by then the live stream may already hold a newer one (delivered). */
export function settleOptimistic<T extends { id: string } & Meta>(list: T[] | undefined, msg: T): T[] {
  if (!list) return [msg]
  const idx = list.findIndex((m) => m.id === msg.id)
  if (idx === -1) return [...list, msg]
  if (!list[idx]!.meta?.pending) return list
  const next = list.slice()
  next[idx] = msg
  return next
}

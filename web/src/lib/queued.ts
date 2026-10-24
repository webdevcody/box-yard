// Messages sent while the Coordinator, a Captain or an agent is mid-turn (meta.queued, see Store.deliverQueued
// on the server). They show at the bottom, under the live turn, labelled "Queued", until the turn that reads
// them starts. The server then moves them to that moment (new createdAt, meta.queuedAt = when sent), so they
// sit right before that turn's output, after the reply they were typed over, here and after a reload.

type Meta = { meta: Record<string, unknown> | null }

const NONE: never[] = []

export const isQueued = (m: Meta) => m.meta?.queued === true

/** The thread without its queued messages, and those. `settled` is `items` itself when nothing is queued, so memos hold. */
export function splitQueued<T extends Meta>(items: T[]): { settled: T[]; queued: T[] } {
  if (!items.some(isQueued)) return { settled: items, queued: NONE }
  return { settled: items.filter((m) => !isQueued(m)), queued: items.filter(isQueued) }
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

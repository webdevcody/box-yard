/** Default cap for an agent reply handed to the orchestrator in one tool result. */
export const REPLY_CAP = 20_000

/**
 * Slice `text` from `offset` to at most `max` chars. When something is left
 * over, end with an explicit marker saying how to read the rest.
 */
export function capReply(text: string, offset = 0, max = REPLY_CAP): string {
  const start = Math.max(0, offset)
  const end = start + max
  if (text.length <= end) return text.slice(start)
  const rest = text.length - end
  return `${text.slice(start, end)}\n[truncated: ${rest} more chars — call get_task with full_reply and offset=${end} to read the rest]`
}

/** A short preview for older transcript lines and notices; always says how to read the full text. */
export function preview(text: string, max: number, hint = "call get_task for the full text"): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)} [truncated: ${text.length - max} more chars — ${hint}]`
}

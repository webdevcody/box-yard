// The "[truncated: N more chars — call get_task …]" markers server/replies.ts adds to shortened replies and notices.
// They tell the model how to read the rest, so the MCP tools keep them; the UI drops them and links the task instead.
// Pure, so it is unit tested.

const MARKER = /\s*\[truncated: \d+ more chars[^\]\n]*\]/g

/** `text` with every truncation marker replaced by "…", and whether it had one. */
export function stripTruncation(text: string): { text: string; truncated: boolean } {
  let truncated = false
  const out = text.replace(MARKER, () => {
    truncated = true
    return "…"
  })
  return { text: out, truncated }
}

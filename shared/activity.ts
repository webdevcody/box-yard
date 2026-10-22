// One-line "what is the agent doing" text for task cards, built from the transcript's latest assistant or tool message.
// Shared so the server (initial task list) and the web client (live task.message events) agree.

const MAX = 200

/** Input keys that say most about a tool call, best first. */
const TOOL_KEYS = ["description", "command", "file_path", "path", "pattern", "url", "query", "prompt", "skill"]

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()
const clip = (s: string) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s)

/** Last 3 path segments: "/workspace/home/…/web/src/App.tsx" → "web/src/App.tsx". */
function shortPath(p: string) {
  const parts = p.split("/").filter(Boolean)
  return parts.length > 3 ? parts.slice(-3).join("/") : p
}

/** The most telling string in a tool's (possibly clipped) JSON input. */
function toolDetail(input: string): string {
  let obj: Record<string, unknown> | null = null
  try {
    const v = JSON.parse(input) as unknown
    if (v && typeof v === "object" && !Array.isArray(v)) obj = v as Record<string, unknown>
  } catch {
    // The runner clips long inputs, so the JSON may be cut off: fall back to the first "key":"value" pairs.
    obj = {}
    for (const [, key = "", value = ""] of input.matchAll(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)/g)) {
      try {
        obj[key] ??= JSON.parse(`"${value}"`)
      } catch {
        obj[key] ??= value
      }
    }
  }
  if (!obj) return oneLine(input)
  for (const key of TOOL_KEYS) {
    const v = obj[key]
    if (typeof v === "string" && v.trim()) return key === "file_path" || key === "path" ? shortPath(v.trim()) : oneLine(v)
  }
  return ""
}

/**
 * The card line for one transcript message, or null when it says nothing useful (other roles, errors, empty text).
 * Tool messages are stored as `${name} ${jsonInput}`; assistant text is markdown, so only its last paragraph is kept.
 */
export function activityLine(role: string, content: string, meta?: Record<string, unknown> | null): string | null {
  if (role === "assistant") {
    const paras = content
      .replace(/```[\s\S]*?```/g, " ")
      .split(/\n\s*\n/)
      .map((p) =>
        oneLine(
          p
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/^\s{0,3}#{1,6}\s+/gm, "")
            .replace(/^\s*(?:[-*+>]|\d+\.)\s+/gm, "")
            .replace(/(\*\*|__|`)/g, ""),
        ),
      )
      .filter(Boolean)
    const last = paras[paras.length - 1]
    return last ? clip(last) : null
  }
  if (role === "tool") {
    if (meta?.error) return null
    const text = content.trim()
    const space = text.indexOf(" ")
    const name = (space < 0 ? text : text.slice(0, space)).replace(/^mcp__\w+?__/, "")
    if (!name) return null
    const detail = space < 0 ? "" : toolDetail(text.slice(space + 1))
    return clip(detail ? `${name}: ${detail}` : name)
  }
  return null
}

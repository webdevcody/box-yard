export const NEXT_STEPS_META_KEY = "nextSteps"

const MAX_STEPS = 4
const MAX_STEP_CHARS = 180

// Each block style: an opener that must start a line, and the whole block from that
// opener to the end of the reply. The block only counts when it is the last opener
// and runs to the very end (trailing whitespace allowed), so a reply that merely
// mentions the marker keeps its text.
const BLOCKS = [
  {
    opener: /^[ \t]*<!--\s*boxyard-next-steps/gim,
    block: /^[ \t]*<!--\s*boxyard-next-steps\s*([\s\S]*?)\s*-->\s*$/i,
    closesEarly: (body: string) => body.includes("-->"),
  },
  {
    opener: /^[ \t]*```\s*boxyard-next-steps/gim,
    block: /^[ \t]*```\s*boxyard-next-steps\s*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/i,
    closesEarly: (body: string) => /^[ \t]*```/m.test(body),
  },
]

export interface ParsedNextSteps {
  content: string
  nextSteps: string[]
}

/** Pull the hidden next-step payload off the end of a model reply. */
export function parseNextSteps(text: string): ParsedNextSteps {
  for (const { opener, block, closesEarly } of BLOCKS) {
    const start = lastIndex(opener, text)
    if (start < 0) continue
    const match = block.exec(text.slice(start))
    if (!match) continue
    const body = match[1] ?? ""
    if (closesEarly(body)) continue
    return { content: text.slice(0, start).trimEnd(), nextSteps: normalizeSteps(body) }
  }
  return { content: text, nextSteps: [] }
}

function lastIndex(re: RegExp, text: string): number {
  let last = -1
  for (const m of text.matchAll(re)) last = m.index ?? last
  return last
}

function normalizeSteps(raw: string): string[] {
  const body = raw.trim()
  if (!body) return []
  const parsed = parseStructured(body)
  // Malformed JSON: drop the block without inventing chips from its raw text.
  if (!Array.isArray(parsed) && /^[[{]/.test(body)) return []
  const values = Array.isArray(parsed) ? parsed : lines(body)
  return [...new Set(values.map(cleanStep).filter(Boolean))].slice(0, MAX_STEPS)
}

function parseStructured(body: string): unknown {
  try {
    const parsed = JSON.parse(body) as unknown
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { next_steps?: unknown }).next_steps)) return (parsed as { next_steps: unknown[] }).next_steps
  } catch {}
  return null
}

function lines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, ""))
}

function cleanStep(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
  return text.length > MAX_STEP_CHARS ? `${text.slice(0, MAX_STEP_CHARS - 1)}…` : text
}

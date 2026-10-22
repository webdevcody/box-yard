export const NEXT_STEPS_META_KEY = "nextSteps"

const MAX_STEPS = 4
const MAX_STEP_CHARS = 180

const BLOCKS = [
  /(?:\r?\n)?<!--\s*boxyard-next-steps\s*([\s\S]*?)\s*-->\s*$/i,
  /(?:\r?\n)?```\s*boxyard-next-steps\s*\r?\n([\s\S]*?)\r?\n```\s*$/i,
]

export interface ParsedNextSteps {
  content: string
  nextSteps: string[]
}

/** Pull the hidden next-step payload off the end of a model reply. */
export function parseNextSteps(text: string): ParsedNextSteps {
  for (const re of BLOCKS) {
    const match = re.exec(text)
    if (!match) continue
    return { content: text.slice(0, match.index).trimEnd(), nextSteps: normalizeSteps(match[1] ?? "") }
  }
  return { content: text, nextSteps: [] }
}

function normalizeSteps(raw: string): string[] {
  const body = raw.trim()
  if (!body) return []
  const parsed = parseStructured(body)
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

/** Context-usage helpers shared by the orchestrator and the task runner path. */

export interface RawUsage {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

/**
 * Tokens in the context right now, from one assistant message's usage: the
 * prompt side of that API call (fresh + cache reads + cache writes) plus what
 * it just wrote, which will be part of the next prompt. The `result` message's
 * own `usage` sums every call in the turn, so it must not be used for this.
 */
export function contextTokens(u: RawUsage | null | undefined): number | null {
  if (!u) return null
  const n = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
  return n > 0 ? n : null
}

/** Window size from a `result` message's modelUsage, if the CLI reported one. */
export function contextWindowOf(modelUsage: Record<string, { contextWindow?: number }> | undefined | null): number | null {
  let best: number | null = null
  for (const v of Object.values(modelUsage ?? {})) if (typeof v?.contextWindow === "number" && v.contextWindow > (best ?? 0)) best = v.contextWindow
  return best
}

const UNIT: Record<string, number> = { "": 1, k: 1e3, m: 1e6 }
const parseAmount = (s: string) => {
  const m = /^([\d.]+)\s*([km]?)$/i.exec(s.trim())
  return m ? Math.round(Number(m[1]) * UNIT[m[2]!.toLowerCase()]!) : null
}

/** Parse `**Tokens:** 16.1k / 1m (2%)` from the output of `claude -p "/context"`. */
export function parseContextReport(text: string): { tokens: number; window: number } | null {
  const m = /Tokens:?\**\s*([\d.]+\s*[km]?)\s*\/\s*([\d.]+\s*[km]?)/i.exec(text)
  if (!m) return null
  const tokens = parseAmount(m[1]!)
  const window = parseAmount(m[2]!)
  return tokens !== null && window ? { tokens, window } : null
}

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}m`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

/**
 * `text` with every known secret value replaced by "[redacted]", and nothing else: for transcripts, where a word
 * after "token" is usually prose (credentials.ts `redact` also catches key shapes, for errors). Longest first, so a
 * secret that contains another is replaced whole; values under 6 characters are left alone.
 */
export function redactValues(text: string, secrets: readonly string[]): string {
  let out = text
  for (const s of [...new Set(secrets.filter((s) => s && s.length >= 6))].sort((a, b) => b.length - a.length)) if (out.includes(s)) out = out.split(s).join("[redacted]")
  return out
}

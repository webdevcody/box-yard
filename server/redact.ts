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

/**
 * A private key block (PEM or OpenSSH) replaced whole, also when it's cut off before its END line, as a clipped tool
 * output is. Its body is what a key holds (base64, PEM headers, line breaks, also as JSON's \n), so a cut-off key
 * takes the text after it only up to the first other character.
 */
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:(?!-----END)(?:[A-Za-z0-9+/=:,\s-]|\\+[nrt]))*(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----)?/g

export function redactPrivateKeys(text: string): string {
  return text.includes("PRIVATE KEY-----") ? text.replace(PRIVATE_KEY_BLOCK, "[redacted private key]") : text
}

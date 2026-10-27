import { randomBytes } from "node:crypto"
import os from "node:os"
import { COMMON_PASSWORDS } from "./commonPasswords.js"

/**
 * The BOXYARD_PASSWORD rules, after NIST SP 800-63B rev 4: a single-factor password needs at least 15 characters,
 * any characters up to any length, no composition rules, and must not be a common or compromised one. Box Yard
 * won't start with a password that breaks one (server/index.ts), and there is no override.
 */
export const MIN_PASSWORD_LENGTH = 15

/** What `./yard password` writes: 18 random bytes as base64url, 24 characters. */
export const GENERATED_PASSWORD_LENGTH = 24

/** Words a Box Yard password must not contain, whatever their case or 1337 spelling. */
const BANNED_WORDS = ["password", "boxyard"]

/** Keyboard rows: a run along one (or across them) is a sequence, not a password. */
const KEYBOARD = "`1234567890-=qwertyuiop[]\\asdfghjkl;'zxcvbnm,./"

let common: Set<string> | undefined
const commonSet = () => (common ??= new Set(COMMON_PASSWORDS))

/** The user this process runs as: a password containing it is guessable from the machine. */
export function machineUsername() {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USER ?? process.env.LOGNAME ?? ""
  }
}

/** Code points, so an emoji or an accented letter is one character, as NIST counts them. */
export const passwordLength = (pw: string) => [...pw].length

const LEET: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i", "|": "l" }
const unleet = (s: string) => s.replace(/[013457@$!|]/g, (ch) => LEET[ch]!)
/** Lowercased, with the common 1337 swaps undone and spaces, dashes and dots dropped: "P@ss-W0rd" → "password". */
const SEPARATORS = /[\s\-_.]/g
const fold = (s: string) => unleet(s.normalize("NFKC").toLowerCase()).replace(SEPARATORS, "")
/** Drop the digits and symbols padding the start and end: "!!monkey2024" → "monkey". */
const unpad = (s: string) => s.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")

/** The shortest p ≤ length/2 the password repeats with ("abcabcabc…" → 3, "aaaa…" → 1), or 0. */
function period(chars: string[]) {
  for (let p = 1; p <= chars.length / 2; p++) {
    if (chars.every((ch, i) => i < p || ch === chars[i - p])) return p
  }
  return 0
}

/** Each character one up (or one down) from the last ("abcdef…", "987654…", "7890123…"), or a keyboard run. */
function isSequence(chars: string[]) {
  const lower = chars.map((c) => c.toLowerCase())
  const joined = lower.join("")
  if (KEYBOARD.includes(joined) || [...KEYBOARD].reverse().join("").includes(joined)) return true
  const step = (a: string, b: string) => {
    // Digits wrap around: 7890123.
    const d = /\d/.test(a) && /\d/.test(b) ? ((Number(b) - Number(a) + 15) % 10) - 5 : b.codePointAt(0)! - a.codePointAt(0)!
    return d === 1 || d === -1 ? d : 0
  }
  const first = step(lower[0]!, lower[1]!)
  return first !== 0 && lower.every((ch, i) => i === 0 || step(lower[i - 1]!, ch) === first)
}

/** `usernames`: the users the server runs as; default the one this process runs as. Deploys add the target's. */
export type PasswordContext = { usernames?: string[] }

/** Why `pw` can't be BOXYARD_PASSWORD, one reason per broken rule; empty when it's fine. Never echoes the password. */
export function passwordProblems(pw: string, opts: PasswordContext = {}): string[] {
  const problems: string[] = []
  const chars = [...pw.normalize("NFKC")]
  const length = passwordLength(pw)
  if (length < MIN_PASSWORD_LENGTH) problems.push(`It's ${length} character${length === 1 ? "" : "s"} long; it needs at least ${MIN_PASSWORD_LENGTH}.`)
  if (!chars.length) return problems

  const lower = pw.normalize("NFKC").toLowerCase()
  const folded = fold(pw)
  // The password itself, then with separators dropped, edge padding stripped and 1337 undone (in either order).
  const plain = lower.replace(SEPARATORS, "")
  const candidates = new Set([lower, plain, unpad(lower), unpad(plain), folded, unleet(unpad(plain)), unpad(folded)].filter((s) => s.length >= 4))
  if ([...candidates].some((s) => commonSet().has(s))) {
    problems.push(
      candidates.has(lower) && commonSet().has(lower)
        ? "It's on the list of common and leaked passwords."
        : "It's a common or leaked password with a few characters changed or added.",
    )
  }

  const p = period(chars)
  if (p === 1) problems.push("It's one character repeated.")
  else if (p > 1) problems.push(`It's the same ${p} characters repeated.`)
  else if (chars.length >= 3 && isSequence(chars)) problems.push(`It's a simple sequence (like "abcdef…", "987654…" or a keyboard row).`)

  for (const word of BANNED_WORDS) {
    if (folded.includes(word)) problems.push(`It contains "${word}".`)
  }
  for (const name of opts.usernames ?? [machineUsername()]) {
    const username = name.trim()
    if (username.length >= 3 && (lower.includes(username.toLowerCase()) || folded.includes(fold(username)))) {
      problems.push(`It contains the username Box Yard runs as (${username}).`)
      break
    }
  }
  return problems
}

/** A fresh random password: 24 URL-safe characters (144 bits), checked against the rules like any other. */
export function generatePassword(opts: PasswordContext = {}): string {
  for (;;) {
    const pw = randomBytes((GENERATED_PASSWORD_LENGTH * 3) / 4).toString("base64url")
    if (!passwordProblems(pw, opts).length) return pw
  }
}

/** The startup refusal: every broken rule, then a strong password and the generator to fix it. */
export function passwordRefusal(problems: string[], opts: PasswordContext = {}): string {
  return [
    `BOXYARD_PASSWORD is too weak:`,
    ...problems.map((p) => `  - ${p}`),
    `A password needs ${MIN_PASSWORD_LENGTH}+ characters and must not be a common or leaked one, a repeated character or pattern,`,
    `a sequence, or contain "password", "boxyard" or the username Box Yard runs as. Any characters are fine, spaces included.`,
    `Fix it: run ./yard password to put a random one in .env, or use a long passphrase of random words. A strong one,`,
    `freshly made for you: ${generatePassword(opts)}`,
    `There's no override. Leave BOXYARD_PASSWORD empty to keep Box Yard on this computer with no login.`,
  ].join("\n")
}

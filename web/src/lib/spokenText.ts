// What every spoken line goes through before a voice reads it: markdown → plain words, with nothing a
// listener can't use. Ids (task_…, prj_…, up_…), URLs, commit SHAs and code never reach the voice: links
// read their text, a GitHub PR link reads "PR 216", any other bare URL "a link". Task titles are cut to a
// few words. Pure, so it is unit tested (test/spoken-text.test.ts); lib/voice.ts builds the lines and
// lib/speech.ts runs every line through spokenText() once more before it is queued.
import { githubRef } from "./linkify"

/** Longest line we speak. Chrome cuts long utterances off, and announcements should be glanceable. */
export const MAX_SPOKEN = 200
/** A task title is cut to about this many words when it's said. */
export const MAX_TITLE_WORDS = 10

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu
/** A bare URL, without the punctuation that ends the sentence around it. */
const URL = String.raw`(?:https?:\/\/|www\.)\S+?(?=[.,;:!?)\]>]*(?:\s|$))`
/** Box Yard's id prefixes (server newId), said nowhere: any tail. */
const ID_PREFIXES = "task|prj|sch|art|ntf|box|run|chat|hook|hrun|cap|sug|note|idn|mch|thr|thm|msg|tool"

/** How a URL reads: "PR 216" / "issue 12" for GitHub, else "a link". */
function spokenUrl(url: string): string {
  const ref = githubRef(url)
  if (!ref) return " a link "
  return ref.kind === "pull" ? ` PR ${ref.number} ` : ` issue ${ref.number} `
}

/** Markdown → plain words a speech engine reads well. Keeps link text; drops code, ids, SHAs and emoji; URLs become "a link". */
export function spokenText(md: string): string {
  let t = md
  t = t.replace(/```[\s\S]*?(```|$)/g, " ") // fenced code
  t = t.replace(new RegExp(String.raw`<(${URL})>`, "gi"), (_m, url: string) => spokenUrl(url)) // <autolinks>
  t = t.replace(/<[^>\n]+>/g, " ") // html tags
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
  t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1") // [text][ref]
  t = t.replace(/`[^`\n]*`/g, " ") // inline code
  // A URL in brackets is a source for the words before it: drop it. Elsewhere it's "a link" (or "PR 216").
  t = t.replace(new RegExp(String.raw`\(\s*${URL}\s*\)`, "gi"), " ")
  t = t.replace(new RegExp(String.raw`\b${URL}`, "gi"), (url) => spokenUrl(url))
  t = t.replace(/(?:^|\s)\/(?:tasks|projects|schedules|boxes|artifacts|uploads)\/\S*/g, " ") // app paths
  t = t.replace(new RegExp(String.raw`\b(?:${ID_PREFIXES})_[A-Za-z0-9-]{4,}\b`, "g"), " ") // ids
  t = t.replace(/\b[a-z]{2,6}_(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{4,}\b/g, " ") // other ids (up_3f9a…): a digit in the tail
  t = t.replace(/\b[0-9a-f]{7,40}\b/g, (m) => (/[a-f]/.test(m) && /\d/.test(m) ? " " : m)) // commit shas
  t = t.replace(EMOJI, " ")
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
  t = t.replace(/^\s{0,3}>\s?/gm, "") // quotes
  t = t.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "") // list markers
  t = t.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ") // table rules
  t = t.replace(/\|/g, ", ")
  t = t.replace(/(\*\*|__|~~)(.+?)\1/g, "$2") // bold, strike
  t = t.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2") // italics
  t = t.replace(/[*_~]{2,}/g, " ")
  // "PR #216" / "PRs #1 and #2" → "PR 216" / "PRs 1 and 2"; "owner/repo#5" and a bare "#30" → "number 30".
  t = t.replace(/\b(PRs?|pull requests?|issues?)\s*(#\d+(?:(?:\s*,\s*|\s+(?:and|or|&)\s+)#\d+)*)/gi, (_m, word: string, refs: string) => `${word} ${refs.replace(/#/g, "")}`)
  t = t.replace(/(^|[\s(])[\w.-]+\/[\w.-]+#(\d+)\b/g, "$1number $2")
  t = t.replace(/(^|[\s(])#(\d+)\b/g, "$1number $2")
  t = t.replace(/\s*(?:→|->)\s*/g, " to ") // small → medium
  t = t.replace(/\b([A-Za-z]+(?:_[A-Za-z]+)+)\b/g, (m) => m.replace(/_/g, " ")) // snake_case → words
  t = t.replace(/\(\s*[,.;:'"]?\s*\)/g, " ") // brackets left empty by removals
  t = t.replace(/(["'])\s*\1/g, " ") // quotes left empty by removals
  t = t.replace(/\s+([,.;:!?])/g, "$1")
  t = t.replace(/([,;:])(?:\s*[,;:])+/g, "$1")
  t = t.replace(/\s+/g, " ").trim()
  t = t.replace(/^[,;:.\s-]+/, "").replace(/[,;:\s-]+$/, "")
  return t
}

/** At most `max` characters, cut at the last word boundary that fits. */
export function capWords(text: string, max = MAX_SPOKEN): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max + 1)
  const space = cut.lastIndexOf(" ")
  return (space > max * 0.5 ? cut.slice(0, space) : text.slice(0, max)).replace(/[,;:\s-]+$/, "")
}

const TRAILING_FILLER = /\s+(?:a|an|and|the|for|of|to|in|on|with|via|from|by|or)$/i

/**
 * A task title as it's said: cleaned like any spoken text, without its (asides), and when it's longer than
 * `maxWords`, cut at a word boundary (at a comma, colon or dash if there is one near the end) with
 * no dangling "of" or "the". Null when nothing speakable is left (a title that was only an id or emoji).
 */
export function spokenTitle(title: string, maxWords = MAX_TITLE_WORDS): string | null {
  let t = spokenText(title.replace(/(?<!\])\s*\([^)]*\)/g, ""))
  const words = t.split(" ").filter(Boolean)
  if (words.length > maxWords) {
    // A clause break (a comma, colon or dash) that keeps at least half the words, and runs at most two
    // past the cap, reads better than a cut mid-phrase.
    let at = -1
    for (let i = Math.ceil(maxWords / 2) - 1; i < Math.min(words.length - 1, maxWords + 2); i++) {
      if (/[,;:]$/.test(words[i]!) || /^[-–—]$/.test(words[i + 1]!)) at = i
    }
    t = words.slice(0, at >= 0 ? at + 1 : maxWords).join(" ")
  }
  t = t.replace(/[,;:.\s–—-]+$/, "")
  while (TRAILING_FILLER.test(t)) t = t.replace(TRAILING_FILLER, "").replace(/[,;:.\s–—-]+$/, "")
  return /[\p{L}\p{N}]/u.test(t) ? t : null
}

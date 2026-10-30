// Whether a Captain's reply to the Coordinator wakes it for a turn. The reply shows on the Coordinator chat at once
// either way; a wake is a whole Coordinator turn (~8 s), and for a reply that's only for Cody's information it just
// restates the reply or says "(no update)". So the Captain marks such a reply FYI, and Box Yard still wakes the
// Coordinator when anything says it should: when unsure, wake.

import { withOwner } from "../shared/owner.js"

/** The hidden line a Captain ends a reply with when the Coordinator has nothing to act on in it. */
export const FYI_MARKER = "<!-- boxyard-coordinator: fyi -->"
const FYI_RE = /<!--\s*boxyard-coordinator:\s*fyi\s*-->/gi

/** The text without the FYI marker, and whether it had one. */
export function takeFyiMarker(text: string): { text: string; fyi: boolean } {
  const stripped = text.replace(FYI_RE, "")
  if (stripped === text) return { text, fyi: false }
  return { text: stripped.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim(), fyi: true }
}

/** Code, links and URLs say nothing about whether the reply needs anyone ("?" in a query string, a branch called fix-error). */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\]\([^)\s]*\)/g, "]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/(?:^|\s)\/[\w./?=&%#-]+/g, " ")
}

const FAILURE = /\b(?:fail(?:s|ed|ing|ures?)?|errors?|errored|blocked|blocking|stuck|crash(?:ed|es|ing)?|broken|can't|cannot|couldn't|unable|denied|timed out|conflicts?)\b/i
const DECISION = /\b(?:decide|decision|approve|approval|confirm|sign[- ]off|your call|which (?:one|option)|should (?:i|we)|do you want|would you like|waiting (?:on|for) (?:you|your))\b/i

/**
 * Why this reply should wake the Coordinator even though the Captain marked it FYI, or null. A question, a decision
 * for Cody, or a failure in the text always wakes it: a wrongly marked reply costs a turn, a wrongly dropped one costs
 * Cody's answer.
 */
export function mustWake(text: string, ownerName?: string): string | null {
  const p = prose(text)
  if (p.includes("?")) return "it asks something"
  if (FAILURE.test(p)) return "it reports a failure"
  if (DECISION.test(p)) return "it holds a decision"
  const owner = withOwner("Cody", ownerName).trim()
  const name = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (owner && new RegExp(`\\b${name}(?:'s)? (?:needs|has) to\\b|\\bneeds? ${name}\\b`, "i").test(p)) return `it needs ${owner}`
  return null
}

export interface WakeInput {
  /** The Captain's turn ended without an error. */
  ok: boolean
  /** The reply, without the marker. */
  text: string
  /** The Captain marked it FYI. */
  fyi: boolean
  /** The Coordinator said it acts on this reply: it passed act_on_reply, or sent the same turn to other Captains too. */
  coordinatorWaits?: boolean
  ownerName?: string
}

/** Whether a Captain's reply (or automatic report) wakes the Coordinator, and why. */
export function captainReplyWakes(r: WakeInput): { wake: boolean; why: string } {
  if (!r.ok) return { wake: true, why: "the Captain's turn failed" }
  if (r.coordinatorWaits) return { wake: true, why: "the Coordinator acts on it" }
  if (!r.fyi) return { wake: true, why: "not marked FYI" }
  const why = mustWake(r.text, r.ownerName)
  return why ? { wake: true, why } : { wake: false, why: "FYI" }
}

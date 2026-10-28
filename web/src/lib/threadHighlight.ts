// The passages that have a side thread, tinted in their message with the CSS Custom Highlight API (no wrapper
// elements, so the memo'd Markdown isn't touched). The open thread's passage gets a stronger tint.

/** Elements whose text isn't part of the message (its toolbar, the thread markers under it). */
const SKIP = "[data-message-actions], [data-thread-markers]"

/** The letters of `text` without any whitespace: a selection's text and the DOM's differ in line breaks and spaces. */
export function squash(text: string): string {
  return text.replace(/\s+/g, "")
}

/** Where `quote` is in `root`'s text, matched ignoring whitespace; null when it isn't there (an edited message). */
export function findQuoteRange(root: Node, quote: string): Range | null {
  const want = squash(quote)
  if (!want) return null
  const nodes: Text[] = []
  const offsets: number[] = []
  let flat = ""
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)),
  })
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const s = n.data
    for (let i = 0; i < s.length; i++) {
      if (/\s/.test(s[i]!)) continue
      flat += s[i]
      nodes.push(n)
      offsets.push(i)
    }
  }
  const at = flat.indexOf(want)
  if (at < 0) return null
  const end = at + want.length - 1
  const range = document.createRange()
  range.setStart(nodes[at]!, offsets[at]!)
  range.setEnd(nodes[end]!, offsets[end]! + 1)
  return range
}

const ranges = new Map<string, Range>()
const open = new Set<string>()
let frame = 0

const supported = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"

function sync() {
  frame = 0
  if (!supported()) return
  const rest: Range[] = []
  const lit: Range[] = []
  for (const [id, r] of ranges) (open.has(id) ? lit : rest).push(r)
  CSS.highlights.set("side-thread", new Highlight(...rest))
  CSS.highlights.set("side-thread-open", new Highlight(...lit))
}
const schedule = () => {
  if (!frame && supported()) frame = requestAnimationFrame(sync)
}

export function setThreadRange(id: string, range: Range | null) {
  if (range) ranges.set(id, range)
  else if (!ranges.delete(id)) return
  schedule()
}

export function threadRange(id: string): Range | null {
  return ranges.get(id) ?? null
}

/** The open thread of a chat, or none: its passage is lit. */
export function setOpenHighlight(id: string, on: boolean) {
  if (on === open.has(id)) return
  if (on) open.add(id)
  else open.delete(id)
  schedule()
}

/** The text position under a point, for "is this click on a highlighted passage". */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const p = doc.caretPositionFromPoint?.(x, y)
  if (p) return { node: p.offsetNode, offset: p.offset }
  const r = doc.caretRangeFromPoint?.(x, y)
  return r ? { node: r.startContainer, offset: r.startOffset } : null
}

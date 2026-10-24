// The "updates since your last turn" list in Coordinator and Captain prompts. An agent that publishes ten
// screenshots leaves ten "📎 **Task** published X: url" notices; back-to-back ones from the same task go into
// the prompt as one line, so the model reads (and pays for) the task once. The chat keeps every notice.

// Matches the notice TaskManager writes for an artifact (server/tasks.ts). A file title may contain ": ".
const PUBLISHED = /^📎 \*\*(.+?)\*\* published ([\s\S]+): (\S+)$/u

/**
 * Fold back-to-back published-file notices from the same task into one:
 * `📎 **Task** published 3 files: Before (url); After (url); Mobile (url)`. Any other notice ends the run,
 * and within a run each task's line stays where its first file was. Everything else passes through as is.
 */
export function batchNotices(notices: readonly string[]): string[] {
  type Entry = { title: string; first: string; files: string[] }
  const out: (string | Entry)[] = []
  let run = new Map<string, Entry>()
  for (const n of notices) {
    const m = n.match(PUBLISHED)
    if (!m) {
      run = new Map()
      out.push(n)
      continue
    }
    const [, title, file, url] = m as unknown as [string, string, string, string]
    let entry = run.get(title)
    if (!entry) {
      entry = { title, first: n, files: [] }
      run.set(title, entry)
      out.push(entry)
    }
    entry.files.push(`${file} (${url})`)
  }
  return out.map((e) => (typeof e === "string" ? e : e.files.length === 1 ? e.first : `📎 **${e.title}** published ${e.files.length} files: ${e.files.join("; ")}`))
}

/** The bulleted updates block a turn's prompt starts with ("" when there are none). */
export function updatesBlock(heading: string, notices: readonly string[]): string {
  return notices.length ? `[${heading}]\n${batchNotices(notices).map((n) => `- ${n}`).join("\n")}` : ""
}

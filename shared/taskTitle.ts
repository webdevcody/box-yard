/** Longest title a task can have (the API's limit). */
export const TASK_TITLE_MAX = 120

/**
 * A task title made from its prompt, for when nobody typed one: the first line with text, without markdown
 * markers, cut at a word boundary to about `max` characters with an ellipsis.
 */
export function titleFromPrompt(prompt: string, max = 72): string {
  const line =
    prompt
      .split("\n")
      .map((l) =>
        l
          .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)+/, "")
          .replace(/[`*_~]+/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find(Boolean) ?? ""
  if (line.length <= max) return line || "New task"
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, "")}…`
}

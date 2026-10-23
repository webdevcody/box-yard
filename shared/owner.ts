/** The human Box Yard works for, as written in its built-in prompts, tool descriptions and labels. */
export const DEFAULT_OWNER_NAME = "Cody"

/**
 * Put the configured owner name into Box Yard's own text. Only use it on
 * templates Box Yard wrote, never on user content (notes, messages, prompts),
 * which may mention the default name for other reasons.
 */
export function withOwner(text: string, name: string | undefined): string {
  const owner = name?.trim()
  if (!owner || owner === DEFAULT_OWNER_NAME) return text
  return text.replace(/\bCody\b/g, () => owner)
}

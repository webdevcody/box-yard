// Project colours: a project's tasks share its colour in the Coordinator chat (task icons, the project bar, card
// edges) and on its sidebar row. The palette skips the colours the app already means something by: yellow (in-app
// links, Box Yard), sky (other sites, working), emerald (open PRs, done), red (failed) and purple (merged).
// A project without a colour of its own (projects.color NULL) gets one from its name, distinct from the others'
// while the palette lasts (projectColors).

export const PROJECT_COLORS = ["teal", "lime", "rose", "indigo", "pink", "fuchsia", "orange", "cyan"] as const
export type ProjectColor = (typeof PROJECT_COLORS)[number]

/** Tailwind's 400 shades: bright enough on zinc-950, and what tints and edges mix from. */
export const PROJECT_COLOR_HEX: Record<ProjectColor, string> = {
  teal: "#2dd4bf",
  lime: "#a3e635",
  rose: "#fb7185",
  indigo: "#818cf8",
  pink: "#f472b6",
  fuchsia: "#e879f9",
  orange: "#fb923c",
  cyan: "#22d3ee",
}

export const isProjectColor = (v: unknown): v is ProjectColor => typeof v === "string" && (PROJECT_COLORS as readonly string[]).includes(v)

/** FNV-1a: a small, stable hash of a string (a name or an id) for picking from a list. */
export function stableHash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Every project's colour: its own when set; otherwise the palette slot its name hashes to, or the next one no
 * project has yet. Oldest first, so a new project never changes an older one's colour. Once every colour is
 * taken, names share them.
 */
export function projectColors(projects: readonly { id: string; name: string; color?: string | null; createdAt: number }[]): Map<string, ProjectColor> {
  const out = new Map<string, ProjectColor>()
  const used = new Set<ProjectColor>()
  for (const p of projects) {
    if (!isProjectColor(p.color)) continue
    out.set(p.id, p.color)
    used.add(p.color)
  }
  const rest = projects.filter((p) => !out.has(p.id)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  for (const p of rest) {
    const start = stableHash(p.name.trim().toLowerCase()) % PROJECT_COLORS.length
    let pick: ProjectColor = PROJECT_COLORS[start]!
    for (let i = 0; i < PROJECT_COLORS.length; i++) {
      const c = PROJECT_COLORS[(start + i) % PROJECT_COLORS.length]!
      if (!used.has(c)) {
        pick = c
        break
      }
    }
    out.set(p.id, pick)
    used.add(pick)
  }
  return out
}

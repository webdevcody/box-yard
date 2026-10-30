// Task icons: a small glyph per task, drawn in its project's colour (shared/projectColors.ts), so a task reads the
// same in a chip, a link, the project bar and its card. create_task can pick one (tasks.icon); a task without one
// gets one from its title's words, else one hashed from its id. The names are lucide's; web/src/components/TaskIcon.tsx
// draws them.
import { stableHash } from "./projectColors.js"

/** What a task's work is about. create_task's `icon` takes one of these. */
export const TASK_ICONS = [
  "bug",
  "wrench",
  "hammer",
  "flask-conical",
  "book-open",
  "pen-line",
  "palette",
  "layers",
  "panel-right",
  "camera",
  "image",
  "film",
  "audio-lines",
  "map",
  "gamepad-2",
  "rocket",
  "cloud",
  "server",
  "database",
  "cpu",
  "gauge",
  "chart-line",
  "circle-dollar-sign",
  "telescope",
  "lightbulb",
  "shield",
  "lock",
  "key-round",
  "plug",
  "link",
  "git-pull-request",
  "terminal",
  "code",
  "package",
  "boxes",
  "settings",
  "toggle-right",
  "bell",
  "mail",
  "message-square",
  "calendar-clock",
  "smartphone",
  "globe",
  "users",
  "heart-pulse",
  "dumbbell",
  "sparkles",
  "list-checks",
  // Shapes: the fallback for a title that names nothing above.
  "moon",
  "star",
  "hexagon",
  "leaf",
  "diamond",
  "triangle",
  "droplet",
  "flame",
  "zap",
  "anchor",
  "mountain",
  "tent",
  "route",
  "radio",
] as const
export type TaskIconName = (typeof TASK_ICONS)[number]

export const isTaskIcon = (v: unknown): v is TaskIconName => typeof v === "string" && (TASK_ICONS as readonly string[]).includes(v)

/** A title's words → its icon; the first rule that matches wins, so the more specific ones go first. */
const RULES: [RegExp, TaskIconName][] = [
  [/\b(bugs?|fix(es|ed)?|broken|crash(es)?|regressions?|flaky)\b/, "bug"],
  [/\b(tests?|vitest|e2e|specs?)\b/, "flask-conical"],
  [/\b(screenshots?|photos?|cameras?|shots?)\b/, "camera"],
  [/\b(design|mockups?|ui|ux|layouts?|styles?|css|themes?|colou?rs?)\b/, "palette"],
  [/\b(docs?|readme|guides?|changelog|write-?ups?)\b/, "book-open"],
  [/\b(maps?|levels?|terrain)\b/, "map"],
  [/\b(game|games|player|enemy|weapons?|zombies?)\b/, "gamepad-2"],
  [/\b(deploy(s|ment)?|releases?|launch|ship)\b/, "rocket"],
  [/\b(research|investigate|explore|compare|survey)\b/, "telescope"],
  [/\b(perf|performance|speed|faster|slow|latency|timing|benchmarks?)\b/, "gauge"],
  [/\b(usage|costs?|billing|spend|price|pricing)\b/, "circle-dollar-sign"],
  [/\b(oauth|auth|login|passwords?|credentials?|secrets?|tokens?|keys?)\b/, "key-round"],
  [/\b(security|sandbox(ing)?|permissions?)\b/, "shield"],
  [/\b(mcp|connectors?|integrations?|plugins?|webhooks?|api)\b/, "plug"],
  [/\b(box|boxes|containers?|docker|pods?)\b/, "boxes"],
  [/\b(database|sqlite|db|migrations?|sql)\b/, "database"],
  [/\b(voice|audio|tts|speech|sounds?)\b/, "audio-lines"],
  [/\b(videos?|youtube|film)\b/, "film"],
  [/\b(mobile|iphone|phones?|ios|android)\b/, "smartphone"],
  [/\b(email|gmail|mail)\b/, "mail"],
  [/\b(notifications?|notify|alerts?|toasts?)\b/, "bell"],
  [/\b(schedules?|cron|daily|weekly|nightly)\b/, "calendar-clock"],
  [/\b(chats?|messages?|threads?|repl(y|ies)|coordinator|captains?)\b/, "message-square"],
  [/\b(settings?|config(uration)?|options?)\b/, "settings"],
  [/\b(toggles?|switch)\b/, "toggle-right"],
  [/\b(prs?|merge|branch(es)?|git|rebase)\b/, "git-pull-request"],
  [/\b(cli|terminal|shell|scripts?)\b/, "terminal"],
  [/\b(deps|dependencies|packages?|npm|upgrade)\b/, "package"],
  [/\b(workouts?|exercise|gym)\b/, "dumbbell"],
  [/\b(health|sleep|diet)\b/, "heart-pulse"],
  [/\b(ideas?|brainstorm)\b/, "lightbulb"],
  [/\b(refactor|cleanup|clean up|tidy|lint)\b/, "sparkles"],
  [/\b(server|backend|endpoints?)\b/, "server"],
  [/\b(memory|cpu|swap)\b/, "cpu"],
  [/\b(charts?|graphs?|metrics|stats|dashboards?)\b/, "chart-line"],
  [/\b(panel|sidebar|drawer)\b/, "panel-right"],
  [/\b(links?|urls?)\b/, "link"],
  [/\b(users?|accounts?|teams?|identit(y|ies))\b/, "users"],
  [/\b(web|site|website|seo|landing)\b/, "globe"],
  [/\b(images?|icons?|logos?|lightbox)\b/, "image"],
  [/\b(todo|checklists?|backlog)\b/, "list-checks"],
]

const SHAPES: readonly TaskIconName[] = ["moon", "star", "hexagon", "leaf", "diamond", "triangle", "droplet", "flame", "zap", "anchor", "mountain", "tent", "route", "radio"]

/** The icon a task without one of its own gets: from its title's words, else one of the shapes, by its id. */
export function defaultTaskIcon(t: { id: string; title: string }): TaskIconName {
  const title = t.title.toLowerCase()
  for (const [re, icon] of RULES) if (re.test(title)) return icon
  return SHAPES[stableHash(t.id) % SHAPES.length]!
}

/** A task's icon: its own, or the default. */
export const taskIcon = (t: { id: string; title: string; icon?: string | null }): TaskIconName => (isTaskIcon(t.icon) ? t.icon : defaultTaskIcon(t))

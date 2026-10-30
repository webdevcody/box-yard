// A task's tile (its icon in its project's colour, shared/taskIcons.ts and shared/projectColors.ts) and a project's
// dot. The same tile marks a task in a chat link, an update chip, a "from:" line and the project bar, so a task
// reads the same wherever it shows up.
import { memo, type CSSProperties } from "react"
import {
  Anchor,
  AudioLines,
  Bell,
  BookOpen,
  Boxes,
  Bug,
  CalendarClock,
  Camera,
  ChartLine,
  CircleDollarSign,
  Cloud,
  Code,
  Cpu,
  Database,
  Diamond,
  Droplet,
  Dumbbell,
  Film,
  Flame,
  FlaskConical,
  Gamepad2,
  Gauge,
  GitPullRequest,
  Globe,
  Hammer,
  HeartPulse,
  Hexagon,
  Image as ImageIcon,
  KeyRound,
  Layers,
  Leaf,
  Lightbulb,
  Link as LinkIcon,
  ListChecks,
  Lock,
  Mail,
  Map as MapIcon,
  MessageSquare,
  Moon,
  Mountain,
  Package,
  Palette,
  PanelRight,
  PenLine,
  Plug,
  Radio,
  Rocket,
  Route,
  Server,
  Settings,
  Shield,
  Smartphone,
  Sparkles,
  Star,
  Telescope,
  Tent,
  Terminal,
  ToggleRight,
  Triangle,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { useProjectColor, useTaskTile } from "../lib/taskTiles"
import { PROJECT_COLOR_HEX, type ProjectColor } from "../../../shared/projectColors"
import type { TaskIconName } from "../../../shared/taskIcons"

// Not ui.tsx's cx: ui.tsx draws task links with TaskTile, so importing it here would be a cycle.
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ")

export const TASK_ICON_COMPONENTS: Record<TaskIconName, LucideIcon> = {
  bug: Bug,
  wrench: Wrench,
  hammer: Hammer,
  "flask-conical": FlaskConical,
  "book-open": BookOpen,
  "pen-line": PenLine,
  palette: Palette,
  layers: Layers,
  "panel-right": PanelRight,
  camera: Camera,
  image: ImageIcon,
  film: Film,
  "audio-lines": AudioLines,
  map: MapIcon,
  "gamepad-2": Gamepad2,
  rocket: Rocket,
  cloud: Cloud,
  server: Server,
  database: Database,
  cpu: Cpu,
  gauge: Gauge,
  "chart-line": ChartLine,
  "circle-dollar-sign": CircleDollarSign,
  telescope: Telescope,
  lightbulb: Lightbulb,
  shield: Shield,
  lock: Lock,
  "key-round": KeyRound,
  plug: Plug,
  link: LinkIcon,
  "git-pull-request": GitPullRequest,
  terminal: Terminal,
  code: Code,
  package: Package,
  boxes: Boxes,
  settings: Settings,
  "toggle-right": ToggleRight,
  bell: Bell,
  mail: Mail,
  "message-square": MessageSquare,
  "calendar-clock": CalendarClock,
  smartphone: Smartphone,
  globe: Globe,
  users: Users,
  "heart-pulse": HeartPulse,
  dumbbell: Dumbbell,
  sparkles: Sparkles,
  "list-checks": ListChecks,
  moon: Moon,
  star: Star,
  hexagon: Hexagon,
  leaf: Leaf,
  diamond: Diamond,
  triangle: Triangle,
  droplet: Droplet,
  flame: Flame,
  zap: Zap,
  anchor: Anchor,
  mountain: Mountain,
  tent: Tent,
  route: Route,
  radio: Radio,
}

/** `--pc`: the project colour that tiles, dots and edges draw with (`text-(--pc)`, `bg-(--pc)/15`). */
export const projectColorStyle = (color: ProjectColor | null | undefined): CSSProperties | undefined =>
  color ? ({ "--pc": PROJECT_COLOR_HEX[color] } as CSSProperties) : undefined

const TILE_SIZE = {
  sm: "h-4 w-4 rounded-[4px] [&>svg]:h-[11px] [&>svg]:w-[11px]",
  lg: "h-[22px] w-[22px] rounded-md [&>svg]:h-[13px] [&>svg]:w-[13px]",
} as const

/**
 * A task's tile: its icon in its project's colour, on a tint of it (`bare`: no tint, for inside a link's text).
 * Nothing for a task the app doesn't know. Decorative: the text beside it names the task.
 */
export const TaskTile = memo(function TaskTile({ id, size = "sm", bare = false, className }: { id: string | null | undefined; size?: "sm" | "lg"; bare?: boolean; className?: string }) {
  const tile = useTaskTile(id)
  if (!tile) return null
  const Icon = TASK_ICON_COMPONENTS[tile.icon]
  return (
    <span
      aria-hidden
      data-testid="task-tile"
      data-icon={tile.icon}
      data-color={tile.color}
      title={`${tile.title}${tile.projectName ? ` · ${tile.projectName}` : ""}`}
      style={projectColorStyle(tile.color)}
      className={cx("inline-grid shrink-0 place-items-center text-(--pc)", bare ? "[&>svg]:h-[11px] [&>svg]:w-[11px]" : cx(TILE_SIZE[size], "bg-(--pc)/15"), className)}
    >
      <Icon />
    </span>
  )
})

/** A project's dot, in its colour. */
export const ProjectDot = memo(function ProjectDot({ projectId, className }: { projectId: string | null | undefined; className?: string }) {
  const color = useProjectColor(projectId)
  if (!color) return null
  return <span aria-hidden data-testid="project-dot" data-color={color} style={projectColorStyle(color)} className={cx("inline-block h-2 w-2 shrink-0 rounded-full bg-(--pc)", className)} />
})

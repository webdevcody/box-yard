// The icon each notice kind shows (the kind comes from the notice's leading emoji, lib/captainTranscript.ts).
// Shared by the Coordinator's notice cards, the published-files card and the Captain tab's rows.
import {
  AlertTriangle,
  CheckCircle2,
  GitMerge,
  GitPullRequest,
  Info,
  MessageCircleQuestion,
  MessageSquare,
  Minimize2,
  NotebookPen,
  Paperclip,
  Webhook,
  XCircle,
  type LucideIcon,
} from "lucide-react"
import type { NoticeKind } from "../lib/captainTranscript"

export const NOTICE_ICON: Record<NoticeKind, { icon: LucideIcon; className: string; label: string }> = {
  done: { icon: CheckCircle2, className: "text-emerald-400", label: "Done" },
  failed: { icon: XCircle, className: "text-red-400", label: "Failed" },
  needs_input: { icon: MessageCircleQuestion, className: "text-amber-400", label: "Needs you" },
  pr: { icon: GitPullRequest, className: "text-emerald-400", label: "Pull request" },
  merge: { icon: GitMerge, className: "text-merged-fg", label: "Merge requested" },
  hook: { icon: Webhook, className: "text-teal-300", label: "Hook fired" },
  artifact: { icon: Paperclip, className: "text-zinc-400", label: "File published" },
  message: { icon: MessageSquare, className: "text-sky-400", label: "Update" },
  warning: { icon: AlertTriangle, className: "text-amber-400", label: "Warning" },
  compaction: { icon: Minimize2, className: "text-zinc-500", label: "Compacted" },
  notes: { icon: NotebookPen, className: "text-amber-300", label: "Project notes" },
  info: { icon: Info, className: "text-zinc-500", label: "Notice" },
}

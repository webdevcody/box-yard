import { DEFAULT_OWNER_NAME } from "./owner.js"

/** Who wrote a "user" line in a task transcript: the task prompt, the owner (Cody), the Coordinator or a project Captain. */
export function userMessageLabel(meta: Record<string, unknown> | null | undefined, ownerName: string = DEFAULT_OWNER_NAME): string {
  if (meta?.kind === "task_prompt") return "Task"
  if (meta?.source === "orchestrator") return "Coordinator"
  if (meta?.source === "captain") return typeof meta.captainName === "string" && meta.captainName ? `${meta.captainName} Captain` : "Captain"
  return ownerName
}

/** Who wrote a "user" line in a task transcript: the task prompt, Cody, the Coordinator, a project Captain or a hook. */
export function userMessageLabel(meta: Record<string, unknown> | null | undefined): string {
  if (meta?.kind === "task_prompt") return "Task"
  if (meta?.source === "cody:merge") return "Cody (Merge button)"
  if (meta?.source === "orchestrator") return "Coordinator"
  if (meta?.source === "hook") return typeof meta.hookName === "string" && meta.hookName ? `Hook: ${meta.hookName}` : "Hook"
  if (meta?.source === "captain") return typeof meta.captainName === "string" && meta.captainName ? `${meta.captainName} Captain` : "Captain"
  return "Cody"
}

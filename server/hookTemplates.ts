import type { HookInput } from "./hookStore.js"
import type { HookTemplate } from "../shared/hooks.js"

// TODO(task_22ebcf600041): use the Merge PR button's standard merge message constant here, not a copy.
const STANDARD_MERGE_MESSAGE =
  "Please merge your pull request {pr_url} now. Merge the latest {branch} base into it first if it's behind, fix any conflicts, make sure the checks and tests pass, then merge it on GitHub (no force-push). Report back the merge commit, or exactly what blocked the merge."

export interface HookTemplateInfo {
  key: HookTemplate
  description: string
  /** Everything a new hook from this template starts with. It's created off; enabling it is a separate step. */
  draft: Omit<HookInput, "projectId" | "createdBy">
}

/** The built-in hooks, ready to create with one click. */
export function hookTemplates(): HookTemplateInfo[] {
  return [
    {
      key: "pr_merge",
      description:
        "When an agent's PR is ready (opened or pushed, turn ended, not a draft), send it the Merge PR button's standard merge request. PRs labelled no-automerge are skipped. Edit the prompt to customize it.",
      draft: {
        name: "On PR ready → merge",
        trigger: "task.pr_ready",
        filters: { excludeLabels: ["no-automerge"] },
        action: "send_to_task",
        prompt: STANDARD_MERGE_MESSAGE,
        enabled: false,
        allowSelfTrigger: false,
        maxFiresPerTask: 3,
        template: "pr_merge",
      },
    },
  ]
}

export function hookTemplate(key: string): HookTemplateInfo | null {
  return hookTemplates().find((t) => t.key === key) ?? null
}

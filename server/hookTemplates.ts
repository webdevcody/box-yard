import type { HookInput } from "./hookStore.js"
import type { HookTemplate } from "../shared/hooks.js"
import { MERGE_REQUEST_PROMPT } from "./prompts.js"

/** The Merge PR button's standard message as a hook template: its PR number becomes {pr_number}. */
export const MERGE_HOOK_PROMPT = MERGE_REQUEST_PROMPT.replaceAll("{N}", "{pr_number}")

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
        "When an agent's PR is ready (opened or pushed, its turn over, not a draft), send it the Merge PR button's standard merge request, once per head commit. It takes the button's path, so it never runs while another merge of that PR is pending. PRs labelled no-automerge are skipped. Edit the prompt to make it your own.",
      draft: {
        name: "On PR ready → merge",
        trigger: "task.pr_ready",
        filters: { excludeLabels: ["no-automerge"] },
        action: "send_to_task",
        prompt: MERGE_HOOK_PROMPT,
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

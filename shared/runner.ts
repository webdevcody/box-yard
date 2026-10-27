// Where a project's agents run: in Upstash boxes (the default), on the computer that runs Box Yard (the local runner),
// on a RunPod GPU pod of the project's own (shared/runpod.ts, docs/runpod.md), or in a Docker container of the
// project's own on the computer that runs Box Yard (shared/docker.ts, docs/docker.md).

export const RUNNERS = ["box", "local", "gpu", "docker"] as const
export type Runner = (typeof RUNNERS)[number]

/** Anything unknown (NULL from older rows, a typo) is "box", so a project only runs locally when someone chose it. */
export const normalizeRunner = (v: unknown): Runner => (v === "local" || v === "gpu" || v === "docker" ? v : "box")

/** A task's own runner (Task.runsOn), which wins over its project's in both directions; null follows the project. */
export const parseRunsOn = (v: unknown): Runner | null => (v === "local" || v === "box" || v === "gpu" || v === "docker" ? v : null)

export const RUNNER_LABEL: Record<Runner, string> = { box: "Upstash box", local: "This computer", gpu: "RunPod GPU", docker: "Docker container" }

/** "an Upstash box", "this computer", "a RunPod GPU pod", "a Docker container": for sentences. */
export const RUNNER_PHRASE: Record<Runner, string> = { box: "an Upstash box", local: "this computer", gpu: "a RunPod GPU pod", docker: "a Docker container on this computer" }

/** The runners the onboarding choice (the default for new projects) offers. RunPod GPU is picked per project. */
export const SETUP_RUNNERS = ["box", "local", "docker"] as const

/**
 * The one virtual box every local-runner task lives on. It is never a `boxes` row, so box reconcile, the pool
 * (Max boxes, Max agents), cost metering, the janitor and the Boxes page never see it, and it can't be lost or
 * swept. It must not start with `local-`: that prefix is LocalProvider's mock boxes (providers/auto.ts).
 */
export const LOCAL_BOX_ID = "this-computer"

export const isLocalRunnerBox = (id: string | null | undefined): boolean => id === LOCAL_BOX_ID

/** Shown on the "Runs on" setting and on each local task's header. */
export const LOCAL_UNSANDBOXED =
  "Local agents are not sandboxed: they run as your user on this computer, with your files, keys, network and logged-in tools. Only use it for repos and prompts you trust."

/** Settings › Local agents: how many local turns may run at once. */
export const LOCAL_AGENTS_LIMITS = { min: 1, max: 32 } as const

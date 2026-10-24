// Where a project's agents run: in Upstash boxes (the default), or on the computer that runs Box Yard (the local runner).

export const RUNNERS = ["box", "local"] as const
export type Runner = (typeof RUNNERS)[number]

/** Anything unknown (NULL from older rows, a typo) is "box", so a project only runs locally when someone chose it. */
export const normalizeRunner = (v: unknown): Runner => (v === "local" ? "local" : "box")

export const RUNNER_LABEL: Record<Runner, string> = { box: "Upstash box", local: "This computer" }

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

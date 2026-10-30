// Where a task actually runs (Task.placement): the box its workspace is on now, where it last ran once that box
// let it go (resting, archived), and where its next turn goes. Cards, the task header and the MCP task tools all
// word it with the functions here, so "Upstash · pure-lobster · small" reads the same everywhere.
import type { BoxSize } from "./types.js"
import { LOCAL_BOX_ID, RUNNER_PHRASE, type Runner } from "./runner.js"
import { gpuBoxIndex, isGpuBox } from "./runpod.js"
import { GPU_PROVIDER_LABEL, gpuBoxProvider } from "./gpu.js"
import { isDockerBox } from "./docker.js"
import { isMachineBox, labelPhrase, machineOfBox } from "./machines.js"

/**
 * The kinds of place a workspace can be: this computer, a worker box (Upstash, or a folder box in mock mode), a
 * RunPod GPU pod, a Docker container on this computer (the Docker runner fills that one in), or one of Cody's
 * SSH machines.
 */
export const PLACE_KINDS = ["local", "box", "gpu", "docker", "ssh"] as const
export type PlaceKind = (typeof PLACE_KINDS)[number]

export interface Place {
  kind: PlaceKind
  /** The box id: an Upstash box's name, "this-computer", `runpod-<project>[-n]`, or the Docker runner's box. */
  boxId: string
  /** Worker boxes: who made it ("upstash", or "local" for mock folder boxes) and its size. */
  provider?: string | null
  size?: BoxSize | null
  /** RunPod: the GPU type ("RTX A5000") and RunPod's pod id, while this server knows the pod. */
  gpu?: string | null
  podId?: string | null
  /** Docker: the container's name. */
  container?: string | null
  /** SSH machines: the machine's name. */
  machine?: string | null
  /** Worker boxes, where its workspace is now: how placement picked the box (null: its project's own box). */
  how?: BoxPick | null
}

/**
 * How placement picked a worker box: a new one made for the task, another project's idle box given to its project
 * rather than making one, or a slot beside another project's tasks because no box could be made right then.
 */
export const BOX_PICKS = ["new", "reused", "shared"] as const
export type BoxPick = (typeof BOX_PICKS)[number]
export const isBoxPick = (v: unknown): v is BoxPick => BOX_PICKS.includes(v as BoxPick)

export const BOX_PICK_LABEL: Record<BoxPick, string> = { new: "new box", reused: "reused idle box", shared: "shared box" }

/** The details' line on why that box. */
export const BOX_PICK_WHY: Record<BoxPick, string> = {
  new: "A new box was made for it: no box of its project had a free slot.",
  reused: "Another project's box sat idle, so it went to this project instead of a new box being made. Its workspaces wait in the archive.",
  shared: "It runs beside another project's tasks: no new box could be made right then.",
}

/** Which setting picked the runner: the task's own Runs on, or its project's. */
export type RunnerSource = "task" | "project"

export interface TaskPlacement {
  /** Where its workspace is now, or null (not placed yet, or its box let it go). */
  now: Place | null
  /** Where it last ran, once its box let it go (ms since epoch in `leftAt`); null when it never ran anywhere. */
  last: (Place & { leftAt: number }) | null
  /** Where its next turn goes: its own runs_on, else its project's Runs on. */
  runner: Runner
  chosenBy: RunnerSource
  /** The project's Runs on, so a task pinned off it shows a "pinned" mark. */
  projectRunner: Runner
  /** SSH machines: the label (or machine name) its next turn picks a machine by; null: any machine. */
  machineLabel?: string | null
}

/** The kind of place a box id is. Worker boxes are everything that isn't one of the runners' virtual boxes. */
export const placeKindOf = (boxId: string): PlaceKind =>
  boxId === LOCAL_BOX_ID ? "local" : isGpuBox(boxId) ? "gpu" : isDockerBox(boxId) ? "docker" : isMachineBox(boxId) ? "ssh" : "box"

/** The place a runner's turns go to. */
export const RUNNER_PLACE: Record<Runner, PlaceKind> = { local: "local", box: "box", gpu: "gpu", docker: "docker", ssh: "ssh" }

/** The provider's name, as the chip leads with it. */
export const PLACE_NAME: Record<PlaceKind, string> = { local: "This computer", box: "Upstash", gpu: "RunPod", docker: "Docker", ssh: "SSH" }

/** "Upstash" for Upstash boxes, "Local box" for mock mode's folder boxes. */
const boxProviderName = (p: Place) => (p.provider && p.provider !== "upstash" ? (p.provider === "local" ? "Local box" : p.provider) : PLACE_NAME.box)

/** "RunPod", or "Vast.ai" for a Vast.ai instance's box, "Daytona" for a Daytona sandbox's. */
const gpuPlaceName = (p: Place) => {
  const cloud = gpuBoxProvider(p.boxId)
  return cloud && cloud !== "runpod" ? GPU_PROVIDER_LABEL[cloud] : PLACE_NAME.gpu
}

/** RunPod pod ids are 14 characters; the first 6 tell pods apart. */
export const shortPodId = (id: string) => (id.length > 8 ? id.slice(0, 6) : id)

/** "pod 3x9k2a" ("sandbox 3x9k2a" on Daytona), or "pod #2" before this server has seen the pod. */
const podName = (p: Place) => {
  const noun = gpuBoxProvider(p.boxId) === "daytona" ? "sandbox" : "pod"
  return p.podId ? `${noun} ${shortPodId(p.podId)}` : `${noun} #${gpuBoxIndex(p.boxId)}`
}

const join = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ")

/** The full form: "This computer", "Upstash · pure-lobster · small" (" · reused idle box"), "RunPod · RTX A5000 · pod 3x9k2a", "Docker · boxyard-task-1", "SSH · laptop-1". */
export function placeLabel(p: Place): string {
  switch (p.kind) {
    case "local":
      return PLACE_NAME.local
    case "box":
      return join([boxProviderName(p), p.boxId, p.size, p.how && BOX_PICK_LABEL[p.how]])
    case "gpu":
      return join([gpuPlaceName(p), p.gpu, podName(p)])
    case "docker":
      return join([PLACE_NAME.docker, p.container ?? p.boxId])
    case "ssh":
      return join([PLACE_NAME.ssh, p.machine ?? machineOfBox(p.boxId)])
  }
}

/** The compact form for cards: the provider and the one detail that matters most ("Upstash · small", "RunPod · RTX A5000"). */
export function placeShort(p: Place): string {
  switch (p.kind) {
    case "local":
      return PLACE_NAME.local
    case "box":
      return join([boxProviderName(p), p.size])
    case "gpu":
      return join([gpuPlaceName(p), p.gpu ?? podName(p)])
    case "docker":
      return join([PLACE_NAME.docker, p.container ?? p.boxId])
    case "ssh":
      return join([PLACE_NAME.ssh, p.machine ?? machineOfBox(p.boxId)])
  }
}

/** "here": its workspace is there now. "next": not placed yet, this is where it goes. "last": where it ran before its box let it go. */
export type PlacementState = "here" | "next" | "last"

export interface PlacementView {
  state: PlacementState
  kind: PlaceKind
  /** Full: "Upstash · pure-lobster · small", "→ This computer", "Upstash · pure-lobster · small · archived". */
  label: string
  /** Compact, for cards: "Upstash · small", "→ This computer", "Upstash · small · archived". */
  short: string
  /** Its own runs_on differs from its project's Runs on. */
  pinned: boolean
  chosenBy: RunnerSource
  /** "This task's Runs on: this computer" / "Project's Runs on: an Upstash box". */
  setting: string
  /** Why it's where it is when that isn't simply its runner: it's waiting to move, it's archived, or how its box was picked. */
  reason: string | null
  /** The box id (and size) for the details, when there is a box. */
  place: Place | null
}

type PlacementTask = { placement?: TaskPlacement | null; status: string; boxId: string | null; runsOn?: Runner | null; lastArchivedAt: number | null }

/** Where a task without a `placement` (an older server, a test fixture) is, from its box id and runs_on. */
function fallback(t: PlacementTask, projectRunner: Runner | undefined): TaskPlacement {
  const project = projectRunner ?? "box"
  return {
    now: t.boxId ? { kind: placeKindOf(t.boxId), boxId: t.boxId } : null,
    last: null,
    runner: t.runsOn ?? project,
    chosenBy: t.runsOn ? "task" : "project",
    projectRunner: project,
  }
}

/** Statuses whose next step is a turn: an unplaced task in one of these shows where it will go. */
const HEADING_OUT = new Set(["queued", "starting"])

/** Everything the chip and its details say about where a task runs. `projectRunner` is only for tasks without `placement`. */
export function placementView(t: PlacementTask, projectRunner?: Runner): PlacementView {
  const p = t.placement ?? fallback(t, projectRunner)
  const pinned = p.chosenBy === "task" && p.runner !== p.projectRunner
  // SSH machines say which: 'SSH machines labelled "laptops"'.
  const phrase = p.runner === "ssh" ? labelPhrase(p.machineLabel ?? null) : RUNNER_PHRASE[p.runner]
  const setting = `${p.chosenBy === "task" ? "This task's" : "Project's"} Runs on: ${phrase}`
  const base = { pinned, chosenBy: p.chosenBy, setting }
  const wanted = RUNNER_PLACE[p.runner]
  if (p.now) {
    const moving = p.now.kind !== wanted
    return {
      ...base,
      state: "here",
      kind: p.now.kind,
      label: placeLabel(p.now),
      short: placeShort(p.now),
      reason: moving
        ? `It's set to run on ${phrase}, but its workspace is still here: it moves before a turn once its archive and push hold all the work.`
        : p.now.how
          ? BOX_PICK_WHY[p.now.how]
          : null,
      place: p.now,
    }
  }
  if (p.last && !HEADING_OUT.has(t.status)) {
    return {
      ...base,
      state: "last",
      kind: p.last.kind,
      label: `${placeLabel(p.last)} · archived`,
      short: `${placeShort(p.last)} · archived`,
      reason: `Its workspace is archived; the next turn restores it on ${phrase}.`,
      place: p.last,
    }
  }
  const name = p.runner === "ssh" && p.machineLabel ? `${PLACE_NAME.ssh} · ${p.machineLabel}` : PLACE_NAME[wanted]
  const archived = Boolean(t.lastArchivedAt) && !HEADING_OUT.has(t.status)
  return {
    ...base,
    state: archived ? "last" : "next",
    kind: wanted,
    label: archived ? `${name} · archived` : `→ ${name}`,
    short: archived ? `${name} · archived` : `→ ${name}`,
    reason: archived ? `Its workspace is archived; the next turn restores it on ${phrase}.` : HEADING_OUT.has(t.status) ? `Not placed yet: its next turn goes to ${phrase}.` : null,
    place: null,
  }
}

/** One line for the MCP task tools: "Upstash · pure-lobster · small (project's Runs on)", "→ This computer (pinned to this task)". */
export function placementLine(t: PlacementTask, projectRunner?: Runner): string {
  const v = placementView(t, projectRunner)
  const why = v.pinned ? "pinned by this task's runs_on" : v.chosenBy === "task" ? "this task's runs_on" : "project's Runs on"
  return `${v.state === "next" ? `not placed yet ${v.label}` : v.label} (${why})`
}

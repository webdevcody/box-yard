import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { WorkerSize } from "../../shared/types.js"
import { GPU_BOX_PREFIXES, gpuBoxProvider, gpuBoxRest } from "../../shared/gpu.js"
import { gpuBoxProject } from "../../shared/runpod.js"
import { DAYTONA_CPU, DAYTONA_GPU_GUIDE, daytonaGpuLabel, daytonaHourlyUsd, type DaytonaSettings, type DaytonaShape } from "../../shared/daytona.js"
import { DaytonaError, sandboxGpu, sandboxStatus, type DaytonaApi, type DaytonaSandbox } from "../daytona/api.js"
import { q, type BoxHealth, type BoxProvider, type BoxUsageProbe, type ExecResult } from "./types.js"

const ROOT = "/box"
const PREFIX = GPU_BOX_PREFIXES.daytona
const LIST_TTL_MS = 10_000
const EXEC_TIMEOUT_S = 30 * 60
const BOOTSTRAP_TIMEOUT_S = 20 * 60
/** A hold is one long toolbox call (Daytona counts an open call as activity); the turn's hold loop starts the next. */
const HOLD_TIMEOUT_S = 30 * 60
const STREAM_TIMEOUT_S = 2 * 60 * 60
/** Signed preview URLs last a day (Daytona's most) and are signed again an hour before they lapse. */
const PREVIEW_TTL_S = 24 * 60 * 60
const PREVIEW_RENEW_MS = 60 * 60_000
/** Splits a command's stdout from its stderr in the toolbox's one `result`. */
const MARK = "__boxyard_stderr_5c1e__"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A Daytona sandbox as TaskManager reads every GPU cloud's pods: RunPod's field names. */
export interface DaytonaPod {
  id: string
  name: string
  status: "RUNNING" | "STARTING" | "EXITED" | "ERROR"
  /** Box Yard's estimate, $/hr: Daytona doesn't price a sandbox itself (daytonaHourlyUsd). */
  cost?: number
  gpu?: { id?: string } | null
  dataCenterId?: string | null
  startedAt?: string | null
  image?: string
}

export interface DaytonaPodState {
  boxId: string
  pod: DaytonaPod
  sandbox: DaytonaSandbox
}

/** A project's own machine for its next sandbox; null fields use Settings › Daytona's. */
export interface DaytonaProjectMachine {
  gpuTypes: string[] | null
  minRamGb: number | null
  minVcpus: number | null
}

export interface DaytonaProviderDeps {
  api: DaytonaApi
  settings: () => DaytonaSettings
  /** The image GPU sandboxes start from (settings.image, else RunPod's built image, else the stock one). */
  image: () => string
  install: () => string
  /** Box Yard's runpod/ folder (bootstrap.sh installs the tools on any Ubuntu image) and daytona/ (init.sh). */
  bootstrapDir: string
  scriptsDir: string
  onEvent?: (e: { boxId: string; kind: "started" | "terminated"; detail: string }) => void
  onProgress?: (boxId: string, message: string) => void
  projectCap?: (projectId: string) => number | null
  projectMachine?: (projectId: string) => DaytonaProjectMachine
  keepWarmUntil?: (boxId: string) => number | null
  /** How often to read a starting sandbox, shortened in tests. */
  pollMs?: number
}

/** Building Box Yard's tools into the image failed at Daytona: start again from the plain image. */
class BuildFailed extends Error {}

/** A sandbox's GPU types as a list: what it asked for (Daytona echoes the list) or what it got. */
const typesOf = (sb: Pick<DaytonaSandbox, "gpuType">): string[] => (Array.isArray(sb.gpuType) ? sb.gpuType : sb.gpuType ? [sb.gpuType] : [])

/** What a sandbox costs per hour, as Box Yard estimates it (its dearest GPU type when it asked for several). */
export function sandboxCost(sb: DaytonaSandbox): number {
  return daytonaHourlyUsd({ gpuTypes: typesOf(sb), gpus: sb.gpu ?? 0, vcpus: sb.cpu ?? 0, memoryGb: sb.memory ?? 0, diskGb: sb.disk ?? 0, spot: Boolean(sb.spot) })
}

function podOf(sb: DaytonaSandbox, image?: string): DaytonaPod {
  return {
    id: sb.id,
    name: sb.name ?? sb.id,
    status: sandboxStatus(sb),
    cost: sandboxCost(sb),
    gpu: { id: sandboxGpu(sb) },
    dataCenterId: sb.target ?? null,
    startedAt: sb.createdAt ?? null,
    ...(image ? { image } : {}),
  }
}

/** "RTX 4090", "2× H100", or "CPU-only", for messages. */
export function shapeLabel(s: Pick<DaytonaShape, "gpuTypes" | "gpus">): string {
  if (!s.gpus) return "CPU-only"
  const names = s.gpuTypes.map(daytonaGpuLabel).join(" or ") || "GPU"
  return s.gpus > 1 ? `${s.gpus}× ${names}` : names
}

/**
 * A GPU id from another cloud as a Daytona gpuType: "NVIDIA GeForce RTX 4090" (RunPod) and "RTX 4090" (Vast.ai) are
 * "RTX-4090", "NVIDIA H100 80GB HBM3" is "H100". Null when Daytona has no such GPU.
 */
export function daytonaGpuType(id: string): string | null {
  if (id === DAYTONA_CPU || DAYTONA_GPU_GUIDE[id]) return id
  const norm = id
    .replace(/^(NVIDIA|AMD)\s+/i, "")
    .replace(/^GeForce\s+/i, "")
    .trim()
    .replace(/\s+/g, "-")
    .toUpperCase()
  if (DAYTONA_GPU_GUIDE[norm]) return norm
  return Object.keys(DAYTONA_GPU_GUIDE).find((t) => norm.startsWith(`${t}-`)) ?? null
}

/**
 * Daytona sandboxes as Box Yard boxes, beside RunPod's and Vast.ai's. Each of a GPU project's sandboxes is a virtual
 * box, `daytona-<projectId>` for #1 and `daytona-<projectId>-<n>` for #n (shared/gpu.ts), with at most one sandbox
 * behind it, labelled with this install and the box at Daytona. `wake` makes one from a Dockerfile (the image, with
 * Box Yard's tools built in), sized by Settings › Daytona or the project, within the $/hr caps; `destroy` deletes it.
 * Sandboxes are ephemeral (Daytona's rule for GPU ones): when Box Yard stops touching one, Daytona's auto-stop stops
 * it and so deletes it, which is the dead-man switch, with no key inside the sandbox.
 *
 * Box Yard reaches a sandbox only through Daytona's toolbox API with its own key: commands, files, and a signed URL
 * per preview port. Nothing in the sandbox can call Box Yard or Daytona's API.
 */
export class DaytonaProvider implements BoxProvider {
  readonly name = "daytona"
  readonly nodeBin = "node"
  readonly claudeBin = "claude"
  private readonly states = new Map<string, DaytonaPodState>()
  private readonly waking = new Map<string, Promise<void>>()
  private readonly previews = new Map<string, { url: string; until: number }>()
  private listed: { at: number; sandboxes: DaytonaSandbox[] } | null = null
  /** Makes one at a time, so two sandboxes starting together can't both fit under a cap only one fits under. */
  private creating: Promise<unknown> = Promise.resolve()
  private readonly lastProgress = new Map<string, string>()

  constructor(private readonly d: DaytonaProviderDeps) {}

  root() {
    return ROOT
  }

  /** The labels on this install's sandboxes: which Box Yard, and which box. */
  private labelsFor(boxId?: string): Record<string, string> {
    return { "boxyard-install": this.d.install(), ...(boxId ? { "boxyard-box": gpuBoxRest(boxId) } : {}) }
  }

  private boxOf(sb: DaytonaSandbox): string | null {
    const rest = sb.labels?.["boxyard-box"]
    return sb.labels?.["boxyard-install"] === this.d.install() && rest ? `${PREFIX}${rest}` : null
  }

  async create(_opts: { labels: string[]; size?: WorkerSize; snapshotId?: string }): Promise<string> {
    throw new Error("Daytona boxes aren't made through the box pool: a GPU project's sandboxes are daytona-<projectId>[-<n>]")
  }

  /** This install's sandboxes, by box id. A box with two (a crash mid-start) shows both; the sweep finds the other. */
  async listPods(fresh = false): Promise<DaytonaPodState[]> {
    if (fresh || !this.listed || Date.now() - this.listed.at > LIST_TTL_MS) this.listed = { at: Date.now(), sandboxes: await this.d.api.listSandboxes(this.labelsFor()) }
    const out: DaytonaPodState[] = []
    for (const sandbox of this.listed.sandboxes) {
      const boxId = this.boxOf(sandbox)
      if (boxId) out.push({ boxId, pod: podOf(sandbox), sandbox })
    }
    return out
  }

  cached(boxId: string): DaytonaPod | null {
    return this.states.get(boxId)?.pod ?? null
  }

  private async state(boxId: string): Promise<DaytonaPodState | null> {
    const known = this.states.get(boxId)
    if (known) return known
    const found = (await this.listPods()).find((p) => p.boxId === boxId)
    if (found) this.states.set(boxId, found)
    return found ?? null
  }

  private setState(boxId: string, sandbox: DaytonaSandbox) {
    const st: DaytonaPodState = { boxId, pod: podOf(sandbox, this.d.image()), sandbox }
    this.states.set(boxId, st)
    return st
  }

  private dropState(boxId: string) {
    const st = this.states.get(boxId)
    if (st) for (const k of [...this.previews.keys()]) if (k.startsWith(`${st.sandbox.id}:`)) this.previews.delete(k)
    this.states.delete(boxId)
    this.lastProgress.delete(boxId)
    this.listed = null
  }

  /** The box's sandbox while it's started; throws otherwise. */
  private async running(boxId: string): Promise<DaytonaPodState> {
    const st = await this.state(boxId)
    if (!st || st.pod.status !== "RUNNING") throw new Error(`The Daytona sandbox for ${boxId} isn't running`)
    return st
  }

  /**
   * Run a command in a login shell, with stdout and stderr apart: the toolbox answers with both in one `result`, so
   * stderr goes to a file that's printed after a marker.
   */
  private async run(st: DaytonaPodState, command: string, timeoutSec: number, signal?: AbortSignal): Promise<ExecResult> {
    const script = `e=$(mktemp 2>/dev/null || echo /tmp/.boxyard-err-$$); bash -lc ${q(command)} 2>"$e"; c=$?; printf '\\n%s\\n' ${MARK}; cat "$e" 2>/dev/null; rm -f "$e"; exit $c`
    let r: { exitCode: number; result: string }
    try {
      r = await this.d.api.execute(st.sandbox, `sh -c ${q(script)}`, timeoutSec, signal)
    } catch (err) {
      if (err instanceof DaytonaError && err.status === 408) return { exitCode: 124, stdout: "", stderr: `(timed out after ${timeoutSec} s)` }
      throw err
    }
    return splitResult(r.exitCode, r.result)
  }

  async exec(boxId: string, command: string): Promise<ExecResult> {
    return this.run(await this.running(boxId), command, EXEC_TIMEOUT_S)
  }

  /**
   * The command's output goes to a file in the sandbox, which then streams down: the toolbox has no streaming call
   * (only a WebSocket one), so an archive needs room for itself in the sandbox's /tmp.
   */
  async execStream(boxId: string, command: string, onOutput: (chunk: string) => void): Promise<{ exitCode: number }> {
    const st = await this.running(boxId)
    const out = `/tmp/.boxyard-stream-${randomUUID()}`
    try {
      const r = await this.run(st, `{ ${command}\n} > ${q(out)} 2>&1`, STREAM_TIMEOUT_S)
      const decoder = new TextDecoder()
      await this.d.api.downloadStream(st.sandbox, out, (chunk) => onOutput(decoder.decode(chunk, { stream: true })))
      const tail = decoder.decode()
      if (tail) onOutput(tail)
      return { exitCode: r.exitCode }
    } finally {
      await this.run(st, `rm -f ${q(out)}`, 60).catch(() => {})
    }
  }

  async hold(boxId: string, command: string, signal: AbortSignal): Promise<void> {
    try {
      await this.run(await this.running(boxId), command, HOLD_TIMEOUT_S, signal)
    } catch {}
  }

  /** Upload next to the file, then move it into place, so a reader never sees half of it. */
  private async put(boxId: string, filePath: string, content: Buffer | { localPath: string }, timeoutMs: number) {
    const st = await this.running(boxId)
    const tmp = `${filePath}.by-tmp`
    await this.d.api.upload(st.sandbox, tmp, content, timeoutMs)
    const r = await this.run(st, `mv -f ${q(tmp)} ${q(filePath)}`, 60)
    if (r.exitCode !== 0) throw new Error(`Writing ${filePath} on ${boxId} failed: ${r.stderr.slice(-300)}`)
  }

  async writeFile(boxId: string, filePath: string, content: string | Buffer): Promise<void> {
    await this.put(boxId, filePath, Buffer.isBuffer(content) ? content : Buffer.from(content), 10 * 60_000)
  }

  async readFile(boxId: string, filePath: string): Promise<Buffer> {
    return this.d.api.download((await this.running(boxId)).sandbox, filePath)
  }

  async uploadFile(boxId: string, localPath: string, destination: string): Promise<void> {
    await this.put(boxId, destination, { localPath }, 60 * 60_000)
  }

  async health(boxId: string): Promise<BoxHealth> {
    let st: DaytonaPodState | null
    try {
      st = await this.state(boxId)
      if (st) {
        const sb = await this.d.api.getSandbox(st.sandbox.id)
        if (!sb) {
          this.dropState(boxId)
          return "paused"
        }
        st = this.setState(boxId, sb)
      }
    } catch {
      return "unknown"
    }
    if (!st) return "paused"
    if (st.pod.status === "RUNNING") return "running"
    if (st.pod.status === "ERROR") return "error"
    return st.pod.status === "EXITED" ? "paused" : "unknown"
  }

  wake(boxId: string): Promise<void> {
    if (gpuBoxProvider(boxId) !== "daytona") return Promise.reject(new Error(`${boxId} isn't a Daytona box`))
    const running = this.waking.get(boxId)
    if (running) return running
    const p = this.ensureSandbox(boxId).finally(() => this.waking.delete(boxId))
    this.waking.set(boxId, p)
    return p
  }

  private progress(boxId: string, message: string) {
    if (this.lastProgress.get(boxId) === message) return
    this.lastProgress.set(boxId, message)
    this.d.onProgress?.(boxId, message)
  }

  /** Delete a sandbox Box Yard won't use, forgetting it either way. */
  private async discard(boxId: string, id: string) {
    await this.d.api.deleteSandbox(id).catch(() => {})
    this.dropState(boxId)
  }

  private async ensureSandbox(boxId: string): Promise<void> {
    const existing = await this.state(boxId)
    if (existing) {
      const sb = await this.d.api.getSandbox(existing.sandbox.id)
      if (sb && sandboxStatus(sb) === "RUNNING") {
        const st = this.setState(boxId, sb)
        // A toolbox that doesn't answer throws here: the wake fails and is tried again, the sandbox is kept.
        const ok = await this.run(st, "test -f /opt/boxyard/ready && test -d /box/tasks", 60)
        if (ok.exitCode === 0) return
        return this.prepare(boxId, st)
      }
      if (sb && sandboxStatus(sb) === "STARTING") {
        let st: DaytonaPodState
        try {
          st = await this.waitStarted(boxId, sb.id)
        } catch (err) {
          await this.discard(boxId, sb.id)
          throw err
        }
        return this.prepare(boxId, st)
      }
      // Stopped, deleted or failed: a stopped sandbox is on its way out (ephemeral), so start over.
      if (sb) await this.d.api.deleteSandbox(sb.id).catch(() => {})
      this.dropState(boxId)
    }
    const st = await this.launch(boxId)
    try {
      await this.prepare(boxId, st)
    } catch (err) {
      await this.discard(boxId, st.sandbox.id)
      throw err
    }
  }

  /** Make a sandbox with the tools built into its image; if Daytona can't build that, from the plain image. */
  private async launch(boxId: string): Promise<DaytonaPodState> {
    const sb = await this.startSandbox(boxId, true)
    try {
      return await this.waitStarted(boxId, sb.id)
    } catch (err) {
      await this.discard(boxId, sb.id)
      if (!(err instanceof BuildFailed)) throw err
      console.warn(`[box-yard] Daytona couldn't build Box Yard's tools into the image for ${boxId}: ${err.message}`)
      this.progress(boxId, "Daytona couldn't build Box Yard's tools into the image; starting from the plain image and installing them in the sandbox")
    }
    const plain = await this.startSandbox(boxId, false)
    try {
      return await this.waitStarted(boxId, plain.id)
    } catch (err) {
      await this.discard(boxId, plain.id)
      throw err
    }
  }

  /** The $/hr cap on a project's sandboxes together: its own, else Settings › Daytona's. 0: none. */
  capOf(projectId: string): number {
    return this.d.projectCap?.(projectId) ?? this.d.settings().maxHourlyUsd
  }

  /**
   * The sandbox a project's next one asks for: its own GPU types, RAM and vCPUs, else Settings › Daytona's. Types
   * from another cloud ("NVIDIA GeForce RTX 4090") are read as Daytona's; when none is a Daytona GPU, Settings' are used.
   */
  shapeOf(projectId: string): DaytonaShape {
    const s = this.d.settings()
    const own = this.d.projectMachine?.(projectId)
    const mapped = [...new Set((own?.gpuTypes ?? []).map(daytonaGpuType).filter((t): t is string => Boolean(t)))]
    const types = mapped.length ? mapped : s.gpuTypes
    if (types.includes(DAYTONA_CPU)) return { gpuTypes: [], gpus: 0, vcpus: own?.minVcpus ?? s.cpuVcpus, memoryGb: own?.minRamGb ?? s.cpuMemoryGb, diskGb: s.cpuDiskGb, spot: false }
    return { gpuTypes: types, gpus: s.gpus, vcpus: own?.minVcpus ?? s.vcpus, memoryGb: own?.minRamGb ?? s.memoryGb, diskGb: s.diskGb, spot: s.spot }
  }

  /** The shape with only the GPU types it can afford under `room` ($/hr), or null when none fits. */
  private fitting(shape: DaytonaShape, room: number): DaytonaShape | null {
    if (!shape.gpus) return daytonaHourlyUsd(shape) <= room + 1e-9 ? shape : null
    const types = shape.gpuTypes.filter((t) => daytonaHourlyUsd({ ...shape, gpuTypes: [t] }) <= room + 1e-9)
    return types.length ? { ...shape, gpuTypes: types } : null
  }

  /**
   * What the project's next sandbox would cost at most: its shape with the GPU types that fit its cap, at the dearest
   * of them (Daytona may give any). Null when none fits. Placement checks the caps with it before it counts on one.
   */
  async nextPodPrice(projectId: string): Promise<{ gpu: string; usd: number } | null> {
    const cap = this.capOf(projectId)
    const fit = this.fitting(this.shapeOf(projectId), cap || Infinity)
    return fit ? { gpu: `${shapeLabel(fit)} sandbox (Daytona)`, usd: daytonaHourlyUsd(fit) } : null
  }

  /** The image a sandbox of this shape starts from: CPU-only ones a small one, GPU ones a CUDA one. */
  imageFor(shape: Pick<DaytonaShape, "gpus">): string {
    return shape.gpus ? this.d.image() : this.d.settings().cpuImage
  }

  /**
   * The Dockerfile a sandbox is built from: the image, with bootstrap.sh (public: no key or token in it) run at build
   * time when `bake`, so Daytona builds the tools once per image and new sandboxes start ready.
   */
  dockerfile(image: string, bake: boolean): string {
    const lines = [`FROM ${image}`, "USER root"]
    if (bake) {
      const b64 = fs.readFileSync(path.join(this.d.bootstrapDir, "bootstrap.sh")).toString("base64")
      lines.push(`RUN mkdir -p /opt/boxyard && echo ${b64} | base64 -d > /opt/boxyard/bootstrap.sh && bash /opt/boxyard/bootstrap.sh`)
    }
    return `${lines.join("\n")}\n`
  }

  /** Minutes without contact before Daytona stops (and deletes) the box's sandbox: Settings' dead-man time, or past a keep-warm. */
  private autoStopFor(boxId: string): number {
    const s = this.d.settings()
    const until = this.d.keepWarmUntil?.(boxId) ?? null
    return until && until > Date.now() ? Math.ceil((until - Date.now()) / 60_000) + s.watchdogMinutes : s.watchdogMinutes
  }

  private startSandbox(boxId: string, bake: boolean): Promise<DaytonaSandbox> {
    const p = this.creating.then(() => this.make(boxId, bake))
    this.creating = p.catch(() => {})
    return p
  }

  /** Make the box's sandbox, within both caps. */
  private async make(boxId: string, bake: boolean): Promise<DaytonaSandbox> {
    const s = this.d.settings()
    const projectId = gpuBoxProject(boxId)
    const cap = this.capOf(projectId)
    // The caps count every sandbox this install has, and the project's own.
    const all = await this.listPods(true)
    // One still labelled for this box is left from a start that didn't finish (the box has none now): it goes first.
    for (const stale of all.filter((p) => p.boxId === boxId)) await this.d.api.deleteSandbox(stale.sandbox.id)
    const others = all.filter((p) => p.boxId !== boxId)
    const spend = others.reduce((sum, p) => sum + (p.pod.cost ?? 0), 0)
    const projectSpend = others.filter((p) => gpuBoxProject(p.boxId) === projectId).reduce((sum, p) => sum + (p.pod.cost ?? 0), 0)
    const room = Math.min(cap ? cap - projectSpend : Infinity, s.totalMaxHourlyUsd ? s.totalMaxHourlyUsd - spend : Infinity)
    if (room <= 0) throw new Error(`Couldn't start a Daytona sandbox: the $/hr caps are reached (the project's sandboxes cost $${projectSpend.toFixed(2)}/hr, all of them $${spend.toFixed(2)}/hr)`)
    const shape = this.shapeOf(projectId)
    const fit = this.fitting(shape, room)
    if (!fit) {
      throw new Error(
        `A Daytona ${shapeLabel(shape)} sandbox (${shape.vcpus} vCPUs, ${shape.memoryGb} GiB) is about $${daytonaHourlyUsd(shape).toFixed(2)}/hr, over the $${room.toFixed(2)}/hr the caps leave. Raise the caps, or pick a cheaper GPU type or a smaller sandbox in Settings › Daytona`,
      )
    }
    const usd = daytonaHourlyUsd(fit)
    const image = this.imageFor(fit)
    this.progress(boxId, `Starting a Daytona ${shapeLabel(fit)} sandbox (${fit.vcpus} vCPUs, ${fit.memoryGb} GiB, ${fit.diskGb} GiB disk) at about $${usd.toFixed(2)}/hr`)
    const sb = await this.d.api.createSandbox({
      labels: this.labelsFor(boxId),
      dockerfile: this.dockerfile(image, bake),
      gpuTypes: fit.gpuTypes,
      gpus: fit.gpus,
      vcpus: fit.vcpus,
      memoryGb: fit.memoryGb,
      diskGb: fit.diskGb,
      spot: fit.spot,
      autoStopMinutes: this.autoStopFor(boxId),
    })
    this.listed = null
    this.setState(boxId, sb)
    this.d.onEvent?.({ boxId, kind: "started", detail: `${shapeLabel(fit)}${fit.spot && fit.gpus ? " (spot)" : ""}, ${fit.vcpus} vCPUs, ${fit.memoryGb} GiB at about $${usd.toFixed(3)}/hr, sandbox ${sb.id}` })
    return sb
  }

  private async waitStarted(boxId: string, id: string): Promise<DaytonaPodState> {
    const s = this.d.settings()
    const until = Date.now() + s.startMinutes * 60_000
    while (Date.now() < until) {
      const sb = await this.d.api.getSandbox(id)
      if (!sb) throw new Error(`Daytona sandbox ${id} was deleted while starting`)
      const reason = sb.errorReason ? `: ${sb.errorReason.slice(0, 300)}` : ""
      if (sb.state === "build_failed") throw new BuildFailed(`Daytona couldn't build sandbox ${id}'s image${reason}`)
      const status = sandboxStatus(sb)
      if (status === "ERROR" || status === "EXITED") throw new Error(`Daytona sandbox ${id} ${sb.state ?? "failed"} while starting${reason}`)
      const st = this.setState(boxId, sb)
      if (status === "RUNNING") return st
      const building = sb.state === "pending_build" || sb.state === "building_snapshot"
      this.progress(
        boxId,
        building ? `Daytona is building the sandbox's image or waiting for a free GPU (${sb.state}; the first build of an image takes a few minutes)` : `Waiting for Daytona sandbox ${id} to start (${sb.state ?? "creating"})`,
      )
      await sleep(this.d.pollMs ?? 4000)
    }
    throw new Error(`Daytona sandbox ${id} didn't start within ${s.startMinutes} minutes (no GPU of its types was free, or its image build is slow). Try again later, add a GPU type, or raise Start within in Settings › Daytona`)
  }

  /** Make a started sandbox ready: tools installed (unless the image has them), init.sh, git identity. */
  private async prepare(boxId: string, st: DaytonaPodState): Promise<void> {
    const who = await this.run(st, "id -u", 60)
    // Box Yard asks for root; when Daytona runs it as another user, setup goes through passwordless sudo.
    const sudo = who.stdout.trim() === "0" ? "" : "sudo -n "
    for (const [dir, name] of [
      [this.d.bootstrapDir, "bootstrap.sh"],
      [this.d.scriptsDir, "init.sh"],
    ] as const) {
      const tmp = `/tmp/boxyard-${name}`
      await this.d.api.upload(st.sandbox, tmp, fs.readFileSync(path.join(dir, name)))
      const r = await this.run(st, `${sudo}mkdir -p /opt/boxyard && ${sudo}mv -f ${tmp} /opt/boxyard/${name} && ${sudo}chmod +x /opt/boxyard/${name}`, 60)
      if (r.exitCode !== 0) throw new Error(`Couldn't put ${name} in Daytona sandbox ${st.sandbox.id}: ${r.stderr.slice(-300)}`)
    }
    const ready = await this.run(st, "test -f /opt/boxyard/ready", 60)
    if (ready.exitCode !== 0) {
      this.progress(boxId, "Installing the agent tools in the Daytona sandbox (a few minutes)")
      const b = await this.run(st, `${sudo}bash /opt/boxyard/bootstrap.sh > /tmp/boxyard-bootstrap.log 2>&1 || (tail -n 30 /tmp/boxyard-bootstrap.log; exit 1)`, BOOTSTRAP_TIMEOUT_S)
      if (b.exitCode !== 0) throw new Error(`Installing tools in Daytona sandbox ${st.sandbox.id} failed: ${(b.stdout + b.stderr).slice(-800)}`)
    }
    const init = await this.run(st, `${sudo}bash /opt/boxyard/init.sh "$(id -un)" && node --version && claude --version`, 300)
    if (init.exitCode !== 0) throw new Error(`Preparing Daytona sandbox ${st.sandbox.id} failed: ${(init.stdout + init.stderr).slice(-800)}`)
  }

  /**
   * A signed URL for the port, which only opens that port and lapses after a day (signed again before then). Any
   * port works: Daytona's proxy reaches every one.
   */
  async publicUrl(boxId: string, port: number): Promise<string> {
    const st = await this.running(boxId)
    const key = `${st.sandbox.id}:${port}`
    const known = this.previews.get(key)
    if (known && known.until - Date.now() > PREVIEW_RENEW_MS) return known.url
    const url = await this.d.api.signedPreviewUrl(st.sandbox.id, port, PREVIEW_TTL_S)
    this.previews.set(key, { url, until: Date.now() + PREVIEW_TTL_S * 1000 })
    return url
  }

  /** Delete the box's sandbox (its disk goes with it). */
  async destroy(boxId: string): Promise<void> {
    const st = await this.state(boxId).catch(() => null)
    if (!st) return
    await this.d.api.deleteSandbox(st.sandbox.id)
    this.d.onEvent?.({ boxId, kind: "terminated", detail: `${st.pod.gpu?.id ?? "Daytona"} sandbox ${st.sandbox.id} deleted` })
    this.dropState(boxId)
  }

  async usage(_boxId: string): Promise<BoxUsageProbe> {
    return { source: "estimated" }
  }

  /** Hold Daytona's auto-stop off until `until` (ms since epoch), or put it back to Settings' with null. */
  async keepWarm(boxId: string, until: number | null): Promise<void> {
    const st = await this.state(boxId)
    if (!st) return
    const s = this.d.settings()
    const minutes = until && until > Date.now() ? Math.ceil((until - Date.now()) / 60_000) + s.watchdogMinutes : s.watchdogMinutes
    await this.d.api.setAutoStop(st.sandbox.id, minutes)
  }
}

/** The toolbox's one `result` split at the marker into stdout and stderr (all of it is stdout when there's no marker). */
export function splitResult(exitCode: number, result: string): ExecResult {
  const at = result.lastIndexOf(MARK)
  if (at < 0) return { exitCode, stdout: result, stderr: "" }
  const stdout = result.slice(0, at).replace(/\n$/, "")
  const stderr = result.slice(at + MARK.length).replace(/^\n/, "")
  return { exitCode, stdout, stderr }
}

/** The marker, for tests that play the toolbox. */
export const STDERR_MARK = MARK

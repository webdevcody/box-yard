import fs from "node:fs"
import path from "node:path"
import type { WorkerSize } from "../../shared/types.js"
import { RUNPOD_STOCK_IMAGE, cloudLabel, shortGpu, gpuBoxIndex, gpuBoxProject, isGpuBox, type ProjectGpuMachine, type RunPodCloud } from "../../shared/runpod.js"
import type { RunPodSettings } from "../../shared/runpod.js"
import { RunPodError, rankDataCenters, type CatalogGpu, type RunPodApi, type RunPodPod, type RunPodVolume } from "../runpod/api.js"
import type { SshPool, SshTarget } from "../runpod/ssh.js"
import { q, type BoxHealth, type BoxProvider, type BoxUsageProbe } from "./types.js"
import { SshBoxProvider } from "./sshBox.js"

const ROOT = "/box"
/** Box Yard gives each task the ports PORT_BASE + 10·n (TaskManager.assign); a pod exposes the first of each. */
export const POD_HTTP_PORTS = Array.from({ length: 20 }, (_, i) => 4000 + i * 10)
const POLL_MS = 3000
/** A pod's image can take a while to pull the first time a host sees it. */
const START_TIMEOUT_MS = 15 * 60_000
const SSH_TIMEOUT_MS = 3 * 60_000
const BOOTSTRAP_TIMEOUT_MS = 20 * 60_000
const LIST_TTL_MS = 10_000
/** GPU list prices change rarely; placement asks for the next pod's price on every pass. */
const CATALOG_TTL_MS = 5 * 60_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface RunPodPodState {
  boxId: string
  pod: RunPodPod
  target: SshTarget | null
}

export interface RunPodProviderDeps {
  api: RunPodApi
  ssh: SshPool
  settings: () => RunPodSettings
  /** This install's id (TaskManager's install label without "by-"), so pods and volumes of other installs are left alone. */
  install: () => string
  /** Box Yard's runpod/ folder: init.sh, watchdog.sh and bootstrap.sh are uploaded from it to every pod. */
  scriptsDir: string
  /** A pod was started or terminated (box history). */
  onEvent?: (e: { boxId: string; kind: "started" | "terminated"; pod: RunPodPod; detail: string }) => void
  /** Progress while a pod starts, for the task's wait reason. */
  onProgress?: (boxId: string, message: string) => void
  /** A project's own $/hr cap for its pods (Project.gpuMaxHourlyUsd), or null for Settings › RunPod GPU's. */
  projectCap?: (projectId: string) => number | null
  /** A project's own GPU types, cloud and least host RAM/vCPUs (Project.gpuMachine); null fields use the settings'. */
  projectMachine?: (projectId: string) => ProjectGpuMachine
}

/** What a project's next pod asks RunPod for. */
export interface PodMachine {
  gpuTypes: string[]
  cloud: RunPodCloud
  minRamGb: number
  minVcpus: number
}

/** A GPU type's list price on a cloud, or null when RunPod doesn't offer it there. */
export function catalogPrice(g: CatalogGpu, cloud: RunPodCloud): number | null {
  const offered = cloud === "COMMUNITY" ? (g.community ?? g.price.community > 0) : g.secure
  const usd = cloud === "COMMUNITY" ? g.price.community : g.price.secure
  return offered && usd > 0 ? usd : null
}

/**
 * RunPod GPU pods as Box Yard boxes. Each of a GPU project's pods is a virtual box, `runpod-<projectId>` for pod #1
 * and `runpod-<projectId>-<n>` for pod #n (shared/runpod.ts), with at most one pod behind it at a time. TaskManager
 * decides how many a project gets. `wake` starts the pod (pod #1 on the project's network volume when there is one,
 * the others on their container disk) and `pause`/`destroy` terminate it; the volume stays. Commands, files and
 * uploads go over SSH to the pod's public TCP port. Nothing here ever starts a pod except `wake`, so polling a
 * stopped box costs nothing.
 */
export class RunPodProvider extends SshBoxProvider implements BoxProvider {
  readonly name = "runpod"
  readonly nodeBin = "node"
  readonly claudeBin = "claude"
  private readonly states = new Map<string, RunPodPodState>()
  private readonly waking = new Map<string, Promise<void>>()
  private listed: { at: number; pods: RunPodPod[] } | null = null
  private catalog: { at: number; gpus: CatalogGpu[] } | null = null
  /** Pod creates one at a time, so two pods starting together can't both fit under a cap only one fits under. */
  private creating: Promise<unknown> = Promise.resolve()

  constructor(private readonly d: RunPodProviderDeps) {
    super(d.ssh)
  }

  root() {
    return ROOT
  }

  /** Pod names: `boxyard-<install>-<projectId>` for pod #1, `boxyard-<install>-<projectId>-<n>` for pod #n. */
  resourceName(boxId: string) {
    return `boxyard-${this.d.install()}-${boxId.slice("runpod-".length)}`
  }

  /** The project's network volume: `boxyard-<install>-<projectId>`, the name pod #1 has always had. */
  volumeName(boxId: string) {
    return `boxyard-${this.d.install()}-${gpuBoxProject(boxId)}`
  }

  private boxOfName(name: string): string | null {
    const prefix = `boxyard-${this.d.install()}-`
    return name.startsWith(prefix) ? `runpod-${name.slice(prefix.length)}` : null
  }

  async create(_opts: { labels: string[]; size?: WorkerSize; snapshotId?: string }): Promise<string> {
    throw new Error("RunPod boxes aren't made through the box pool: a GPU project's pods are runpod-<projectId>[-<n>]")
  }

  /** This install's live pods (not terminated), by box id. */
  async listPods(fresh = false): Promise<RunPodPodState[]> {
    if (fresh || !this.listed || Date.now() - this.listed.at > LIST_TTL_MS) {
      this.listed = { at: Date.now(), pods: await this.d.api.listPods() }
    }
    const out: RunPodPodState[] = []
    for (const pod of this.listed.pods) {
      const boxId = this.boxOfName(pod.name)
      if (!boxId || pod.status === "TERMINATED") continue
      out.push({ boxId, pod, target: targetOf(pod) })
    }
    return out
  }

  /** The pod behind a box as this process last saw it (no API call), or null. */
  cached(boxId: string): RunPodPod | null {
    return this.states.get(boxId)?.pod ?? null
  }

  /** The pod behind a box, or null. Asks RunPod when this process doesn't know it yet (after a restart). */
  private async state(boxId: string): Promise<RunPodPodState | null> {
    const known = this.states.get(boxId)
    if (known) return known
    const found = (await this.listPods()).find((p) => p.boxId === boxId)
    if (found) this.states.set(boxId, found)
    return found ?? null
  }

  protected async target(boxId: string): Promise<SshTarget> {
    const st = await this.state(boxId)
    if (!st?.target || st.pod.status !== "RUNNING") throw new Error(`The GPU pod for ${boxId} isn't running`)
    return st.target
  }

  async health(boxId: string): Promise<BoxHealth> {
    let st: RunPodPodState | null
    try {
      st = await this.state(boxId)
      if (st) {
        const pod = await this.d.api.getPod(st.pod.id)
        if (!pod || pod.status === "TERMINATED") {
          this.dropState(boxId)
          return "paused"
        }
        st = { boxId, pod, target: targetOf(pod) ?? st.target }
        this.states.set(boxId, st)
      }
    } catch {
      return "unknown"
    }
    if (!st) return "paused"
    if (st.pod.status === "RUNNING") return "running"
    if (st.pod.status === "ERROR") return "error"
    return st.pod.status === "EXITED" ? "paused" : "unknown"
  }

  private dropState(boxId: string) {
    const st = this.states.get(boxId)
    if (st?.target) this.d.ssh.close(st.target)
    this.states.delete(boxId)
    this.lastProgress.delete(boxId)
    this.listed = null
  }

  /** Start the box's pod unless it's already up. Concurrent calls share one start, so a box never gets two pods. */
  wake(boxId: string): Promise<void> {
    if (!isGpuBox(boxId)) return Promise.reject(new Error(`${boxId} isn't a RunPod box`))
    const running = this.waking.get(boxId)
    if (running) return running
    const p = this.ensurePod(boxId).finally(() => this.waking.delete(boxId))
    this.waking.set(boxId, p)
    return p
  }

  private readonly lastProgress = new Map<string, string>()

  /** Tell the box's starting tasks what's happening, once per change (waits poll every few seconds). */
  private progress(boxId: string, message: string) {
    if (this.lastProgress.get(boxId) === message) return
    this.lastProgress.set(boxId, message)
    this.d.onProgress?.(boxId, message)
  }

  private async ensurePod(boxId: string): Promise<void> {
    const existing = await this.state(boxId)
    if (existing) {
      const pod = await this.d.api.getPod(existing.pod.id)
      if (pod && pod.status === "RUNNING" && targetOf(pod)) {
        const st = { boxId, pod, target: targetOf(pod)! }
        this.states.set(boxId, st)
        const ok = await this.d.ssh.run(st.target, "test -f /opt/boxyard/ready && test -d /box/tasks", { timeoutMs: 30_000 })
        if (ok.exitCode === 0) return
        if (ok.exitCode !== 255) return this.prepare(boxId, st)
      }
      if (pod && (pod.status === "PROVISIONING" || pod.status === "STARTING" || (pod.status === "RUNNING" && !targetOf(pod)))) {
        return this.prepare(boxId, await this.waitRunning(boxId, pod))
      }
      // Exited, errored or unreachable: start over on a new pod (the volume keeps the caches).
      if (pod) await this.d.api.terminatePod(pod.id).catch(() => {})
      this.dropState(boxId)
    }
    const pod = await this.startPod(boxId)
    const st = await this.waitRunning(boxId, pod).catch(async (err) => {
      await this.d.api.terminatePod(pod.id).catch(() => {})
      this.dropState(boxId)
      throw err
    })
    await this.prepare(boxId, st).catch(async (err) => {
      await this.d.api.terminatePod(pod.id).catch(() => {})
      this.dropState(boxId)
      throw err
    })
  }

  /**
   * The project's network volume for its pod #1: found by name, else made in the datacenter with the best stock.
   * Null when off, and always for pods #2 and up: RunPod warns that writes to one volume from several pods at once
   * may corrupt it, and the caches there don't lock across machines, so the others keep their caches on their
   * container disk (docs/runpod.md).
   */
  async ensureVolume(boxId: string, gpus?: CatalogGpu[]): Promise<RunPodVolume | null> {
    if (gpuBoxIndex(boxId) > 1) return null
    const s = this.d.settings()
    const machine = this.machineOf(gpuBoxProject(boxId))
    // Network volumes are Secure Cloud only: a Community pod keeps its caches on its container disk.
    if (machine.cloud !== "SECURE") return null
    const name = this.volumeName(boxId)
    const mine = (await this.d.api.listVolumes()).find((v) => v.name === name)
    if (mine || s.volumeGb <= 0) return mine ?? null
    const dcs = await this.d.api.dataCenters()
    const wanted = this.affordable(machine, gpus ?? (await this.gpuCatalog()), this.capOf(gpuBoxProject(boxId))).map((c) => c.gpu.id)
    const ranked = rankDataCenters(dcs, wanted)
    const pick = s.dataCenter ? dcs.find((dc) => dc.id === s.dataCenter) : null
    const dc = pick
      ? { id: pick.id, volumeType: pick.networkVolumeTypes.includes("STANDARD") ? "STANDARD" : (pick.networkVolumeTypes[0] ?? "") }
      : ranked[0]
    if (!dc?.volumeType) {
      throw new Error(
        pick
          ? `Datacenter ${pick.id} has no network volumes; pick another in Settings › RunPod GPU`
          : `No datacenter with network volumes has any ${wanted.map(shortGpu).join(" / ") || "of the chosen GPUs"} in stock right now. Try again later, or add another GPU type in Settings › RunPod GPU`,
      )
    }
    this.progress(boxId, `Making a ${s.volumeGb} GB network volume in ${dc.id}`)
    return this.d.api.createVolume({ name, sizeGb: s.volumeGb, dataCenter: dc.id, type: dc.volumeType })
  }

  /** The $/hr cap on a project's pods together: its own, else Settings › RunPod GPU's. 0: none. */
  capOf(projectId: string): number {
    return this.d.projectCap?.(projectId) ?? this.d.settings().maxHourlyUsd
  }

  /** RunPod's GPU catalog with list prices, cached for a few minutes. */
  private async gpuCatalog(fresh = false): Promise<CatalogGpu[]> {
    if (fresh || !this.catalog || Date.now() - this.catalog.at > CATALOG_TTL_MS) this.catalog = { at: Date.now(), gpus: await this.d.api.gpus() }
    return this.catalog.gpus
  }

  /** The machine a project's next pod asks for: its own GPU types, cloud and minimums, else Settings › RunPod GPU's. */
  machineOf(projectId: string): PodMachine {
    const s = this.d.settings()
    const own = this.d.projectMachine?.(projectId)
    return {
      gpuTypes: own?.gpuTypes?.length ? own.gpuTypes : s.gpuTypes,
      cloud: own?.cloud ?? s.cloud,
      minRamGb: own?.minRamGb ?? s.minRamGb,
      minVcpus: own?.minVcpus ?? s.minVcpus,
    }
  }

  /**
   * The machine's GPU types in priority order that its cloud offers, each at its list price there, within the
   * project's cap (no one pod may cost more).
   */
  private affordable(m: PodMachine, gpus: CatalogGpu[], cap: number): { gpu: CatalogGpu; usd: number }[] {
    const byId = new Map(gpus.map((g) => [g.id, g]))
    const out: { gpu: CatalogGpu; usd: number }[] = []
    for (const id of m.gpuTypes) {
      const gpu = byId.get(id)
      const usd = gpu ? catalogPrice(gpu, m.cloud) : null
      if (gpu && usd !== null && (!cap || usd <= cap)) out.push({ gpu, usd })
    }
    return out
  }

  /**
   * What the project's next pod would likely cost: the list price, on the project's cloud, of the first of its GPU
   * types that fits its cap (the type a pod tries first). Null when none fits. Placement checks the caps with it
   * before it counts on a new pod.
   */
  async nextPodPrice(projectId: string): Promise<{ gpu: string; usd: number } | null> {
    const m = this.machineOf(projectId)
    const first = this.affordable(m, await this.gpuCatalog(), this.capOf(projectId))[0]
    return first ? { gpu: `${shortGpu(first.gpu.id)}${m.cloud === "COMMUNITY" ? " (Community)" : ""}`, usd: first.usd } : null
  }

  private startPod(boxId: string): Promise<RunPodPod> {
    const p = this.creating.then(() => this.createPod(boxId))
    this.creating = p.catch(() => {})
    return p
  }

  private async createPod(boxId: string): Promise<RunPodPod> {
    const s = this.d.settings()
    const projectId = gpuBoxProject(boxId)
    const cap = this.capOf(projectId)
    const m = this.machineOf(projectId)
    const gpus = await this.gpuCatalog(true)
    const candidates = this.affordable(m, gpus, cap)
    if (!candidates.length) {
      throw new Error(`None of the project's GPU types (${m.gpuTypes.map(shortGpu).join(", ")}) is offered on ${cloudLabel(m.cloud)} within the $${cap}/hr cap`)
    }
    // The caps count every pod this install has running, and the project's own.
    const others = (await this.listPods(true)).filter((p) => p.boxId !== boxId)
    const spend = others.reduce((sum, p) => sum + (p.pod.cost ?? 0), 0)
    const projectSpend = others.filter((p) => gpuBoxProject(p.boxId) === projectId).reduce((sum, p) => sum + (p.pod.cost ?? 0), 0)
    const volume = await this.ensureVolume(boxId, gpus)
    // Community hosts aren't in RunPod's datacenter list: RunPod places those pods itself.
    const secure = m.cloud === "SECURE"
    const dcs = volume || !secure ? null : await this.d.api.dataCenters()
    const misses: string[] = []
    for (const { gpu, usd } of candidates) {
      if (s.totalMaxHourlyUsd && spend + usd > s.totalMaxHourlyUsd) {
        misses.push(`${shortGpu(gpu.id)} would take GPU spend to $${(spend + usd).toFixed(2)}/hr, over the $${s.totalMaxHourlyUsd}/hr total cap`)
        continue
      }
      if (cap && projectSpend + usd > cap) {
        misses.push(`${shortGpu(gpu.id)} would take the project's pods to $${(projectSpend + usd).toFixed(2)}/hr, over its $${cap}/hr cap`)
        continue
      }
      const dc = secure ? (volume?.dataCenter ?? s.dataCenter ?? rankDataCenters(dcs ?? [], [gpu.id])[0]?.id ?? null) : null
      if (secure && !dc) {
        misses.push(`no ${shortGpu(gpu.id)} in stock`)
        continue
      }
      this.progress(boxId, `Starting a RunPod ${shortGpu(gpu.id)} ${dc ? `in ${dc}` : "on Community Cloud"} (${m.minRamGb} GB RAM, ${m.minVcpus} vCPUs or more)`)
      try {
        const pod = await this.d.api.createPod({
          name: this.resourceName(boxId),
          image: s.image || RUNPOD_STOCK_IMAGE,
          gpuId: gpu.id,
          cloud: m.cloud,
          dataCenterId: dc,
          minRamGb: m.minRamGb,
          minVcpus: m.minVcpus,
          volumeId: volume?.id ?? null,
          containerDiskGb: s.containerDiskGb,
          ports: ["22/tcp", ...POD_HTTP_PORTS.map((p) => `${p}/http`)],
          env: {
            PUBLIC_KEY: this.d.ssh.publicKey(),
            BOXYARD_POD_IDLE_MINUTES: String(s.watchdogMinutes),
            NVIDIA_DRIVER_CAPABILITIES: "all",
            NVIDIA_DISABLE_REQUIRE: "1",
            IS_SANDBOX: "1",
            DISABLE_AUTOUPDATER: "1",
          },
        })
        if (cap && projectSpend + (pod.cost ?? 0) > cap) {
          await this.d.api.terminatePod(pod.id).catch(() => {})
          misses.push(`${shortGpu(gpu.id)} came back at $${pod.cost}/hr, over the project's $${cap}/hr cap`)
          continue
        }
        this.listed = null
        this.d.onEvent?.({ boxId, kind: "started", pod, detail: `${shortGpu(gpu.id)} ${dc ? `in ${dc}` : "on Community Cloud"} at $${pod.cost ?? usd}/hr${volume ? `, volume ${volume.id}` : ""}` })
        return pod
      } catch (err) {
        if (err instanceof RunPodError && (err.capacity || err.status === 500)) {
          misses.push(`no ${shortGpu(gpu.id)} free ${dc ? `in ${dc}` : "on Community Cloud"} with ${m.minRamGb} GB RAM and ${m.minVcpus} vCPUs`)
          continue
        }
        throw err
      }
    }
    throw new Error(`Couldn't start a GPU pod: ${misses.join("; ")}. Try again in a few minutes, or add another GPU type in Settings › RunPod GPU`)
  }

  private async waitRunning(boxId: string, pod: RunPodPod): Promise<RunPodPodState> {
    const until = Date.now() + START_TIMEOUT_MS
    let current: RunPodPod | null = pod
    while (Date.now() < until) {
      current = await this.d.api.getPod(pod.id)
      if (!current || current.status === "TERMINATED") throw new Error(`Pod ${pod.id} was terminated while starting`)
      if (current.status === "ERROR" || current.status === "EXITED") throw new Error(`Pod ${pod.id} ${current.status.toLowerCase()} while starting (check the image: ${current.image ?? "?"})`)
      const target = targetOf(current)
      if (current.status === "RUNNING" && target) {
        const st = { boxId, pod: current, target }
        this.states.set(boxId, st)
        return st
      }
      this.progress(boxId, `Waiting for the GPU pod ${pod.id} to start (${(current.status ?? "starting").toLowerCase()})`)
      await sleep(POLL_MS)
    }
    throw new Error(`Pod ${pod.id} didn't start within ${START_TIMEOUT_MS / 60_000} minutes`)
  }

  /** Make a running pod ready for Box Yard: SSH up, tools installed (stock image only), init.sh, git identity. */
  private async prepare(boxId: string, st: RunPodPodState): Promise<void> {
    const t = st.target!
    const until = Date.now() + SSH_TIMEOUT_MS
    let last = ""
    for (;;) {
      const r = await this.d.ssh.run(t, "true", { direct: true, timeoutMs: 30_000 })
      if (r.exitCode === 0) break
      last = r.stderr.trim().split("\n").pop() ?? ""
      if (Date.now() > until) throw new Error(`Couldn't SSH into pod ${st.pod.id}: ${last}`)
      await sleep(POLL_MS)
    }
    // Scripts from this Box Yard (a custom image has them too; these may be newer).
    for (const name of ["bootstrap.sh", "init.sh", "watchdog.sh"]) {
      const r = await this.d.ssh.run(t, `mkdir -p /opt/boxyard && cat > /opt/boxyard/${name}.tmp && chmod +x /opt/boxyard/${name}.tmp && mv /opt/boxyard/${name}.tmp /opt/boxyard/${name}`, {
        direct: true,
        input: fs.readFileSync(path.join(this.d.scriptsDir, name)),
        timeoutMs: 60_000,
      })
      if (r.exitCode !== 0) throw new Error(`Couldn't upload ${name} to pod ${st.pod.id}: ${r.stderr.slice(-300)}`)
    }
    const ready = await this.d.ssh.run(t, "test -f /opt/boxyard/ready", { direct: true, timeoutMs: 30_000 })
    if (ready.exitCode !== 0) {
      this.progress(boxId, `Installing the agent tools on the GPU pod (about a minute; a custom image in Settings › RunPod GPU skips this)`)
      const b = await this.d.ssh.run(t, "bash /opt/boxyard/bootstrap.sh > /root/boxyard-bootstrap.log 2>&1 || (tail -n 30 /root/boxyard-bootstrap.log; exit 1)", { direct: true, timeoutMs: BOOTSTRAP_TIMEOUT_MS })
      if (b.exitCode !== 0) throw new Error(`Installing tools on pod ${st.pod.id} failed: ${(b.stdout.toString() + b.stderr).slice(-800)}`)
    }
    const init = await this.d.ssh.run(
      t,
      [
        "bash /opt/boxyard/init.sh",
        "node --version && claude --version",
      ].join(" && "),
      { direct: true, timeoutMs: 120_000 },
    )
    if (init.exitCode !== 0) throw new Error(`Preparing pod ${st.pod.id} failed: ${(init.stdout.toString() + init.stderr).slice(-800)}`)
  }

  /** RunPod's HTTP proxy: public, no auth, about 100 s per request, websockets work. Only POD_HTTP_PORTS are exposed. */
  async publicUrl(boxId: string, port: number): Promise<string> {
    const st = await this.state(boxId)
    if (!st) throw new Error(`The GPU pod for ${boxId} isn't running`)
    if (!POD_HTTP_PORTS.includes(port)) throw new Error(`Only the first port of each task (${POD_HTTP_PORTS[0]}, ${POD_HTTP_PORTS[1]}, …) is reachable on a RunPod pod; serve on that one`)
    return `https://${st.pod.id}-${port}.proxy.runpod.net`
  }

  /** Terminate the box's pod. Its network volume stays: only Settings › RunPod GPU deletes volumes. */
  async destroy(boxId: string): Promise<void> {
    const st = await this.state(boxId).catch(() => null)
    if (!st) return
    await this.d.api.terminatePod(st.pod.id)
    this.d.onEvent?.({ boxId, kind: "terminated", pod: st.pod, detail: `${shortGpu(st.pod.gpu?.id ?? "GPU")} pod ${st.pod.id} terminated` })
    this.d.ssh.forget(st.pod.id)
    this.dropState(boxId)
  }

  async usage(_boxId: string): Promise<BoxUsageProbe> {
    return { source: "estimated" }
  }

  /** Hold the pod's own watchdog off until `until` (ms since epoch), or clear it with null. */
  async keepWarm(boxId: string, until: number | null): Promise<void> {
    const st = await this.state(boxId)
    if (!st?.target) return
    await this.d.ssh.run(st.target, until ? `echo ${Math.ceil(until / 1000)} > /box/.keep-warm-until` : "rm -f /box/.keep-warm-until", { timeoutMs: 30_000 })
  }
}

function targetOf(pod: RunPodPod): SshTarget | null {
  const d = pod.ssh?.direct
  return d?.host && d.port ? { podId: pod.id, host: d.host, port: d.port } : null
}

export { shortGpu }

import fs from "node:fs"
import path from "node:path"
import type { WorkerSize } from "../../shared/types.js"
import { GPU_BOX_PREFIXES, gpuBoxProvider, gpuBoxRest } from "../../shared/gpu.js"
import { gpuBoxProject } from "../../shared/runpod.js"
import type { VastSettings } from "../../shared/vast.js"
import { ONSTART_MAX, VastError, hostPort, instanceStatus, sshEndpoint, vastGpuName, type OfferQuery, type VastApi, type VastInstance, type VastOffer } from "../vast/api.js"
import type { SshPool, SshTarget } from "../runpod/ssh.js"
import { q, type BoxHealth, type BoxProvider, type BoxUsageProbe } from "./types.js"
import { SshBoxProvider } from "./sshBox.js"
import { POD_HTTP_PORTS } from "./runpod.js"

const ROOT = "/box"
const PREFIX = GPU_BOX_PREFIXES.vast
const POLL_MS = 4000
/** A marketplace host may pull the image slowly the first time it sees it. */
const START_TIMEOUT_MS = 20 * 60_000
const SSH_TIMEOUT_MS = 4 * 60_000
const BOOTSTRAP_TIMEOUT_MS = 20 * 60_000
const LIST_TTL_MS = 10_000
/**
 * Offers change by the minute, but Vast has a daily search quota: placement asks for the next instance's price on
 * every pass, so it reads offers this old at most. A create searches again.
 */
const OFFERS_TTL_MS = 3 * 60_000
/** Offers tried per GPU type when one is taken between search and rent. */
const OFFERS_PER_TYPE = 3
/** SSH, plus a task's first port per folder, go straight to the host. */
const MIN_DIRECT_PORTS = POD_HTTP_PORTS.length + 1
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A Vast instance as TaskManager reads every GPU cloud's pods: RunPod's field names. */
export interface VastPod {
  id: string
  name: string
  status: "RUNNING" | "STARTING" | "EXITED" | "ERROR"
  cost?: number
  gpu?: { id?: string } | null
  dataCenterId?: string | null
  startedAt?: string | null
  image?: string
}

export interface VastPodState {
  boxId: string
  pod: VastPod
  target: SshTarget | null
  instance: VastInstance
}

/** A project's own machine for its next instance; null fields use Settings › Vast.ai GPU's. */
export interface VastProjectMachine {
  gpuTypes: string[] | null
  minRamGb: number | null
  minVcpus: number | null
}

export interface VastProviderDeps {
  api: VastApi
  ssh: SshPool
  settings: () => VastSettings
  /** The image instances start from (settings.image, else RunPod's built image, else the stock one). */
  image: () => string
  install: () => string
  /** Box Yard's runpod/ folder (bootstrap.sh installs the tools on any Ubuntu image) and vast/ (init.sh, watchdog.sh). */
  bootstrapDir: string
  scriptsDir: string
  onEvent?: (e: { boxId: string; kind: "started" | "terminated"; detail: string }) => void
  onProgress?: (boxId: string, message: string) => void
  projectCap?: (projectId: string) => number | null
  projectMachine?: (projectId: string) => VastProjectMachine
}

export interface VastMachine {
  gpuTypes: string[]
  minRamGb: number
  minVcpus: number
}

function podOf(i: VastInstance, image?: string): VastPod {
  return {
    id: String(i.id),
    name: i.label ?? "",
    status: instanceStatus(i),
    ...(typeof i.dph_total === "number" ? { cost: Math.round(i.dph_total * 10_000) / 10_000 } : {}),
    gpu: i.gpu_name ? { id: i.gpu_name } : null,
    dataCenterId: i.geolocation ?? null,
    startedAt: i.start_date ? new Date(i.start_date * 1000).toISOString() : null,
    ...(image ? { image } : {}),
  }
}

function targetOf(i: VastInstance): SshTarget | null {
  const e = instanceStatus(i) === "RUNNING" ? sshEndpoint(i) : null
  return e ? { podId: `vast${i.id}`, host: e.host, port: e.port } : null
}

/**
 * Vast.ai GPU instances as Box Yard boxes, beside RunPod's (providers/runpod.ts). Each of a GPU project's instances is
 * a virtual box, `vastai-<projectId>` for #1 and `vastai-<projectId>-<n>` for #n (shared/gpu.ts), with at most one
 * instance behind it, labelled `boxyard-<install>-<projectId>[-<n>]` at Vast. `wake` rents the cheapest offer that
 * fits the project's GPU types, machine minimums and the $/hr caps; `destroy` destroys it (a stopped Vast instance
 * keeps no GPU and may never restart, so idle ones go). Nothing but `wake` ever rents, so polling a stopped box is
 * free. There's no volume: every instance starts cold and its workspaces come back from Box Yard's archives.
 */
export class VastProvider extends SshBoxProvider implements BoxProvider {
  readonly name = "vast"
  readonly nodeBin = "node"
  readonly claudeBin = "claude"
  private readonly states = new Map<string, VastPodState>()
  private readonly waking = new Map<string, Promise<void>>()
  private listed: { at: number; instances: VastInstance[] } | null = null
  private offers: { at: number; key: string; offers: VastOffer[] } | null = null
  /** Rents one at a time, so two instances starting together can't both fit under a cap only one fits under. */
  private creating: Promise<unknown> = Promise.resolve()
  private readonly lastProgress = new Map<string, string>()

  constructor(private readonly d: VastProviderDeps) {
    super(d.ssh)
  }

  root() {
    return ROOT
  }

  /** Instance labels: `boxyard-<install>-<projectId>[-<n>]`, as RunPod pods are named. */
  resourceName(boxId: string) {
    return `boxyard-${this.d.install()}-${gpuBoxRest(boxId)}`
  }

  private boxOfLabel(label: string | null | undefined): string | null {
    const prefix = `boxyard-${this.d.install()}-`
    return label?.startsWith(prefix) ? `${PREFIX}${label.slice(prefix.length)}` : null
  }

  async create(_opts: { labels: string[]; size?: WorkerSize; snapshotId?: string }): Promise<string> {
    throw new Error("Vast.ai boxes aren't made through the box pool: a GPU project's instances are vastai-<projectId>[-<n>]")
  }

  /** This install's instances, by box id. A box with two (a crash mid-rent) shows the newest; the sweep finds the other. */
  async listPods(fresh = false): Promise<VastPodState[]> {
    if (fresh || !this.listed || Date.now() - this.listed.at > LIST_TTL_MS) this.listed = { at: Date.now(), instances: await this.d.api.listInstances() }
    const out: VastPodState[] = []
    for (const instance of this.listed.instances) {
      const boxId = this.boxOfLabel(instance.label)
      if (!boxId) continue
      out.push({ boxId, pod: podOf(instance), target: targetOf(instance), instance })
    }
    return out
  }

  cached(boxId: string): VastPod | null {
    return this.states.get(boxId)?.pod ?? null
  }

  private async state(boxId: string): Promise<VastPodState | null> {
    const known = this.states.get(boxId)
    if (known) return known
    const found = (await this.listPods()).find((p) => p.boxId === boxId)
    if (found) this.states.set(boxId, found)
    return found ?? null
  }

  private setState(boxId: string, instance: VastInstance) {
    const st: VastPodState = { boxId, pod: podOf(instance, this.d.image()), target: targetOf(instance), instance }
    this.states.set(boxId, st)
    return st
  }

  protected async target(boxId: string): Promise<SshTarget> {
    const st = await this.state(boxId)
    if (!st?.target || st.pod.status !== "RUNNING") throw new Error(`The Vast.ai instance for ${boxId} isn't running`)
    return st.target
  }

  async health(boxId: string): Promise<BoxHealth> {
    let st: VastPodState | null
    try {
      st = await this.state(boxId)
      if (st) {
        const inst = await this.d.api.getInstance(st.instance.id)
        if (!inst) {
          this.dropState(boxId)
          return "paused"
        }
        st = this.setState(boxId, inst)
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

  wake(boxId: string): Promise<void> {
    if (gpuBoxProvider(boxId) !== "vast") return Promise.reject(new Error(`${boxId} isn't a Vast.ai box`))
    const running = this.waking.get(boxId)
    if (running) return running
    const p = this.ensureInstance(boxId).finally(() => this.waking.delete(boxId))
    this.waking.set(boxId, p)
    return p
  }

  private progress(boxId: string, message: string) {
    if (this.lastProgress.get(boxId) === message) return
    this.lastProgress.set(boxId, message)
    this.d.onProgress?.(boxId, message)
  }

  /** Destroy an instance Box Yard won't use, forgetting it either way. */
  private async discard(boxId: string, id: number) {
    await this.d.api.destroyInstance(id).catch(() => {})
    this.dropState(boxId)
  }

  private async ensureInstance(boxId: string): Promise<void> {
    const existing = await this.state(boxId)
    if (existing) {
      const inst = await this.d.api.getInstance(existing.instance.id)
      if (inst && instanceStatus(inst) === "RUNNING" && targetOf(inst)) {
        const st = this.setState(boxId, inst)
        const ok = await this.d.ssh.run(st.target!, "test -f /opt/boxyard/ready && test -d /box/tasks", { timeoutMs: 30_000 })
        if (ok.exitCode === 0) return
        if (ok.exitCode !== 255) return this.prepare(boxId, st)
      }
      if (inst && instanceStatus(inst) === "STARTING") return this.prepare(boxId, await this.waitRunning(boxId, inst.id))
      // Stopped, exited or unreachable: a stopped Vast instance may never get its GPU back, so start over.
      if (inst) await this.d.api.destroyInstance(inst.id).catch(() => {})
      this.dropState(boxId)
    }
    const id = await this.startInstance(boxId)
    try {
      const st = await this.waitRunning(boxId, id)
      await this.prepare(boxId, st)
    } catch (err) {
      await this.discard(boxId, id)
      throw err
    }
  }

  /** The $/hr cap on a project's instances together: its own, else Settings › Vast.ai GPU's. 0: none. */
  capOf(projectId: string): number {
    return this.d.projectCap?.(projectId) ?? this.d.settings().maxHourlyUsd
  }

  /** The machine a project's next instance asks for: its own GPU types and minimums, else Settings › Vast.ai GPU's. */
  machineOf(projectId: string): VastMachine {
    const s = this.d.settings()
    const own = this.d.projectMachine?.(projectId)
    return {
      // A project's GPU types may be RunPod ids from when it ran there ("NVIDIA RTX A5000" is Vast's "RTX A5000").
      gpuTypes: [...new Set((own?.gpuTypes?.length ? own.gpuTypes : s.gpuTypes).map(vastGpuName))],
      minRamGb: own?.minRamGb ?? s.minRamGb,
      minVcpus: own?.minVcpus ?? s.minVcpus,
    }
  }

  private query(m: VastMachine, maxUsd: number): OfferQuery {
    const s = this.d.settings()
    return {
      gpuTypes: m.gpuTypes,
      minRamGb: m.minRamGb,
      minVcpus: m.minVcpus,
      diskGb: s.containerDiskGb,
      verifiedOnly: s.verifiedOnly,
      minReliability: s.minReliability,
      minInetDownMbps: s.minInetDownMbps,
      minDirectPorts: MIN_DIRECT_PORTS,
      maxUsd,
    }
  }

  /** Offers that fit a machine under `maxUsd`, cheapest first, cached a few minutes unless `fresh` (Vast's search quota). */
  async searchOffers(m: VastMachine, maxUsd: number, fresh = false): Promise<VastOffer[]> {
    const q = this.query(m, maxUsd)
    const key = JSON.stringify(q)
    if (!fresh && this.offers?.key === key && Date.now() - this.offers.at < OFFERS_TTL_MS) return this.offers.offers
    const offers = await this.d.api.searchOffers(q)
    this.offers = { at: Date.now(), key, offers }
    return offers
  }

  /**
   * Offers in the project's GPU priority order (a type's cheapest first), each within its cap. The first GPU type
   * with an offer is what the next instance tries first.
   */
  private ranked(m: VastMachine, offers: VastOffer[]): VastOffer[] {
    const order = new Map(m.gpuTypes.map((g, i) => [g, i]))
    return offers.filter((o) => order.has(o.gpu_name)).sort((a, b) => order.get(a.gpu_name)! - order.get(b.gpu_name)! || a.dph_total - b.dph_total)
  }

  /**
   * What the project's next instance would likely cost: the cheapest offer of the first of its GPU types that has
   * one within its cap. Null when none does. Placement checks the caps with it before it counts on a new instance.
   */
  async nextPodPrice(projectId: string): Promise<{ gpu: string; usd: number } | null> {
    const m = this.machineOf(projectId)
    const first = this.ranked(m, await this.searchOffers(m, this.capOf(projectId)))[0]
    return first ? { gpu: `${first.gpu_name} (Vast.ai)`, usd: Math.round(first.dph_total * 10_000) / 10_000 } : null
  }

  private startInstance(boxId: string): Promise<number> {
    const p = this.creating.then(() => this.rent(boxId))
    this.creating = p.catch(() => {})
    return p
  }

  /** The onstart script: Box Yard's key in, the instance-scoped key kept for the watchdog only, and the watchdog started. */
  onstart(): string {
    const s = this.d.settings()
    const watchdog = fs
      .readFileSync(path.join(this.d.scriptsDir, "watchdog.sh"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l) || l.startsWith("#!"))
      .join("\n")
    const key = this.d.ssh.publicKey()
    const script = [
      "mkdir -p /root/.ssh /opt/boxyard /box/.boxyard /box/tasks && chmod 700 /root/.ssh",
      `grep -qxF ${q(key)} /root/.ssh/authorized_keys 2>/dev/null || echo ${q(key)} >> /root/.ssh/authorized_keys`,
      "chmod 600 /root/.ssh/authorized_keys; touch /root/.no_auto_tmux /box/.heartbeat",
      // Vast puts CONTAINER_ID and CONTAINER_API_KEY in the container's env; PID 1 has them when onstart's shell doesn't.
      ...["CONTAINER_ID", "CONTAINER_API_KEY"].map((v) => `[ -n "\${${v}:-}" ] || ${v}=$(tr '\\0' '\\n' < /proc/1/environ | sed -n 's/^${v}=//p' | head -n1)`),
      `(umask 077; printf 'CONTAINER_ID=%s\\nCONTAINER_API_KEY=%s\\nBOXYARD_POD_IDLE_MINUTES=%s\\n' "$CONTAINER_ID" "$CONTAINER_API_KEY" ${s.watchdogMinutes} > /opt/boxyard/vast.env)`,
      "cat > /opt/boxyard/watchdog.sh <<'BOXYARD_EOF'",
      watchdog.trimEnd(),
      "BOXYARD_EOF",
      "chmod 700 /opt/boxyard/watchdog.sh",
      "pgrep -f /opt/boxyard/watchdog.sh >/dev/null || (setsid nohup /opt/boxyard/watchdog.sh >> /box/watchdog.log 2>&1 < /dev/null &)",
      "",
    ].join("\n")
    if (script.length > ONSTART_MAX) throw new Error(`The Vast.ai onstart script is ${script.length} characters, over Vast's ${ONSTART_MAX}`)
    return script
  }

  /** Rent the cheapest offer that fits, within both caps. Returns the instance id. */
  private async rent(boxId: string): Promise<number> {
    const s = this.d.settings()
    const projectId = gpuBoxProject(boxId)
    const cap = this.capOf(projectId)
    const m = this.machineOf(projectId)
    // The caps count every instance this install has, and the project's own.
    const all = await this.listPods(true)
    // One still labelled for this box is left from a start that didn't finish (the box has none now): it goes first.
    for (const stale of all.filter((p) => p.boxId === boxId)) await this.d.api.destroyInstance(stale.instance.id)
    const others = all.filter((p) => p.boxId !== boxId)
    const spend = others.reduce((sum, p) => sum + (p.pod.cost ?? 0), 0)
    const projectSpend = others.filter((p) => gpuBoxProject(p.boxId) === projectId).reduce((sum, p) => sum + (p.pod.cost ?? 0), 0)
    const room = Math.min(cap ? cap - projectSpend : Infinity, s.totalMaxHourlyUsd ? s.totalMaxHourlyUsd - spend : Infinity)
    if (room <= 0) throw new Error(`Couldn't rent a Vast.ai GPU: the $/hr caps are reached (the project's instances cost $${projectSpend.toFixed(2)}/hr, all of them $${spend.toFixed(2)}/hr)`)
    const offers = this.ranked(m, await this.searchOffers(m, Number.isFinite(room) ? room : 0, true))
    if (!offers.length) {
      throw new Error(
        `No Vast.ai offer of ${m.gpuTypes.join(", ")} with ${m.minRamGb} GB RAM, ${m.minVcpus} vCPUs, ${s.containerDiskGb} GB disk and ${MIN_DIRECT_PORTS} open ports is under $${(Number.isFinite(room) ? room : cap).toFixed(2)}/hr right now. Try again in a few minutes, or add a GPU type or lower the minimums in Settings › Vast.ai GPU`,
      )
    }
    const misses: string[] = []
    const tried = new Map<string, number>()
    const onstart = this.onstart()
    for (const offer of offers) {
      const n = tried.get(offer.gpu_name) ?? 0
      if (n >= OFFERS_PER_TYPE) continue
      tried.set(offer.gpu_name, n + 1)
      const where = offer.geolocation ? ` in ${offer.geolocation}` : ""
      this.progress(boxId, `Renting a Vast.ai ${offer.gpu_name}${where} at $${offer.dph_total.toFixed(3)}/hr (${m.minRamGb} GB RAM, ${m.minVcpus} vCPUs or more)`)
      let id: number
      try {
        id = await this.d.api.createInstance(offer.id, {
          image: this.d.image(),
          diskGb: s.containerDiskGb,
          label: this.resourceName(boxId),
          onstart,
          env: {},
          ports: POD_HTTP_PORTS,
        })
      } catch (err) {
        if (err instanceof VastError && (err.gone || err.status >= 500)) {
          misses.push(`offer ${offer.id} (${offer.gpu_name}) was taken`)
          continue
        }
        throw err
      }
      this.listed = null
      // Its price is the offer's; check it again, as the RunPod runner does, in case Vast bills it higher.
      const inst = await this.d.api.getInstance(id).catch(() => null)
      const usd = inst?.dph_total ?? offer.dph_total
      if ((cap && projectSpend + usd > cap + 1e-9) || (s.totalMaxHourlyUsd && spend + usd > s.totalMaxHourlyUsd + 1e-9)) {
        await this.d.api.destroyInstance(id).catch(() => {})
        misses.push(`${offer.gpu_name} came back at $${usd}/hr, over the caps`)
        continue
      }
      try {
        await this.d.api.attachSshKey(id, this.d.ssh.publicKey())
      } catch (err) {
        // onstart lets the key in too; a failed attach is only fatal if SSH never comes up (prepare says so).
        console.warn(`[box-yard] Vast.ai instance ${id}: attaching the SSH key failed: ${(err as Error).message}`)
      }
      if (inst) this.setState(boxId, inst)
      this.d.onEvent?.({ boxId, kind: "started", detail: `${offer.gpu_name}${where} at $${usd.toFixed(3)}/hr, instance ${id} (offer ${offer.id})` })
      return id
    }
    throw new Error(`Couldn't rent a Vast.ai GPU: ${misses.join("; ")}. Try again in a few minutes`)
  }

  private async waitRunning(boxId: string, id: number): Promise<VastPodState> {
    const until = Date.now() + START_TIMEOUT_MS
    while (Date.now() < until) {
      const inst = await this.d.api.getInstance(id)
      if (!inst) throw new Error(`Vast.ai instance ${id} was destroyed while starting`)
      const status = instanceStatus(inst)
      if (status === "ERROR" || status === "EXITED") throw new Error(`Vast.ai instance ${id} ${inst.actual_status ?? "failed"} while starting${inst.status_msg ? `: ${inst.status_msg.slice(0, 200)}` : ""}`)
      const st = this.setState(boxId, inst)
      if (status === "RUNNING" && st.target) return st
      this.progress(boxId, `Waiting for the Vast.ai instance ${id} to start (${inst.actual_status ?? "scheduling"}${inst.status_msg ? `: ${inst.status_msg.slice(0, 80)}` : ""})`)
      await sleep(POLL_MS)
    }
    throw new Error(`Vast.ai instance ${id} didn't start within ${START_TIMEOUT_MS / 60_000} minutes`)
  }

  /** Make a running instance ready: SSH up, tools installed (bootstrap.sh, unless the image has them), init.sh, git identity. */
  private async prepare(boxId: string, st: VastPodState): Promise<void> {
    const t = st.target!
    const until = Date.now() + SSH_TIMEOUT_MS
    for (;;) {
      const r = await this.d.ssh.run(t, "true", { direct: true, timeoutMs: 30_000 })
      if (r.exitCode === 0) break
      const last = r.stderr.trim().split("\n").pop() ?? ""
      if (Date.now() > until) throw new Error(`Couldn't SSH into Vast.ai instance ${st.pod.id}: ${last}`)
      await sleep(POLL_MS)
    }
    const scripts: [string, string][] = [
      [this.d.bootstrapDir, "bootstrap.sh"],
      [this.d.scriptsDir, "init.sh"],
    ]
    for (const [dir, name] of scripts) {
      const r = await this.d.ssh.run(t, `mkdir -p /opt/boxyard && cat > /opt/boxyard/${name}.tmp && chmod +x /opt/boxyard/${name}.tmp && mv /opt/boxyard/${name}.tmp /opt/boxyard/${name}`, {
        direct: true,
        input: fs.readFileSync(path.join(dir, name)),
        timeoutMs: 60_000,
      })
      if (r.exitCode !== 0) throw new Error(`Couldn't upload ${name} to Vast.ai instance ${st.pod.id}: ${r.stderr.slice(-300)}`)
    }
    const ready = await this.d.ssh.run(t, "test -f /opt/boxyard/ready", { direct: true, timeoutMs: 30_000 })
    if (ready.exitCode !== 0) {
      this.progress(boxId, "Installing the agent tools on the Vast.ai instance (a few minutes; a built image in Settings › RunPod GPU skips this)")
      const b = await this.d.ssh.run(t, "bash /opt/boxyard/bootstrap.sh > /root/boxyard-bootstrap.log 2>&1 || (tail -n 30 /root/boxyard-bootstrap.log; exit 1)", { direct: true, timeoutMs: BOOTSTRAP_TIMEOUT_MS })
      if (b.exitCode !== 0) throw new Error(`Installing tools on Vast.ai instance ${st.pod.id} failed: ${(b.stdout.toString() + b.stderr).slice(-800)}`)
    }
    const init = await this.d.ssh.run(
      t,
      ["bash /opt/boxyard/init.sh", "node --version && claude --version"].join(" && "),
      { direct: true, timeoutMs: 120_000 },
    )
    if (init.exitCode !== 0) throw new Error(`Preparing Vast.ai instance ${st.pod.id} failed: ${(init.stdout.toString() + init.stderr).slice(-800)}`)
  }

  /** The host's own port for a task's first port: plain HTTP, no proxy (Vast has none). Only POD_HTTP_PORTS are published. */
  async publicUrl(boxId: string, port: number): Promise<string> {
    const st = await this.state(boxId)
    if (!st) throw new Error(`The Vast.ai instance for ${boxId} isn't running`)
    if (!POD_HTTP_PORTS.includes(port)) throw new Error(`Only the first port of each task (${POD_HTTP_PORTS[0]}, ${POD_HTTP_PORTS[1]}, …) is reachable on a Vast.ai instance; serve on that one`)
    const p = hostPort(st.instance, port)
    if (!p || !st.instance.public_ipaddr) throw new Error(`Vast.ai hasn't published port ${port} of ${boxId} yet`)
    return `http://${st.instance.public_ipaddr.trim()}:${p}`
  }

  /** Destroy the box's instance (its disk goes with it). */
  async destroy(boxId: string): Promise<void> {
    const st = await this.state(boxId).catch(() => null)
    if (!st) return
    await this.d.api.destroyInstance(st.instance.id)
    this.d.onEvent?.({ boxId, kind: "terminated", detail: `${st.pod.gpu?.id ?? "GPU"} instance ${st.pod.id} destroyed` })
    if (st.target) this.d.ssh.forget(st.target.podId)
    this.dropState(boxId)
  }

  async usage(_boxId: string): Promise<BoxUsageProbe> {
    return { source: "estimated" }
  }

  /** Hold the instance's own watchdog off until `until` (ms since epoch), or clear it with null. */
  async keepWarm(boxId: string, until: number | null): Promise<void> {
    const st = await this.state(boxId)
    if (!st?.target) return
    await this.d.ssh.run(st.target, until ? `echo ${Math.ceil(until / 1000)} > /box/.keep-warm-until` : "rm -f /box/.keep-warm-until", { timeoutMs: 30_000 })
  }
}

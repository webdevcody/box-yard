import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { DOCKER_CONTAINER_PORTS, DOCKER_MAX_TASKS, dockerBoxProject, type DockerSettings } from "../../shared/docker.js"
import { docker, dockerEnv, jsonLines, parseLabels } from "../docker/cli.js"
import type { DockerEngine } from "../docker/engine.js"
import type { DockerImages } from "../docker/images.js"
import { q, type BoxHealth, type BoxProvider, type ExecResult } from "./types.js"

/** The workspace volume's mount: task folders, repo mirrors and the dependency cache. */
const ROOT = "/workspace"
/**
 * A tmpfs for the turn's credentials (task.json's env): only in the container's memory, gone when it stops or is
 * deleted, never on the volume, in the image or in `docker inspect`.
 */
export const DOCKER_SECRETS_DIR = "/run/boxyard"
/** Commands go in on stdin, never on the command line, so `ps` on this computer and `docker events` can't show a token. */
const EVAL = 'eval "$(cat)"'
const LIST_TTL_MS = 5_000
const STOP_TIMEOUT_S = 10

/** What Box Yard knows of a project's container, from `docker ps` (and its volume, when the container is gone). */
export interface DockerContainerState {
  boxId: string
  projectId: string
  /** The container's name, e.g. boxyard-1a2b3c4d-prj_ab12cd. */
  name: string
  /** running, exited, created, paused, restarting, dead; "missing" when only its volume is left. */
  state: string
  image: string | null
  /** ISO time it last started, when it's running. */
  startedAt: string | null
  /** The first of its published ports on this computer (DOCKER_MAX_TASKS in a row). */
  hostPortBase: number | null
}

interface ContainerJson {
  Id: string
  State: { Status: string; Running: boolean; StartedAt?: string }
  Config: { Labels: Record<string, string> | null; Image: string }
}

export interface DockerProviderDeps {
  engine: DockerEngine
  images: Pick<DockerImages, "ensure">
  settings: () => DockerSettings
  /** This install's id (TaskManager.installLabel without "by-"): containers and volumes carry it, and Box Yard only touches those. */
  install: () => string
  /** Box Yard created or started a container (box history). Stops and deletes are TaskManager's own. */
  onEvent?: (e: { boxId: string; kind: "created" | "started"; detail: string }) => void
  /** Progress while a container starts (an image build), for the task's log. */
  onProgress?: (boxId: string, message: string) => void
  /** Tests: the claude command inside containers. */
  claudeBin?: string
}

const isRunningError = (stderr: string) => /is not running|is paused/i.test(stderr)

/**
 * Docker containers on this computer as Box Yard boxes (docs/docker.md). A Docker project's virtual box,
 * `docker-<projectId>`, is one container of its own, made by `wake` from the project's image (DockerImages) with:
 * - the named volume `<container>-work` at /workspace, the only thing mounted: no host folder, no Docker socket;
 * - each task folder's $PORT published on 127.0.0.1 only (`publicUrl` is http://localhost:<port>);
 * - CPU, memory and process limits from Settings › Docker, the default bridge network (git, npm and the Claude API
 *   need it), and the image's user (Box Yard's: "agent", uid 1000, with sudo inside the container only).
 * Commands run with `docker exec -i` and arrive on stdin, so no token is ever on a command line. A turn's credentials
 * reach it in task.json and its signing key in signing.key, which `writeFile` keeps on a tmpfs (DOCKER_SECRETS_DIR,
 * also the runner's `secretsDir`), never on the volume. Stopping the container (idle)
 * keeps the volume; `destroy` removes both. Every container and volume carries this install's labels, and nothing
 * here touches one that doesn't.
 */
/** Task folder files writeFile keeps on the tmpfs, and the suffix each gets there. */
const HELD_IN_MEMORY: Record<string, string> = { "task.json": "json", "signing.key": "signing.key", "codex-auth.json": "codex-auth.json" }

export class DockerProvider implements BoxProvider {
  readonly name = "docker"
  readonly nodeBin = "node"
  readonly claudeBin: string
  readonly secretsDir = DOCKER_SECRETS_DIR
  private readonly waking = new Map<string, Promise<void>>()
  private listed: { at: number; containers: DockerContainerState[] } | null = null
  /** Each container's first published port, as last read, so a preview link doesn't need `docker inspect`. */
  private readonly ports = new Map<string, number>()

  constructor(private readonly d: DockerProviderDeps) {
    this.claudeBin = d.claudeBin ?? "claude"
  }

  containerName(boxId: string): string {
    return `boxyard-${this.d.install()}-${dockerBoxProject(boxId).toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`
  }

  volumeName(boxId: string): string {
    return `${this.containerName(boxId)}-work`
  }

  root(_boxId: string): string {
    return ROOT
  }

  async create(): Promise<string> {
    throw new Error("A Docker project's container is made when its first task needs it (wake), never from the pool")
  }

  /**
   * running; paused when the container is stopped, or gone while its volume stays (wake makes it again, workspaces
   * and all); gone when the volume is gone too; unknown when Docker can't say (not running).
   */
  async health(boxId: string): Promise<BoxHealth> {
    let bin: string
    try {
      bin = await this.d.engine.bin()
    } catch {
      return "unknown"
    }
    const c = await this.inspect(bin, boxId)
    if (c === "error") return "unknown"
    if (c) return c.State.Running ? "running" : "paused"
    const v = await docker(bin, ["volume", "inspect", this.volumeName(boxId)], { timeoutMs: 30_000 })
    if (v.code === 0) return "paused"
    return /no such volume/i.test(v.stderr) ? "gone" : "unknown"
  }

  /** Start the project's container, making it (and its image) first when needed. Concurrent calls share one start. */
  wake(boxId: string): Promise<void> {
    const running = this.waking.get(boxId)
    if (running) return running
    const p = this.ensure(boxId).finally(() => this.waking.delete(boxId))
    this.waking.set(boxId, p)
    return p
  }

  private async ensure(boxId: string): Promise<void> {
    const bin = await this.d.engine.bin()
    const name = this.containerName(boxId)
    let c = await this.inspect(bin, boxId)
    if (c === "error") throw new Error(`docker couldn't inspect container ${name}`)
    if (c?.State.Running) return
    const image = await this.d.images.ensure(dockerBoxProject(boxId), (m) => this.d.onProgress?.(boxId, m))
    let replaced = false
    if (c && c.Config.Labels?.["boxyard.image"] !== image) {
      // Stopped on an older image (docker/ or the project's Dockerfile changed): make it again. The volume keeps
      // every workspace; only what agents installed outside it (apt packages) goes.
      this.mine(c, name)
      const rm = await docker(bin, ["rm", "-f", name], { timeoutMs: 60_000 })
      if (rm.code !== 0) throw new Error(`docker rm ${name} failed: ${rm.stderr.trim().slice(-300)}`)
      c = null
      replaced = true
    }
    if (c) {
      this.mine(c, name)
      // Settings › Docker's CPU and memory, as they are now.
      await docker(bin, ["update", ...this.limits(name)], { timeoutMs: 30_000 })
      const r = await docker(bin, ["start", name], { timeoutMs: 120_000 })
      if (r.code !== 0) throw new Error(`docker start ${name} failed: ${r.stderr.trim().slice(-400)}`)
      this.listed = null
      await this.prepare(bin, boxId, image)
      this.d.onEvent?.({ boxId, kind: "started", detail: `Started container ${name} (${image}); its workspaces were on its volume.` })
      return
    }
    const base = await this.runContainer(bin, boxId, image)
    this.listed = null
    await this.prepare(bin, boxId, image)
    this.d.onEvent?.({
      boxId,
      kind: "created",
      detail: `${replaced ? "Re-created" : "Created"} container ${name} from ${image} (${this.d.settings().cpus} CPUs, ${this.d.settings().memoryMb} MB), previews on localhost:${base}-${base + DOCKER_MAX_TASKS - 1}.`,
    })
  }

  /** --cpus and --memory from Settings › Docker, for `docker run` and `docker update`. Swap: as much again. */
  private limits(name?: string): string[] {
    const s = this.d.settings()
    return ["--cpus", String(s.cpus), "--memory", `${s.memoryMb}m`, "--memory-swap", `${s.memoryMb * 2}m`, ...(name ? [name] : [])]
  }

  private async runContainer(bin: string, boxId: string, image: string): Promise<number> {
    const name = this.containerName(boxId)
    const volume = this.volumeName(boxId)
    const install = this.d.install()
    const labels = ["boxyard=1", `boxyard.install=${install}`, `boxyard.box=${boxId}`, `boxyard.project=${dockerBoxProject(boxId)}`]
    const vol = await docker(bin, ["volume", "inspect", "--format", "{{json .Labels}}", volume], { timeoutMs: 30_000 })
    let volLabels: Record<string, string> = {}
    try {
      volLabels = (JSON.parse(vol.stdout.toString("utf8")) as Record<string, string> | null) ?? {}
    } catch {}
    if (vol.code === 0 && volLabels["boxyard.install"] !== install) throw new Error(`Volume ${volume} isn't this Box Yard's; it was left alone`)
    const preferred = Number(volLabels["boxyard.ports"]) || null
    let tries = 0
    for (;;) {
      const base = await this.pickPorts(bin, preferred, tries)
      if (vol.code !== 0 && tries === 0) {
        // The volume remembers its first port block, so a container made again keeps its preview links.
        const mk = await docker(bin, ["volume", "create", ...labels.flatMap((l) => ["--label", l]), "--label", `boxyard.ports=${base}`, volume], { timeoutMs: 30_000 })
        if (mk.code !== 0) throw new Error(`docker volume create ${volume} failed: ${mk.stderr.trim().slice(-300)}`)
      }
      const args = [
        "run", "-d", "--name", name, "--init",
        ...[...labels, `boxyard.image=${image}`, `boxyard.ports=${base}`].flatMap((l) => ["--label", l]),
        ...this.limits(),
        "--pids-limit", "4096", "--shm-size", "1g",
        "--mount", `type=volume,src=${volume},dst=${ROOT}`,
        "--tmpfs", `${DOCKER_SECRETS_DIR}:rw,nosuid,nodev,noexec,size=16m,mode=0700`,
        "-e", "IS_SANDBOX=1", "-e", "DISABLE_AUTOUPDATER=1", "-e", "BOXYARD_DOCKER=1",
        ...DOCKER_CONTAINER_PORTS.flatMap((p, i) => ["-p", `127.0.0.1:${base + i}:${p}`]),
        // Whatever the image's entrypoint, the container only idles: agents start with docker exec.
        "--entrypoint", "sleep", image, "infinity",
      ]
      const r = await docker(bin, args, { timeoutMs: 120_000 })
      if (r.code === 0) {
        this.ports.set(boxId, base)
        return base
      }
      await docker(bin, ["rm", "-f", name], { timeoutMs: 60_000 })
      // Something else took a port between the check and the run: try the next block.
      if (/port is already allocated|address already in use|bind/i.test(r.stderr) && ++tries < 5) continue
      throw new Error(`docker run for ${name} failed: ${r.stderr.trim().slice(-400)}`)
    }
  }

  /**
   * A block of DOCKER_MAX_TASKS free ports on this computer for a container's previews: the volume's own when it's
   * still free, else the first one from Settings › Docker › Preview ports that no Box Yard container (of any install
   * here) has and nothing else is listening on.
   */
  private async pickPorts(bin: string, preferred: number | null, skip: number): Promise<number> {
    const r = await docker(bin, ["ps", "-a", "--filter", "label=boxyard.ports", "--format", '{{.Label "boxyard.ports"}}'], { timeoutMs: 30_000 })
    const taken = r.stdout.toString("utf8").split("\n").map(Number).filter((n) => n > 0)
    const clash = (base: number) => taken.some((t) => Math.abs(t - base) < DOCKER_MAX_TASKS)
    const from = this.d.settings().hostPortBase
    const candidates = [...(preferred && skip === 0 ? [preferred] : []), ...Array.from({ length: 200 }, (_, n) => from + (n + skip) * DOCKER_MAX_TASKS)]
    for (const base of candidates) {
      if (base + DOCKER_MAX_TASKS > 65_535) break
      if (clash(base)) continue
      if (await portsFree(base, DOCKER_MAX_TASKS)) return base
    }
    throw new Error(`No ${DOCKER_MAX_TASKS} free ports in a row from ${from} for the container's previews: change Settings › Docker › Preview ports`)
  }

  /**
   * After a start: the volume and the secrets tmpfs belong to the image's user (a project's own image may run as
   * another), git signs commits as Box Yard does on boxes, and the tools a turn needs are there.
   */
  private async prepare(bin: string, boxId: string, image: string) {
    const name = this.containerName(boxId)
    const who = await docker(bin, ["exec", name, "sh", "-c", "id -u; id -g"], { timeoutMs: 30_000 })
    const [uid, gid] = who.stdout.toString("utf8").trim().split("\n").map((s) => s.trim())
    if (who.code !== 0 || !/^\d+$/.test(uid ?? "") || !/^\d+$/.test(gid ?? "")) throw new Error(`Container ${name} didn't start cleanly: ${who.stderr.trim().slice(-300)}`)
    const dirs = [ROOT, `${ROOT}/tasks`, `${ROOT}/.boxyard`, DOCKER_SECRETS_DIR]
    const own = await docker(bin, ["exec", "-u", "0", name, "sh", "-c", `mkdir -p ${dirs.join(" ")} && chown ${uid}:${gid} ${dirs.join(" ")} && chmod 700 ${DOCKER_SECRETS_DIR}`], { timeoutMs: 30_000 })
    if (own.code !== 0) throw new Error(`Couldn't prepare container ${name}: ${own.stderr.trim().slice(-300)}`)
    const tools = ["node", "git", this.claudeBin.split(" ")[0]!]
    // Straight to docker, not this.exec: a container that died already mustn't wake itself from inside its own wake.
    const r = await docker(bin, ["exec", "-i", name, "bash", "-c", EVAL], {
      timeoutMs: 60_000,
      input: [
        `missing=""; for t in ${tools.map(q).join(" ")}; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done`,
        `if [ -n "$missing" ]; then echo "missing:$missing"; exit 3; fi`,
      ].join("\n"),
    })
    const check = { exitCode: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr }
    if (check.exitCode === 3) {
      const missing = check.stdout.match(/missing:(.*)/)?.[1]?.trim() ?? ""
      throw new Error(`The image ${image} has no ${missing}: a project's own image needs bash, node, git and claude (or build on Box Yard's with a Dockerfile)`)
    }
    if (check.exitCode !== 0) throw new Error(`Couldn't prepare container ${name}: ${(check.stderr || check.stdout).trim().slice(-300)}`)
  }

  async exec(boxId: string, command: string): Promise<ExecResult> {
    const r = await this.withStart(boxId, (bin) => docker(bin, ["exec", "-i", this.containerName(boxId), "bash", "-c", EVAL], { input: command }))
    return { exitCode: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr }
  }

  async execStream(boxId: string, command: string, onOutput: (chunk: string) => void): Promise<{ exitCode: number }> {
    // Merged, like the other providers' exec streams.
    const out = new StringDecoder("utf8")
    const r = await this.withStart(boxId, (bin) =>
      docker(bin, ["exec", "-i", this.containerName(boxId), "bash", "-c", EVAL], { input: command, onStdout: (d) => onOutput(out.write(d)), onStderr: onOutput }),
    )
    const rest = out.end()
    if (rest) onOutput(rest)
    if (r.code === 127 && !r.stdout.length) throw new Error(r.stderr || "docker exec failed")
    return { exitCode: r.code }
  }

  /**
   * A stopped container (the idle sweep stopped it, or Docker restarted) starts again when a command needs it, e.g.
   * an archive before a task moves. One that doesn't exist isn't made just for a command: that's `wake`'s.
   */
  private async withStart(boxId: string, run: (bin: string) => Promise<{ code: number; stdout: Buffer; stderr: string }>) {
    const bin = await this.d.engine.bin()
    const r = await run(bin)
    if (r.code === 0 || !isRunningError(r.stderr)) return r
    await this.wake(boxId)
    return run(bin)
  }

  hold(boxId: string, command: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      void this.d.engine
        .bin()
        .then((bin) => {
          const child = spawn(bin, ["exec", "-i", this.containerName(boxId), "bash", "-c", EVAL], { env: dockerEnv(bin), stdio: ["pipe", "ignore", "ignore"] })
          child.stdin!.on("error", () => {})
          child.stdin!.end(command)
          // This computer stays awake while an agent works in its container, like the local runner (macOS only).
          const awake = process.platform === "darwin" && child.pid ? spawn("caffeinate", ["-is", "-w", String(child.pid)], { stdio: "ignore" }) : null
          awake?.on("error", () => {})
          const onAbort = () => child.kill("SIGTERM")
          signal.addEventListener("abort", onAbort, { once: true })
          child.on("error", () => resolve())
          child.on("close", () => {
            signal.removeEventListener("abort", onAbort)
            awake?.kill()
            resolve()
          })
        })
        .catch(() => resolve())
    })
  }

  async writeFile(boxId: string, filePath: string, content: string | Buffer): Promise<void> {
    const dir = path.posix.dirname(filePath)
    let command: string
    const name = path.posix.basename(filePath)
    if (HELD_IN_MEMORY[name] && path.posix.dirname(dir) === `${ROOT}/tasks`) {
      // The turn's credentials, signing key and Codex login: kept in memory (the tmpfs), linked from the task folder where the runner reads them.
      const held = `${DOCKER_SECRETS_DIR}/${path.posix.basename(dir)}.${HELD_IN_MEMORY[name]}`
      command = `umask 077 && cat > ${q(held + ".tmp")} && mv ${q(held + ".tmp")} ${q(held)} && mkdir -p ${q(dir)} && ln -sfn ${q(held)} ${q(filePath)}`
    } else {
      const tmp = `${filePath}.boxyard-tmp`
      command = `mkdir -p ${q(dir)} && cat > ${q(tmp)} && mv ${q(tmp)} ${q(filePath)}`
    }
    const r = await this.withStart(boxId, (bin) => docker(bin, ["exec", "-i", this.containerName(boxId), "sh", "-c", command], { input: content }))
    if (r.code !== 0) throw new Error(`Couldn't write ${filePath} in container ${this.containerName(boxId)}: ${r.stderr.trim().slice(-300)}`)
  }

  async readFile(boxId: string, filePath: string): Promise<Buffer> {
    const r = await this.withStart(boxId, (bin) => docker(bin, ["exec", this.containerName(boxId), "cat", "--", filePath], { timeoutMs: 120_000 }))
    if (r.code === 0) return r.stdout
    const err = new Error(`Couldn't read ${filePath} in container ${this.containerName(boxId)}: ${r.stderr.trim().slice(-300)}`) as NodeJS.ErrnoException
    if (/no such file/i.test(r.stderr)) err.code = "ENOENT"
    throw err
  }

  async uploadFile(boxId: string, localPath: string, destination: string): Promise<void> {
    const tmp = `${destination}.boxyard-tmp`
    const command = `mkdir -p ${q(path.posix.dirname(destination))} && cat > ${q(tmp)} && mv ${q(tmp)} ${q(destination)}`
    const r = await this.withStart(boxId, (bin) => docker(bin, ["exec", "-i", this.containerName(boxId), "sh", "-c", command], { input: fs.createReadStream(localPath) }))
    if (r.code !== 0) throw new Error(`Couldn't upload ${path.basename(localPath)} to container ${this.containerName(boxId)}: ${r.stderr.trim().slice(-300)}`)
  }

  /** Each task folder's $PORT is published on this computer's 127.0.0.1, at the container's block of ports. */
  async publicUrl(boxId: string, port: number): Promise<string> {
    const i = DOCKER_CONTAINER_PORTS.indexOf(port)
    if (i < 0) {
      throw new Error(`Only each task's $PORT (${DOCKER_CONTAINER_PORTS[0]}, ${DOCKER_CONTAINER_PORTS[1]}, …) reaches this computer from a Docker container; serve on $PORT, bound to 0.0.0.0`)
    }
    let base = this.ports.get(boxId) ?? null
    if (base === null) {
      const c = await this.inspect(await this.d.engine.bin(), boxId)
      base = c && c !== "error" ? Number(c.Config.Labels?.["boxyard.ports"]) || null : null
      if (base === null) throw new Error(`Container ${this.containerName(boxId)} isn't made yet: send the task a message first`)
      this.ports.set(boxId, base)
    }
    return `http://localhost:${base + i}`
  }

  /** Stop the container (the idle sweep, Stop in Settings › Docker). Its volume keeps every workspace. */
  async stop(boxId: string): Promise<void> {
    const bin = await this.d.engine.bin()
    const name = this.containerName(boxId)
    const c = await this.inspect(bin, boxId)
    if (!c || c === "error" || !c.State.Running) return
    this.mine(c, name)
    const r = await docker(bin, ["stop", "-t", String(STOP_TIMEOUT_S), name], { timeoutMs: (STOP_TIMEOUT_S + 60) * 1000 })
    this.listed = null
    if (r.code !== 0) throw new Error(`docker stop ${name} failed: ${r.stderr.trim().slice(-300)}`)
  }

  /** Remove the container and its volume: every workspace in it, and the credentials' tmpfs, go. Already gone is fine. */
  async destroy(boxId: string): Promise<void> {
    const bin = await this.d.engine.bin()
    const name = this.containerName(boxId)
    const volume = this.volumeName(boxId)
    const c = await this.inspect(bin, boxId)
    if (c === "error") throw new Error(`docker couldn't inspect container ${name}`)
    if (c) {
      this.mine(c, name)
      const r = await docker(bin, ["rm", "-f", name], { timeoutMs: 120_000 })
      if (r.code !== 0 && !/no such container/i.test(r.stderr)) throw new Error(`docker rm ${name} failed: ${r.stderr.trim().slice(-300)}`)
    }
    const v = await docker(bin, ["volume", "inspect", "--format", '{{index .Labels "boxyard.install"}}', volume], { timeoutMs: 30_000 })
    if (v.code === 0) {
      if (v.stdout.toString("utf8").trim() !== this.d.install()) throw new Error(`Volume ${volume} isn't this Box Yard's; it was left alone`)
      const r = await docker(bin, ["volume", "rm", "-f", volume], { timeoutMs: 120_000 })
      if (r.code !== 0) throw new Error(`docker volume rm ${volume} failed: ${r.stderr.trim().slice(-300)}`)
    }
    this.ports.delete(boxId)
    this.listed = null
  }

  /** This install's containers, and volumes whose container is gone ("missing"). Cached a few seconds unless `fresh`. */
  async list(fresh = false): Promise<DockerContainerState[]> {
    if (!fresh && this.listed && Date.now() - this.listed.at < LIST_TTL_MS) return this.listed.containers
    const bin = await this.d.engine.bin()
    const install = this.d.install()
    const ps = await docker(bin, ["ps", "-a", "--filter", `label=boxyard.install=${install}`, "--filter", "label=boxyard.box", "--format", "{{json .}}"], { timeoutMs: 30_000 })
    if (ps.code !== 0) {
      this.d.engine.forget()
      throw new Error(`docker ps failed: ${ps.stderr.trim().slice(-300)}`)
    }
    const rows = jsonLines<{ ID: string; Names: string; Image: string; State: string; Labels: string }>(ps.stdout.toString("utf8"))
    const running = rows.filter((r) => r.State === "running").map((r) => r.ID)
    const started = new Map<string, string>()
    if (running.length) {
      const ins = await docker(bin, ["inspect", "--format", "{{.Id}} {{.State.StartedAt}}", ...running], { timeoutMs: 30_000 })
      for (const line of ins.stdout.toString("utf8").split("\n")) {
        const [id, at] = line.trim().split(" ")
        if (id && at) started.set(id.slice(0, 12), at)
      }
    }
    const containers: DockerContainerState[] = rows.map((r) => {
      const labels = parseLabels(r.Labels)
      const boxId = labels["boxyard.box"]!
      const base = Number(labels["boxyard.ports"]) || null
      if (base) this.ports.set(boxId, base)
      return {
        boxId,
        projectId: dockerBoxProject(boxId),
        name: r.Names,
        state: r.State,
        image: labels["boxyard.image"] ?? r.Image,
        startedAt: r.State === "running" ? (started.get(r.ID.slice(0, 12)) ?? null) : null,
        hostPortBase: base,
      }
    })
    const vols = await docker(bin, ["volume", "ls", "--filter", `label=boxyard.install=${install}`, "--format", "{{.Labels}}"], { timeoutMs: 30_000 })
    for (const line of vols.stdout.toString("utf8").split("\n")) {
      const labels = parseLabels(line.trim())
      const boxId = labels["boxyard.box"]
      if (!boxId || containers.some((c) => c.boxId === boxId)) continue
      containers.push({ boxId, projectId: dockerBoxProject(boxId), name: this.containerName(boxId), state: "missing", image: null, startedAt: null, hostPortBase: Number(labels["boxyard.ports"]) || null })
    }
    this.listed = { at: Date.now(), containers }
    return containers
  }

  /** The containers as last listed (no docker call). */
  cached(): DockerContainerState[] {
    return this.listed?.containers ?? []
  }

  private async inspect(bin: string, boxId: string): Promise<ContainerJson | null | "error"> {
    const r = await docker(bin, ["container", "inspect", this.containerName(boxId)], { timeoutMs: 30_000 })
    if (r.code !== 0) {
      if (/no such (container|object)/i.test(r.stderr)) return null
      this.d.engine.forget()
      return "error"
    }
    try {
      const [c] = JSON.parse(r.stdout.toString("utf8")) as ContainerJson[]
      return c ?? null
    } catch {
      return "error"
    }
  }

  /** A container by our name that isn't labelled as this install's is someone else's: never touch it. */
  private mine(c: ContainerJson, name: string) {
    if (c.Config.Labels?.["boxyard.install"] !== this.d.install()) throw new Error(`Container ${name} isn't this Box Yard's; it was left alone`)
  }
}

/** Nothing on this computer listens on any of `count` ports from `base` (127.0.0.1)? */
async function portsFree(base: number, count: number): Promise<boolean> {
  for (let p = base; p < base + count; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer()
      srv.once("error", () => resolve(false))
      srv.listen(p, "127.0.0.1", () => srv.close(() => resolve(true)))
    })
    if (!free) return false
  }
  return true
}

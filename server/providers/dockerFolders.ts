import fs from "node:fs"
import path from "node:path"
import { DOCKER_CONTAINER_PORTS, dockerBoxProject } from "../../shared/docker.js"
import type { DockerContainerState } from "./docker.js"
import { LocalProvider } from "./local.js"
import type { BoxHealth } from "./types.js"

/**
 * Docker containers as folders on this machine, for mock mode (no Docker needed to try the Docker runner's screens)
 * and tests: `<dir>/<boxId>` is a container's volume, and it's "running" from `wake` until `stop`. No isolation at
 * all, like LocalProvider; real Docker is DockerProvider.
 */
export class FolderDockerProvider extends LocalProvider {
  override readonly name = "docker"
  private readonly up = new Map<string, number>()
  /** Box Yard created or started a container (box history), as DockerProvider reports it. */
  onEvent: ((e: { boxId: string; kind: "created" | "started"; detail: string }) => void) | null = null

  constructor(private readonly dir: string, claudeBin = "claude") {
    super(dir, claudeBin)
  }

  override async create(): Promise<string> {
    throw new Error("A Docker project's container is made when its first task needs it (wake), never from the pool")
  }

  override async health(boxId: string): Promise<BoxHealth> {
    if (!fs.existsSync(this.root(boxId))) return "gone"
    return this.up.has(boxId) ? "running" : "paused"
  }

  override async wake(boxId?: string): Promise<void> {
    if (!boxId || this.up.has(boxId)) return
    const made = !fs.existsSync(this.root(boxId))
    fs.mkdirSync(path.join(this.root(boxId), ".boxyard"), { recursive: true })
    fs.mkdirSync(path.join(this.root(boxId), "tasks"), { recursive: true })
    this.up.set(boxId, Date.now())
    this.onEvent?.({ boxId, kind: made ? "created" : "started", detail: `${made ? "Created" : "Started"} container ${boxId} (a folder: mock mode)` })
  }

  async stop(boxId: string): Promise<void> {
    this.up.delete(boxId)
  }

  override async destroy(boxId: string): Promise<void> {
    this.up.delete(boxId)
    await super.destroy(boxId)
  }

  override async publicUrl(_boxId: string, port: number): Promise<string> {
    if (!DOCKER_CONTAINER_PORTS.includes(port)) throw new Error(`Only each task's $PORT reaches this computer from a Docker container`)
    return `http://localhost:${port}`
  }

  async list(): Promise<DockerContainerState[]> {
    return this.cached()
  }

  cached(): DockerContainerState[] {
    if (!fs.existsSync(this.dir)) return []
    return fs
      .readdirSync(this.dir)
      .filter((id) => id.startsWith("docker-"))
      .map((boxId) => {
        const at = this.up.get(boxId)
        return { boxId, projectId: dockerBoxProject(boxId), name: boxId, state: at ? "running" : "exited", image: "boxyard-agent:mock", startedAt: at ? new Date(at).toISOString() : null, hostPortBase: null }
      })
  }
}

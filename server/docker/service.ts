import os from "node:os"
import type { CredentialStore } from "../credentials.js"
import { BadRequestError, type Store } from "../store.js"
import type { DockerBoxProvider, DockerRunner } from "../tasks.js"
import { DockerProvider } from "../providers/docker.js"
import { FolderDockerProvider } from "../providers/dockerFolders.js"
import { DOCKER_MAX_TASKS, type DockerContainerInfo, type DockerImageBuild, type DockerSettings, type DockerStatus } from "../../shared/docker.js"
import { DockerEngine } from "./engine.js"
import { DockerImages } from "./images.js"
import { DockerSettingsStore } from "./settings.js"

/**
 * Settings › Docker and the runner behind "Runs on: Docker container" (docs/docker.md): Docker detection, the
 * settings, the images and the provider every `docker-<projectId>` box routes to. In mock mode containers are folders
 * (FolderDockerProvider), so the screens work without Docker.
 */
export class DockerService implements DockerRunner {
  readonly engine: DockerEngine
  readonly store: DockerSettingsStore
  readonly images: DockerImages
  readonly provider: DockerBoxProvider
  /** Set by the app once TaskManager exists: containers made or started go to the box history, progress to the tasks' logs. */
  onEvent: ((e: { boxId: string; kind: "created" | "started"; detail: string }) => void) | null = null
  onProgress: ((boxId: string, message: string) => void) | null = null

  constructor(
    private readonly d: {
      store: Store
      credentials: CredentialStore
      /** Every credential value in effect (Settings' and identities'): a build refuses a Dockerfile holding one, and its log never shows one. */
      secrets?: () => string[]
      /** The install id (TaskManager.installLabel without "by-"). */
      install: () => string
      /** DOCKER_BIN, or a fake docker CLI in tests. */
      bin?: string | null
      /** Mock mode: containers are folders here, and agents run this claude. */
      mock?: { dir: string; claudeBin: string } | null
      /** Tests: the claude command inside real containers (else the image's `claude`). */
      claudeBin?: string
    },
  ) {
    this.engine = new DockerEngine({ bin: d.bin || null })
    this.store = new DockerSettingsStore(d.store)
    this.images = new DockerImages({
      engine: this.engine,
      install: d.install,
      settings: () => this.store.get(),
      project: (projectId) => d.store.projectDocker(projectId),
      secrets: d.secrets ?? (() => d.credentials.secrets()),
    })
    if (d.mock) {
      const folders = new FolderDockerProvider(d.mock.dir, d.mock.claudeBin)
      folders.onEvent = (e) => this.onEvent?.(e)
      this.provider = folders
    } else {
      this.provider = new DockerProvider({
        engine: this.engine,
        images: this.images,
        settings: () => this.store.get(),
        install: d.install,
        onEvent: (e) => this.onEvent?.(e),
        onProgress: (boxId, message) => this.onProgress?.(boxId, message),
        claudeBin: d.claudeBin,
      })
    }
  }

  settings(): DockerSettings {
    return this.store.get()
  }

  /** Why Docker projects can't start a container now (Docker missing or stopped), or null. */
  async problem(): Promise<string | null> {
    if (this.d.mock) return null
    return (await this.engine.info()).error
  }

  /** Settings › Docker › Build image: Box Yard's image, now, in the background. */
  async buildImage(): Promise<DockerImageBuild> {
    if (this.d.mock) throw new BadRequestError("Mock mode runs no containers, so there's no image to build")
    try {
      return await this.images.start()
    } catch (err) {
      throw new BadRequestError((err as Error).message)
    }
  }

  /** Everything Settings › Docker shows. Docker's own errors land in `docker.error`, never thrown. */
  async status(projects: { name: (id: string) => string | null; running: (boxId: string) => number; tasks: (boxId: string) => number }): Promise<DockerStatus> {
    const settings = this.store.get()
    const info = this.d.mock
      ? { installed: true, running: true, version: "mock", error: null, cpus: os.cpus().length, memoryBytes: os.totalmem() }
      : await this.engine.info(true)
    const tag = this.images.baseTag()
    const out: DockerStatus = {
      docker: { installed: info.installed, running: info.running, version: info.version, error: info.error, cpus: info.cpus, memoryBytes: info.memoryBytes },
      settings,
      image: { tag, present: Boolean(this.d.mock) },
      build: this.images.status(),
      containers: [],
    }
    if (info.error) return out
    try {
      if (!this.d.mock) out.image.present = await this.images.present(tag)
      const list = await this.provider.list(true)
      out.containers = list
        .map((c): DockerContainerInfo => ({
          boxId: c.boxId,
          projectId: c.projectId,
          projectName: projects.name(c.projectId),
          name: c.name,
          state: c.state,
          image: c.image,
          startedAt: c.startedAt ? Date.parse(c.startedAt) || null : null,
          running: projects.running(c.boxId),
          tasks: projects.tasks(c.boxId),
          hostPorts: c.hostPortBase ? `${c.hostPortBase}-${c.hostPortBase + DOCKER_MAX_TASKS - 1}` : null,
        }))
        .sort((a, b) => (a.projectName ?? a.projectId).localeCompare(b.projectName ?? b.projectId))
    } catch (err) {
      out.docker.error = (err as Error).message
    }
    return out
  }
}

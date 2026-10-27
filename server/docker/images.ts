import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { DockerImageBuild, DockerSettings, ProjectDocker } from "../../shared/docker.js"
import { redact } from "../credentials.js"
import { keyLines, scanForKeys } from "../runpod/image.js"
import { docker } from "./cli.js"
import type { DockerEngine } from "./engine.js"

/** The files of Box Yard's agent image (docker/). Only these are in its build context. */
export const DOCKER_IMAGE_FILES = ["Dockerfile", "gitconfig"] as const
export const BASE_REPO = "boxyard-agent"
const LOG_TAIL = 24_000
const BUILD_TIMEOUT_MS = 60 * 60_000
const PULL_TIMEOUT_MS = 30 * 60_000
const here = path.dirname(fileURLToPath(import.meta.url))

/** Box Yard's docker/ folder: beside server/ in a checkout (tsx), or found from the working directory (a build). */
export function dockerDir(): string {
  const candidates = [path.resolve(here, "../../docker"), path.resolve(here, "../../../../docker"), path.resolve(process.cwd(), "docker")]
  return candidates.find((d) => fs.existsSync(path.join(d, "Dockerfile"))) ?? candidates.at(-1)!
}

const hash = (...parts: (string | Buffer)[]) => {
  const h = createHash("sha256")
  for (const p of parts) h.update(p)
  return h.digest("hex").slice(0, 12)
}

/** `boxyard-agent:bx-<hash of docker/>`: a new tag whenever the image's files change, so it's rebuilt then. */
export function baseImageTag(dir = dockerDir()): string {
  const parts: (string | Buffer)[] = []
  for (const f of DOCKER_IMAGE_FILES) {
    parts.push(f)
    try {
      parts.push(fs.readFileSync(path.join(dir, f)))
    } catch {}
  }
  return `${BASE_REPO}:bx-${hash(...parts)}`
}

/** A project's own Dockerfile's image: `boxyard-project-<id>:bx-<hash of the Dockerfile and the image it builds on>`. */
export function projectImageTag(projectId: string, dockerfile: string, base: string): string {
  return `boxyard-project-${projectId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}:bx-${hash(dockerfile, "\0", base)}`
}

const idle = (): DockerImageBuild => ({ state: "idle", image: null, projectId: null, startedAt: null, finishedAt: null, error: null, log: "" })

/**
 * The images Docker containers start from (docs/docker.md), built and kept on this computer, never pushed:
 * - Box Yard's own, from docker/, tagged by its files' hash (`baseImageTag`), so editing docker/ builds a new one;
 * - or Settings › Docker's image, run as it is (pulled when it isn't here);
 * - a project's own image, run as it is, or its own Dockerfile, built with BOXYARD_BASE set to the image above.
 * A build's context holds only its Dockerfile (Box Yard's: docker/), so no file from this computer gets in, and a
 * Dockerfile with something shaped like a key is refused. One build per image at a time; the latest's log is kept
 * for Settings › Docker.
 */
export class DockerImages {
  private current: DockerImageBuild = idle()
  private readonly listeners = new Set<() => void>()
  private readonly building = new Map<string, Promise<void>>()

  constructor(
    private readonly d: {
      engine: DockerEngine
      install: () => string
      settings: () => DockerSettings
      project: (projectId: string) => ProjectDocker
      /** Every credential value, so none can end up in a build or its log. */
      secrets: () => string[]
      dir?: string
    },
  ) {}

  status(): DockerImageBuild {
    return this.current
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  private set(patch: Partial<DockerImageBuild>) {
    this.current = { ...this.current, ...patch }
    this.emit()
  }

  private log(s: string) {
    this.current.log = redact(this.current.log + s, this.d.secrets()).slice(-LOG_TAIL)
  }

  baseTag(): string {
    return baseImageTag(this.d.dir ?? dockerDir())
  }

  /** The image a project's own Dockerfile builds on: Settings › Docker's image, else Box Yard's. */
  private base(): string {
    return this.d.settings().image ?? this.baseTag()
  }

  /** The image a project's container should run now (nothing is built or pulled). */
  imageFor(projectId: string): string {
    const own = this.d.project(projectId)
    if (own.dockerfile) return projectImageTag(projectId, own.dockerfile, this.base())
    return own.image ?? this.base()
  }

  async present(image: string): Promise<boolean> {
    const bin = await this.d.engine.bin()
    return (await docker(bin, ["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 30_000 })).code === 0
  }

  /**
   * The image a project's container runs, built or pulled first when it isn't on this computer. `progress` hears
   * what's taking the time. Throws with the reason when it can't be had.
   */
  async ensure(projectId: string, progress: (message: string) => void = () => {}): Promise<string> {
    const own = this.d.project(projectId)
    const image = this.imageFor(projectId)
    if (await this.present(image)) return image
    if (own.dockerfile) {
      const base = this.base()
      if (/\bBOXYARD_BASE\b/.test(own.dockerfile) && !(await this.present(base))) await this.getBase(base, progress)
      progress("Building this project's Docker image from its Dockerfile (Settings › Runs on)")
      await this.build(image, { dockerfile: own.dockerfile, projectId, buildArgs: { BOXYARD_BASE: base } })
      return image
    }
    await this.getBase(image, progress)
    return image
  }

  /** Box Yard's own image (built from docker/), or someone else's (pulled). */
  private async getBase(image: string, progress: (message: string) => void) {
    if (image === this.baseTag()) {
      progress("Building Box Yard's Docker image (the first time takes a few minutes; Settings › Docker › Build image does it ahead)")
      await this.build(image, { dir: this.d.dir ?? dockerDir(), projectId: null })
    } else {
      progress(`Pulling the Docker image ${image}`)
      await this.pull(image)
    }
  }

  /** Settings › Docker › Build image: build Box Yard's image now, in the background. Throws when it can't start. */
  async start(): Promise<DockerImageBuild> {
    await this.d.engine.bin()
    const image = this.baseTag()
    if (this.building.has(image)) return this.current
    void this.build(image, { dir: this.d.dir ?? dockerDir(), projectId: null }).catch(() => {})
    return this.current
  }

  private build(image: string, src: { dir?: string; dockerfile?: string; projectId: string | null; buildArgs?: Record<string, string> }): Promise<void> {
    const running = this.building.get(image)
    if (running) return running
    const p = this.runBuild(image, src).finally(() => this.building.delete(image))
    this.building.set(image, p)
    return p
  }

  private async runBuild(image: string, src: { dir?: string; dockerfile?: string; projectId: string | null; buildArgs?: Record<string, string> }) {
    const secrets = this.d.secrets()
    let dir = src.dir
    let scratch: string | null = null
    if (src.dockerfile !== undefined) {
      const hits = keyLines(src.dockerfile, secrets)
      if (hits.length) throw new Error(`Refusing to build: line ${hits.join(", ")} of the project's Dockerfile looks like a key or token. Take it out first`)
      // The context is a folder of its own with only the Dockerfile: COPY can't reach anything on this computer.
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "boxyard-dockerfile-"))
      fs.writeFileSync(path.join(scratch, "Dockerfile"), src.dockerfile)
      dir = scratch
    } else {
      if (!dir || !fs.existsSync(path.join(dir, "Dockerfile"))) throw new Error(`Box Yard's docker/ folder isn't at ${dir}`)
      const hits = scanForKeys(dir, secrets, DOCKER_IMAGE_FILES)
      if (hits.length) throw new Error(`Refusing to build: something shaped like a key is in ${hits.join(", ")}. Take it out first`)
    }
    const args = ["build", "--progress", "plain", "--label", "boxyard=1", "--label", `boxyard.install=${this.d.install()}`, "-t", image]
    for (const [k, v] of Object.entries(src.buildArgs ?? {})) args.push("--build-arg", `${k}=${v}`)
    args.push(dir!)
    this.current = { ...idle(), state: "running", image, projectId: src.projectId, startedAt: Date.now() }
    this.log(`$ docker ${args.join(" ")}\n`)
    this.emit()
    try {
      const bin = await this.d.engine.bin()
      let lastEmit = 0
      const take = (s: string) => {
        this.log(s)
        if (Date.now() - lastEmit > 1000) {
          lastEmit = Date.now()
          this.emit()
        }
      }
      // BuildKit writes its progress to stderr.
      const r = await docker(bin, args, { timeoutMs: BUILD_TIMEOUT_MS, onStdout: (d) => take(d.toString("utf8")), onStderr: take })
      if (r.code !== 0) {
        const tail = redact(r.stderr, secrets).trim().split("\n").slice(-6).join("\n")
        const error = `docker build of ${image} failed (exit ${r.code})${tail ? `: ${tail}` : ""}`
        this.set({ state: "failed", finishedAt: Date.now(), error })
        throw new Error(error)
      }
      this.set({ state: "succeeded", finishedAt: Date.now() })
      void this.prune(image).catch(() => {})
    } catch (err) {
      if (this.current.state === "running") this.set({ state: "failed", finishedAt: Date.now(), error: (err as Error).message })
      throw err
    } finally {
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
    }
  }

  private async pull(image: string) {
    const bin = await this.d.engine.bin()
    const r = await docker(bin, ["pull", image], { timeoutMs: PULL_TIMEOUT_MS })
    if (r.code !== 0) throw new Error(`docker pull ${image} failed: ${r.stderr.trim().split("\n").slice(-3).join(" ")}`)
  }

  /**
   * Remove this install's older builds of the same image (another tag of `boxyard-agent`, or of the project's), so
   * each edit of docker/ doesn't leave 2 GB behind. Only images Box Yard labelled as this install's; one a container
   * still uses stays (docker refuses).
   */
  async prune(keep: string) {
    const bin = await this.d.engine.bin()
    const repo = keep.slice(0, keep.lastIndexOf(":"))
    const r = await docker(bin, ["image", "ls", "--filter", `label=boxyard.install=${this.d.install()}`, "--filter", `reference=${repo}`, "--format", "{{.Repository}}:{{.Tag}}"], { timeoutMs: 30_000 })
    if (r.code !== 0) return
    for (const ref of r.stdout.toString("utf8").split("\n").map((s) => s.trim())) {
      if (!ref || ref === keep || !ref.startsWith(`${repo}:bx-`)) continue
      await docker(bin, ["image", "rm", ref], { timeoutMs: 60_000 })
    }
  }
}

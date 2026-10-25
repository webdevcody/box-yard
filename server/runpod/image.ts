import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { RunPodImageBuild } from "../../shared/runpod.js"
import { redact } from "../credentials.js"

/** The files of Box Yard's pod image (runpod/), in build order. Only these are in the build context (.dockerignore). */
export const IMAGE_FILES = ["Dockerfile", "bootstrap.sh", "init.sh", "watchdog.sh", "start.sh"] as const
const LOG_TAIL = 24_000
const here = path.dirname(fileURLToPath(import.meta.url))

/** Box Yard's runpod/ folder: beside server/ in a checkout (tsx), or found from the working directory (a build). */
export function runpodDir(): string {
  const candidates = [path.resolve(here, "../../runpod"), path.resolve(here, "../../../../runpod"), path.resolve(process.cwd(), "runpod")]
  return candidates.find((d) => fs.existsSync(path.join(d, "Dockerfile"))) ?? candidates.at(-1)!
}

/** `bx-<hash of runpod/>`: a new tag whenever the image's files change, so pods never start from a stale build. */
export function imageTag(dir = runpodDir()): string {
  const h = createHash("sha256")
  for (const f of IMAGE_FILES) {
    h.update(f)
    try {
      h.update(fs.readFileSync(path.join(dir, f)))
    } catch {}
  }
  return `bx-${h.digest("hex").slice(0, 12)}`
}

/** Strings shaped like keys or tokens. The image is public, so a build refuses to start when its files hold one. */
const KEY_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /\bgh[opsu]_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/,
  /\brpa_[A-Za-z0-9]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(api[_-]?key|token|secret|password)\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{20,}/i,
]

/** Files in the image's context that look like they hold a secret, with the line. Empty: clean. */
export function scanForKeys(dir = runpodDir(), secrets: readonly string[] = []): string[] {
  const hits: string[] = []
  for (const f of IMAGE_FILES) {
    let text = ""
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8")
    } catch {
      continue
    }
    text.split("\n").forEach((line, i) => {
      if (KEY_SHAPES.some((re) => re.test(line)) || secrets.some((s) => s.length >= 8 && line.includes(s))) hits.push(`${f}:${i + 1}`)
    })
  }
  return hits
}

const DOCKER_PATHS = ["docker", "/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"]

function run(bin: string, args: string[], onOutput?: (s: string) => void, timeoutMs = 10_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = ""
    let child: ReturnType<typeof spawn>
    try {
      // Docker Desktop's credential helpers live beside its CLI, which may not be on the server's PATH.
      const env = { ...process.env, PATH: `${process.env.PATH ?? ""}:${path.dirname(bin.includes("/") ? bin : "/usr/local/bin/docker")}:/usr/local/bin:/opt/homebrew/bin` }
      child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] })
    } catch (err) {
      resolve({ code: 127, out: (err as Error).message })
      return
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    const take = (d: Buffer) => {
      const s = d.toString("utf8")
      out = (out + s).slice(-LOG_TAIL)
      onOutput?.(s)
    }
    child.stdout?.on("data", take)
    child.stderr?.on("data", take)
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: 127, out: err.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, out })
    })
  })
}

export interface DockerCheck {
  installed: boolean
  running: boolean
  error: string | null
  bin: string | null
}

/** Is Docker installed here, and is its daemon answering? */
export async function checkDocker(): Promise<DockerCheck> {
  for (const bin of DOCKER_PATHS) {
    const v = await run(bin, ["--version"])
    if (v.code === 127) continue
    if (v.code !== 0) continue
    const info = await run(bin, ["info", "--format", "{{.ServerVersion}}"], undefined, 20_000)
    if (info.code !== 0) return { installed: true, running: false, error: "Docker is installed but not running: start Docker Desktop (or the Docker daemon), then try again", bin }
    const bx = await run(bin, ["buildx", "version"])
    if (bx.code !== 0) return { installed: true, running: true, error: "Docker's buildx plugin is missing (it comes with Docker Desktop)", bin }
    return { installed: true, running: true, error: null, bin }
  }
  return { installed: false, running: false, error: "Docker isn't installed on the computer running Box Yard (docs/runpod.md shows another way)", bin: null }
}

/** "docker.io/alice/x" → registry "registry-1.docker.io", name "alice/x". "alice/x" is Docker Hub too. */
export function parseRepo(repo: string): { registry: string; name: string } {
  const parts = repo.split("/")
  const first = parts[0] ?? ""
  const hasRegistry = parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost")
  let registry = hasRegistry ? first : "docker.io"
  let name = hasRegistry ? parts.slice(1).join("/") : repo
  if (registry === "docker.io" || registry === "index.docker.io") {
    registry = "registry-1.docker.io"
    if (!name.includes("/")) name = `library/${name}`
  }
  return { registry, name }
}

/**
 * Can anyone pull `repo:tag` without logging in? RunPod pulls with no credentials unless the owner adds registry
 * auth there, so a private image would fail when a pod starts. Follows the registry's Bearer challenge.
 */
export async function anonymousPullable(repo: string, tag: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  const { registry, name } = parseRepo(repo)
  const url = `https://${registry}/v2/${name}/manifests/${tag}`
  const accept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
  ].join(", ")
  try {
    let res = await fetchImpl(url, { method: "HEAD", headers: { Accept: accept }, signal: AbortSignal.timeout(20_000) })
    if (res.status === 401) {
      const challenge = res.headers.get("www-authenticate") ?? ""
      const field = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(challenge)?.[1]
      const realm = field("realm")
      if (!realm) return { ok: false, detail: `${registry} asked for a login` }
      const tokenUrl = new URL(realm)
      if (field("service")) tokenUrl.searchParams.set("service", field("service")!)
      tokenUrl.searchParams.set("scope", field("scope") ?? `repository:${name}:pull`)
      const t = await fetchImpl(tokenUrl, { signal: AbortSignal.timeout(20_000) })
      const token = t.ok ? ((await t.json()) as { token?: string; access_token?: string }) : null
      const bearer = token?.token ?? token?.access_token
      if (!bearer) return { ok: false, detail: `${registry} gives no anonymous pull token for ${name}` }
      res = await fetchImpl(url, { method: "HEAD", headers: { Accept: accept, Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(20_000) })
    }
    if (res.ok) return { ok: true, detail: "anyone can pull it" }
    return { ok: false, detail: `${registry} answered ${res.status} to an anonymous pull` }
  } catch (err) {
    return { ok: false, detail: `couldn't ask ${registry}: ${(err as Error).message}` }
  }
}

const idle = (): RunPodImageBuild => ({ state: "idle", image: null, startedAt: null, finishedAt: null, error: null, warning: null, log: "" })

/**
 * Settings › RunPod GPU › Build image: builds runpod/ for linux/amd64 with the owner's own Docker and pushes it to
 * the repository they chose (logged in with `docker login` on this computer; Box Yard never sees that login).
 * One build at a time; the state and the log's tail are kept for the settings page.
 */
export class ImageBuilder {
  private current: RunPodImageBuild = idle()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly d: {
      secrets: () => string[]
      /** A build pushed and passed its checks: use it for new pods. */
      onBuilt: (image: string) => void
      dir?: string
      fetch?: typeof fetch
    },
  ) {}

  status(): RunPodImageBuild {
    return this.current
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(patch: Partial<RunPodImageBuild>) {
    this.current = { ...this.current, ...patch }
    for (const fn of this.listeners) fn()
  }

  private log(s: string) {
    this.current.log = redact(this.current.log + s, this.d.secrets()).slice(-LOG_TAIL)
  }

  /** Start a build and push. Throws when one is running or Docker can't; otherwise resolves when it's started. */
  async start(repo: string): Promise<RunPodImageBuild> {
    if (this.current.state === "running") throw new Error("An image build is already running")
    const dir = this.d.dir ?? runpodDir()
    if (!fs.existsSync(path.join(dir, "Dockerfile"))) throw new Error(`Box Yard's runpod/ folder isn't at ${dir}`)
    const hits = scanForKeys(dir, this.d.secrets())
    if (hits.length) throw new Error(`Refusing to build: something shaped like a key is in ${hits.join(", ")}. The image is public, so take it out first.`)
    const docker = await checkDocker()
    if (docker.error || !docker.bin) throw new Error(docker.error ?? "Docker isn't available")
    const image = `${repo}:${imageTag(dir)}`
    this.current = { ...idle(), state: "running", image, startedAt: Date.now() }
    this.log(`$ docker buildx build --platform linux/amd64 -t ${image} --push ${dir}\n`)
    for (const fn of this.listeners) fn()
    void this.build(docker.bin, dir, repo, image)
    return this.current
  }

  private async build(bin: string, dir: string, repo: string, image: string) {
    let lastEmit = 0
    const r = await run(
      bin,
      ["buildx", "build", "--platform", "linux/amd64", "--progress", "plain", "-t", image, "--push", dir],
      (s) => {
        this.log(s)
        if (Date.now() - lastEmit > 1000) {
          lastEmit = Date.now()
          for (const fn of this.listeners) fn()
        }
      },
      90 * 60_000,
    )
    if (r.code !== 0) {
      const denied = /denied|unauthorized|authentication required|insufficient_scope/i.test(this.current.log)
      this.set({
        state: "failed",
        finishedAt: Date.now(),
        error: denied
          ? `The push to ${repo} was refused: run \`docker login\` for that registry on this computer (and check the repository is yours), then build again`
          : `docker buildx exited with ${r.code}; the log below says why`,
      })
      return
    }
    this.log(`\nPushed ${image}. Checking RunPod can pull it without a login…\n`)
    const pull = await anonymousPullable(repo, image.slice(repo.length + 1), this.d.fetch)
    this.log(`${pull.ok ? "✓" : "!"} ${pull.detail}\n`)
    this.d.onBuilt(image)
    this.set({
      state: "succeeded",
      finishedAt: Date.now(),
      warning: pull.ok ? null : `RunPod may not be able to pull ${image} (${pull.detail}). Make the repository public, or add registry auth for it in RunPod.`,
    })
  }
}

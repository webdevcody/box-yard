// Docker containers as a runner ("Runs on: Docker container", shared/runner.ts). A Docker project gets one container
// of its own on the computer running Box Yard, from Box Yard's image (docker/) or the project's own. Its workspaces
// live on a named volume, so stopping the container when it's idle loses nothing (docs/docker.md).

/**
 * A Docker project's virtual box: `docker-<projectId>`, its one container. Like the GPU pods and the local runner's
 * box it is never a `boxes` row, so the pool (Max boxes, Max tasks running at once), cost metering and the box janitor never see it.
 */
export const DOCKER_BOX_PREFIX = "docker-"
export const dockerBoxId = (projectId: string) => `${DOCKER_BOX_PREFIX}${projectId}`
export const isDockerBox = (id: string | null | undefined): id is string => Boolean(id?.startsWith(DOCKER_BOX_PREFIX))
export const dockerBoxProject = (id: string) => id.slice(DOCKER_BOX_PREFIX.length)
/** "Docker · survive-the-night". */
export const dockerLabel = (id: string, projectName: string | null) => `Docker · ${projectName ?? dockerBoxProject(id)}`

/**
 * Why a Docker container's agents have no Claude sign-in: they can't use this computer's own `claude` login (macOS
 * keeps it in the keychain, and no host folder is mounted), only a Claude key their turns get (TaskManager's
 * turnCredentials): the task's or project's env, the project identity's Claude login, or Settings › Credentials.
 */
export const DOCKER_NEEDS_CLAUDE_KEY =
  "a Docker container can't use this computer's own `claude` login: add a Claude key in Settings › Credentials or on the project's identity (`claude setup-token` makes one)"

/**
 * Task folders one container holds. Each one's $PORT (4000, 4010, …) is published on this computer's 127.0.0.1, so a
 * container publishes at most this many ports; a full container parks an archived, resting folder for room.
 */
export const DOCKER_MAX_TASKS = 20
export const DOCKER_CONTAINER_PORTS = Array.from({ length: DOCKER_MAX_TASKS }, (_, i) => 4000 + i * 10)

/** Settings › Docker (kv "docker"). */
export interface DockerSettings {
  /** CPUs one container may use (docker run --cpus). */
  cpus: number
  /** Memory one container may use, in MB (--memory). Docker Desktop's own VM limit (Settings › Resources) caps all of them. */
  memoryMb: number
  /** Tasks running at once in one container, unless the project sets its own Tasks running at once. */
  agentsPerContainer: number
  /** Stop a container after this many minutes with no agent turn running (its volume keeps the workspaces). 0: never. */
  idleMinutes: number
  /** The image containers start from, when a project doesn't pick its own; null: Box Yard's, built from docker/. */
  image: string | null
  /**
   * The first port on this computer that containers' previews take: each container gets DOCKER_MAX_TASKS of them in
   * a row, from here (http://localhost:<port>).
   */
  hostPortBase: number
}

export const DEFAULT_DOCKER_SETTINGS: DockerSettings = {
  cpus: 2,
  memoryMb: 4096,
  agentsPerContainer: 2,
  idleMinutes: 30,
  image: null,
  hostPortBase: 47100,
}

export const DOCKER_LIMITS = {
  cpus: { min: 0.5, max: 64 },
  memoryMb: { min: 1024, max: 262_144 },
  agentsPerContainer: { min: 1, max: 16 },
  idleMinutes: { min: 0, max: 10_080 },
  hostPortBase: { min: 1024, max: 65_000 },
} as const

/**
 * A Docker project's own image (Project.docker). `image` runs as it is (it must have bash, node, git and claude);
 * `dockerfile` is built on this computer, with Box Yard's image as the build arg BOXYARD_BASE. Both null: Settings ›
 * Docker's image. A Dockerfile wins over an image.
 */
export interface ProjectDocker {
  image: string | null
  dockerfile: string | null
}

export const NO_PROJECT_DOCKER: ProjectDocker = { image: null, dockerfile: null }

/** A starting point for a project's own Dockerfile: Box Yard's image plus what the project needs. */
export const DOCKERFILE_TEMPLATE = `ARG BOXYARD_BASE
FROM \${BOXYARD_BASE}
# Box Yard's image: Node 24, git, gh, Claude Code, build tools and Chromium, as the user "agent" (passwordless sudo).
# Add what this project needs. Never put a key or token here: the image is built on this computer and kept there.
USER root
# RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
USER agent
`

export interface DockerImageBuild {
  state: "idle" | "running" | "succeeded" | "failed"
  /** The image being built (or last built), e.g. boxyard-agent:bx-1a2b3c4d5e6f. */
  image: string | null
  /** The project it's for, or null for Box Yard's own image. */
  projectId: string | null
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  /** The build output's tail. */
  log: string
}

export interface DockerContainerInfo {
  boxId: string
  projectId: string
  projectName: string | null
  /** The container's name in Docker. */
  name: string
  /** Docker's state: running, exited, created, paused, restarting, dead; "missing" when only the volume is left. */
  state: string
  image: string | null
  /** ms since epoch, when it's running. */
  startedAt: number | null
  /** Agent turns running in it now, and task folders on its volume. */
  running: number
  tasks: number
  /** The ports it publishes on this computer, e.g. "47100-47119". */
  hostPorts: string | null
}

/** Settings › Docker's status: is Docker here, and what Box Yard has made with it. */
export interface DockerStatus {
  docker: {
    installed: boolean
    running: boolean
    version: string | null
    /** Why containers can't start now (Docker missing or not running), or null. */
    error: string | null
    /** What Docker (Docker Desktop's VM on a Mac) has in all: no container may get more. */
    cpus: number | null
    memoryBytes: number | null
  }
  settings: DockerSettings
  /** Box Yard's own image: its tag (a hash of docker/) and whether it's built on this computer. */
  image: { tag: string; present: boolean }
  build: DockerImageBuild
  containers: DockerContainerInfo[]
}

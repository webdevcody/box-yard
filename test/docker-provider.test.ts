import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { DOCKER_NOT_INSTALLED, DOCKER_NOT_RUNNING, DockerEngine } from "../server/docker/engine.js"
import { DockerImages, baseImageTag, projectImageTag } from "../server/docker/images.js"
import { DOCKER_SECRETS_DIR, DockerProvider } from "../server/providers/docker.js"
import { DEFAULT_DOCKER_SETTINGS, NO_PROJECT_DOCKER, dockerBoxId, type DockerSettings, type ProjectDocker } from "../shared/docker.js"
import { createBoxYard } from "../server/app.js"
import { testConfig, tmpDir } from "./helpers.js"

// The Docker runner against a fake docker CLI (test/fake-docker.mjs), which keeps containers and volumes in a JSON
// file and logs every call: what Box Yard asks Docker for, that nothing of this computer is mounted, that no secret
// is ever on a command line, and that it never touches a container or volume that isn't its own.

const FAKE = path.resolve("test/fake-docker.mjs")
const INSTALL = "inst1"
const SECRET = "sk-ant-oat01-SECRETSECRETSECRET"
const GH_SECRET = "ghp_SECRETSECRETSECRETSECRETSECRETSECRET1"

interface Call {
  args?: string[]
  stdin?: string
  build?: { dir: string; dockerfile: string; files: string[]; buildArgs: string[] }
}

let state: string
let log: string
const calls = (): Call[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : [])
const runs = () => calls().filter((c) => c.args?.[0] === "run").map((c) => c.args!)
const read = () => JSON.parse(fs.readFileSync(state, "utf8"))
const seed = (s: Record<string, unknown>) => fs.writeFileSync(state, JSON.stringify(s))

beforeAll(() => fs.chmodSync(FAKE, 0o755))
beforeEach(() => {
  const dir = tmpDir("fake-docker-")
  state = path.join(dir, "state.json")
  log = path.join(dir, "calls.jsonl")
  seed({})
  process.env.FAKE_DOCKER_STATE = state
  process.env.FAKE_DOCKER_LOG = log
})

const engine = () => new DockerEngine({ bin: FAKE })

function provider(settings: Partial<DockerSettings> = {}) {
  const events: { boxId: string; kind: string; detail: string }[] = []
  const p = new DockerProvider({
    engine: engine(),
    images: { ensure: async () => "boxyard-agent:bx-test" },
    settings: () => ({ ...DEFAULT_DOCKER_SETTINGS, ...settings }),
    install: () => INSTALL,
    git: { name: "Box Yard", email: "boxyard@example.com" },
    onEvent: (e) => events.push(e),
  })
  return { p, events }
}
const BOX = dockerBoxId("prj_abc")
const NAME = `boxyard-${INSTALL}-prj_abc`
const VOLUME = `${NAME}-work`
const flagValues = (args: string[], flag: string) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []))

describe("DockerEngine", () => {
  it("says Docker isn't installed when no CLI answers", async () => {
    const info = await new DockerEngine({ bin: "/nonexistent/docker" }).info()
    expect(info).toMatchObject({ installed: false, running: false, error: DOCKER_NOT_INSTALLED })
    await expect(new DockerEngine({ bin: "/nonexistent/docker" }).bin()).rejects.toThrow(DOCKER_NOT_INSTALLED)
  })

  it("says Docker isn't running when the daemon doesn't answer", async () => {
    seed({ daemon: false })
    expect(await engine().info()).toMatchObject({ installed: true, running: false, error: DOCKER_NOT_RUNNING })
  })

  it("reads the version, CPUs and memory Docker has", async () => {
    expect(await engine().info()).toMatchObject({ bin: FAKE, installed: true, running: true, version: "27.3.1", cpus: 8, memoryBytes: 8 * 1024 ** 3, error: null })
  })
})

describe("DockerProvider", () => {
  it("makes a project's container with only its own volume mounted, no Docker socket, previews on 127.0.0.1, and its labels", async () => {
    const { p, events } = provider({ cpus: 1.5, memoryMb: 3072 })
    await p.wake(BOX)
    const [args] = runs()
    expect(args).toBeDefined()
    const all = args!.join(" ")
    expect(flagValues(args!, "--name")).toEqual([NAME])
    expect(flagValues(args!, "--mount")).toEqual([`type=volume,src=${VOLUME},dst=/workspace`])
    expect(args).not.toContain("-v")
    expect(args).not.toContain("--volume")
    expect(args).not.toContain("--privileged")
    expect(all).not.toMatch(/docker\.sock|bind|--network[= ]host/)
    expect(flagValues(args!, "--tmpfs")).toEqual([`${DOCKER_SECRETS_DIR}:rw,nosuid,nodev,noexec,size=16m,mode=0700`])
    const ports = flagValues(args!, "-p")
    expect(ports).toHaveLength(20)
    for (const port of ports) expect(port).toMatch(/^127\.0\.0\.1:\d+:\d+$/)
    expect(ports[0]).toMatch(/:4000$/)
    expect(flagValues(args!, "--cpus")).toEqual(["1.5"])
    expect(flagValues(args!, "--memory")).toEqual(["3072m"])
    expect(flagValues(args!, "--label")).toEqual(
      expect.arrayContaining(["boxyard=1", `boxyard.install=${INSTALL}`, `boxyard.box=${BOX}`, "boxyard.project=prj_abc", "boxyard.image=boxyard-agent:bx-test", expect.stringMatching(/^boxyard\.ports=\d+$/)]),
    )
    expect(read().volumes[VOLUME].labels).toMatchObject({ boxyard: "1", "boxyard.install": INSTALL, "boxyard.box": BOX })
    expect(events.map((e) => e.kind)).toEqual(["created"])

    // Already running: nothing more. Stopped: started again (with the limits as they are now), not made again.
    await p.wake(BOX)
    expect(runs()).toHaveLength(1)
    await p.stop(BOX)
    expect(read().containers[NAME].running).toBe(false)
    await p.wake(BOX)
    expect(runs()).toHaveLength(1)
    expect(calls().some((c) => c.args?.[0] === "update" && c.args.at(-1) === NAME)).toBe(true)
    expect(events.map((e) => e.kind)).toEqual(["created", "started"])
  })

  it("sends commands and files on stdin, keeps task.json and signing.key on the tmpfs, and never puts a secret on a command line", async () => {
    const { p } = provider()
    await p.wake(BOX)
    await p.exec(BOX, `export GITHUB_TOKEN=${GH_SECRET} && git push`)
    const exec = calls().at(-1)!
    expect(exec.args).toEqual(["exec", "-i", NAME, "bash", "-c", 'eval "$(cat)"'])
    expect(exec.stdin).toContain(GH_SECRET)

    await p.writeFile(BOX, "/workspace/tasks/task_1/task.json", JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET } }))
    const write = calls().at(-1)!
    expect(write.args!.at(-1)).toContain(`cat > '${DOCKER_SECRETS_DIR}/task_1.json.tmp'`)
    expect(write.args!.at(-1)).toContain(`ln -sfn '${DOCKER_SECRETS_DIR}/task_1.json' '/workspace/tasks/task_1/task.json'`)
    expect(write.stdin).toContain(SECRET)
    expect(p.secretsDir).toBe(DOCKER_SECRETS_DIR)

    const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n"
    await p.writeFile(BOX, "/workspace/tasks/task_1/signing.key", KEY)
    const key = calls().at(-1)!
    expect(key.args!.at(-1)).toMatch(/^umask 077 && /)
    expect(key.args!.at(-1)).toContain(`cat > '${DOCKER_SECRETS_DIR}/task_1.signing.key.tmp'`)
    expect(key.args!.at(-1)).toContain(`ln -sfn '${DOCKER_SECRETS_DIR}/task_1.signing.key' '/workspace/tasks/task_1/signing.key'`)
    expect(key.stdin).toBe(KEY)
    // Only a task folder's: a file of that name elsewhere is an ordinary file.
    await p.writeFile(BOX, "/workspace/tasks/task_1/work/signing.key", "not a key")
    expect(calls().at(-1)!.args!.at(-1)).toContain("/workspace/tasks/task_1/work/signing.key.boxyard-tmp")

    await p.writeFile(BOX, "/workspace/tasks/task_1/prompt.md", "hello")
    expect(calls().at(-1)!.args!.at(-1)).toContain("/workspace/tasks/task_1/prompt.md.boxyard-tmp")

    for (const c of calls()) expect(JSON.stringify(c.args ?? [])).not.toMatch(new RegExp(`${SECRET}|${GH_SECRET}|PRIVATE KEY`))
  })

  it("starts a stopped container again when a command needs it", async () => {
    const { p, events } = provider()
    await p.wake(BOX)
    await p.stop(BOX)
    const r = await p.exec(BOX, "true")
    expect(r.exitCode).toBe(0)
    expect(read().containers[NAME].running).toBe(true)
    expect(events.map((e) => e.kind)).toEqual(["created", "started"])
  })

  it("reads files, and says ENOENT for a missing one", async () => {
    const { p } = provider()
    await p.wake(BOX)
    seed({ ...read(), files: { "/workspace/a.txt": "hi" } })
    expect((await p.readFile(BOX, "/workspace/a.txt")).toString()).toBe("hi")
    await expect(p.readFile(BOX, "/workspace/nope")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("gives each task's $PORT a localhost URL in the container's block, and refuses other ports", async () => {
    const { p } = provider()
    await p.wake(BOX)
    const base = Number(read().containers[NAME].labels["boxyard.ports"])
    expect(await p.publicUrl(BOX, 4000)).toBe(`http://localhost:${base}`)
    expect(await p.publicUrl(BOX, 4010)).toBe(`http://localhost:${base + 1}`)
    await expect(p.publicUrl(BOX, 3000)).rejects.toThrow(/Only each task's \$PORT/)
    // A new provider (a restart) reads the block from the container's label.
    expect(await provider().p.publicUrl(BOX, 4190)).toBe(`http://localhost:${base + 19}`)
  })

  it("takes the next port block when another Box Yard container has the first", async () => {
    seed({ containers: { "boxyard-other-prj_x": { id: "f".repeat(64), image: "x", labels: { "boxyard.install": "other", "boxyard.ports": "47100" }, running: true } } })
    const { p } = provider({ hostPortBase: 47100 })
    await p.wake(BOX)
    expect(Number(read().containers[NAME].labels["boxyard.ports"])).toBeGreaterThanOrEqual(47120)
  })

  it("keeps a container's ports when it's made again from its volume", async () => {
    const { p } = provider()
    await p.wake(BOX)
    const base = read().containers[NAME].labels["boxyard.ports"]
    const s = read()
    delete s.containers[NAME]
    seed(s)
    await p.wake(BOX)
    expect(read().containers[NAME].labels["boxyard.ports"]).toBe(base)
  })

  it("makes a stopped container again when its image changed; the volume stays", async () => {
    const { p, events } = provider()
    await p.wake(BOX)
    await p.stop(BOX)
    const s = read()
    s.containers[NAME].labels["boxyard.image"] = "boxyard-agent:bx-old"
    seed(s)
    await p.wake(BOX)
    expect(runs()).toHaveLength(2)
    expect(calls().some((c) => c.args?.[0] === "rm" && c.args.at(-1) === NAME)).toBe(true)
    expect(read().volumes[VOLUME]).toBeDefined()
    expect(events.at(-1)!.detail).toMatch(/^Re-created container/)
  })

  it("deletes the container and its volume", async () => {
    const { p } = provider()
    await p.wake(BOX)
    await p.destroy(BOX)
    expect(read().containers).toEqual({})
    expect(read().volumes).toEqual({})
    expect(await p.health(BOX)).toBe("gone")
    await p.destroy(BOX)
  })

  it("never touches a container or volume with its name that isn't labelled as this install's", async () => {
    seed({ containers: { [NAME]: { id: "a".repeat(64), image: "someone/else", labels: { other: "1" }, running: true } }, volumes: { [VOLUME]: { labels: {} } } })
    const { p } = provider()
    await expect(p.stop(BOX)).rejects.toThrow(/isn't this Box Yard's/)
    await expect(p.destroy(BOX)).rejects.toThrow(/isn't this Box Yard's/)
    const s = read()
    s.containers[NAME].running = false
    seed(s)
    await expect(p.wake(BOX)).rejects.toThrow(/isn't this Box Yard's/)
    delete s.containers[NAME]
    seed(s)
    await expect(p.wake(BOX)).rejects.toThrow(/Volume .* isn't this Box Yard's/)
    expect(read().containers).toEqual({})
    expect(read().volumes).toEqual({ [VOLUME]: { labels: {} } })
    expect(calls().filter((c) => ["rm", "stop", "run"].includes(c.args?.[0] ?? "") || (c.args?.[0] === "volume" && c.args[1] === "rm"))).toEqual([])
  })

  it("lists only this install's containers, and a volume whose container is gone as missing", async () => {
    seed({ containers: { "boxyard-other-prj_x": { id: "f".repeat(64), image: "x", labels: { "boxyard.install": "other", "boxyard.box": "docker-prj_x" }, running: true } } })
    const { p } = provider()
    await p.wake(BOX)
    await p.wake(dockerBoxId("prj_two"))
    const s = read()
    delete s.containers[`boxyard-${INSTALL}-prj_two`]
    seed(s)
    const list = await p.list(true)
    expect(list.map((c) => [c.boxId, c.state]).sort()).toEqual([
      [BOX, "running"],
      [dockerBoxId("prj_two"), "missing"],
    ])
    expect(list.find((c) => c.boxId === BOX)!.startedAt).toBeTruthy()
  })

  it("health: running, paused when stopped or only the volume is left, gone, and unknown while Docker is down", async () => {
    const { p } = provider()
    expect(await p.health(BOX)).toBe("gone")
    await p.wake(BOX)
    expect(await p.health(BOX)).toBe("running")
    await p.stop(BOX)
    expect(await p.health(BOX)).toBe("paused")
    seed({ ...read(), daemon: false })
    expect(await provider().p.health(BOX)).toBe("unknown")
  })

  it("refuses to start without Docker, with Docker's reason", async () => {
    seed({ daemon: false })
    await expect(provider().p.wake(BOX)).rejects.toThrow(DOCKER_NOT_RUNNING)
  })
})

describe("DockerImages", () => {
  const dockerDir = () => {
    const dir = tmpDir("docker-dir-")
    fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM node:24-bookworm\n")
    fs.writeFileSync(path.join(dir, "gitconfig"), "[init]\n\tdefaultBranch = main\n")
    return dir
  }
  function images(dir: string, project: ProjectDocker = NO_PROJECT_DOCKER, settings: Partial<DockerSettings> = {}) {
    return new DockerImages({ engine: engine(), install: () => INSTALL, settings: () => ({ ...DEFAULT_DOCKER_SETTINGS, ...settings }), project: () => project, secrets: () => [SECRET], dir })
  }
  const builds = () => calls().flatMap((c) => (c.build ? [c.build] : []))

  it("tags Box Yard's image by its files, so a change to docker/ builds a new one", () => {
    const dir = dockerDir()
    const before = baseImageTag(dir)
    expect(before).toMatch(/^boxyard-agent:bx-[0-9a-f]{12}$/)
    expect(baseImageTag(dir)).toBe(before)
    fs.appendFileSync(path.join(dir, "Dockerfile"), "RUN true\n")
    expect(baseImageTag(dir)).not.toBe(before)
  })

  it("builds Box Yard's image from docker/ when it's missing, labelled as this install's, and reuses it after", async () => {
    const dir = dockerDir()
    const im = images(dir)
    const tag = baseImageTag(dir)
    expect(await im.ensure("prj_abc")).toBe(tag)
    expect(builds()).toMatchObject([{ dir, buildArgs: [] }])
    const build = calls().find((c) => c.args?.[0] === "build")!.args!
    expect(flagValues(build, "--label")).toEqual(["boxyard=1", `boxyard.install=${INSTALL}`])
    expect(im.status()).toMatchObject({ state: "succeeded", image: tag })
    expect(await im.ensure("prj_abc")).toBe(tag)
    expect(builds()).toHaveLength(1)
  })

  it("builds a project's Dockerfile on Box Yard's image, in a context holding only the Dockerfile", async () => {
    const dir = dockerDir()
    const dockerfile = "ARG BOXYARD_BASE\nFROM ${BOXYARD_BASE}\nRUN echo hi\n"
    const im = images(dir, { image: null, dockerfile })
    const tag = projectImageTag("prj_abc", dockerfile, baseImageTag(dir))
    expect(await im.ensure("prj_abc")).toBe(tag)
    const [base, own] = builds()
    expect(base!.dir).toBe(dir)
    expect(own).toMatchObject({ dockerfile, files: ["Dockerfile"], buildArgs: [`BOXYARD_BASE=${baseImageTag(dir)}`] })
    expect(fs.existsSync(own!.dir)).toBe(false)
  })

  it("runs a named image as it is, pulled when it isn't here", async () => {
    const im = images(dockerDir(), { image: "ghcr.io/me/agent:1", dockerfile: null })
    expect(await im.ensure("prj_abc")).toBe("ghcr.io/me/agent:1")
    expect(calls().some((c) => c.args?.[0] === "pull" && c.args[1] === "ghcr.io/me/agent:1")).toBe(true)
    expect(builds()).toEqual([])
  })

  it("refuses to build a Dockerfile with a key or one of Box Yard's credentials in it", async () => {
    const dir = dockerDir()
    await expect(images(dir, { image: null, dockerfile: `FROM node\nENV GITHUB_TOKEN=${GH_SECRET}\n` }).ensure("prj_abc")).rejects.toThrow(/Refusing to build: line 2/)
    await expect(images(dir, { image: null, dockerfile: `FROM node\nRUN echo ${SECRET}\n` }).ensure("prj_abc")).rejects.toThrow(/Refusing to build/)
    fs.appendFileSync(path.join(dir, "Dockerfile"), `ENV ANTHROPIC_API_KEY=${SECRET}\n`)
    await expect(images(dir).ensure("prj_abc")).rejects.toThrow(/Refusing to build: something shaped like a key is in Dockerfile/)
    expect(builds()).toEqual([])
  })

  it("refuses a project's Dockerfile holding an identity's secret too, in the app", async () => {
    const yard = createBoxYard(testConfig({ dockerBin: FAKE }), { webDir: "/nonexistent", realDocker: { claudeBin: "claude" } })
    try {
      const acme = yard.identities.create({ name: "Acme" })
      yard.identities.saveClaude(acme.id, { kind: "api_key", value: "acme-claude-0001-not-key-shaped" })
      const p = yard.store.createProject({ name: "own-image", docker: { image: null, dockerfile: "FROM node\nRUN echo acme-claude-0001-not-key-shaped\n" } })
      await expect(yard.docker.images.ensure(p.id)).rejects.toThrow(/Refusing to build: line 2/)
      expect(builds()).toEqual([])
    } finally {
      yard.stop()
    }
  })

  it("Box Yard's own docker/ builds: only public tools, and the git config that clears other credential helpers", () => {
    const repoDocker = path.resolve("docker")
    expect(fs.readdirSync(repoDocker).sort()).toEqual(["Dockerfile", "gitconfig"])
    const gitconfig = fs.readFileSync(path.join(repoDocker, "gitconfig"), "utf8")
    expect(gitconfig).toMatch(/\[credential "https:\/\/github\.com"\]\n\thelper =\n\thelper = /)
    const dockerfile = fs.readFileSync(path.join(repoDocker, "Dockerfile"), "utf8")
    expect(dockerfile).not.toMatch(/^\s*(ARG|ENV)\s+\S*(TOKEN|KEY|SECRET)/im)
  })
})

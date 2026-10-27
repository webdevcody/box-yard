// Settings › Docker: Docker on this computer, the image containers start from (Box Yard's own, built here from
// docker/, or one named here), each container's CPU and memory, agents per container, idle stop and the preview ports,
// and the containers Box Yard has made. docs/docker.md explains the runner. The settings are a draft until the
// dialog's Save; Build image, Stop and Delete are actions and run at once.
import { useState } from "react"
import { CheckCircle2, Hammer, Square, Trash2 } from "lucide-react"
import { api } from "../lib/api"
import { useDocker, useDockerAction } from "../lib/queries"
import { useDraft } from "../lib/settingsDraft"
import { formatBytes } from "../../../shared/disk"
import { DOCKER_LIMITS, type DockerContainerInfo, type DockerImageBuild, type DockerSettings, type DockerStatus } from "../../../shared/docker"
import { BoxActionDialog } from "./BoxActionDialog"
import { Panel, Row } from "./SettingsDialog"
import { Button, TimeAgo, cx, inputClass } from "./ui"

type Numeric = "cpus" | "memoryMb" | "agentsPerContainer" | "idleMinutes" | "hostPortBase"
const NUMBERS: { key: Numeric; label: string; help: string; step?: number; unit: string }[] = [
  { key: "cpus", label: "CPUs per container", unit: "CPUs", step: 0.5, help: "The most CPU one project's container may use (docker --cpus). Its agents share it." },
  {
    key: "memoryMb",
    label: "Memory per container",
    unit: "MB",
    step: 256,
    help: "The most memory one project's container may use (docker --memory); over it, Docker stops the process using the most. On a Mac every container shares Docker Desktop's own memory (Docker Desktop › Settings › Resources), so keep this and the number of Docker projects within it.",
  },
  {
    key: "agentsPerContainer",
    label: "Agents per container",
    unit: "agents",
    help: "Agents of one project that may run in its container at once, unless the project sets its own Agents at once.",
  },
  {
    key: "idleMinutes",
    label: "Stop when idle",
    unit: "min",
    help: "A container with no agent running or waiting is stopped after this long. Its volume keeps every workspace, and the next task starts it again in a few seconds. 0: never stop.",
  },
  {
    key: "hostPortBase",
    label: "Preview ports from",
    unit: "port",
    help: "Each container publishes its tasks' $PORT on this computer's 127.0.0.1 only, 20 ports per container starting here (http://localhost:<port>). Containers keep their ports until deleted.",
  },
]

/** The settings as the form edits them: numbers as typed, "" for Box Yard's own image. */
type DockerForm = { image: string } & Record<Numeric, string>

const formOf = (s: DockerSettings): DockerForm => ({ image: s.image ?? "", ...(Object.fromEntries(NUMBERS.map((n) => [n.key, String(s[n.key])])) as Record<Numeric, string>) })

/** What Save sends: the fields that changed. A number that isn't one stops the save with a message. */
export function dockerPatch(form: DockerForm, saved: DockerSettings): Partial<DockerSettings> {
  const patch: Partial<DockerSettings> = {}
  const image = form.image.trim() || null
  if (image !== saved.image) patch.image = image
  for (const n of NUMBERS) {
    const v = Number(form[n.key])
    if (form[n.key].trim() === "" || !Number.isFinite(v)) throw new Error(`Docker › ${n.label} needs a number.`)
    if (v !== saved[n.key]) patch[n.key] = v
  }
  return patch
}

export function DockerPanel({ fid, active = true }: { fid: (k: string) => string; active?: boolean }) {
  const status = useDocker({ poll: active })
  const s = status.data
  const save = useDockerAction<Partial<DockerSettings>>("Couldn't save the Docker settings", (patch) => api<DockerStatus>("/api/docker/settings", { method: "PUT", body: patch }))
  const [form, setForm] = useDraft("docker", "docker", s ? formOf(s.settings) : null, async (f) => {
    if (f && s) await save.mutateAsync(dockerPatch(f, s.settings))
  })
  const set = (patch: Partial<DockerForm>) => setForm((f) => f && { ...f, ...patch })
  return (
    <Panel section="docker">
      {!s || !form ? (
        <p className="text-sm text-zinc-500">{status.error ? `Couldn't load: ${status.error.message}` : "Loading…"}</p>
      ) : (
        <>
          <EngineRow status={s} memoryMb={Number(form.memoryMb)} />
          <ImageRow fid={fid} status={s} form={form} set={set} />
          {NUMBERS.map((n) => (
            <Row key={n.key} id={fid(`docker-${n.key}`)} label={n.label} help={n.help}>
              <div className="flex items-center gap-2">
                <input
                  id={fid(`docker-${n.key}`)}
                  type="number"
                  min={DOCKER_LIMITS[n.key].min}
                  max={DOCKER_LIMITS[n.key].max}
                  step={n.step ?? 1}
                  className={cx(inputClass, "w-28")}
                  value={form[n.key]}
                  onChange={(e) => set({ [n.key]: e.target.value })}
                  data-testid={`docker-${n.key}`}
                />
                <span className="text-xs text-zinc-500">{n.unit}</span>
              </div>
            </Row>
          ))}
          <ContainersRow status={s} />
        </>
      )}
    </Panel>
  )
}

/** Is Docker here and running, and how much it has for every container together. */
function EngineRow({ status, memoryMb }: { status: DockerStatus; memoryMb: number }) {
  const d = status.docker
  const tight = d.memoryBytes !== null && Number.isFinite(memoryMb) && memoryMb * 1024 * 1024 > d.memoryBytes * 0.9
  return (
    <Row
      label="Docker"
      help="Projects whose Runs on is Docker container get one container each on this computer, with only their workspace volume mounted (no folder of this computer, no Docker socket). Agents get the GitHub and Claude credentials from Settings › Credentials inside the container only; they're never in the image. When Docker isn't running, those projects' tasks wait and say why: they never run somewhere else."
    >
      {d.error ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200" data-testid="docker-problem">
          {d.error}.
        </p>
      ) : (
        <p className="flex items-start gap-1.5 text-xs text-zinc-300" data-testid="docker-engine">
          <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-400" />
          <span>
            Docker {d.version} is running
            {d.cpus !== null && d.memoryBytes !== null && (
              <span className="text-zinc-500">
                {" "}
                · {d.cpus} CPUs and {formatBytes(d.memoryBytes)} for all containers
              </span>
            )}
          </span>
        </p>
      )}
      {tight && <p className="text-xs text-amber-300">Each container may use nearly all of Docker's memory: lower Memory per container, or give Docker Desktop more.</p>}
    </Row>
  )
}

/** The image containers start from: Box Yard's own (built here from docker/) or one named here. */
function ImageRow({ fid, status, form, set }: { fid: (k: string) => string; status: DockerStatus; form: DockerForm; set: (patch: Partial<DockerForm>) => void }) {
  const { image, build, docker } = status
  const start = useDockerAction<void>("Couldn't start the image build", () => api<DockerImageBuild>("/api/docker/image/build", { method: "POST" }))
  const running = build.state === "running"
  const own = !form.image.trim()
  return (
    <Row
      id={fid("docker-image")}
      label="Image"
      help={
        <>
          Containers start from Box Yard's own image, built on this computer from this repo's <code className="font-mono">docker/Dockerfile</code> (Debian with Node, git, gh, Claude Code, build
          tools and Chromium). It's built again when that file changes, and never pushed anywhere. Or name an image of yours (it needs bash, node, git and claude). A project can pick its own image or
          Dockerfile in its Settings › Runs on.
        </>
      }
    >
      <input
        id={fid("docker-image")}
        className={cx(inputClass, "font-mono text-xs")}
        placeholder="Blank: Box Yard's own image"
        value={form.image}
        spellCheck={false}
        onChange={(e) => set({ image: e.target.value })}
        data-testid="docker-image"
      />
      <p className="text-xs text-zinc-400">
        {own ? (
          <>
            Box Yard's: <span className="font-mono break-all text-zinc-300">{image.tag}</span>{" "}
            {image.present ? <span className="text-emerald-300">built</span> : <span className="text-zinc-500">not built yet (the first task builds it)</span>}
          </>
        ) : (
          "Pulled when a container first needs it."
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={image.present ? "ghost" : "primary"} disabled={!docker.running || running} loading={running || start.isPending} onClick={() => start.mutate()}>
          <Hammer className="h-3.5 w-3.5" /> {running ? "Building…" : image.present ? "Build again" : "Build image now"}
        </Button>
      </div>
      {build.state !== "idle" && (
        <div className="space-y-1">
          <p className={cx("text-xs", build.state === "failed" ? "text-red-300" : build.state === "succeeded" ? "text-emerald-300" : "text-zinc-400")}>
            {build.state === "running" ? `Building ${build.image} (the first build takes a few minutes)…` : build.state === "succeeded" ? `Built ${build.image}.` : build.error}
          </p>
          <pre className="scroll-thin max-h-48 overflow-auto rounded-lg bg-zinc-950 p-2 text-[10px] leading-snug text-zinc-400">{build.log.split("\n").slice(-60).join("\n")}</pre>
        </div>
      )}
    </Row>
  )
}

/** Box Yard's containers in Docker now, with Stop and Delete. */
function ContainersRow({ status }: { status: DockerStatus }) {
  const [deleting, setDeleting] = useState<DockerContainerInfo | null>(null)
  const stop = useDockerAction<string>("Couldn't stop the container", (boxId) => api<DockerStatus>(`/api/docker/containers/${encodeURIComponent(boxId)}/stop`, { method: "POST" }))
  return (
    <Row
      label="Containers"
      help={`One per Docker project, made by its first task. Stop keeps its volume, so the next task starts it again where it left off; containers also stop after ${status.settings.idleMinutes || "no"} idle minutes. Delete archives every workspace first, then removes the container and its volume.`}
    >
      {!status.containers.length ? (
        <p className="text-xs text-zinc-500">{status.docker.error ? "Docker isn't running, so none can be listed." : "None yet."}</p>
      ) : (
        <ul className="space-y-2">
          {status.containers.map((c) => (
            <li key={c.boxId} className="space-y-1 rounded-lg bg-zinc-900 px-2.5 py-2 text-xs" data-container={c.boxId}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium text-zinc-200">{c.projectName ?? c.projectId}</span>
                <span className={c.state === "running" ? "text-emerald-300" : "text-zinc-400"}>{c.state}</span>
              </div>
              <p className="wrap-anywhere text-zinc-500">
                <span className="font-mono">{c.name}</span> · {c.running} running · {c.tasks} {c.tasks === 1 ? "task" : "tasks"}
                {c.hostPorts && <> · ports {c.hostPorts}</>}
                {c.startedAt ? (
                  <>
                    {" "}
                    · up <TimeAgo ts={c.startedAt} />
                  </>
                ) : null}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {c.state === "running" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={c.running > 0 || stop.isPending}
                    title={c.running > 0 ? "An agent is running in it" : undefined}
                    onClick={() => stop.mutate(c.boxId)}
                  >
                    <Square className="h-3 w-3" /> Stop
                  </Button>
                )}
                <Button size="sm" variant="danger" onClick={() => setDeleting(c)}>
                  <Trash2 className="h-3 w-3" /> Delete…
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {deleting && <BoxActionDialog container={deleting} action="delete" onClose={() => setDeleting(null)} />}
    </Row>
  )
}

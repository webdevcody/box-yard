// Project snapshots (shared/snapshots.ts): the Settings tab's panel (the snapshot new boxes start from, Replace and
// Clear) and the dialog that takes one, opened from there or from a box on the Boxes page.
import { useState, type FormEvent } from "react"
import { AlertTriangle, Camera, Loader2 } from "lucide-react"
import { useBoxes, useClearSnapshot, useProjectSnapshot, useProjects, useTakeSnapshot } from "../lib/queries"
import { snapshotBlocker, snapshotMeta, snapshotSources } from "../lib/projectSnapshot"
import { confirmDialog } from "../lib/confirm"
import { snapshotJobLine, snapshotSkipReason } from "../../../shared/snapshots"
import type { BoxInfo, Project } from "../../../shared/types"
import { Modal } from "./Modal"
import { Button, Field, LineIcon, Select, TimeAgo, inputClass } from "./ui"

/** Settings › Box snapshot: the project's snapshot, the job taking one, and Take/Replace and Clear. */
export function ProjectSnapshotPanel({ project }: { project: Project }) {
  const state = useProjectSnapshot(project.id)
  const clear = useClearSnapshot()
  const [open, setOpen] = useState(false)
  const snap = project.snapshot
  const job = state.data?.job ?? null
  const running = job?.status === "running"
  // A failed job is shown until a newer snapshot is saved.
  const failed = job?.status === "failed" && (!snap || snap.takenAt < job.startedAt) ? job : null
  const mismatch = snap && project.boxSize ? snapshotSkipReason(snap, project.boxSize, snap.provider) : null

  if (project.runner === "local") {
    return (
      <section className="space-y-1 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4" data-testid="project-snapshot">
        <h3 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Box snapshot</h3>
        <p className="text-sm text-zinc-400">This project runs on this computer, so it doesn't use box snapshots.</p>
      </section>
    )
  }

  const onClear = async () => {
    if (!snap) return
    const ok = await confirmDialog({
      title: `Clear ${project.name}'s snapshot?`,
      body: `Deletes snapshot ${snap.id} at the provider. New boxes for ${project.name} start cold again (clone, install, toolchains). Boxes already running aren't changed.`,
      confirmLabel: "Clear snapshot",
      danger: true,
    })
    if (ok) clear.mutate(project.id)
  }

  return (
    <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4" data-testid="project-snapshot">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Box snapshot</h3>
          {snap ? (
            <div className="space-y-0.5 text-sm">
              <div className="flex min-w-0 items-start gap-2 text-zinc-100">
                <LineIcon icon={Camera} className="h-4 w-4 text-yard-400" />
                <span className="truncate font-mono" data-testid="project-snapshot-id">
                  {snap.id}
                </span>
              </div>
              <p className="text-xs text-zinc-500">
                From <span className="font-mono">{snap.boxId}</span> · {snapshotMeta(snap)} · taken <TimeAgo ts={snap.takenAt} />
              </p>
              <p className="text-xs text-zinc-500">New {snap.size} or bigger boxes for this project start from it, then fetch the repo.</p>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">None. New boxes for this project start cold: they clone the repo and install everything.</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2" role="group" aria-label="Snapshot actions">
          <Button type="button" size="sm" onClick={() => setOpen(true)} disabled={running} data-testid="project-snapshot-take">
            {snap ? "Replace…" : "Take snapshot…"}
          </Button>
          {snap && (
            <Button type="button" size="sm" variant="danger" onClick={() => void onClear()} disabled={running} loading={clear.isPending} data-testid="project-snapshot-clear">
              Clear
            </Button>
          )}
        </div>
      </div>
      {running && job && (
        <p className="flex items-start gap-2 text-xs text-sky-300" data-testid="project-snapshot-job">
          <LineIcon icon={Loader2} className="h-3.5 w-3.5 animate-spin" />
          <span>
            Taking a snapshot of <span className="font-mono">{job.boxId}</span>. {snapshotJobLine(job)}
          </span>
        </p>
      )}
      {failed && (
        <p className="flex items-start gap-2 text-xs text-red-300" role="alert" data-testid="project-snapshot-failed">
          <LineIcon icon={AlertTriangle} className="h-3.5 w-3.5" />
          <span>
            The last snapshot from <span className="font-mono">{failed.boxId}</span> failed: {failed.error ?? "unknown error"}. The box wasn't changed.
          </span>
        </p>
      )}
      {mismatch && (
        <p className="flex items-start gap-2 text-xs text-amber-300">
          <LineIcon icon={AlertTriangle} className="h-3.5 w-3.5" />
          <span>New boxes are {project.boxSize}, so they start cold: the {mismatch}.</span>
        </p>
      )}
      {open && <SnapshotDialog projectId={project.id} onClose={() => setOpen(false)} />}
    </section>
  )
}

/**
 * Take (or replace) a project's snapshot. From Settings the project is fixed and a box is picked; from the Boxes
 * page the box is fixed and one of its projects is picked.
 */
export function SnapshotDialog({ projectId, box, onClose }: { projectId?: string; box?: BoxInfo; onClose: () => void }) {
  const boxes = useBoxes()
  const projects = useProjects()
  const take = useTakeSnapshot()
  const all = projects.data ?? []
  const projectChoices = box ? all.filter((p) => p.runner !== "local" && (box.projectIds ?? []).includes(p.id)) : []
  const [pickedProject, setPickedProject] = useState(projectId ?? "")
  const pid = projectId ?? (pickedProject || projectChoices[0]?.id || "")
  const project = all.find((p) => p.id === pid)
  const boxChoices = box ? [] : snapshotSources(boxes.data, pid)
  const [pickedBox, setPickedBox] = useState("")
  const source = box ?? boxChoices.find((b) => b.id === pickedBox) ?? boxChoices[0]
  const [reason, setReason] = useState("")
  const blocker = source ? snapshotBlocker(source) : null
  const replaces = project?.snapshot ?? null
  const canGo = Boolean(project && source) && !blocker && !take.isPending

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!canGo || !project || !source) return
    take.mutate({ projectId: project.id, boxId: source.id, reason: reason.trim() || undefined }, { onSuccess: onClose })
  }

  return (
    <Modal
      onClose={onClose}
      size="lg"
      dirty={take.isPending}
      onSubmit={submit}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <Camera className="h-4 w-4 shrink-0 text-yard-400" />
          <span className="shrink-0">{replaces ? "Replace" : "Take"} project snapshot</span>
          {project && <span className="truncate text-zinc-400">{project.name}</span>}
        </span>
      }
      description="New boxes for the project start from it instead of cloning and installing from scratch."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={take.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canGo} loading={take.isPending} title={blocker ?? undefined} data-testid="snapshot-confirm">
            {take.isPending ? "Starting…" : replaces ? "Replace snapshot" : "Take snapshot"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {box ? (
          projectChoices.length > 1 ? (
            <Field label="Project">
              <Select className="w-full" value={pid} onChange={(e) => setPickedProject(e.target.value)} data-testid="snapshot-project">
                {projectChoices.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : !projectChoices.length ? (
            <p className="text-zinc-400">No project on {box.id} can use a snapshot.</p>
          ) : null
        ) : boxChoices.length ? (
          <Field label="From box" hint="A ready box with this project's work on it, set up the way new boxes should start.">
            <Select className="w-full" value={source?.id ?? ""} onChange={(e) => setPickedBox(e.target.value)} data-testid="snapshot-box">
              {boxChoices.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.id} · {b.size}
                  {b.runningTurns ? ` · ${b.runningTurns} running` : ""}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="text-zinc-400">{boxes.isLoading ? "Loading boxes…" : "No ready box has this project's work on it yet. Run a task first, then snapshot its box."}</p>
        )}

        {source && project && (
          <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2.5 text-xs text-zinc-400">
            <p>
              <span className="font-mono text-zinc-200">{source.id}</span> isn't changed. Box Yard snapshots it as it is, restores that on a scratch {source.size} box, strips the
              copy, and saves it as {project.name}'s snapshot. The scratch box and the first snapshot are deleted after. It takes a few minutes, and nothing new is placed on{" "}
              {source.id} until the first snapshot is saved.
            </p>
            <p>
              <span className="text-zinc-300">Removed from the copy:</span> every task's workspace and session (uncommitted work stays on {source.id}), other projects' repo
              mirrors, logins and tokens (gh, Claude, git credentials, npm tokens), temp files, logs and shell history.
            </p>
            <p>
              <span className="text-zinc-300">Kept:</span> {project.name}'s repo mirror, the dependency cache (with workspaces' node_modules when the project caches them),
              the npm cache, toolchains, browsers and system packages.
            </p>
            <p>
              New {source.size} or bigger boxes for {project.name} start from it and fetch the repo; smaller ones start cold.
              {replaces && (
                <>
                  {" "}
                  It replaces <span className="font-mono text-zinc-300">{replaces.id}</span> (taken <TimeAgo ts={replaces.takenAt} />
                  ), which is deleted once the new one is saved.
                </>
              )}
            </p>
          </div>
        )}

        {blocker && (
          <p className="flex items-start gap-2 text-xs text-amber-300" data-testid="snapshot-blocker">
            <LineIcon icon={AlertTriangle} className="h-3.5 w-3.5" />
            <span>{blocker}</span>
          </p>
        )}

        <Field label="Reason (optional)">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. repo cloned, npm ci done, Chrome installed" />
        </Field>

        {take.error && (
          <p className="text-xs text-red-300" role="alert">
            {take.error.message}
          </p>
        )}
      </div>
    </Modal>
  )
}

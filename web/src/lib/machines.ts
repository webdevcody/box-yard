// Pure helpers for Settings › Machines and the Boxes page's machines: the add/edit form, and how a machine's state
// and last connection test read.
import { formatBytes } from "../../../shared/disk"
import { DEFAULT_MACHINE_DIR, normalizeLabels, type Machine, type MachineState, type MachineTest, type MachineTool } from "../../../shared/machines"
import type { MachineForm } from "./queries"

export const MACHINE_STATE: Record<MachineState, { label: string; chip: string; dot: string; title: string }> = {
  ready: { label: "Ready", chip: "bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400", title: "It passed its last test and has a free slot." },
  busy: { label: "Busy", chip: "bg-sky-500/10 text-sky-300", dot: "bg-sky-400", title: "Every slot is running a task; tasks for its labels wait." },
  offline: { label: "Offline", chip: "bg-red-500/10 text-red-300", dot: "bg-red-500", title: "Box Yard couldn't reach it. Its tasks wait; it's tried again every minute." },
  problem: { label: "Needs setup", chip: "bg-amber-500/10 text-amber-300", dot: "bg-amber-400", title: "It answered, but something agents need is missing." },
  off: { label: "Off", chip: "bg-zinc-800 text-zinc-400", dot: "bg-zinc-500", title: "Turned off: no new turns start on it." },
  untested: { label: "Not tested", chip: "bg-zinc-800 text-zinc-300", dot: "bg-zinc-500", title: "Test the connection before tasks run on it." },
}

/** The form as typed: numbers and labels as text. */
export interface MachineDraft {
  name: string
  host: string
  user: string
  port: string
  keyRef: string
  maxTasks: string
  labels: string
  dir: string
  enabled: boolean
}

export const EMPTY_MACHINE: MachineDraft = { name: "", host: "", user: "", port: "22", keyRef: "file:~/.ssh/id_ed25519", maxTasks: "1", labels: "", dir: DEFAULT_MACHINE_DIR, enabled: true }

export const draftOf = (m: Machine): MachineDraft => ({
  name: m.name,
  host: m.host,
  user: m.user,
  port: String(m.port),
  keyRef: m.keyRef,
  maxTasks: String(m.maxTasks),
  labels: m.labels.join(", "),
  dir: m.dir,
  enabled: m.enabled,
})

const int = (v: string, what: string) => {
  const n = Number(v.trim())
  if (!v.trim() || !Number.isInteger(n)) throw new Error(`${what} needs a whole number.`)
  return n
}

/** What Add sends. Throws with a message for a field that isn't filled in right. */
export function machineInput(d: MachineDraft): MachineForm {
  for (const [k, label] of [
    ["name", "Name"],
    ["host", "Host"],
    ["user", "User"],
    ["keyRef", "SSH key"],
  ] as const) {
    if (!d[k].trim()) throw new Error(`${label} is required.`)
  }
  return {
    name: d.name.trim(),
    host: d.host.trim(),
    user: d.user.trim(),
    port: int(d.port, "Port"),
    keyRef: d.keyRef.trim(),
    maxTasks: int(d.maxTasks, "Tasks running at once"),
    labels: normalizeLabels(d.labels),
    dir: d.dir.trim() || DEFAULT_MACHINE_DIR,
    enabled: d.enabled,
  }
}

/** What Save sends for an edit: only the fields that changed. */
export function machinePatch(d: MachineDraft, saved: Machine): Partial<MachineForm> {
  const next = machineInput(d)
  const patch: Partial<MachineForm> = {}
  if (next.name !== saved.name) patch.name = next.name
  if (next.host !== saved.host) patch.host = next.host
  if (next.user !== saved.user) patch.user = next.user
  if (next.port !== saved.port) patch.port = next.port
  if (next.keyRef !== saved.keyRef) patch.keyRef = next.keyRef
  if (next.maxTasks !== saved.maxTasks) patch.maxTasks = next.maxTasks
  if (next.labels!.join(",") !== saved.labels.join(",")) patch.labels = next.labels
  if (next.dir !== saved.dir) patch.dir = next.dir
  if (next.enabled !== saved.enabled) patch.enabled = next.enabled
  return patch
}

/** "user@host" or "user@host:2222". */
export const machineAddress = (m: Pick<Machine, "user" | "host" | "port">) => `${m.user}@${m.host}${m.port === 22 ? "" : `:${m.port}`}`

/** "Ubuntu 24.04 · 4 CPUs · 7.6 GB RAM · 112 GB free" from a passed test. */
export function hardwareLine(t: MachineTest): string {
  return [
    t.osName || t.os,
    t.cpus !== null ? `${t.cpus} CPU${t.cpus === 1 ? "" : "s"}` : null,
    t.memoryBytes !== null ? `${formatBytes(t.memoryBytes)} RAM` : null,
    t.diskFreeBytes !== null ? `${formatBytes(t.diskFreeBytes)} free` : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** "2.43.0" from "git version 2.43.0", "codex-cli 0.40.0", "v20.11.1" or "2.0.14 (Claude Code)". */
const version = (name: string, t: MachineTool) =>
  t.version
    ?.replace(new RegExp(`^${name}(-cli)?( version)? `), "")
    .replace(/\s*\(Claude Code.*\)$/, "")
    .replace(/^v(?=\d)/, "") ?? "found"

/** Each tool the test looked for, found or not, with the claude login. */
export function toolList(t: MachineTest): { name: string; text: string; ok: boolean | null }[] {
  const { git, node, claude, codex } = t.tools
  return [
    { name: "git", text: git.found ? version("git", git) : "missing", ok: git.found },
    { name: "node", text: node.found ? version("node", node) : "missing", ok: node.found },
    {
      name: "claude",
      text: !claude.found ? "missing" : `${version("claude", claude)}${t.claudeLogin === true ? ", logged in" : t.claudeLogin === false ? ", not logged in" : ""}`,
      ok: !claude.found ? false : t.claudeLogin === false ? null : true,
    },
    // Codex is only detected: Box Yard runs Claude Code.
    { name: "codex", text: codex.found ? `${version("codex", codex)} (not used)` : "not installed", ok: null },
  ]
}

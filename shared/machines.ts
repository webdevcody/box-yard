// SSH machines as a runner ("Runs on: SSH machine", shared/runner.ts): computers of Cody's (an old laptop, a GPU
// tower) that Box Yard reaches over SSH and runs agents on, much like the local runner but on another computer.
// Each machine has labels ("laptops", "gpu"); a task or project picks machines by label, and the scheduler takes a
// free one of those (docs/machines.md).

import { parseRunsOn, RUNNERS, type Runner } from "./runner.js"

/**
 * A machine's virtual box: `ssh-<machineId>`. Like this computer it's shared by every project that runs there, and
 * like the GPU pods and Docker containers it's never a `boxes` row, so the pool (Max boxes, Max tasks running at
 * once), cost metering and the box janitor's sweeps never see it.
 */
export const MACHINE_BOX_PREFIX = "ssh-"
export const machineBoxId = (machineId: string) => `${MACHINE_BOX_PREFIX}${machineId}`
export const isMachineBox = (id: string | null | undefined): id is string => Boolean(id?.startsWith(MACHINE_BOX_PREFIX))
export const machineOfBox = (boxId: string) => boxId.slice(MACHINE_BOX_PREFIX.length)

/**
 * How Box Yard logs in to a machine, by reference only: the key never passes through a chat or the database.
 * - `file:~/.ssh/<key>`: a private key file in this computer's ~/.ssh (ssh -i, read by ssh itself),
 * - `agent`: whatever key this computer's SSH agent offers,
 * - `agent:SHA256:…`: that one key of the agent's (or 1Password's),
 * - `default`: ssh's own config here (~/.ssh/config, ~/.ssh/id_*).
 */
export type MachineKeyRef = `file:${string}` | "agent" | `agent:${string}` | "default"

export const KEY_REF_HELP =
  "file:~/.ssh/<key> (a key file in this computer's ~/.ssh), agent (any key in this computer's SSH agent), agent:SHA256:<fingerprint> (one agent key) or default (ssh's own config here). Never the key itself."

export function parseKeyRef(v: unknown): MachineKeyRef | null {
  if (typeof v !== "string") return null
  const s = v.trim()
  if (s === "agent" || s === "default") return s
  if (/^agent:SHA256:[A-Za-z0-9+/]{20,}={0,2}$/.test(s)) return s as MachineKeyRef
  if (/^file:\S.*$/.test(s) && !s.includes("\n")) return s as MachineKeyRef
  return null
}

/** One of `which` tools on a machine: whether it's there, its version and where. */
export interface MachineTool {
  found: boolean
  version: string | null
  path: string | null
}

/** What Test connection found on a machine (MachineRegistry.test). */
export interface MachineTest {
  at: number
  /** Logged in over SSH and ran the probe. False: `error` says why. */
  ok: boolean
  error: string | null
  /** How long the SSH round trip took, ms. */
  latencyMs: number | null
  /** "Linux 6.8.0 x86_64", "Darwin 23.4.0 arm64". */
  os: string | null
  /** "Ubuntu 24.04.1 LTS", "macOS 14.4". */
  osName: string | null
  hostname: string | null
  cpus: number | null
  memoryBytes: number | null
  /** The work folder's disk. */
  diskFreeBytes: number | null
  diskTotalBytes: number | null
  /** The login user's home, which a `~/…` work folder resolves against. */
  home: string | null
  /** The work folder (Machine.dir) as an absolute path on the machine: task folders, mirrors and the runner live in it. */
  workDir: string | null
  /** Folders the machine's login shell has node, claude or git in (nvm and the like), put first on PATH for agents. */
  pathDirs: string[]
  tools: { git: MachineTool; node: MachineTool; claude: MachineTool; codex: MachineTool }
  /** `claude auth status` on the machine: its own Claude login. Null: claude isn't there, or it didn't say. */
  claudeLogin: boolean | null
  /** `codex login status` on the machine: its own Codex login. Null (or missing, from before Codex): codex isn't there, or it didn't say. */
  codexLogin?: boolean | null
  /** A folder in memory (a tmpfs) for each turn's task.json, or null: they're on disk in the task folder for the turn. */
  secretsDir: string | null
  /** Problems that stop tasks from running there (no node, no git, …); empty when it's ready. */
  problems: string[]
  /** Worth knowing but not blocking (claude or codex not logged in while Box Yard forwards a key, claude missing where codex is there). */
  notes: string[]
}

export interface Machine {
  id: string
  name: string
  host: string
  user: string
  port: number
  keyRef: MachineKeyRef
  /** Tasks running at once on it. */
  maxTasks: number
  /** Lowercase labels ("laptops", "gpu", "local"); its name works as a label too. */
  labels: string[]
  /** Box Yard's folder on it: `~/boxyard` unless set. Task folders, repo mirrors and the runner live inside. */
  dir: string
  /** Off: no new turns go there (running ones finish). */
  enabled: boolean
  lastTest: MachineTest | null
  createdAt: number
  updatedAt: number
}

export const DEFAULT_MACHINE_DIR = "~/boxyard"

export const MACHINE_LIMITS = {
  maxTasks: { min: 1, max: 32 },
  port: { min: 1, max: 65_535 },
  labels: 20,
  labelLength: 40,
} as const

/** "GPU box" → "gpu-box": lowercase letters, digits, dot, dash and underscore. Null when nothing's left. */
export function normalizeLabel(v: unknown): string | null {
  if (typeof v !== "string") return null
  const s = v
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, MACHINE_LIMITS.labelLength)
  return s || null
}

/** A label list, normalized, deduplicated, at most MACHINE_LIMITS.labels. A comma-separated string works too. */
export function normalizeLabels(v: unknown): string[] {
  const raw = typeof v === "string" ? v.split(",") : Array.isArray(v) ? v : []
  return [...new Set(raw.map(normalizeLabel).filter((l): l is string => Boolean(l)))].slice(0, MACHINE_LIMITS.labels)
}

/** A machine answers to its labels and to its name (both case-insensitive). No label: any machine. */
export function machineMatches(m: Pick<Machine, "name" | "labels">, label: string | null | undefined): boolean {
  const want = normalizeLabel(label)
  if (!want) return true
  return m.labels.includes(want) || normalizeLabel(m.name) === want
}

/** Every label in use, with the machines that carry it (names count as labels only in matching, not here). */
export function labelIndex(machines: Pick<Machine, "name" | "labels" | "enabled">[]): { label: string; machines: string[] }[] {
  const by = new Map<string, string[]>()
  for (const m of machines) for (const l of m.labels) by.set(l, [...(by.get(l) ?? []), m.name])
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, names]) => ({ label, machines: names }))
}

/** `"label:gpu"` → "gpu": runs_on's short form for `runs_on: "ssh"` with `machine_label: "gpu"`. */
export function labelFromRunsOn(v: unknown): string | null {
  if (typeof v !== "string") return null
  const m = /^(?:label|ssh):(.+)$/i.exec(v.trim())
  return m ? normalizeLabel(m[1]) : null
}

/** runs_on's alias for this computer that Settings › Machines › "Local means" never changes. */
export const THIS_COMPUTER = "this_computer"

/**
 * Where the MCP tools' runs_on and machine_label send a task (docs/machines.md › Labels):
 * - "label:gpu" (or "ssh:gpu"), or "ssh" with machine_label "gpu", or machine_label alone: SSH machines labelled gpu;
 * - "ssh" alone: any of Cody's SSH machines;
 * - "local": this computer, unless Settings › Machines › "Local means" names a label (`localLabel`), and then the
 *   SSH machines with that label;
 * - "this_computer": always this computer.
 * `runner` null: follow the project. Throws on a combination that makes no sense.
 */
export function resolveRunsOn(runsOn: string | null | undefined, machineLabel: string | null | undefined, localLabel: string | null): { runner: Runner | null; machineLabel: string | null; viaLocal: boolean } {
  const wanted = machineLabel == null ? null : normalizeLabel(machineLabel)
  if (machineLabel != null && machineLabel.trim() && !wanted) throw new Error(`machine_label "${machineLabel}" has no letters or digits.`)
  const v = runsOn?.trim()
  if (!v) return { runner: wanted ? "ssh" : null, machineLabel: wanted, viaLocal: false }
  const short = /^(?:label|ssh):/i.test(v)
  if (short) {
    const label = labelFromRunsOn(v)
    if (!label) throw new Error(`runs_on "${v}" names no label: use "label:<label>", like "label:gpu".`)
    if (wanted && wanted !== label) throw new Error(`runs_on "${v}" and machine_label "${wanted}" name different labels: pass one.`)
    return { runner: "ssh", machineLabel: label, viaLocal: false }
  }
  if (v === "ssh") return { runner: "ssh", machineLabel: wanted, viaLocal: false }
  if (v === "local" && localLabel && !wanted) return { runner: "ssh", machineLabel: localLabel, viaLocal: true }
  const runner = v === THIS_COMPUTER ? "local" : parseRunsOn(v)
  if (!runner) throw new Error(`runs_on "${v}" isn't a runner: ${[...RUNNERS, THIS_COMPUTER].join(", ")} or "label:<label>".`)
  if (wanted) throw new Error(`machine_label goes with SSH machines (runs_on "ssh", or leave runs_on out), not with runs_on "${v}".`)
  return { runner, machineLabel: null, viaLocal: false }
}

/** "laptops", or "any SSH machine" when there's no label: for wait reasons and placement lines. */
export const labelPhrase = (label: string | null) => (label ? `SSH machines labelled "${label}"` : "your SSH machines")

/** Settings › Machines (kv "machines"). */
export interface MachineSettings {
  /**
   * What "local" means when Cody (or the Coordinator) asks for a task to run locally: null is this computer, the one
   * running Box Yard; a label sends those tasks to the SSH machines with that label instead (runs_on "local" in the
   * MCP tools). The Runs on picker's "This computer" always means this computer.
   */
  localLabel: string | null
}

export const DEFAULT_MACHINE_SETTINGS: MachineSettings = { localLabel: null }

/** Why tasks can't run on a machine now, from its last test, or null when it's ready. */
export function machineProblem(m: Pick<Machine, "enabled" | "lastTest">): string | null {
  if (!m.enabled) return "it's turned off"
  const t = m.lastTest
  if (!t) return "it hasn't been tested yet"
  if (!t.ok) return t.error ?? "the last connection test failed"
  if (t.problems.length) return t.problems.join("; ")
  return null
}

/** How the Boxes page and list_machines show a machine now. */
export type MachineState = "ready" | "busy" | "offline" | "problem" | "off" | "untested"

export interface MachineStatus extends Machine {
  state: MachineState
  /** Why it's offline, has a problem or is off. */
  problem: string | null
  /** Agent turns running there now, and task folders it holds. */
  running: number
  tasks: number
  /** Its virtual box id, `ssh-<id>`. */
  boxId: string
}

export interface MachinesStatus {
  machines: MachineStatus[]
  settings: MachineSettings
  labels: { label: string; machines: string[] }[]
}

/** What placement knows of one machine for a task (pickMachine). */
export interface MachineCandidate {
  id: string
  name: string
  labels: string[]
  enabled: boolean
  /** Why it can't take tasks (failed test, missing node, offline), or null. */
  problem: string | null
  /** Its own Claude login, from the last test; null: unknown. */
  claudeLogin: boolean | null
  maxTasks: number
  running: number
  /** A project's Tasks running at once or Whole machine rules this task out there, or null. */
  blocked: string | null
}

export type MachinePick =
  | { machineId: string; moved: boolean }
  | { wait: string; kind: "none" | "unusable" | "claude" | "busy" }

/**
 * Which machine a task's next turn takes (pure, so it's unit-tested):
 * 1. a workspace that can't move without losing work (`canMove` false) stays on its machine: it runs there when that
 *    machine works and has room, else it waits for it;
 * 2. the machine its workspace is on, while it matches the label, works and has room;
 * 3. the matching working machine with the fewest agents running that has room (ties: by name);
 * 4. else a wait, with the reason as the task shows it ("Waiting for …", "Waiting: …"): no machine has that label, none of them works now, none has a Claude login to
 *    use (`claudeKey` false), or every one is busy.
 */
export function pickMachine(i: { machines: MachineCandidate[]; label: string | null; current: string | null; canMove: boolean; claudeKey: boolean }): MachinePick {
  const room = (m: MachineCandidate) => m.running < m.maxTasks && !m.blocked
  const slots = (m: MachineCandidate) => m.blocked ?? `${m.running} of ${m.maxTasks} running`
  const cur = i.current ? i.machines.find((m) => m.id === i.current) : undefined
  if (cur && !i.canMove) {
    const problem = !cur.enabled ? "it's turned off" : cur.problem
    if (problem) return { kind: "unusable", wait: `Waiting for ${cur.name}, where its workspace is: it can't take tasks now (${problem})` }
    if (!i.claudeKey && cur.claudeLogin !== true) return { kind: "claude", wait: `Waiting for a Claude login on ${cur.name}, where its workspace is: log in to claude there and test it again, or add a Claude key in Settings › Credentials` }
    if (!room(cur)) return { kind: "busy", wait: `Waiting for a free slot on ${cur.name}, where its workspace is (${slots(cur)})` }
    return { machineId: cur.id, moved: false }
  }
  const matching = i.machines.filter((m) => m.enabled && machineMatches(m, i.label))
  const what = labelPhrase(i.label)
  if (!matching.length) {
    const off = i.machines.filter((m) => !m.enabled && machineMatches(m, i.label)).map((m) => m.name)
    return {
      kind: "none",
      wait: off.length
        ? `Waiting: ${what} ${off.length === 1 ? "is" : "are"} turned off (${off.join(", ")}): turn one on in Settings › Machines`
        : i.label
          ? `Waiting: no SSH machine has the label "${i.label}": add one, or label one, in Settings › Machines`
          : "Waiting: no SSH machine is set up: add one in Settings › Machines",
    }
  }
  const working = matching.filter((m) => !m.problem)
  if (!working.length) return { kind: "unusable", wait: `Waiting: none of ${what} can take tasks now (${matching.map((m) => `${m.name}: ${m.problem}`).join("; ")})` }
  const usable = i.claudeKey ? working : working.filter((m) => m.claudeLogin === true)
  if (!usable.length) {
    return {
      kind: "claude",
      wait: `Waiting for a Claude login for ${what}: log in to claude on ${working.length === 1 ? working[0]!.name : "one of them"} and test it again, or add a Claude key in Settings › Credentials`,
    }
  }
  const here = cur && usable.includes(cur) ? cur : undefined
  if (here && room(here)) return { machineId: here.id, moved: false }
  const free = usable.filter((m) => m !== here && room(m)).sort((a, b) => a.running - b.running || a.name.localeCompare(b.name))
  if (free[0]) return { machineId: free[0].id, moved: Boolean(cur) }
  return { kind: "busy", wait: `Waiting for a free slot on ${what} (${usable.map((m) => `${m.name}: ${slots(m)}`).join(", ")})` }
}

/** "SSH · laptop-1". */
export const machineLabel = (name: string | null, boxId: string) => `SSH · ${name ?? machineOfBox(boxId)}`

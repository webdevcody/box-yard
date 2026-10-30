// Cody's SSH machines (shared/machines.ts): the `machines` table and Settings › Machines (kv "machines"). Only
// references to keys are kept (MachineKeys checks them); a machine's last connection test is kept with it.
import type { DB } from "../db.js"
import { BadRequestError, ConflictError, NotFoundError, newId, type Store } from "../store.js"
import {
  DEFAULT_MACHINE_DIR,
  DEFAULT_MACHINE_SETTINGS,
  MACHINE_LIMITS,
  normalizeLabel,
  normalizeLabels,
  parseKeyRef,
  type Machine,
  type MachineKeyRef,
  type MachineSettings,
  type MachineTest,
} from "../../shared/machines.js"
import { SSH_HOST_RE, SSH_USER_RE } from "./ssh.js"

interface MachineRow {
  id: string
  name: string
  host: string
  user: string
  port: number
  key_ref: string
  max_tasks: number
  labels_json: string
  dir: string
  enabled: number
  test_json: string | null
  created_at: number
  updated_at: number
}

/** What add_machine and Settings › Machines › Add send; update takes any part of it. */
export interface MachineInput {
  name: string
  host: string
  user: string
  port?: number
  keyRef: MachineKeyRef
  maxTasks?: number
  labels?: string[]
  dir?: string
  enabled?: boolean
}

const SETTINGS_KEY = "machines"
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

function parse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** A work folder: `~/…` or absolute, below the home or root (never the home itself), with no `..`. */
export function checkDir(v: unknown): string {
  const dir = typeof v === "string" ? v.trim().replace(/\/+$/, "") : ""
  if (!dir) return DEFAULT_MACHINE_DIR
  // Two levels at least: ~/boxyard or /srv/boxyard, never ~ or /srv itself.
  if (!/^(~\/|\/)[\w./ -]+$/.test(dir) || dir.split("/").some((p) => p === "..") || dir.split("/").filter(Boolean).length < 2) {
    throw new BadRequestError(`The work folder must be a folder of its own, like ~/boxyard or /srv/boxyard (letters, digits, space, . _ - and /).`)
  }
  return dir
}

export class MachineRegistry {
  private readonly listeners = new Set<() => void>()

  constructor(private readonly d: { db: DB; store: Pick<Store, "getKv" | "setKv"> }) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed() {
    for (const fn of this.listeners) fn()
  }

  private view(r: MachineRow): Machine {
    return {
      id: r.id,
      name: r.name,
      host: r.host,
      user: r.user,
      port: r.port,
      keyRef: parseKeyRef(r.key_ref) ?? "default",
      maxTasks: r.max_tasks,
      labels: normalizeLabels(parse<string[]>(r.labels_json, [])),
      dir: r.dir || DEFAULT_MACHINE_DIR,
      enabled: r.enabled === 1,
      lastTest: parse<MachineTest | null>(r.test_json, null),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  list(): Machine[] {
    return (this.d.db.prepare("SELECT * FROM machines ORDER BY name COLLATE NOCASE").all() as MachineRow[]).map((r) => this.view(r))
  }

  get(id: string): Machine | null {
    const r = this.d.db.prepare("SELECT * FROM machines WHERE id = ?").get(id) as MachineRow | undefined
    return r ? this.view(r) : null
  }

  /** By id or (case-insensitive) name, for the MCP tools. */
  find(ref: string): Machine | null {
    const r = this.d.db.prepare("SELECT * FROM machines WHERE id = ? OR name = ? COLLATE NOCASE").get(ref.trim(), ref.trim()) as MachineRow | undefined
    return r ? this.view(r) : null
  }

  require(ref: string): Machine {
    const m = this.find(ref)
    if (!m) throw new NotFoundError(`No SSH machine "${ref}". list_machines (or Settings › Machines) shows them.`)
    return m
  }

  /** Checks every field; the key reference is checked by the caller (MachineKeys), which can read the disk. */
  private fields(input: Partial<MachineInput>, current: Machine | null) {
    const name = input.name === undefined ? current!.name : String(input.name).trim()
    if (!NAME_RE.test(name)) throw new BadRequestError("A machine's name is 1–40 letters, digits, dots, dashes or underscores, like old-thinkpad.")
    const host = input.host === undefined ? current!.host : String(input.host).trim()
    if (!SSH_HOST_RE.test(host)) throw new BadRequestError(`"${host}" isn't a host name or IP address.`)
    const user = input.user === undefined ? current!.user : String(input.user).trim()
    if (!SSH_USER_RE.test(user)) throw new BadRequestError(`"${user}" isn't a user name.`)
    const port = input.port === undefined ? (current?.port ?? 22) : Number(input.port)
    if (!Number.isInteger(port) || port < MACHINE_LIMITS.port.min || port > MACHINE_LIMITS.port.max) throw new BadRequestError("The SSH port is a number from 1 to 65535.")
    const maxTasks = input.maxTasks === undefined ? (current?.maxTasks ?? 1) : Number(input.maxTasks)
    if (!Number.isInteger(maxTasks) || maxTasks < MACHINE_LIMITS.maxTasks.min || maxTasks > MACHINE_LIMITS.maxTasks.max) {
      throw new BadRequestError(`Tasks running at once is ${MACHINE_LIMITS.maxTasks.min}–${MACHINE_LIMITS.maxTasks.max}.`)
    }
    const keyRef = input.keyRef === undefined ? current!.keyRef : parseKeyRef(input.keyRef)
    if (!keyRef) throw new BadRequestError("That isn't an SSH key reference.")
    const labels = input.labels === undefined ? (current?.labels ?? []) : normalizeLabels(input.labels)
    const dir = input.dir === undefined ? (current?.dir ?? DEFAULT_MACHINE_DIR) : checkDir(input.dir)
    const enabled = input.enabled === undefined ? (current?.enabled ?? true) : Boolean(input.enabled)
    const other = this.d.db.prepare("SELECT id FROM machines WHERE name = ? COLLATE NOCASE").get(name) as { id: string } | undefined
    if (other && other.id !== current?.id) throw new ConflictError(`There's already a machine named ${name}.`)
    return { name, host, user, port, maxTasks, keyRef, labels, dir, enabled }
  }

  add(input: MachineInput): Machine {
    const f = this.fields(input, null)
    const id = newId("mch")
    const now = Date.now()
    this.d.db
      .prepare(
        "INSERT INTO machines (id, name, host, user, port, key_ref, max_tasks, labels_json, dir, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, f.name, f.host, f.user, f.port, f.keyRef, f.maxTasks, JSON.stringify(f.labels), f.dir, f.enabled ? 1 : 0, now, now)
    this.changed()
    return this.get(id)!
  }

  /**
   * Change a machine. A new host, user, port, key or work folder makes its last test stale (it's cleared), since what
   * it found may not hold any more; `reconnect` says so, and the caller tests it again.
   */
  update(id: string, patch: Partial<MachineInput>): { machine: Machine; reconnect: boolean } {
    const current = this.get(id)
    if (!current) throw new NotFoundError(`No SSH machine ${id}.`)
    const f = this.fields(patch, current)
    const reconnect = f.host !== current.host || f.user !== current.user || f.port !== current.port || f.keyRef !== current.keyRef || f.dir !== current.dir
    this.d.db
      .prepare(
        `UPDATE machines SET name = ?, host = ?, user = ?, port = ?, key_ref = ?, max_tasks = ?, labels_json = ?, dir = ?, enabled = ?, updated_at = ?${reconnect ? ", test_json = NULL" : ""} WHERE id = ?`,
      )
      .run(f.name, f.host, f.user, f.port, f.keyRef, f.maxTasks, JSON.stringify(f.labels), f.dir, f.enabled ? 1 : 0, Date.now(), id)
    this.changed()
    return { machine: this.get(id)!, reconnect }
  }

  remove(id: string) {
    this.d.db.prepare("DELETE FROM machines WHERE id = ?").run(id)
    this.changed()
  }

  setTest(id: string, test: MachineTest) {
    this.d.db.prepare("UPDATE machines SET test_json = ? WHERE id = ?").run(JSON.stringify(test), id)
    this.changed()
  }

  settings(): MachineSettings {
    const s = parse<Partial<MachineSettings>>(this.d.store.getKv(SETTINGS_KEY), {})
    return { ...DEFAULT_MACHINE_SETTINGS, localLabel: normalizeLabel(s.localLabel) }
  }

  saveSettings(patch: Partial<MachineSettings>): MachineSettings {
    const next = { ...this.settings() }
    if (patch.localLabel !== undefined) next.localLabel = patch.localLabel === null ? null : normalizeLabel(patch.localLabel)
    this.d.store.setKv(SETTINGS_KEY, JSON.stringify(next))
    this.changed()
    return next
  }
}

// Cody's SSH machines (docs/machines.md): the registry, how Box Yard logs in to them, their box provider, and Test
// connection. Settings › Machines, the Boxes page and the machine MCP tools all go through here.
import path from "node:path"
import type { DB } from "../db.js"
import type { Store } from "../store.js"
import {
  labelIndex,
  machineBoxId,
  machineProblem,
  type Machine,
  type MachineSettings,
  type MachineState,
  type MachineStatus,
  type MachinesStatus,
  type MachineTest,
} from "../../shared/machines.js"
import { MachineKeys, type MachineKeysOptions } from "./keys.js"
import { failedTest, loginDirs, parseProbe, probeScript, testFromProbe, toolsScript } from "./probe.js"
import { FolderTransport, MachineProvider, SshTransport, type MachineTransport } from "./provider.js"
import { MachineRegistry, type MachineInput } from "./registry.js"
import { SSH_FAILED, scriptFor, sshError } from "./ssh.js"

export interface MachineServiceDeps {
  db: DB
  store: Pick<Store, "getKv" | "setKv">
  dataDir: string
  /** Mock mode and tests: machines are folders here, and agents run this claude (CLAUDE_BIN). */
  mock?: { dir: string; claudeBin: string } | null
  sshBin?: string
  /** Stand-ins for this computer's ~/.ssh and SSH agent (tests). */
  keys?: Omit<MachineKeysOptions, "dir">
  /** A transport of the test's own (a fake ssh). */
  transport?: MachineTransport
}

/** Tasks on one machine now: agent turns running, and task folders it holds. */
export type MachineUsage = (boxId: string) => { running: number; tasks: number }

const TEST_TIMEOUT_MS = 90_000

export class MachineService {
  readonly registry: MachineRegistry
  readonly keys: MachineKeys
  readonly provider: MachineProvider
  private readonly testing = new Map<string, Promise<Machine>>()

  constructor(private readonly d: MachineServiceDeps) {
    this.registry = new MachineRegistry({ db: d.db, store: d.store })
    const dir = path.join(d.dataDir, "machines")
    this.keys = new MachineKeys({ ...d.keys, dir })
    const transport =
      d.transport ??
      (d.mock
        ? // The "machine" finds this process's node first, like a machine with node installed.
          new FolderTransport(d.mock.dir, () => ({ ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` }))
        : new SshTransport({ dir, keys: this.keys, sshBin: d.sshBin }))
    this.provider = new MachineProvider({
      machines: (id) => this.registry.get(id),
      transport,
      claudeBin: d.mock?.claudeBin,
      nodeBin: d.mock ? process.execPath : undefined,
    })
  }

  get mock() {
    return Boolean(this.d.mock)
  }

  onChange(fn: () => void) {
    return this.registry.onChange(fn)
  }

  list(): Machine[] {
    return this.registry.list()
  }

  get(id: string) {
    return this.registry.get(id)
  }

  settings(): MachineSettings {
    return this.registry.settings()
  }

  saveSettings(patch: Partial<MachineSettings>) {
    return this.registry.saveSettings(patch)
  }

  /**
   * Why tasks can't run on a machine now, or null: its last test (off, untested, failed, missing tools), or it didn't
   * answer the last time Box Yard reached for it.
   */
  problem(m: Machine): string | null {
    const own = machineProblem(m)
    if (own) return own
    const reach = this.provider.reachOf(m.id)
    return reach && !reach.ok ? `Box Yard can't reach it (${reach.error ?? "ssh failed"})` : null
  }

  /** Add a machine (its key reference checked first) and test it. */
  async add(input: MachineInput, opts: { test?: boolean } = {}): Promise<Machine> {
    await this.keys.check(input.keyRef)
    const m = this.registry.add(input)
    return opts.test === false ? m : this.test(m.id)
  }

  /** Change a machine. A new address, key or work folder drops the shared connection and tests it again. */
  async update(id: string, patch: Partial<MachineInput>): Promise<Machine> {
    const before = this.registry.require(id)
    if (patch.keyRef !== undefined) await this.keys.check(patch.keyRef)
    const { machine, reconnect } = this.registry.update(before.id, patch)
    if (!reconnect) return machine
    await this.provider.transport.close?.(before)
    if (before.keyRef !== machine.keyRef) this.keys.forget(before.id)
    return this.test(machine.id)
  }

  /** Remove a machine from Box Yard. Its folder on the machine stays; the caller moves or refuses its tasks first. */
  async remove(id: string): Promise<void> {
    const m = this.registry.require(id)
    await this.provider.transport.close?.(m)
    this.provider.transport.forgetHostKey?.(m)
    this.keys.forget(m.id)
    this.registry.remove(m.id)
  }

  /** Forget a machine's host key (it was reinstalled): the next connection trusts whatever key it shows. */
  async forgetHostKey(id: string): Promise<Machine> {
    const m = this.registry.require(id)
    await this.provider.transport.close?.(m)
    this.provider.transport.forgetHostKey?.(m)
    return this.test(m.id)
  }

  /**
   * Test connection: log in, make Box Yard's work folder, and see what the machine has for agents (OS, CPUs, memory,
   * disk, git, node, claude and whether it's logged in, codex). The result is kept with the machine. One test per
   * machine at a time; a second call shares the first.
   */
  test(ref: string): Promise<Machine> {
    const m = this.registry.require(ref)
    const running = this.testing.get(m.id)
    if (running) return running
    const p = this.probe(m)
      .catch((err) => failedTest((err as Error).message, Date.now()))
      .then((test) => {
        // Removed while testing: nothing to keep.
        if (!this.registry.get(m.id)) return m
        this.registry.setTest(m.id, test)
        return this.registry.get(m.id)!
      })
      .finally(() => this.testing.delete(m.id))
    this.testing.set(m.id, p)
    return p
  }

  private async probe(m: Machine): Promise<MachineTest> {
    const at = Date.now()
    const started = performance.now()
    const first = await this.provider.run(m, { input: scriptFor(probeScript(m.dir)), timeoutMs: TEST_TIMEOUT_MS })
    const latencyMs = Math.round(performance.now() - started)
    if (first.exitCode === SSH_FAILED && this.provider.transport.kind === "ssh") return failedTest(`Can't connect: ${sshError(first.stderr)}`, at)
    const facts = parseProbe(first.stdout.toString("utf8"))
    if (!facts.size) {
      const why = first.stderr.trim().split("\n").at(-1)?.slice(0, 300)
      return failedTest(`It logged in but the test didn't run (exit ${first.exitCode}${why ? `: ${why}` : ""}). Box Yard needs bash on it.`, at, latencyMs)
    }
    const pathDirs = loginDirs(facts)
    const second = await this.provider.run(m, { input: scriptFor(toolsScript(), pathDirs), timeoutMs: TEST_TIMEOUT_MS })
    const test = testFromProbe({ first: facts, tools: parseProbe(second.stdout.toString("utf8")), pathDirs, latencyMs, at })
    if (this.d.mock) {
      // Mock mode: agents run the made-up claude and codex, which need no login.
      test.tools.claude = { found: true, version: "2.0.0 (Claude Code, mock)", path: "claude" }
      test.tools.codex = { found: true, version: "codex-cli 0.0.0 (mock)", path: "codex" }
      test.claudeLogin = true
      test.codexLogin = true
      test.problems = test.problems.filter((p) => !/^(claude|neither claude)/.test(p))
      test.notes = test.notes.filter((n) => !/^(claude|codex)/.test(n))
    }
    return test
  }

  /**
   * Ask each enabled machine that didn't answer the last time (and not within `olderThanMs`) whether it's back.
   * True when one is: waiting tasks can go there again.
   */
  async recheck(olderThanMs: number): Promise<boolean> {
    const now = Date.now()
    const down = this.registry.list().filter((m) => {
      const reach = this.provider.reachOf(m.id)
      return m.enabled && reach && !reach.ok && now - reach.at >= olderThanMs
    })
    const back = await Promise.all(down.map(async (m) => (await this.provider.health(machineBoxId(m.id))) === "running"))
    return back.some(Boolean)
  }

  /** Every machine as the Boxes page and list_machines show it. */
  status(usage: MachineUsage): MachinesStatus {
    const machines = this.registry.list().map((m): MachineStatus => {
      const boxId = machineBoxId(m.id)
      const u = usage(boxId)
      const reach = this.provider.reachOf(m.id)
      let state: MachineState
      let problem: string | null = null
      if (!m.enabled) state = "off"
      else if (!m.lastTest) state = "untested"
      else if (!m.lastTest.ok || (reach && !reach.ok)) {
        state = "offline"
        problem = reach && !reach.ok && reach.at > m.lastTest.at ? `Box Yard can't reach it (${reach.error ?? "ssh failed"})` : m.lastTest.error
      } else if (m.lastTest.problems.length) {
        state = "problem"
        problem = m.lastTest.problems.join("; ")
      } else state = u.running >= m.maxTasks ? "busy" : "ready"
      return { ...m, state, problem, running: u.running, tasks: u.tasks, boxId }
    })
    return { machines, settings: this.registry.settings(), labels: labelIndex(machines) }
  }
}

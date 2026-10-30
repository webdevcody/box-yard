// What Settings › Machines (REST) and the machine MCP tools do to Cody's SSH machines: the MachineService change, and
// what follows for tasks (their folders are let go before a machine goes, and the box history records it).
import { ConflictError } from "../store.js"
import type { TaskManager } from "../tasks.js"
import type { BoxActor } from "../../shared/boxHistory.js"
import { machineBoxId, type MachineSettings, type MachineStatus, type MachinesStatus } from "../../shared/machines.js"
import type { MachineInput } from "./registry.js"
import type { MachineService, MachineUsage } from "./service.js"

export interface MachineActionsDeps {
  service: MachineService
  tasks: Pick<TaskManager, "releaseMachine" | "machineEvent">
  /** Agent turns running and task folders kept on a machine's box. */
  usage: MachineUsage
}

export class MachineActions {
  constructor(private readonly d: MachineActionsDeps) {}

  get service() {
    return this.d.service
  }

  status(): MachinesStatus {
    return this.d.service.status(this.d.usage)
  }

  /** One machine as list_machines and the Boxes page show it, by id or name. */
  one(ref: string): MachineStatus {
    const id = this.d.service.registry.require(ref).id
    return this.status().machines.find((m) => m.id === id)!
  }

  settings(): MachineSettings {
    return this.d.service.settings()
  }

  saveSettings(patch: Partial<MachineSettings>): MachineSettings {
    return this.d.service.saveSettings(patch)
  }

  /** Add a machine and test it (unless `test` is false). */
  async add(input: MachineInput, actor: BoxActor, opts: { test?: boolean } = {}): Promise<MachineStatus> {
    const m = await this.d.service.add(input, opts)
    this.d.tasks.machineEvent({ machine: m, kind: "created", actor, reason: "Added to Box Yard as an SSH machine." })
    return this.one(m.id)
  }

  /**
   * Change a machine. Its work folder can't change while it keeps task folders there: they'd be left behind, so those
   * tasks go elsewhere (or finish) first.
   */
  async update(ref: string, patch: Partial<MachineInput>): Promise<MachineStatus> {
    const m = this.d.service.registry.require(ref)
    const held = this.d.usage(machineBoxId(m.id)).tasks
    if (patch.dir !== undefined && patch.dir.trim().replace(/\/+$/, "") !== m.dir && held) {
      throw new ConflictError(`${m.name} keeps ${held} task folder${held === 1 ? "" : "s"} in ${m.dir}. Change its work folder once no task is there (remove it and add it again moves them off it).`)
    }
    await this.d.service.update(m.id, patch)
    return this.one(m.id)
  }

  /**
   * Remove a machine from Box Yard: refused while an agent runs on it; each task folder there is archived first, so its
   * task picks up elsewhere. `force` (Cody only) removes it even when an offline machine's folders can't be archived.
   */
  async remove(ref: string, actor: BoxActor, opts: { force?: boolean } = {}): Promise<{ moved: string[]; lost: string[] }> {
    const m = this.d.service.registry.require(ref)
    const released = await this.d.tasks.releaseMachine(m.id, opts)
    await this.d.service.remove(m.id)
    const detail = released.lost.length ? `${released.lost.length} task folder${released.lost.length === 1 ? "" : "s"} couldn't be archived first` : undefined
    this.d.tasks.machineEvent({ machine: m, kind: "deleted", actor, reason: "Removed from Box Yard.", ...(detail ? { detail } : {}) })
    return released
  }

  async test(ref: string): Promise<MachineStatus> {
    const m = await this.d.service.test(ref)
    return this.one(m.id)
  }

  async forgetHostKey(ref: string): Promise<MachineStatus> {
    const m = await this.d.service.forgetHostKey(ref)
    return this.one(m.id)
  }
}

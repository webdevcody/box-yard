// SSH machines (shared/machines.ts): labels, the runs_on short form, and which machine a task's next turn takes.
import { describe, expect, it } from "vitest"
import {
  isMachineBox,
  labelFromRunsOn,
  labelIndex,
  machineBoxId,
  machineMatches,
  machineOfBox,
  machineProblem,
  normalizeLabel,
  normalizeLabels,
  parseKeyRef,
  pickMachine,
  type MachineCandidate,
} from "../shared/machines.js"
import { placeKindOf, placeLabel } from "../shared/placement.js"

const m = (id: string, over: Partial<MachineCandidate> = {}): MachineCandidate => ({
  id,
  name: id,
  labels: [],
  enabled: true,
  problem: null,
  claudeLogin: true,
  maxTasks: 2,
  running: 0,
  blocked: null,
  ...over,
})

const pick = (machines: MachineCandidate[], over: Partial<Parameters<typeof pickMachine>[0]> = {}) =>
  pickMachine({ machines, label: null, current: null, canMove: true, claudeKey: false, ...over })

describe("machine labels", () => {
  it("normalizes labels and lists", () => {
    expect(normalizeLabel("  GPU Box ")).toBe("gpu-box")
    expect(normalizeLabel("laptops!")).toBe("laptops")
    expect(normalizeLabel("  ")).toBeNull()
    expect(normalizeLabels("laptops, GPU ,laptops,,")).toEqual(["laptops", "gpu"])
    expect(normalizeLabels(["Local", "local", 3])).toEqual(["local"])
  })

  it("matches a label or the machine's name, case-insensitively; no label matches every machine", () => {
    const laptop = { name: "Old-ThinkPad", labels: ["laptops", "local"] }
    expect(machineMatches(laptop, "LAPTOPS")).toBe(true)
    expect(machineMatches(laptop, "old-thinkpad")).toBe(true)
    expect(machineMatches(laptop, "gpu")).toBe(false)
    expect(machineMatches(laptop, null)).toBe(true)
  })

  it("reads runs_on's label: short form", () => {
    expect(labelFromRunsOn("label:gpu")).toBe("gpu")
    expect(labelFromRunsOn("ssh:Laptops")).toBe("laptops")
    expect(labelFromRunsOn("ssh")).toBeNull()
    expect(labelFromRunsOn("local")).toBeNull()
  })

  it("indexes labels to machines", () => {
    expect(labelIndex([{ name: "a", labels: ["gpu", "local"], enabled: true }, { name: "b", labels: ["local"], enabled: false }])).toEqual([
      { label: "gpu", machines: ["a"] },
      { label: "local", machines: ["a", "b"] },
    ])
  })

  it("takes SSH keys by reference only", () => {
    expect(parseKeyRef("file:~/.ssh/laptop")).toBe("file:~/.ssh/laptop")
    expect(parseKeyRef("agent")).toBe("agent")
    expect(parseKeyRef("default")).toBe("default")
    expect(parseKeyRef("agent:SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")).toBe("agent:SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")
    expect(parseKeyRef("-----BEGIN OPENSSH PRIVATE KEY-----\nabc")).toBeNull()
    expect(parseKeyRef("agent:nope")).toBeNull()
  })

  it("has a virtual box per machine that placement names", () => {
    const id = machineBoxId("mch_abc123")
    expect(id).toBe("ssh-mch_abc123")
    expect(isMachineBox(id)).toBe(true)
    expect(isMachineBox("pure-lobster")).toBe(false)
    expect(machineOfBox(id)).toBe("mch_abc123")
    expect(placeKindOf(id)).toBe("ssh")
    expect(placeLabel({ kind: "ssh", boxId: id, machine: "old-thinkpad" })).toBe("SSH · old-thinkpad")
  })

  it("says why a machine can't take tasks", () => {
    expect(machineProblem({ enabled: false, lastTest: null })).toBe("it's turned off")
    expect(machineProblem({ enabled: true, lastTest: null })).toBe("it hasn't been tested yet")
  })
})

describe("pickMachine", () => {
  it("takes the least busy free machine with the label", () => {
    const machines = [m("a", { labels: ["gpu"], running: 1 }), m("b", { labels: ["laptops"] }), m("c", { labels: ["laptops"], running: 1 }), m("d", { labels: ["laptops"] })]
    expect(pick(machines, { label: "laptops" })).toEqual({ machineId: "b", moved: false })
    expect(pick(machines, { label: "gpu" })).toEqual({ machineId: "a", moved: false })
    // No label: any machine, the least busy (ties by name).
    expect(pick(machines)).toEqual({ machineId: "b", moved: false })
  })

  it("matches a machine by its name too", () => {
    expect(pick([m("a", { name: "tower" }), m("b", { name: "laptop" })], { label: "tower" })).toEqual({ machineId: "a", moved: false })
  })

  it("queues when every matching machine is busy, naming them", () => {
    const p = pick([m("a", { labels: ["laptops"], running: 2 }), m("b", { labels: ["laptops"], maxTasks: 1, running: 1 }), m("c", { labels: ["gpu"] })], { label: "laptops" })
    expect(p).toEqual({ kind: "busy", wait: 'Waiting for a free slot on SSH machines labelled "laptops" (a: 2 of 2 running, b: 1 of 1 running)' })
  })

  it("respects a project's limit on a machine (agents_per_box, whole_machine)", () => {
    const p = pick([m("a", { blocked: "its project's Tasks running at once (1) is reached on a" }), m("b", { running: 1 })])
    expect(p).toEqual({ machineId: "b", moved: false })
    const all = pick([m("a", { blocked: "another project has the whole machine" })])
    expect(all).toMatchObject({ kind: "busy", wait: expect.stringContaining("another project has the whole machine") })
  })

  it("waits with a reason when no machine has the label, or they're off", () => {
    expect(pick([m("a", { labels: ["gpu"] })], { label: "laptops" })).toEqual({ kind: "none", wait: 'Waiting: no SSH machine has the label "laptops": add one, or label one, in Settings › Machines' })
    expect(pick([], {})).toMatchObject({ kind: "none", wait: "Waiting: no SSH machine is set up: add one in Settings › Machines" })
    expect(pick([m("a", { labels: ["gpu"], enabled: false })], { label: "gpu" })).toMatchObject({ kind: "none", wait: expect.stringContaining("turned off (a)") })
  })

  it("skips machines that can't take tasks (offline, missing node)", () => {
    expect(pick([m("a", { problem: "offline" }), m("b", { running: 1 })])).toEqual({ machineId: "b", moved: false })
    expect(pick([m("a", { problem: "offline" })])).toMatchObject({ kind: "unusable", wait: expect.stringContaining("a: offline") })
  })

  it("needs a Claude login: the machine's own, or a key Box Yard forwards", () => {
    const machines = [m("a", { claudeLogin: false }), m("b", { claudeLogin: null, running: 1 }), m("c", { claudeLogin: true, running: 1 })]
    expect(pick(machines)).toEqual({ machineId: "c", moved: false })
    expect(pick(machines, { claudeKey: true })).toEqual({ machineId: "a", moved: false })
    expect(pick([m("a", { claudeLogin: false })])).toMatchObject({ kind: "claude" })
  })

  it("never gives a Codex task a machine: it waits, saying Codex isn't supported there yet", () => {
    const codex = { kind: "codex", wait: "Waiting: Codex isn't supported on SSH machines yet: move it to another runner (Runs on)" }
    expect(pick([m("a")], { cli: "codex", claudeKey: true })).toEqual(codex)
    expect(pick([m("a")], { cli: "codex", current: "a", canMove: false })).toEqual(codex)
    expect(pick([m("a")], { cli: "claude" })).toEqual({ machineId: "a", moved: false })
  })

  it("stays on its machine while it has room, and moves when it's busy and nothing would be lost", () => {
    const machines = [m("a", { running: 1 }), m("b")]
    expect(pick(machines, { current: "a" })).toEqual({ machineId: "a", moved: false })
    const full = [m("a", { running: 2 }), m("b")]
    expect(pick(full, { current: "a" })).toEqual({ machineId: "b", moved: true })
  })

  it("waits for its own machine when its workspace can't move", () => {
    const full = [m("a", { running: 2 }), m("b")]
    expect(pick(full, { current: "a", canMove: false })).toEqual({ kind: "busy", wait: "Waiting for a free slot on a, where its workspace is (2 of 2 running)" })
    // Even when its label no longer matches, or the machine is down: the work there would be lost.
    expect(pick([m("a", { labels: ["old"] }), m("b", { labels: ["new"] })], { label: "new", current: "a", canMove: false })).toEqual({ machineId: "a", moved: false })
    expect(pick([m("a", { problem: "offline" }), m("b")], { current: "a", canMove: false })).toMatchObject({ kind: "unusable", wait: expect.stringContaining("a, where its workspace is") })
  })

  it("leaves a machine whose label no longer matches when it can move", () => {
    expect(pick([m("a", { labels: ["old"] }), m("b", { labels: ["new"] })], { label: "new", current: "a" })).toEqual({ machineId: "b", moved: true })
  })
})

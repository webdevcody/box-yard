// Settings › Machines' form and how a machine's last test reads (web/src/lib/machines.ts).
import { describe, expect, it } from "vitest"
import { draftOf, EMPTY_MACHINE, hardwareLine, hostKeyChanged, machineAddress, machineInput, machinePatch, toolList } from "../web/src/lib/machines"
import { failedTest, parseProbe, testFromProbe } from "../server/machines/probe"
import { sshError } from "../server/machines/ssh"
import type { Machine } from "../shared/machines"

const saved: Machine = {
  id: "mch_1",
  name: "old-thinkpad",
  host: "thinkpad.lan",
  user: "cody",
  port: 22,
  keyRef: "file:~/.ssh/id_ed25519",
  maxTasks: 1,
  labels: ["laptops"],
  dir: "~/boxyard",
  enabled: true,
  lastTest: null,
  createdAt: 1,
  updatedAt: 1,
}

describe("the machine form", () => {
  it("sends what was typed, trimmed, with labels normalized", () => {
    const d = { ...EMPTY_MACHINE, name: " old-thinkpad ", host: "thinkpad.lan", user: "cody", labels: "Laptops, GPU box, laptops", maxTasks: "2", dir: " " }
    expect(machineInput(d)).toEqual({ name: "old-thinkpad", host: "thinkpad.lan", user: "cody", port: 22, keyRef: "file:~/.ssh/id_ed25519", maxTasks: 2, labels: ["laptops", "gpu-box"], dir: "~/boxyard", enabled: true })
  })

  it("says which field is wrong", () => {
    expect(() => machineInput({ ...EMPTY_MACHINE, host: "h", user: "u" })).toThrow("Name is required.")
    expect(() => machineInput({ ...EMPTY_MACHINE, name: "n", host: "h", user: "u", port: "22.5" })).toThrow("Port needs a whole number.")
    expect(() => machineInput({ ...EMPTY_MACHINE, name: "n", host: "h", user: "u", maxTasks: "" })).toThrow("Tasks running at once needs a whole number.")
  })

  it("saves only what changed", () => {
    expect(machinePatch(draftOf(saved), saved)).toEqual({})
    expect(machinePatch({ ...draftOf(saved), labels: "laptops, local", maxTasks: "3", enabled: false }, saved)).toEqual({ labels: ["laptops", "local"], maxTasks: 3, enabled: false })
  })

  it("shows the address with a port only when it isn't 22", () => {
    expect(machineAddress(saved)).toBe("cody@thinkpad.lan")
    expect(machineAddress({ ...saved, port: 2222 })).toBe("cody@thinkpad.lan:2222")
  })
})

describe("a machine's last test", () => {
  const test = testFromProbe({
    first: parseProbe("BOXYARD_PROBE\nuname=Linux 6.8 x86_64\nosname=Ubuntu 24.04 LTS\ncpus=4\nmem=8589934592\nworkdir=/home/c/boxyard\ndisk=107374182400 214748364800\n"),
    tools: parseProbe('BOXYARD_PROBE\npath_git=/usr/bin/git\nversion_git=git version 2.43.0\npath_node=/usr/bin/node\nversion_node=v20.11.1\npath_claude=/usr/bin/claude\nversion_claude=2.0.14 (Claude Code)\nclaude_auth="loggedIn": false\npath_codex=/usr/bin/codex\nversion_codex=codex-cli 0.40.0\n'),
    pathDirs: [],
    latencyMs: 1,
    at: 1,
  })

  it("reads as one hardware line", () => {
    expect(hardwareLine(test)).toMatch(/^Ubuntu 24.04 LTS · 4 CPUs · 8(\.0)? GB RAM · 100(\.0)? GB free$/)
    expect(hardwareLine(failedTest("x", 1))).toBe("")
  })

  it("lists each tool, claude's login, and codex as found but not used", () => {
    expect(toolList(test)).toEqual([
      { name: "git", text: "2.43.0", ok: true },
      { name: "node", text: "20.11.1", ok: true },
      { name: "claude", text: "2.0.14, not logged in", ok: null },
      { name: "codex", text: "0.40.0 (not used)", ok: null },
    ])
    expect(toolList(failedTest("x", 1)).map((t) => t.text)).toEqual(["missing", "missing", "missing", "not installed"])
  })

  it("offers Forget host key only when ssh refused a changed host key", () => {
    const changed = sshError("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.")
    expect(hostKeyChanged({ problem: null, lastTest: failedTest(`Can't connect: ${changed}`, 1) })).toBe(true)
    expect(hostKeyChanged({ problem: `Box Yard can't reach it (${changed})`, lastTest: null })).toBe(true)
    expect(hostKeyChanged({ problem: null, lastTest: failedTest(`Can't connect: ${sshError("Connection refused")}`, 1) })).toBe(false)
    expect(hostKeyChanged({ problem: null, lastTest: null })).toBe(false)
  })
})

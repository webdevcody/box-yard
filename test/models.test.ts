import { afterEach, describe, expect, it } from "vitest"
import { ClaudeModels, probeCliModels } from "../server/claudeModels.js"
import { BUILTIN_MODELS, checkEffort, findModel, mergeCliModels, type CliModelInfo } from "../shared/models.js"
import { EFFORTS } from "../shared/types.js"
import { FAKE_CLAUDE } from "./helpers.js"

// The model list every model/effort picker shows, which effort levels each model takes, and the CLI's own list.

afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODELS
})

describe("the built-in model list", () => {
  it("has today's models first, every alias the CLI takes, and older models", () => {
    const ids = BUILTIN_MODELS.map((m) => m.id)
    expect(BUILTIN_MODELS.filter((m) => m.group === "latest").map((m) => m.id)).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])
    expect(ids).toEqual(expect.arrayContaining(["opus", "sonnet", "haiku", "fable", "best", "opusplan", "opus[1m]", "sonnet[1m]", "fable[1m]", "opusplan[1m]"]))
    expect(ids).toEqual(expect.arrayContaining(["claude-opus-4-6[1m]", "claude-sonnet-4-6[1m]", "claude-opus-4-1", "claude-haiku-4-5"]))
    expect(new Set(ids).size).toBe(ids.length)
    // Every id passes the Settings / routing model check.
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._:\[\]/-]+$/)
  })

  it("finds a dated id by its short one", () => {
    expect(findModel(BUILTIN_MODELS, "claude-sonnet-4-5-20250929")?.label).toBe("Sonnet 4.5")
    expect(findModel(BUILTIN_MODELS, "claude-opus-4-6[1m]")?.label).toBe("Opus 4.6 [1m]")
    expect(findModel(BUILTIN_MODELS, "my-proxy-model")).toBeUndefined()
  })
})

describe("checkEffort", () => {
  it("passes what a model takes, and anything for a model it doesn't know", () => {
    for (const e of EFFORTS) expect(checkEffort(BUILTIN_MODELS, "claude-opus-5-5", e)).toEqual({ ok: true })
    expect(checkEffort(BUILTIN_MODELS, "my-proxy-model", "xhigh")).toEqual({ ok: true })
    expect(checkEffort(BUILTIN_MODELS, "claude-opus-4-6", "max")).toEqual({ ok: true })
  })

  it("says what the CLI runs instead: the highest level the model takes below it, or none", () => {
    expect(checkEffort(BUILTIN_MODELS, "claude-opus-4-6", "xhigh")).toEqual({ ok: false, runsAs: "high", message: "Opus 4.6 has no Extra high effort, so the CLI runs it at High." })
    expect(checkEffort(BUILTIN_MODELS, "claude-sonnet-4-6[1m]", "xhigh")).toMatchObject({ ok: false, runsAs: "high" })
    expect(checkEffort(BUILTIN_MODELS, "claude-haiku-4-5", "low")).toEqual({ ok: false, runsAs: null, message: "Haiku 4.5 takes no effort level, so the CLI sends none." })
  })
})

describe("mergeCliModels", () => {
  const all = [...EFFORTS]
  it("takes the CLI's effort levels and what each alias runs on now, and leaves out default", () => {
    const rows: CliModelInfo[] = [
      { value: "default", resolvedModel: "claude-opus-5-5", supportsEffort: true, supportedEffortLevels: all },
      { value: "opus", resolvedModel: "claude-opus-5-5", supportsEffort: true, supportedEffortLevels: all },
      { value: "best", resolvedModel: "claude-fable-5-1", supportsEffort: true, supportedEffortLevels: all },
      { value: "haiku", resolvedModel: "claude-haiku-5-5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
    ]
    const merged = mergeCliModels(BUILTIN_MODELS, rows)
    expect(merged.some((m) => m.id === "default")).toBe(false)
    expect(findModel(merged, "opus")?.note).toBe("Opus 5.5 now")
    expect(findModel(merged, "best")?.note).toBe("Fable where your account has it, else Opus (Fable 5.1 now)")
    expect(findModel(merged, "haiku")?.efforts).toEqual(["low", "medium", "high"])
    expect(merged).toHaveLength(BUILTIN_MODELS.length)
    // The built-in list isn't changed.
    expect(findModel(BUILTIN_MODELS, "haiku")?.efforts).toEqual(all)
  })

  it("adds a model or alias it doesn't know: an id to Latest, an alias to Aliases", () => {
    const merged = mergeCliModels(BUILTIN_MODELS, [
      { value: "sonnet", resolvedModel: "claude-sonnet-6", supportsEffort: true, supportedEffortLevels: all },
      { value: "claude-haiku-6", supportsEffort: false },
      { value: "turbo", displayName: "Turbo", resolvedModel: "claude-opus-5-5", supportsEffort: true },
    ])
    expect(merged.filter((m) => m.group === "latest").map((m) => m.id)).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-6", "claude-haiku-6"])
    expect(findModel(merged, "claude-sonnet-6")).toMatchObject({ label: "Sonnet 6", efforts: all })
    expect(findModel(merged, "claude-haiku-6")).toMatchObject({ label: "Haiku 6", efforts: [] })
    expect(findModel(merged, "turbo")).toMatchObject({ group: "alias", note: "Opus 5.5 now", efforts: all })
    expect(findModel(merged, "sonnet")?.note).toBe("Sonnet 6 now")
  })
})

describe("the CLI's own list", () => {
  it("is read from fake claude's initialize response", async () => {
    const rows = await probeCliModels(FAKE_CLAUDE, process.env)
    expect(rows.map((r) => r.value)).toEqual(["default", "opus", "fable", "sonnet", "haiku"])
  })

  it("fails with the reason when claude can't say", async () => {
    process.env.FAKE_CLAUDE_MODELS = "fail"
    await expect(probeCliModels(FAKE_CLAUDE, process.env)).rejects.toThrow(/claude exited \(1\) before listing its models/)
    await expect(probeCliModels("/nonexistent/claude", process.env)).rejects.toThrow(/couldn't run claude/)
  })

  it("is cached, asked once at a time, retried sooner after a failure, and kept over the built-in one", async () => {
    let now = 0
    let calls = 0
    let fail = false
    const models = new ClaudeModels({
      claudeBin: "claude",
      env: () => ({}),
      version: async () => "2.1.293 (Claude Code)",
      now: () => now,
      probe: async () => {
        calls++
        if (fail) throw new Error("not today")
        return [{ value: "opus", resolvedModel: "claude-opus-5-5", supportsEffort: true }]
      },
    })
    const [a, b] = await Promise.all([models.get(), models.get()])
    expect(calls).toBe(1)
    expect(a).toBe(b)
    expect(a).toMatchObject({ source: "cli", cliVersion: "2.1.293 (Claude Code)", fetchedAt: 0 })
    now = 60 * 60_000
    await models.get()
    expect(calls).toBe(1)
    fail = true
    expect((await models.get(true)).source).toBe("cli")
    expect(calls).toBe(2)

    const fresh = new ClaudeModels({ claudeBin: "claude", env: () => ({}), version: async () => null, now: () => now, probe: async () => (calls++, Promise.reject(new Error("not today"))) })
    expect(await fresh.get()).toMatchObject({ source: "builtin", error: "not today" })
    now += 5 * 60_000
    await fresh.get()
    expect(calls).toBe(3)
    now += 6 * 60_000
    await fresh.get()
    expect(calls).toBe(4)
  })
})

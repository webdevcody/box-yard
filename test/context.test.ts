import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore, autocompactFlag, compactThreshold } from "../server/settings.js"
import { contextTokens, contextWindowOf, formatTokens, parseContextReport } from "../server/usage.js"
import {
  SUMMARY_PROMPT,
  cleanSummary,
  compactionStamp,
  compactionsPrompt,
  finishCompaction,
  lastCompaction,
  listCompactions,
  summaryLooksValid,
  writeCompaction,
} from "../server/compactions.js"
import { tmpDir } from "./helpers.js"

const memStore = () => new Store(openDb(tmpDir(), ":memory:"))

describe("usage helpers", () => {
  it("counts the prompt side of the last call plus its output, not the turn total", () => {
    expect(contextTokens({ input_tokens: 10, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 4000, output_tokens: 500 })).toBe(84_510)
    expect(contextTokens({})).toBeNull()
    expect(contextTokens(undefined)).toBeNull()
  })
  it("reads the window from modelUsage", () => {
    expect(contextWindowOf({ "claude-opus-5-5": { contextWindow: 1_000_000 } })).toBe(1_000_000)
    expect(contextWindowOf({})).toBeNull()
  })
  it("parses the /context report", () => {
    expect(parseContextReport("## Context Usage\n\n**Model:** claude-opus-5-5  \n**Tokens:** 16.1k / 1m (2%)\n")).toEqual({ tokens: 16_100, window: 1_000_000 })
    expect(parseContextReport("Tokens: 84,000 / 200k")).toBeNull() // thousands separators aren't printed by the CLI; stay safe
    expect(parseContextReport("nothing here")).toBeNull()
  })
  it("formats tokens", () => {
    expect(formatTokens(84_000)).toBe("84k")
    expect(formatTokens(1_000_000)).toBe("1m")
    expect(formatTokens(512)).toBe("512")
  })
})

describe("settings", () => {
  it("defaults to opus 5.5 with high effort for both", () => {
    const s = new SettingsStore(memStore(), { orchestratorModel: "", workerModel: "" }).info()
    expect(s.settings.orchestratorModel).toBe("claude-opus-5-5")
    expect(s.settings.orchestratorEffort).toBe("high")
    expect(s.settings.agentModel).toBe("claude-opus-5-5")
    expect(s.settings.agentEffort).toBe("high")
    expect(s.settings.agentRoutingConfig).toBe("")
    expect(s.sources.agentModel).toBe("default")
  })
  it("env vars override the defaults, and values saved in the UI win over env vars", () => {
    const store = memStore()
    const settings = new SettingsStore(store, { orchestratorModel: "env-orch", workerModel: "env-worker" })
    expect(settings.info().settings.orchestratorModel).toBe("env-orch")
    expect(settings.info().sources.agentModel).toBe("env")
    settings.update({ agentModel: "ui-model", agentEffort: "orchestrator" })
    const info = settings.info()
    expect(info.settings.agentModel).toBe("ui-model")
    expect(info.settings.agentEffort).toBe("orchestrator")
    expect(info.sources.agentModel).toBe("ui")
    expect(info.settings.orchestratorModel).toBe("env-orch")
    // survives a new store object over the same database
    expect(new SettingsStore(store, { orchestratorModel: "", workerModel: "" }).get().agentModel).toBe("ui-model")
    settings.reset()
    expect(settings.info().settings.agentModel).toBe("env-worker")
  })
  it("saves routing YAML as a free-text setting", () => {
    const settings = new SettingsStore(memStore(), { orchestratorModel: "", workerModel: "" })
    const info = settings.update({ agentRoutingConfig: "fallback:\n  model: claude-sonnet-5-5\n  effort: medium\n" })
    expect(info.settings.agentRoutingConfig).toContain("fallback")
    expect(info.sources.agentRoutingConfig).toBe("ui")
  })
  it("rejects bad values", () => {
    const settings = new SettingsStore(memStore(), { orchestratorModel: "", workerModel: "" })
    expect(() => settings.update({ agentEffort: "turbo" })).toThrow()
    expect(() => settings.update({ orchestratorModel: "has space" })).toThrow()
    expect(() => settings.update({ orchestratorAutoCompact: { enabled: true, unit: "percent", value: 99 } })).toThrow(/10 and 95/)
    expect(() => settings.update({ agentAutoCompact: { enabled: true, unit: "tokens", value: 5000 } })).toThrow(/between/)
    expect(() => settings.update({ nope: 1 })).toThrow()
  })
  it("turns thresholds into tokens", () => {
    expect(compactThreshold({ enabled: false, unit: "percent", value: 80 }, 1_000_000)).toBeNull()
    expect(compactThreshold({ enabled: true, unit: "percent", value: 50 }, 200_000)).toBe(100_000)
    expect(compactThreshold({ enabled: true, unit: "tokens", value: 150_000 }, 1_000_000)).toBe(150_000)
    expect(autocompactFlag({ enabled: true, unit: "percent", value: 10 }, 200_000)).toBe("100000") // clamped up to the CLI's minimum
    expect(autocompactFlag({ enabled: false, unit: "percent", value: 50 }, null)).toBeNull()
  })
})

describe("compaction log", () => {
  it("names files so they sort chronologically", () => {
    expect(compactionStamp(Date.UTC(2026, 9, 22, 18, 40, 5, 321))).toBe("2026-10-22T18-40-05Z")
    expect(compactionStamp(Date.UTC(2026, 9, 22, 18, 40, 5))).toBe("2026-10-22T18-40-05Z")
  })
  it("writes frontmatter and sections, fills in tokens_after, and never overwrites", () => {
    const dir = path.join(tmpDir(), "orchestrator", "compactions")
    const meta = { at: Date.UTC(2026, 9, 22, 18, 40, 5), sessionId: "sess-1", model: "claude-opus-5-5", trigger: "auto" as const, tokensBefore: 412_000 }
    const summary = "## Decisions and preferences\n- short replies\n\n## Projects and repos\n- x\n\n## Ongoing work\n- none\n\n## Open threads and next steps\n- none"
    const file = writeCompaction(dir, meta, summary)
    expect(path.basename(file)).toBe("2026-10-22T18-40-05Z.md")
    const second = writeCompaction(dir, meta, summary)
    expect(path.basename(second)).toBe("2026-10-22T18-40-05Z-2.md")
    finishCompaction(file, 38_000)
    const text = fs.readFileSync(file, "utf8")
    expect(text).toMatch(/^---\ntimestamp: 2026-10-22T18:40:05Z\nsession_id: sess-1\nmodel: claude-opus-5-5\ntrigger: auto\ntokens_before: 412000\ntokens_after: 38000\n---/)
    for (const h of ["## Decisions and preferences", "## Projects and repos", "## Ongoing work", "## Open threads and next steps"]) expect(text).toContain(h)
    expect(listCompactions(dir)).toEqual(["2026-10-22T18-40-05Z-2.md", "2026-10-22T18-40-05Z.md"].sort())
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false)
    expect(lastCompaction(dir)).toMatchObject({ trigger: "auto", tokensBefore: 412_000 })
  })
  it("cleans and validates summaries", () => {
    expect(cleanSummary("Sure!\n\n## Decisions and preferences\n- a")).toBe("## Decisions and preferences\n- a")
    expect(cleanSummary("```markdown\n## Decisions and preferences\n- a\n```")).toBe("## Decisions and preferences\n- a")
    expect(summaryLooksValid("ok")).toBe(false)
    expect(summaryLooksValid(`## Decisions and preferences\n${"- a thing\n".repeat(10)}`)).toBe(true)
    expect(SUMMARY_PROMPT).toContain("## Open threads and next steps")
  })
  it("the prompt points at the folder, says it is chronological, and lists the newest files", () => {
    const dir = path.join(tmpDir(), "orchestrator", "compactions")
    expect(compactionsPrompt(dir)).toContain(dir)
    expect(compactionsPrompt(dir)).toMatch(/chronological/)
    expect(compactionsPrompt(dir)).toMatch(/newest first/)
    expect(compactionsPrompt(dir)).toContain("There are none yet")
    for (let i = 0; i < 7; i++) writeCompaction(dir, { at: Date.UTC(2026, 0, 1, 0, 0, i), sessionId: "s", model: "m", trigger: "button", tokensBefore: 1 }, "## Decisions and preferences\n- x")
    const p = compactionsPrompt(dir)
    expect(p).toContain("are 7 files")
    expect(p).toContain("2026-01-01T00-00-06Z.md")
    expect(p).not.toContain("2026-01-01T00-00-00Z.md")
  })
})

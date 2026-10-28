import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import { CLOUD_RAISE_KEY, cloudSpend, localDay, raiseToday, startOfLocalDay, todaysRaise } from "../server/cloudLimit.js"
import { tmpDir } from "./helpers.js"

// Settings › Daily cloud limit: what boxes may cost per day. At 80% a warning, at 100% new boxes wait (running work
// goes on), and "Raise today's limit" adds a day's worth until midnight.

const H = 3_600_000
const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const settingsOf = (store: Store, c: ConstructorParameters<typeof SettingsStore>[1] = {}) =>
  new SettingsStore(store, { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "", ...c })

/** Box spend: `usd` priced by the provider over the hour before `at`. */
function spend(store: Store, usd: number, at: number, boxId = "b") {
  store.recordBoxUsageInterval({ boxId, provider: "upstash", size: "small", keepAlive: false, startedAt: at - H, endedAt: at, activeMs: H, uptimeMs: H, source: "actual", computeUsd: usd })
}

describe("cloud spend", () => {
  it("defaults to a $10 daily limit, no monthly one, and a ceiling of 50 boxes", () => {
    const s = settingsOf(memStore()).get()
    expect(s.budget).toEqual({ dailyUsd: 10, monthlyUsd: 0 })
    expect(s.maxBoxes).toBe(50)
    expect(s.boxIdleDeleteMinutes).toBe(30)
  })

  it("warns from 80% of today's limit and blocks at it; yesterday's spend doesn't count", () => {
    const store = memStore()
    const rates = settingsOf(store).get().costRates
    const noon = startOfLocalDay(Date.now()) + 12 * H
    spend(store, 50, startOfLocalDay(noon) - H, "yesterday")
    const budget = { dailyUsd: 10, monthlyUsd: 0 }
    expect(cloudSpend(store, budget, rates, noon)).toMatchObject({ todayUsd: 0, state: "ok", blockedReason: null })
    spend(store, 8, noon)
    expect(cloudSpend(store, budget, rates, noon)).toMatchObject({ todayUsd: 8, dailyLimitUsd: 10, state: "warning", blockedReason: null })
    spend(store, 2.5, noon)
    expect(cloudSpend(store, budget, rates, noon)).toMatchObject({ state: "reached", blockedReason: "today's cloud spend is $10.50 of its $10 limit" })
    // No daily limit: never blocks.
    expect(cloudSpend(store, { dailyUsd: 0, monthlyUsd: 0 }, rates, noon)).toMatchObject({ dailyLimitUsd: 0, raiseToUsd: null, state: "ok" })
  })

  it("blocks on the monthly limit over the last 30 days", () => {
    const store = memStore()
    const rates = settingsOf(store).get().costRates
    const now = Date.now()
    spend(store, 40, now - 5 * 24 * H)
    const s = cloudSpend(store, { dailyUsd: 10, monthlyUsd: 40 }, rates, now)
    expect(s).toMatchObject({ todayUsd: 0, monthUsd: 40, state: "reached", blockedReason: "cloud spend over the last 30 days is $40 of its $40 monthly limit" })
  })

  it("raises today's limit by a day's worth past today's spend, until midnight", () => {
    const store = memStore()
    const rates = settingsOf(store).get().costRates
    const noon = startOfLocalDay(Date.now()) + 12 * H
    const budget = { dailyUsd: 10, monthlyUsd: 0 }
    spend(store, 12, noon) // boxes that ran on took it past the limit
    expect(cloudSpend(store, budget, rates, noon)).toMatchObject({ state: "reached", raiseToUsd: 22 })
    expect(raiseToday(store, budget, 12, noon)).toBe(12)
    expect(cloudSpend(store, budget, rates, noon)).toMatchObject({ dailyLimitUsd: 22, raisedUsd: 12, state: "ok", raiseToUsd: 32 })
    expect(raiseToday(store, budget, 12, noon)).toBe(22) // again: one more day's worth on top
    expect(todaysRaise(store, noon + 13 * H)).toBe(0) // tomorrow
    expect(JSON.parse(store.getKv(CLOUD_RAISE_KEY)!)).toEqual({ day: localDay(noon), usd: 22 })
    expect(raiseToday(store, { dailyUsd: 0, monthlyUsd: 0 }, 12, noon)).toBe(0)
    // Past the limit by cents: the raise starts from the next whole dollar.
    const other = memStore()
    spend(other, 10.13, noon)
    expect(cloudSpend(other, budget, rates, noon)).toMatchObject({ state: "reached", raiseToUsd: 21 })
    expect(raiseToday(other, budget, 10.13, noon)).toBe(11)
  })
})

describe("upgrade to the cloud limit", () => {
  it("drops a saved $0/$0 budget and a Max boxes under the ceiling, once, and keeps the rest", () => {
    const store = memStore()
    store.setKv("settings", JSON.stringify({ budget: { dailyUsd: 0, monthlyUsd: 0 }, maxBoxes: 5, slotsPerBox: 3 }))
    const settings = settingsOf(store)
    const changed = settings.upgradeForCloudLimit()
    expect(changed).toHaveLength(2)
    expect(changed[0]).toContain("Daily cloud limit: $10")
    expect(changed[1]).toContain("Max boxes was 5")
    expect(settings.get()).toMatchObject({ budget: { dailyUsd: 10, monthlyUsd: 0 }, maxBoxes: 50, slotsPerBox: 3 })
    expect(settings.info().sources).toMatchObject({ budget: "default", maxBoxes: "default", slotsPerBox: "ui" })
    // Once: what Cody sets afterwards stays.
    settings.update({ budget: { dailyUsd: 0, monthlyUsd: 0 }, maxBoxes: 4 })
    expect(settings.upgradeForCloudLimit()).toEqual([])
    expect(settings.get()).toMatchObject({ budget: { dailyUsd: 0, monthlyUsd: 0 }, maxBoxes: 4 })
  })

  it("keeps a budget or ceiling that was set on purpose", () => {
    const store = memStore()
    store.setKv("settings", JSON.stringify({ budget: { dailyUsd: 25, monthlyUsd: 0 }, maxBoxes: 60 }))
    const settings = settingsOf(store)
    expect(settings.upgradeForCloudLimit()).toEqual([])
    expect(settings.get()).toMatchObject({ budget: { dailyUsd: 25, monthlyUsd: 0 }, maxBoxes: 60 })
    expect(settingsOf(memStore()).upgradeForCloudLimit()).toEqual([])
  })
})

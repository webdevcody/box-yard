// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CloudMeter } from "../web/src/components/CloudMeter.js"
import { WaitFixButton } from "../web/src/components/WaitReason.js"
import { boxState, dollars, limitPct, meterLabel } from "../web/src/lib/cloud.js"
import { keys } from "../web/src/lib/queries.js"
import type { CloudBox, CloudStatus } from "../shared/types"

// The cloud meter on the Coordinator: boxes now, $/h and today's spend against the daily cloud limit; its sheet
// raises today's limit. A task the limit holds back offers the same raise.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MIN = 60_000
const now = Date.now()

function box(over: Partial<CloudBox> = {}): CloudBox {
  return { id: "box-1", status: "ready", size: "small", projects: ["web"], runningTurns: 0, todayUsd: 0.4, totalUsd: 2, idleSince: null, deletesAt: null, idleHeld: null, ...over }
}

function status(over: Partial<CloudStatus["spend"]> = {}, list: CloudBox[] = [box({ runningTurns: 2 }), box({ id: "box-2", idleSince: now - 18 * MIN, deletesAt: now + 12 * MIN })]): CloudStatus {
  return {
    spend: { todayUsd: 3.1, dailyLimitUsd: 10, raisedUsd: 0, raiseToUsd: 20, monthUsd: 3.1, monthlyLimitUsd: 0, state: "ok", blockedReason: null, source: "measured", ...over },
    hourlyUsd: 0.42,
    boxes: { running: 1, idle: 1, creating: 0, total: 2 },
    ceiling: 50,
    idleDeleteMinutes: 30,
    list,
    gpu: null,
  }
}

let root: Root
let host: HTMLElement
let requests: { method: string; url: string }[]
let replies: Record<string, unknown>

function render(el: ReturnType<typeof createElement>, cloud: CloudStatus) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.cloud, cloud)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, el)))
  return qc
}

beforeEach(() => {
  requests = []
  replies = {}
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    requests.push({ method, url })
    const reply = replies[`${method} ${url}`]
    if (!reply) return new Promise(() => {})
    return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } })
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

const chip = () => document.querySelector<HTMLButtonElement>("[data-testid=cloud-meter]")!
const sheet = () => document.querySelector<HTMLElement>("[data-testid=cloud-sheet]")
const raiseButton = () => document.querySelector<HTMLButtonElement>("[data-testid=raise-cloud-limit]")
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))

describe("cloud meter words", () => {
  it("formats money, the share of the limit and each box's state", () => {
    expect([dollars(10), dollars(3.1), dollars(0.004), dollars(0)]).toEqual(["$10", "$3.10", "<$0.01", "$0"])
    expect(limitPct(status().spend)).toBe(31)
    expect(limitPct(status({ todayUsd: 9.996 }).spend)).toBe(99) // not "100%" before the limit
    expect(limitPct(status({ dailyLimitUsd: 0 }).spend)).toBeNull()
    expect(boxState(box({ runningTurns: 2 }), now).text).toBe("Running 2 turns")
    expect(boxState(box({ deletesAt: now + 12 * MIN }), now).text).toBe("Idle, deleted in 12 min")
    expect(boxState(box({ deletesAt: now + 75 * MIN }), now).text).toBe("Idle, deleted in 1 h 15 min")
    expect(boxState(box({ deletesAt: now + 12 * MIN, idleHeld: "its workspace archive failed; retrying" }), now)).toEqual({ text: "Idle, kept: its workspace archive failed; retrying", tone: "held" })
    expect(boxState(box({ status: "creating" }), now).text).toBe("Starting")
  })
})

describe("cloud meter", () => {
  it("reads boxes, $/h and today against the limit, and opens a sheet with every box", () => {
    render(createElement(CloudMeter, { variant: "inline" }), status())
    expect(chip().dataset.state).toBe("ok")
    expect(chip().getAttribute("aria-label")).toBe(meterLabel(status()))
    expect(chip().getAttribute("aria-label")).toBe("Cloud boxes: 1 running · 1 idle · $0.42/h now · $3.10 of $10 today's cloud limit")
    // Every tier is in the DOM; the header's width (a container query) shows one.
    expect([...chip().querySelectorAll("span")].map((e) => e.textContent)).toEqual(["$3.10 of $10 · 2 boxes · $0.42/h", "$3.10 of $10 · 2 boxes", "$3.10/$10 · 2"])
    act(() => chip().click())
    expect(sheet()).not.toBeNull()
    const rows = [...document.querySelectorAll("[data-testid=cloud-box]")].map((r) => r.textContent)
    expect(rows[0]).toContain("Running 2 turns")
    expect(rows[1]).toContain("Idle, deleted in 12 min")
    expect(document.querySelector("[role=meter]")?.getAttribute("aria-valuenow")).toBe("3.1")
    expect(sheet()!.textContent).toContain("31% used · $6.90 left until midnight")
    expect(sheet()!.textContent).toContain("up to 50 boxes at once")
    expect(raiseButton()).toBeNull() // nothing to raise at 31%
  })

  it("at the limit says new boxes wait and raises today's limit in one click", async () => {
    const reached = status({ todayUsd: 10.02, state: "reached", blockedReason: "today's cloud spend is $10.02 of its $10 limit", raiseToUsd: 20.02 })
    render(createElement(CloudMeter, { variant: "inline" }), reached)
    expect(chip().dataset.state).toBe("reached")
    expect(chip().getAttribute("aria-label")).toContain("New boxes wait")
    act(() => chip().click())
    expect(document.querySelector("[data-testid=cloud-reached]")!.textContent).toContain("New boxes wait: today's cloud spend is $10.02 of its $10 limit. Work already running goes on.")
    expect(raiseButton()!.textContent).toBe("Raise today's limit to $20.02")
    replies["POST /api/cloud/raise"] = status({ todayUsd: 10.02, dailyLimitUsd: 20.02, raisedUsd: 10.02, raiseToUsd: 30.02, state: "ok" })
    act(() => raiseButton()!.click())
    await settle()
    expect(requests).toContainEqual({ method: "POST", url: "/api/cloud/raise" })
    expect(chip().dataset.state).toBe("ok")
    expect(sheet()!.textContent).toContain("raised $10.02 today")
  })

  it("offers the monthly limit's settings, not a raise, when the 30-day limit holds new boxes", () => {
    render(createElement(CloudMeter, { variant: "inline" }), status({ monthUsd: 40, monthlyLimitUsd: 40, state: "reached", blockedReason: "cloud spend over the last 30 days is $40 of its $40 monthly limit" }))
    act(() => chip().click())
    expect(raiseButton()).toBeNull()
    expect(document.querySelector("[data-testid=cloud-reached]")!.textContent).toContain("Change the monthly limit")
  })

  it("without a daily limit shows today's spend and says so", () => {
    render(createElement(CloudMeter, { variant: "inline" }), status({ dailyLimitUsd: 0, raiseToUsd: null }, []))
    expect(chip().textContent).toContain("$3.10 today · 2 boxes")
    act(() => chip().click())
    expect(sheet()!.textContent).toContain("No daily cloud limit")
    expect(sheet()!.textContent).toContain("No boxes right now")
  })
})

describe("a task waiting on the cloud limit", () => {
  it("offers Raise today's limit, and nothing for other waits", async () => {
    replies["POST /api/cloud/raise"] = status()
    render(createElement(WaitFixButton, { task: { waitFix: "raise-cloud-limit" } }), status())
    const fix = document.querySelector<HTMLButtonElement>("[data-testid=wait-fix]")!
    expect(fix.textContent).toBe("Raise today's limit")
    act(() => fix.click())
    await settle()
    expect(requests).toContainEqual({ method: "POST", url: "/api/cloud/raise" })
    render(createElement(WaitFixButton, { task: { waitFix: null } }), status())
    expect(document.querySelector("[data-testid=wait-fix]")).toBeNull()
  })
})

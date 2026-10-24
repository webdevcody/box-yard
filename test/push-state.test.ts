import { describe, expect, it } from "vitest"
import { pushStateLine } from "../web/src/lib/pushState"
import type { PushState } from "../shared/types"

const state = (over: Partial<PushState>): PushState => ({ status: "pushed", at: 1, branch: "boxyard/x", head: "c".repeat(40), wip: null, reason: null, ...over })

describe("pushStateLine", () => {
  it("says whether uncommitted work went along", () => {
    expect(pushStateLine(state({ wip: "a".repeat(40) }))).toEqual({ text: "Pushed, with uncommitted work on a hidden ref", tone: "ok" })
    expect(pushStateLine(state({}))).toEqual({ text: "Pushed, nothing uncommitted", tone: "ok" })
  })

  it("names why it wasn't pushed, quietly for a skip and as a warning for a failure", () => {
    expect(pushStateLine(state({ status: "skipped", reason: "no write access to origin (Permission denied)" }))).toEqual({
      text: "Not pushed: no write access to origin (Permission denied). Archives keep the whole workspace.",
      tone: "muted",
    })
    expect(pushStateLine(state({ status: "failed", reason: "git push: timeout" }))).toEqual({ text: "Push failed: git push: timeout. Archives keep the whole workspace.", tone: "warn" })
    expect(pushStateLine(state({ status: "failed" })).text).toBe("Push failed. Archives keep the whole workspace.")
  })
})

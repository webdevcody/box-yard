import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { BoxHistory } from "../server/boxHistory.js"
import { BOX_HISTORY_MAX_DAYS, BOX_HISTORY_MAX_ROWS, boxActorLabel } from "../shared/boxHistory.js"
import { tmpDir } from "./helpers.js"

const DAY = 24 * 3600_000

describe("BoxHistory", () => {
  it("filters by box (both boxes of a resize), type, actor and a Captain's project", () => {
    const h = new BoxHistory(openDb(tmpDir(), ":memory:"))
    h.add({ boxId: "box-a", type: "created", actor: { kind: "scheduler" }, projects: [{ id: "prj_alpha1", name: "alpha" }] })
    h.add({ boxId: "box-b", type: "created", actor: { kind: "resize" }, relatedBoxId: "box-a", projects: [{ id: "prj_alpha1", name: "alpha" }] })
    h.add({ boxId: "box-c", type: "created", actor: { kind: "scheduler" }, projects: [{ id: "prj_beta01", name: "beta" }] })
    h.add({ boxId: "box-c", type: "resized", actor: { kind: "captain", projectId: "prj_alpha1" }, reason: "  more room  " })

    expect(h.list({ boxId: "box-a" }).map((e) => e.boxId)).toEqual(["box-b", "box-a"])
    expect(h.list({ type: "resized" })).toMatchObject([{ actor: "captain", actorProjectId: "prj_alpha1", reason: "more room" }])
    expect(h.list({ actor: "resize" }).map((e) => e.boxId)).toEqual(["box-b"])
    // A Captain's project: its boxes, plus what its Captain did elsewhere.
    expect(h.list({ projectId: "prj_alpha1" }).map((e) => [e.boxId, e.type])).toEqual([
      ["box-c", "resized"],
      ["box-b", "created"],
      ["box-a", "created"],
    ])
    expect(h.list({ projectId: "prj_beta01" }).map((e) => e.boxId)).toEqual(["box-c"])
    expect(h.boxIds()).toEqual(["box-c", "box-b", "box-a"])
    expect(h.boxIds("prj_beta01")).toEqual(["box-c"])
  })

  it("keeps rows bounded: older than the max age and beyond the row cap go", () => {
    const h = new BoxHistory(openDb(tmpDir(), ":memory:"))
    const now = Date.now()
    h.add({ boxId: "old", type: "deleted", actor: { kind: "owner" }, at: now - (BOX_HISTORY_MAX_DAYS + 1) * DAY })
    h.add({ boxId: "recent", type: "created", actor: { kind: "scheduler" }, at: now - DAY })
    expect(h.list().map((e) => e.boxId)).toEqual(["recent"])

    for (let i = 0; i < BOX_HISTORY_MAX_ROWS + 5; i++) h.add({ boxId: `b${i}`, type: "cleanup", actor: { kind: "janitor" }, at: now })
    const count = (h as unknown as { db: { prepare(sql: string): { get(): { n: number } } } }).db.prepare("SELECT COUNT(*) AS n FROM box_events").get().n
    expect(count).toBe(BOX_HISTORY_MAX_ROWS)
    expect(h.list({ limit: 1 })[0]!.boxId).toBe(`b${BOX_HISTORY_MAX_ROWS + 4}`)
  })

  it("labels actors", () => {
    expect(boxActorLabel({ actor: "owner", actorProjectId: null })).toBe("Cody")
    expect(boxActorLabel({ actor: "captain", actorProjectId: "prj_alpha1" }, () => "alpha")).toBe("The alpha Captain")
    expect(boxActorLabel({ actor: "captain", actorProjectId: "prj_gone01" }, () => undefined)).toBe("The prj_gone01 Captain")
    expect(boxActorLabel({ actor: "resize-cleanup", actorProjectId: null })).toBe("Failed-resize cleanup")
  })
})

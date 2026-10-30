import { describe, expect, it } from "vitest"
import { closingRefs, issueCloseEvent } from "../server/mergeFollowUp.js"

// Which issues a merged PR names with GitHub's closing keywords (server/mergeFollowUp.ts). The end-to-end side,
// closing them on GitHub, is in merge-follow-up.e2e.test.ts.

describe("closingRefs", () => {
  it("reads every closing keyword, any case, with or without a colon", () => {
    const text = "close #1, closes #2, closed #3, fix #4, FIXES #5, Fixed #6, resolve #7, resolves: #8, Resolved #9"
    expect(closingRefs(text).map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it("keeps the repo of a cross-repo or URL reference, and dedupes", () => {
    expect(closingRefs("Fixes acme/site#4 and fixes https://github.com/acme/other/issues/5. Fixes #4, fixes #4.")).toEqual([
      { repo: "acme/site", number: 4 },
      { repo: "acme/other", number: 5 },
      { repo: null, number: 4 },
    ])
  })

  it("skips mentions without a keyword, words that only contain one, and code or comments", () => {
    const text = [
      "Mentions #1. Prefixes #2. Fixes#3. Fixes #4abc. Fixes #5/6.",
      "`fixes #7` inline",
      "<!-- closes #8 -->",
      "```",
      "fixes #9",
      "```",
      "Closes #10",
    ].join("\n")
    expect(closingRefs(text)).toEqual([{ repo: null, number: 10 }])
  })
})

describe("issueCloseEvent", () => {
  const url = "https://github.com/acme/site/pull/40"
  it("says nothing for a default-branch merge or a PR that names no issues", () => {
    expect(issueCloseEvent(url, { base: "main", defaultBranch: true, closed: [], skipped: [] })).toBeNull()
    expect(issueCloseEvent(url, { base: "epic", defaultBranch: false, closed: [], skipped: [] })).toBeNull()
  })

  it("names what it closed and what it left alone", () => {
    expect(issueCloseEvent(url, { base: "epic", defaultBranch: false, closed: [5], skipped: ["#9 (already closed)"] })).toBe(
      "Closed issue #5: PR #40 names it and merged into epic, where GitHub doesn't close it itself. Left alone: #9 (already closed).",
    )
    expect(issueCloseEvent(url, { base: "epic", defaultBranch: false, closed: [], skipped: ["#9 (already closed)"] })).toBe(
      "PR #40 merged into epic, and closed no issues. Left alone: #9 (already closed).",
    )
  })
})

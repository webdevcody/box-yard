<!-- 02 · Before / After — the change replaces something visible: a layout, a key, a status colour.
     Every change is a row with both states; every screenshot is a pair. -->

<One sentence: what was replaced, and the one-clause reason.>

**Contents:** [🔁 Before / After](#user-content-before-after) · [📸 Screenshots](#user-content-screenshots) · [🧭 What moved](#user-content-what-moved) · [⚠️ Risk](#user-content-risk) · [🔧 Technical overview](#user-content-technical-overview) · [📝 Notes](#user-content-notes)

## 🔁 Before / After <a id="before-after"></a>

| | Before | After |
|---|---|---|
| **<Thing one>** | <what it did — one clause> | <what it does now — one clause, the key in backticks> |
| **<Thing two>** | <…> | <…> |
| **<Thing three>** | <…> | <…> |
| **Unchanged** | <what the user liked and still has — say it, so the reviewer knows you kept it> | same |

## 📸 Screenshots <a id="screenshots"></a>

| Before | After |
|---|---|
| ![<alt: … before>](<artifact-or-url>/<thing-one>-before.png) | ![<alt: … after>](<artifact-or-url>/<thing-one>-after.png) |
| ![<alt>](<artifact-or-url>/<thing-two>-before.png) | ![<alt>](<artifact-or-url>/<thing-two>-after.png) |

<!-- The "before" shot comes from an origin/main build in the screenshot/proof workflow; same size, same demo data, same cursor position. -->

## 🧭 What moved <a id="what-moved"></a>

```mermaid
flowchart TB
  subgraph Before
    a1["old thing"] --> a2["old result"]
  end
  subgraph After
    b1["new thing"] --> b2["new result"]
  end
  a1 -. replaced by .-> b1
  classDef gone fill:#fecaca,stroke:#991b1b,color:#111
  classDef new fill:#bbf7d0,stroke:#166534,color:#111
  class a1,a2 gone
  class b1,b2 new
```

## ⚠️ Risk <a id="risk"></a>

<!-- Only when the change ADDS A SURFACE — the server execs a program, opens a socket, route or
     HTTP request, reads a new config source, writes a file it did not before. One bullet per way
     in: who or what reaches it, what holds it, what does not. The 🔒 row below then rates the
     residue. A PR that adds no surface deletes this subsection. -->
### 🎯 Attack surface <a id="attack-surface"></a>

- **<Way in>.** <Who or what reaches it. Held by: <mitigation>. Not held: <what remains>.>
- **<Way in>.** <…>

**Verdict:** <🟢 Low risk · 🟡 Merge with care · 🔴 Do not merge as-is — pick one, then one clause saying why. The author's own read; the PR REVIEWER SKILL checks it against the diff.>

| | Level | Why |
|---|---|---|
| 🔒 **Security & production** | <Low / Medium / High> | <who can reach the new code and what it reaches — a new `HTTP request`, a hook route, a shell call, a token, a file the server writes — or "no new surface: <why>"> |
| ⚡ **Performance** | <Low / Medium / High> | <the hot path touched — the web app draw, the event-loop drain, the worker log path, the scheduler/maintenance tick — or "off every hot path: <why>"> |
| 🧩 **Fit with the codebase** | <Low / Medium / High> | <the existing pattern it follows, or the departure and why> |

**Rollback:** <one line — `git revert <merge>`, plus what the revert does not undo: a schema/config change, a migrated SQLite store, a pushed branch.>

## 🔧 Technical overview <a id="technical-overview"></a>

- **What actually changed.** <The mechanism in three sentences; name the type, the flag, the function that moved.>
- **Files.** `server/<file>.ts or web/src/<file>.tsx` — <clause>; `server/<file>.ts or web/src/<file>.tsx` — <clause>.
- **Kept as-is on purpose.** <The behaviour the change stops short of, and why.>
- **Gate.** <`npm test` and `npm run typecheck` green; or what did not run and why.>

## 📝 Notes <a id="notes"></a>

- <Merge state and conflicts.>
- <Upgrade note, if any.>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<optional session link; delete this line when none is provided>

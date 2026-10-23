<!-- 06 · User journey — the change is a sequence of things the user does and sees.
     One numbered step per action, a screenshot per step, the diagram is the same sequence from the inside. -->

<One sentence: the journey this PR adds or changes, from the first key to the last screen.>

**Contents:** [🪜 The journey](#user-content-the-journey) · [📸 Screenshots](#user-content-screenshots) · [🧭 Under the hood](#user-content-under-the-hood) · [⚠️ Risk](#user-content-risk) · [🔧 Technical overview](#user-content-technical-overview) · [📝 Notes](#user-content-notes)

## 🪜 The journey <a id="the-journey"></a>

1. **You press `<key>`** in the <PANEL>. <What appears, one clause.>
2. **You <type / pick / confirm>.** <What the screen does, one clause.>
3. **The <task / box / workspace / …> <starts / moves / finishes>.** <The status you see and when.>
4. **You come back later.** <What has changed on screen without you — the badge, the sort, the sound.>

**Still the same:** <the parts of the flow the user already knows that did not move.>

## 📸 Screenshots <a id="screenshots"></a>

| Step 1 — <caption> | Step 2 — <caption> |
|---|---|
| ![<alt>](<artifact-or-url>/step-1.png) | ![<alt>](<artifact-or-url>/step-2.png) |
| **Step 3 — <caption>** | **Step 4 — <caption>** |
| ![<alt>](<artifact-or-url>/step-3.png) | ![<alt>](<artifact-or-url>/step-4.png) |

## 🧭 Under the hood <a id="under-the-hood"></a>

```mermaid
sequenceDiagram
  actor U as User
  participant T as web app
  participant D as server
  participant C as worker runner
  U->>T: 1. key
  T->>D: request
  D->>C: 2. spawn with env / first prompt
  C-->>D: 3. hook event: UserPromptSubmit / Stop
  D-->>T: status
  T-->>U: 4. badge / sort / sound
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

- **Step 1–2.** <Mechanism: the overlay or picker, the request type, three sentences; files with a clause each.>
- **Step 3–4.** <Mechanism: the server-side state, the hook route, the web app field it feeds.>
- **Files.** `web/src/<file>.tsx` — <clause>; `server/<file>.ts` — <clause>.
- **Gate.** <`npm test` and `npm run typecheck` green, including the e2e that walks this journey; or what did not run and why.>

## 📝 Notes <a id="notes"></a>

- <Merge state, conflicts, upgrade note.>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<optional session link; delete this line when none is provided>

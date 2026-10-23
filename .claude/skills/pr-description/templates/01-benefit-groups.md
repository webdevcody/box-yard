<!-- 01 · Benefit groups — the default. A feature PR with two to four things the user gets.
     Sections are named for the benefit, fixes file under the promise they keep. -->

<One or two sentences: what landed and why — the two things a reader must know before the diff.>

**Contents**
- [✨ What you get](#user-content-what-you-get)
  - [🚀 <Benefit group one>](#user-content-benefit-group-one)
  - [🔔 <Benefit group two>](#user-content-benefit-group-two)
- [📸 Screenshots](#user-content-screenshots)
- [🧭 How it flows](#user-content-how-it-flows)
- [⚠️ Risk](#user-content-risk)
- [🔧 Technical overview](#user-content-technical-overview)
- [📝 Notes](#user-content-notes)

## ✨ What you get <a id="what-you-get"></a>

### 🚀 <Benefit group one> <a id="benefit-group-one"></a>

- **<Two-to-five-word hook>** — <the key, command or setting it hangs on: backticks, or the `Settings › Sessions › done_sound` form>
  - <one fact: what it does>
  - <one fact: what you see>
  - <one fact: the edge — a refusal, offline, the old way>
- **<Hook>** — <…>
  - <…>
  - <…>

### 🔔 <Benefit group two> <a id="benefit-group-two"></a>

- **<Hook>** — <…>
  - <…>
- **<A fix, filed here because this is the promise it keeps>** — <the symptom>
  - <the cause, one clause>
  - <the new behaviour>

<!-- A group with one bullet merges into its neighbour. Two or three bullets per group. -->

## 📸 Screenshots <a id="screenshots"></a>

| <What this shows — the screen after the change> |
|---|
| ![<alt: the Settings panel with …>](<artifact-or-url>/<after>.png) |

<!-- Use a screenshot artifact for UI changes; for server-only work, use a fenced terminal proof block and say why there is no PNG. -->

## 🧭 How it flows <a id="how-it-flows"></a>

```mermaid
flowchart LR
  U([User]) -->|"key or command"| T[web app]
  T -->|"request"| D[server]
  D -->|"what is new"| N["new mechanism"]
  N -->|"result"| T
  classDef changed fill:#fde68a,stroke:#b45309,color:#111
  class N changed
```

<!-- Draw the change, not the system: ten to twenty nodes, the new node(s) given the `changed` class. -->

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

- **Mechanism.** <How it works, in three or four sentences: the type or flag added, who owns the state, what triggers it.>
- **Files.** `server/<file>.ts or web/src/<file>.tsx` — <one clause>; `server/<file>.ts or web/src/<file>.tsx` — <one clause>.
- **Not done.** <The approach rejected and why, so the reviewer does not ask "why not X".>
- **Gate.** `npm test` and `npm run typecheck` green. <Or: what did not run, and why.>

## 📝 Notes <a id="notes"></a>

- <Merge state: `origin/main` (vX.Y.Z) is merged in; conflicts and what they broke, or "none".>
- <Anything the user must do to upgrade — a schema/config change means `restart Box Yard` first.>
- Closes #<N>.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<optional session link; delete this line when none is provided>

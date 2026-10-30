# Coordinator → Captain → reply: where a round trip's time goes (baseline)

*Speed project, step 1. Box Yard analysis, Oct 30 2026. This step ships per-turn timings (the `turn_timings` table, kept 30 days; the ⏱ chip on every reply and "Turn N finished" line; and the `turn_timings` MCP tool). This report is the baseline they'll be compared against.*

**How to read the numbers.** Every number carries one of these tags:

| Tag | Meaning |
|---|---|
| **[live]** | Measured on a real Claude session with real API calls (this task's own session log, Opus 5.5, high effort, auto-compact at 250k). |
| **[mock]** | Measured on a real Box Yard server with `fake-claude` standing in for the model (`scripts/perf/roundtrip-bench.ts`, 8 round trips after one warm-up). It's Box Yard's own overhead with the model taken out. |
| **[cli]** | Measured on this box with the real Claude CLI 2.1.293, without API calls (spawn, resume, exit, MCP handshake). |
| **[est]** | Estimated from the above. The working is shown. |
| **[pending live run]** | Needs Cody's live Box Yard database, which this box can't reach. The command to fill it in is at the end. |

## Headline

A typical Coordinator → Captain → reply round trip is modelled at about **25–30 s** [est]:

| Hop | What happens | Estimated p50 | Mostly |
|---|---|---:|---|
| 1. Coordinator turn on Cody's message | CLI start, ~2 model steps (decide and `send_to_captain`, then "asked the Captain"), CLI exit | ~7 s | model |
| 2. Captain turn on the Coordinator's message | CLI start, ~3–4 model steps (look things up, then reply), tools, exit | ~11–14 s | model |
| → The Captain's reply shows on the Coordinator chat | | **~18–21 s after Cody sent** | |
| 3. Coordinator wake on the reply | **4.0 s debounce**, CLI start, 1–2 model steps, exit | ~8 s | model + debounce |
| → The Coordinator's own comment on it | | **~26–29 s after Cody sent** | |

Where those ~27 s go [est]:

- **≈70–75%: model API time.** That's ~7–8 model steps at ~2.9 s p50 each.
- **≈15%: the Coordinator's 4 s wake debounce.**
- **≈5–10%: Claude CLI start, resume and exit**, 0.7–1.6 s per hop over 3 hops.
- **<1%: Box Yard itself.** Queues, the MCP handshake, `send_to_captain`, posting the reply: 226 ms Cody → reply when the model takes no time [mock].

Box Yard's plumbing is fast. **The cost is the number of model steps per hop, and the hops themselves.** On top of that sit two kinds of rare but large stalls: a cold prompt cache after 5 min idle, and auto-compaction (66–72 s each [live]).

## Box Yard's own overhead [mock]

`npx tsx scripts/perf/roundtrip-bench.ts 8` runs a real server in a temp data dir with `fake-claude` (every model step ~0 ms), and sends "tell captain demo: status N" eight times.

| Stage | p50 | Notes |
|---|---:|---|
| **Cody → the Captain's reply on the Coordinator chat** | **226 ms** | the whole round trip without the model |
| Cody → the Coordinator's wake on that reply done | 4.4 s | 4.0 s of it is the wake debounce |
| Coordinator turn: queue | 2 ms | Cody's message doesn't wait |
| Coordinator turn: start-up | 72 ms | process 51 ms + MCP 19 ms (`fake-claude` is a small Node script; the real CLI is ~5× slower, see below) |
| `send_to_captain` tool call | 13 ms | |
| Captain turn: queue | 2 ms | a Coordinator message isn't debounced |
| Captain turn: start-up | 89 ms | |
| Coordinator wake turn: queue | **4.0 s** | `WAKE_DEBOUNCE_MS = 4000` (Captains: 3 s on task updates) |
| `buildMcpServer` per `/mcp` request | 2 ms | ~3 per handshake, 1 per tool call |
| `tools/list` (in memory) | 3 ms | |

A task turn on the same mock [mock]:

- queue 35 ms, setup 58 ms, process 65 ms, MCP 1 ms;
- total 283 ms, of which ~95 ms is the server's poll latency on the runner's events.

Rebuilding the trips from message timestamps alone (`turn-baseline.mjs` on the bench DB) agrees: Cody's message → the Captain's reply 158 ms, reply → the Coordinator's wake 4.0 s.

**The only Box Yard-made wait that matters is the 4 s debounce.** Everything else is milliseconds.

## The Claude CLI itself [cli]

Measured with the real CLI 2.1.293 on this box (4 GB, Upstash):

| Step | Time |
|---|---:|
| spawn → `init` line (fresh session) | 270–320 ms |
| `--resume` of a 1 MB session | 310 ms |
| … 5 MB | 340 ms |
| … 20 MB | 410 ms |
| … 60 MB | 600 ms |
| Process exit after the final result | 400–1,000 ms |
| Local MCP handshake (`initialize` + `tools/list`) | ~20 ms |

Per hop that's **~0.7–1.6 s** of CLI start plus exit. Over the 3 hops of a round trip it's **~2–5 s** [est]. Resume time grows with the session file, so long-lived Coordinator and Captain sessions creep up. Compaction doesn't shrink the file; the CLI appends to it.

The exit tail is the 400–1,000 ms between the CLI's `result` event and the process ending. The timings call it `tail`. **It sits on the round trip's critical path.** The Captain's reply is relayed to the Coordinator (`replyUpward` in `server/captains.ts`) only after the Captain's turn finishes, which means after its process exits. The Coordinator's wake can't start before its own previous turn has exited either. Relaying at `result` would save ~0.4–1 s per hop.

## The model [live]

This task's own session log has 205 model steps (Opus 5.5, high effort, 30k–220k context), timed from each `tool_result` to the next assistant message:

| Context | Steps | p50 | p95 | Cache-read share |
|---|---:|---:|---:|---:|
| < 60k | 30 | 2.8 s | 6.9 s | 92% |
| 60–100k | 40 | 2.3 s | 17.0 s | 98% |
| 100–140k | 45 | 3.0 s | 12.9 s | 99% |
| ≥ 140k | 90 | 3.0 s | 12.4 s | 99% |
| **All** | **205** | **2.9 s** | **12.4 s** | **98%** |

A least-squares fit over the same steps:

> **step ≈ 2.7 s + 2.2 ms × output tokens + 0.12 ms × cache-write tokens**

By output size:

| Output tokens | Steps | p50 |
|---|---:|---:|
| < 100 | 12 | 2.0 s |
| 100–300 | 86 | 2.4 s |
| 300–1,000 | 67 | 4.0 s |
| ≥ 1,000 | 40 | 8.8 s |

What this says:

- **A step costs ~2.7 s before it writes anything.** That's request, prefill against a warm cache, and the first token. The number of steps per hop is what drives a round trip, more than context size.
- **With a warm cache, context size barely matters.** p50 is flat from 60k to 220k because 98–99% of the prompt is a cache read.
- **A cold cache does matter.** After more than 5 min idle the prompt cache expires, and the whole context is written again. By the fit, that's ~0.12 ms per token:

  | Context when the cache is cold | Extra time on the first step [est] |
  |---|---:|
  | 50k | ~6 s |
  | 120k | ~14 s |
  | 220k | ~26 s |

  Coordinators and Captains idle between Cody's messages far more than a task does, so this likely hits the first hop of most round trips. **[pending live run]** for the real rate. `turn-baseline.mjs` splits steps by idle gap (< 5 min vs > 5 min) once it can read the live session logs.

- **Auto-compaction: 71.6 s at 218k and 65.7 s at 220k** (two `compact_boundary` entries in this session). That's ~7% of this session's wall time. A turn that compacts is a minute slower, and the step after it starts cold.

### The two settings changes: high → medium effort, auto-compact 250k → 120k

Both were changed shortly before 2026-10-30T05:25Z. There's no "after" data on this box, and the live DB is out of reach, so **both effects are estimates** [est]. The timings shipped here record `effort` and `contextTokens` on every turn, so the next report can measure them.

**captainEffort high → medium.**

- Effort mostly changes how much the model thinks, which shows up as output tokens.
- At 2.2 ms per output token:
  - the typical step (~300 output tokens, ~2.9 s) can save at most ~0.3 s (~10%), even if medium halved its thinking;
  - the long steps (≥ 1,000 tokens, p50 8.8 s, p95 ~12–17 s) are where it pays: about 2–5 s each.
- A Captain hop has 3–4 steps, usually 0–1 of them long. Expected saving: **~1–4 s per round trip (~5–15%)** [est].
- The fixed ~2.7 s per step doesn't change.

**Auto-compact 250k → 120k.**

- Warm steps: no measurable change. p50 is flat across context sizes.
- Compactions: each one should be shorter. Compaction is mostly writing the summary, so not half as long: ~40–55 s at 120k instead of ~70 s at 220k [est]. They'll come about twice as often.
- Cold-cache first steps: these get cheaper, ~14 s at 120k instead of ~26 s at 220k [est]. That's probably the larger win for Coordinators and Captains, which idle often.
- Net per round trip: neutral to slightly faster. It's better for long idle-heavy chats and worse for chats that compact often.

## Live Coordinator ↔ Captain rows [pending live run]

These need Cody's live `box-yard.sqlite` and the `~/.claude/projects` session logs on the Mac. The Captain passed the command to Cody and the Coordinator. The rows to fill in:

| Measure | Value |
|---|---|
| Real round trips: Cody → Captain reply, p50 / p95 | pending live run |
| Coordinator / Captain queue by trigger (Cody, coordinator, updates) | pending live run |
| Model steps per Coordinator turn and per Captain turn | pending live run |
| Model-step latency, warm vs > 5 min idle | pending live run |
| Compactions per day, and their duration | pending live run |
| Before/after the effort and auto-compact change (the script finds the time from `update_settings`) | pending live run (little "after" data yet) |

The command is one line. Run it in the Box Yard checkout on the Mac. It leaves the working tree alone: it copies the script out of the PR branch to /tmp. It opens the database read-only and only reads the session logs:

```sh
git fetch -q origin boxyard/speed-project-step-1-per-turn-timing-ins-6407 && git show FETCH_HEAD:scripts/perf/turn-baseline.mjs > /tmp/turn-baseline.mjs && node /tmp/turn-baseline.mjs --days 14 > /tmp/turn-baseline.md
```

After the PR merges, it's just `node scripts/perf/turn-baseline.mjs --days 14`.

- **Database:** it reads `$BOXYARD_DATA_DIR` or `./data`. If the data is elsewhere, pass the directory first.
- **Session logs:** it reads them from `~/.claude/projects`.
- **When the settings changed:** settings are stored without timestamps. A change the Coordinator made through `update_settings` is a dated tool line in its chat, so the script lists those. It splits before and after at the latest `captainEffort` or auto-compact change, which gives the exact time in place of the "shortly before 05:24:55Z" approximation. A change made in the Settings dialog leaves no trace. For that case, add `--split 2026-10-30T05:20:00Z`.

From this PR on, every new turn also lands in `turn_timings`, so the next report can just ask:

```
turn_timings { days: 14 }
```

That gives p50/p95 per role and stage, the slowest tools and recent turns, with nothing to rebuild.

## The earlier report's open fixes (art_fbbdd6418632)

The Oct 26 report covered survive-the-night **task** time on Upstash boxes. Its five suggestions are about task turns, not the Coordinator ↔ Captain path, and none has shipped on `main` yet. Where they stand against this work:

| Earlier fix | Status on main | How the new timings help | Effect on a round trip |
|---|---|---|---|
| 1. GPU for the browser (stop forcing SwiftShader; browser and perf work on the RunPod GPU) | Open. RunPod pods exist (#132–#135), but the project's `launchChrome` still forces SwiftShader. | Task timings name each tool call, so `turn_timings { role: "task" }` lists the slowest tools, e.g. Bash with the browser runs. | None directly. It was 48% of task time. |
| 2. WIP checkpoints during long turns | Open. The runner still pushes only at turn end. | `ok: false` turns and their totals show how much work an interrupted turn lost. | None. |
| 3. Project snapshot with deps baked in (#122) | Open. | The task `setup` stage (box, clone, restore) and the tool spans for `npm ci` / `npx node@24` show it. | None. It was <1% of task time. |
| 4. Background shells holding the CLI open | Open. | The `tail` stage (result → process exit) **is** this. Tails of more than a few seconds mean a shell left running. | Small. The CLI exit is 0.4–1 s per hop [cli]. A tail measured in minutes would block the agent's next turn. |
| 5. Size the large-box pool; one browser per box | Partly. Idle boxes are reused and pacing is in (#169, #171). | The task `queue` stage measures it directly. | None. |

**One open fix touches round trips: #4.** A Captain that leaves a background shell running keeps its CLI alive, and every message to it queues behind that. The new `tail` and `queue` stages show it per turn.

## Ranked time sinks for a Coordinator → Captain → reply round trip

| # | Time sink | Size | Tag | What would cut it (later steps) |
|---|---|---|---|---|
| 1 | **Model steps per hop.** ~2.7 s fixed per step, 7–8 steps per round trip. | **~20 s of ~27 s** (p50 step 2.9 s, p95 12.4 s) | live + est | Fewer steps: let `send_to_captain` return the Captain's reply in the same turn for quick questions; a lighter model or lower effort for relay-only Coordinator turns; give the Captain the context it would otherwise look up. |
| 2 | **Cold prompt cache after more than 5 min idle.** The whole context is rewritten on the first step. | **+6 s at 50k, +14 s at 120k, +26 s at 220k**, per first step after idle | est (from the live fit); rate pending live run | A smaller context (the 120k auto-compact already helps); keep the cache warm only for agents likely to be asked soon. |
| 3 | **The Coordinator's 4 s wake debounce** on a Captain's reply (3 s for Captains on task updates), plus a wake turn that often only acknowledges. | **4.0 s per reply** (≈15%), plus ~3–6 s of wake turn | mock | Skip the debounce when the update is a reply to the Coordinator's own question; don't wake for replies Cody already sees. |
| 4 | **Auto-compaction.** | **66–72 s per compaction** at ~220k; estimated ~40–55 s at 120k, twice as often | live / est | Compact between turns while idle, not mid-reply. |
| 5 | **Claude CLI start, resume and exit, per hop.** The Captain's reply is relayed only after its CLI exits. | **0.7–1.6 s per hop, ~2–5 s per round trip.** Resume grows from 310 ms (1 MB session) to 600 ms (60 MB). | cli | Relay the Captain's reply at `result`, not at exit (~0.4–1 s); a warm, long-lived CLI per Coordinator or Captain (stream-json input) instead of a spawn per turn; trim session files. |
| – | Box Yard itself (queues, MCP, `send_to_captain`, posting) | **226 ms per round trip** | mock | Nothing worth doing. |

## Method

- **[mock] numbers:**
  - `scripts/perf/roundtrip-bench.ts` on this box: 8 trips after one warm-up, `FAKE_CLAUDE_WORD_MS=1`.
  - It reads the new `turn_timings` rows, so every stage comes from the same instrumentation the PR ships.
  - `buildMcpServer` and `tools/list` timings are 60 in-memory builds.
- **[cli] numbers:**
  - Small probes that spawn the real CLI 2.1.293 against synthetic session files of 1–60 MB.
  - They time spawn → `init`, `--resume`, and `result` → exit.
  - No API calls (the box isn't logged in), so model time isn't in them.
- **[live] numbers:**
  - This task's Claude session log, 05:25–05:58 UTC on Oct 30: 205 main-thread steps, two `compact_boundary` entries.
  - Each step runs from the `tool_result` or prompt timestamp to the next assistant message's first line.
  - That includes network and time to first token. It's a task session, not a Coordinator or Captain, but it's the same model, the same CLI and a similar context range.
- **[est] round trip:**
  - Assumes 2 model steps for the Coordinator's turn, 3–4 for the Captain's and 1–2 for the wake, at the live p50.
  - Adds the [cli] start and exit per hop and the [mock] overhead.
  - The step counts are the weakest assumption. The live run, or two weeks of `turn_timings`, will replace them.
- **Instrumentation overhead:**
  - The clock does a few `Date.now()` calls per stream event, keeps at most 300 steps, and does one SQLite insert per turn.
  - The UI fetches a turn's detail only when its chip is opened.
  - It wasn't benchmarked on its own. Against a ~70 ms mock start-up and ~3 s model steps, its cost is in the microseconds.

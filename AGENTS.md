# Agent Instructions

- When doing work, please commit the work along the way in small chunk size commits with descriptive messages.
- When creating or updating a pull request, always use the `.claude/skills/pr-description` skill to draft the PR title/body so every PR uses the same review format.

## Code conventions

### Server

- **MCP tool scoping.** `buildMcpServer(deps, caller)` in `server/mcp.ts` serves both the Coordinator and the per-project Captains (`caller = { kind: "captain", projectId }`). A new tool must do one of these, or a Captain can reach other projects:
  - resolve every ref through the scope helpers `project()`, `task()`, `schedule()` (and `projectFilter()` for optional filters). They throw `Out of scope: …` for another project's rows.
  - or wrap the registration in `coordinatorOnly(...)`, which removes the tool for Captains.
- **Owner name.** Box Yard-written text that says "Cody" (prompts, labels, notices, events, tool descriptions) goes through `withOwner(text, ownerName)` from `shared/owner.ts`. In `TaskManager`/`CaptainManager` that's `withOwner(text, this.owner())`. Never apply it to user content (notes, messages, prompts).
- **Migrations.** `MIGRATIONS` in `server/db.ts` are append-only; never edit a shipped one. A test that seeds old-shaped rows stops before a specific migration by content, not by position, so later migrations don't break it:
  ```ts
  migrate(db, MIGRATIONS.findIndex((m) => m.includes("claude_usage_new")))
  ```
  Don't use `MIGRATIONS.length - 1`.
- **Notices.** `TaskManager.notice()` text has the shape `<emoji> **Title** verb: detail`, which `parseNotice` in `web/src/lib/captainTranscript.ts` reads. If you change the format or add an emoji, update `EMOJI_KIND` and `test/captain-transcript.test.ts` too.
- **Box sizes.** Per-size CPU, RAM, disk and price live only in `BOX_SIZE_SPECS` (`shared/boxSizes.ts`).
- **Box history.** Every code path that creates, resizes, deletes, loses, cleans up or sweeps a box must record it with `TaskManager.recordBoxEvent` (`server/tasks.ts`, types in `server/boxHistory.ts`), with an actor and a reason, so the box history log (#107, `box_history` MCP tool, Boxes › History) has no gaps.

### Web UI: shared pieces

Use these instead of hand-rolling:

| Need | Use | Where |
| --- | --- | --- |
| Any dialog, drawer or sheet | `<Modal>` (`size`, `placement="center\|top\|sheet"`, `dirty`, `onSubmit`, `footer`) | `web/src/components/Modal.tsx` |
| Yes/no prompt | `await confirmDialog({ title, body, confirmLabel, danger })`, not `window.confirm` | `web/src/lib/confirm.ts` |
| A dropdown | `<Select>` (width via `className`, `size="sm"` inline), not a raw `<select>` | `web/src/components/ui.tsx` |
| Link to another site | `<NewTabLink>`; never hand-write `target="_blank"`. It adds the ↗ (`ExternalMark`) and the URL tooltip: `mark="end"` in a flex chip, `mark={false}` only for icon buttons that already say where they go | `ui.tsx` |
| Link that may be in-app, a file or external (e.g. markdown) | `<AppLink>`, which routes by `linkTarget()` in `lib/linkify.ts` | `ui.tsx` |
| Link to an artifact or upload | `<FileLink>` / `<ArtifactLink>` (opens the preview modal; wrap lists in `{...PREVIEW_GROUP}` for the ←/→ gallery) | `web/src/components/FileLink.tsx` |
| Leading icon on a text row | `<LineIcon icon={X} className="h-4 w-4" />` in an `items-start` row, not a hand-tuned `mt-*` | `ui.tsx` |
| A chip in the task header meta row | `META_CHIP` (44px on phones, 24px from `sm`) | `ui.tsx` |
| A list of task cards | `useStableTasks(tasks, { compare, include, resetKey })` + `<TaskGrid stable />` | `web/src/components/TaskGrid.tsx` |

- `AppLink`, `FileLink` and `NewTabLink` stop click propagation. Never wrap rendered Markdown in a `<Link>`/`<a>`: auto-linked URLs become nested anchors. Use a `role="link"` div card (see `NoticeCard` in `ChatLine.tsx`).
- Link colours: yellow = in-app, sky + ↗ = another site, PR glyph in its state colour + ↗ = a GitHub PR. A pasted GitHub PR/issue URL renders as "PR #154" / "owner/repo#154" (`shortGithubLabel` in `lib/linkify.ts`). Artifacts and uploads are in-app (preview modal, or download in place), so no ↗.
- PR links and task status: `<PrChip>` and `<StatusBadge status={badgeStatus(task)} />` from `ui.tsx` (`badgeStatus` is in `lib/prState.ts`). They show the purple Merged state, so don't hand-roll PR links.
- Settings: open it with `useOpenSettings()(section)`. It's mounted once as `SettingsHost`, so don't render `<SettingsDialog>` yourself. New categories go in `SETTINGS_SECTIONS` (`lib/settingsNav.ts`).
- `useStableTasks`: pass all candidate tasks and filter with `include` (pre-filtering makes cards vanish instead of dimming). `resetKey` is the sort/filter/search, never `now`.

### Web UI: performance

Long threads must stay fast while typing and while SSE events stream in.

- **The Composer owns its draft** and calls `onSubmit(text, attachments)`. Never lift the draft into `ChatPanel`, `CaptainTab` or `TaskView`. Chat footers use `COMPOSER_FOOTER` from `Composer.tsx`.
- **The transcript doesn't re-render on header or draft updates (#29).** Keep transcripts in their own memo'd component (`TaskThread` in `TaskView.tsx`). `ChatLine`, `ToolLine`, `Line` and `TaskCard` are memo'd, so keep their props stable (callbacks via `useCallback`; `TaskCard`'s `onMarkDone` takes the task).
- Long lists render through `useTail` (`web/src/lib/tail.ts`) plus `StickyScroll`'s `hidden`/`onLoadEarlier`, so only the newest items are in the DOM. To jump to an older chat message, call `revealChatMessage(id)` (`lib/reveal.ts`), not `getElementById`.
- `Markdown` is memo'd and cached; pass `live` for streaming text.
- Views that read a list once (like the command palette) pass `QUIET` from `lib/queries.ts` to the list hooks, so they don't re-render on every live update.

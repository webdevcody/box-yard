// Per-project box snapshots (shared/snapshots.ts): the scripts that turn a copy of a box into a project's snapshot.
//
// Box Yard never strips the box a snapshot is taken from. It snapshots that box as it is, restores that snapshot on
// a scratch box, strips the scratch box and snapshots it again (TaskManager.runSnapshot). So no task's work is ever
// deleted, committed or not: only the scratch box's copy of it goes.

import { q } from "./providers/types.js"

/** On the scratch box only, holding the job id. The strip script refuses to run where it doesn't match. */
export const SCRATCH_MARKER = ".boxyard/snapshot-scratch"
/** The strip script prints `boxyard-strip=<category> <count>` per category. */
export const STRIP_MARK = "boxyard-strip="
/** The dependency save prints `boxyard-deps=<the runner's JSON result>` per workspace. */
export const DEPS_MARK = "boxyard-deps="

/**
 * Logins and tokens in the box user's home. New boxes get their own when they're created (the env, the git token),
 * so none of these belong in a snapshot. `.claude` and `.codex` are symlinks into the box root on Upstash, so
 * they're stripped under both.
 */
export const STRIP_CREDENTIALS = [
  ".git-credentials",
  ".netrc",
  ".config/gh/hosts.yml",
  ".local/state/gh",
  ".cache/gh",
  ".claude.json",
  ".claude.json.backup",
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".config/cursor/auth.json",
  ".docker/config.json",
  ".aws/credentials",
  ".config/gcloud/credentials.db",
  ".config/gcloud/access_tokens.db",
]

/** Sessions, logs and shell history in the box user's home. */
export const STRIP_LOGS = [
  ".claude/projects",
  ".claude/todos",
  ".claude/shell-snapshots",
  ".claude/statsig",
  ".claude/debug",
  ".claude/session-env",
  ".claude/file-history",
  ".claude/history.jsonl",
  ".codex/sessions",
  ".codex/log",
  ".codex/history.jsonl",
  ".cache/claude-cli-nodejs",
  ".npm/_logs",
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".node_repl_history",
  ".sqlite_history",
  ".psql_history",
  ".lesshst",
  ".viminfo",
  ".wget-hsts",
]

export interface StripSpec {
  /** The box root (holds .boxyard/ and the task folders). */
  root: string
  /** The folder of task folders. */
  tasks: string
  /** The box user's home: `$HOME` on Upstash, a folder inside the box's own on local boxes. */
  home: string
  /** The box's temp folder. */
  tmp: string
  /** The project's repo mirror in .boxyard/repos (`<name>.git`), kept; every other mirror goes. */
  keepMirror: string | null
  /** The job id the scratch marker must hold. */
  jobId: string
}

/** A folder for the shell: `$HOME` stays a variable, anything else is quoted. */
const shellPath = (p: string) => (p === "$HOME" ? `"$HOME"` : q(p))

/**
 * Strip a scratch box down to what a new box for the project should start with. Removes every task folder (their
 * workspaces, sessions, task.json with the project's env), other projects' repo mirrors, Box Yard's temp files,
 * logins and tokens, logs and shell history, and the box user's own temp entries. Keeps the project's repo mirror,
 * the dependency cache (.boxyard/deps), the npm cache, toolchains and browsers (~/.cache/ms-playwright and the
 * like) and system packages. Refuses unless the scratch marker holds `jobId`, so it can never run on a box with
 * work on it. Fails when a task folder can't be removed, rather than save a snapshot with one in it.
 */
export function stripScript(s: StripSpec): string {
  const cat = (name: string) => `echo "${STRIP_MARK}${name} $c"`
  const rmEach = (paths: string) =>
    `for f in ${paths}; do { [ -e "$f" ] || [ -L "$f" ]; } || continue; rm -rf "$f" 2>/dev/null || { chmod -R u+w "$f" 2>/dev/null; rm -rf "$f" 2>/dev/null; }; { [ -e "$f" ] || [ -L "$f" ]; } || c=$((c+1)); done`
  const inHome = (list: string[]) => list.flatMap((p) => [`"$byhome"/${q(p)}`, ...(/^\.(claude|codex)\//.test(p) ? [`"$byroot"/${q(p)}`] : [])]).join(" ")
  const keep = s.keepMirror ? `${q(s.keepMirror)}|${q(`${s.keepMirror}.lock`)}) continue;;` : ""
  return [
    `byroot=${q(s.root)}; bytasks=${q(s.tasks)}; byhome=${shellPath(s.home)}; bytmp=${shellPath(s.tmp)}`,
    `[ "$(cat "$byroot"/${q(SCRATCH_MARKER)} 2>/dev/null)" = ${q(s.jobId)} ] || { echo "not this snapshot's scratch box: nothing was stripped" >&2; exit 3; }`,
    `case "$byhome:$bytmp:$byroot:$bytasks" in :*|*::*|*:|/:*|*:/:*|*:/) echo "a folder to strip is empty or /" >&2; exit 3;; esac`,
    // Every task folder: workspaces, Claude sessions, task.json (the project's env).
    `c=0; ${rmEach(`"$bytasks"/* "$bytasks"/.[!.]*`)}; ${cat("workspaces")}`,
    `[ -z "$(ls -A "$bytasks" 2>/dev/null)" ] || { echo "couldn't remove every task folder: $(ls -A "$bytasks" | head -5 | tr '\\n' ' ')" >&2; exit 4; }`,
    // Other projects' repo mirrors.
    `c=0; for f in "$byroot"/.boxyard/repos/*; do [ -e "$f" ] || continue; case "$(basename "$f")" in ${keep} *.lock) rm -f "$f"; continue;; esac; rm -rf "$f" && c=$((c+1)); done; ${cat("mirrors")}`,
    // Box Yard's temp files and restore downloads.
    `c=0; ${rmEach(`"$byroot"/.boxyard/tmp/* "$byroot"/.boxyard/tmp/.[!.]* "$byroot"/.boxyard/restore-*`)}; ${cat("boxyard-tmp")}`,
    `c=0; ${rmEach(inHome(STRIP_CREDENTIALS))}; ${cat("credentials")}`,
    // npm tokens in ~/.npmrc: the lines go, the rest of the file (registry settings) stays.
    `if [ -f "$byhome/.npmrc" ] && grep -qE '_authToken|_auth|_password' "$byhome/.npmrc"; then sed -i -E '/_authToken|_auth|_password/d' "$byhome/.npmrc"; c=$((c+1)); echo "${STRIP_MARK}npmrc 1"; fi`,
    `c=0; ${rmEach(inHome(STRIP_LOGS))}; ${cat("logs")}`,
    // The box user's own temp entries; the npm cache stays (agent shells on Upstash use /tmp/.npm-cache), minus its logs.
    `c=0; for f in "$bytmp"/* "$bytmp"/.[!.]*; do { [ -e "$f" ] || [ -L "$f" ]; } || continue; [ "$(basename "$f")" = .npm-cache ] && continue; [ -O "$f" ] || continue; rm -rf "$f" 2>/dev/null || { chmod -R u+w "$f" 2>/dev/null; rm -rf "$f" 2>/dev/null; }; { [ -e "$f" ] || [ -L "$f" ]; } || c=$((c+1)); done; rm -rf "$bytmp"/.npm-cache/_logs 2>/dev/null; ${cat("tmp")}`,
    // What stays, for the history line.
    `c=$(ls -d "$byroot"/.boxyard/deps/*/*/ 2>/dev/null | wc -l); ${cat("kept-deps")}`,
    `rm -f "$byroot"/${q(SCRATCH_MARKER)}`,
    `sync 2>/dev/null; true`,
  ].join("\n")
}

/** The strip script's counts by category. */
export function stripCounts(stdout: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(STRIP_MARK)) continue
    const [name, n] = line.slice(STRIP_MARK.length).trim().split(/\s+/)
    if (name && n && /^\d+$/.test(n)) counts[name] = (counts[name] ?? 0) + Number(n)
  }
  return counts
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "Removed 3 workspaces, 1 other repo mirror, 4 logins and tokens and 12 temp files and logs; kept app.git and 2 dependency cache entries" */
export function stripSummary(counts: Record<string, number>, keepMirror: string | null): string {
  const n = (k: string) => counts[k] ?? 0
  const removed = [
    plural(n("workspaces"), "workspace"),
    ...(n("mirrors") ? [plural(n("mirrors"), "other repo mirror")] : []),
    plural(n("credentials") + n("npmrc"), "login or token", "logins and tokens"),
    plural(n("logs") + n("tmp") + n("boxyard-tmp"), "temp file or log", "temp files and logs"),
  ]
  const kept = [...(keepMirror ? [`the ${keepMirror} mirror`] : []), plural(n("kept-deps"), "dependency cache entry", "dependency cache entries")]
  return `Removed ${removed.slice(0, -1).join(", ")} and ${removed.at(-1)}; kept ${kept.join(" and ")}`
}

/**
 * Before the task folders go: save each workspace's node_modules to the box's dependency cache (box-runner.mjs
 * depsSave, #118), so tasks on new boxes link it instead of running npm ci. Each call gets a stand-in task folder
 * whose work/ points at the real one and whose turn.json names this box's own cache (a copied turn.json would name
 * the source box's on a local box). Never fails: a tree that can't be cached is skipped and says why.
 */
export function depsSaveScript(o: { root: string; nodeBin: string; runner: string; works: string[]; maxMb: number }): string {
  const deps = JSON.stringify({ deps: { npm: true, dir: `${o.root}/.boxyard/deps`, maxMb: o.maxMb } })
  return o.works
    .map((work, i) => {
      const stand = `${o.root}/.boxyard/tmp/snapshot-deps-${i}`
      return [
        `if [ -d ${q(`${work}/node_modules`)} ]; then`,
        `  rm -rf ${q(stand)}; mkdir -p ${q(stand)} && ln -s ${q(work)} ${q(`${stand}/work`)} && printf '%s' ${q(deps)} > ${q(`${stand}/turn.json`)}`,
        `  echo "${DEPS_MARK}$(${q(o.nodeBin)} ${q(o.runner)} deps ${q(stand)} save 2>&1 | tail -1)"`,
        `  rm -rf ${q(stand)}`,
        `fi`,
      ].join("\n")
    })
    .concat("true")
    .join("\n")
}

/** "saved 1, already cached 1, skipped 1 (node_modules doesn't match package-lock.json)" or null when nothing ran. */
export function depsSaveSummary(stdout: string): string | null {
  const results = stdout
    .split("\n")
    .filter((l) => l.startsWith(DEPS_MARK))
    .map((l) => {
      try {
        return JSON.parse(l.slice(DEPS_MARK.length)) as { action?: string; reason?: string; error?: string } | null
      } catch {
        return { action: "failed", error: l.slice(DEPS_MARK.length).slice(0, 200) }
      }
    })
    .filter((r): r is { action?: string; reason?: string; error?: string } => Boolean(r))
  if (!results.length) return null
  const count = (a: string) => results.filter((r) => r.action === a).length
  const why = [...new Set(results.filter((r) => r.action === "skipped" || r.action === "failed").map((r) => r.reason ?? r.error ?? "unknown"))]
  const parts = [
    ...(count("saved") ? [`saved ${count("saved")}`] : []),
    ...(count("present") ? [`already cached ${count("present")}`] : []),
    ...(count("skipped") + count("failed") ? [`skipped ${count("skipped") + count("failed")} (${why.join("; ")})`] : []),
  ]
  return parts.length ? `node_modules to the dependency cache: ${parts.join(", ")}` : null
}

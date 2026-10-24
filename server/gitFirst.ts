// Git-first archives.
//
// Git carries the code; the archive carries only what git can't. At the end of every turn (repo projects, push
// at turn end on), gitPrepScript snapshots the task's work without touching its repo and pushes it:
// - the task's branch, when it has commits origin lacks (fast-forward only, never forced);
// - the uncommitted work, staged and unstaged apart, plus untracked files git doesn't ignore, as a commit on the
//   hidden ref refs/boxyard/wip/<task>. Its parents are HEAD, a commit of the index, and any local branch or
//   stash entry origin lacks, so one ref holds everything the folder has that origin doesn't.
// Once that push is confirmed the archive is small: the Claude session, the log, runner state, gitignored files
// (.env…) outside the build dirs, git.manifest (branch, HEAD, the WIP commits) and git.pack (the task's own
// objects, so a restore needs no more from origin than its base branch). No .git, no checkout.
//
// Restore (gitRestoreScript): clone from the box's mirror (or GitHub), add git.pack, fetch whatever is missing
// from the branch, the WIP ref or by sha, put HEAD on the branch, write the WIP tree to the working tree and the
// index commit's tree to the index. Any failure removes the half-built folder; the archive is left as it was.
//
// A task whose push failed or was skipped (no write access, push off, submodules, LFS, a merge in progress)
// keeps the full archive: whole, then partial (.git and a WIP snapshot), then thin (gitPrepScript without the
// push: manifest plus a pack of everything origin's base branch lacks).
//
// The snapshot never runs `git commit` in the task's repo: it builds trees from copies of the index, with a
// new object dir in a stage folder (/tmp, or the work disk when that has more room) and the repo's objects as
// an alternate. Its commits have fixed dates, so the same work gives the same commit and a no-op push.

import { q } from "./providers/types.js"

export const wipRef = (taskId: string) => `refs/boxyard/wip/${taskId}`
/** In a git-first or thin archive, next to work/: what to rebuild the repo from. */
export const GIT_MANIFEST = "git.manifest"
/** Objects the task has that origin's base branch doesn't (its commits, the WIP snapshot). */
export const GIT_PACK = "git.pack"
/** First word of gitPrepScript's result line. */
export const GIT_PREP_MARK = "@@boxyard-git"
/** First word of gitRestoreScript's result line. */
export const RESTORE_MARK = "@@boxyard-restore"
/** Name of a task's stage folder, under /tmp or <root>/.boxyard/tmp. */
export const gitStageName = (taskId: string) => `boxyard-git-${taskId}`
/** Both places a task's stage may be, for cleanup. */
export const gitStages = (root: string, taskId: string) => [`/tmp/${gitStageName(taskId)}`, `${root}/.boxyard/tmp/${gitStageName(taskId)}`]
/** The snapshot commits' fixed author and committer date (2000-01-01). */
const SNAPSHOT_DATE = "946684800 +0000"
/** A pack with no objects: 12-byte header + 20-byte checksum. */
const EMPTY_PACK_BYTES = 32

/**
 * Bash: pick the stage's base folder, the one of /tmp and `<root>/.boxyard/tmp` with more free space, so a nearly
 * full root disk (Upstash's / holds /tmp and HOME) doesn't stop an archive. Sets $bybase.
 */
export function stageBaseScript(root: string): string {
  const alt = q(`${root}/.boxyard/tmp`)
  return [
    `byfree() { df -Pk "$1" 2>/dev/null | awk 'NR > 1 { print $4 }' | tail -n 1; }`,
    `bybase=/tmp; byft=$(byfree /tmp)`,
    `if mkdir -p ${alt} 2>/dev/null; then byfa=$(byfree ${alt}); [ "\${byfa:-0}" -gt "\${byft:-0}" ] && bybase=${alt}; fi`,
  ].join("\n")
}

export interface GitPrepOptions {
  /** The box's root folder (its stage fallback is <root>/.boxyard/tmp). */
  root: string
  /** The task's work/ folder. */
  work: string
  taskId: string
  /** The task's branch: pushed when it has commits origin lacks. */
  branch: string | null
  baseBranch: string
  /** Push the branch and the WIP ref. Off: only snapshot (the thin archive). */
  push: boolean
  /** What refs/boxyard/wip/<task> held after the last push, for --force-with-lease and the cleanup delete. */
  lastWip: string | null
  /** Write git.pack when it fits in this many bytes; 0 = no pack (push only). */
  packMaxBytes: number
  /** `git` with the credential helper, ready to take arguments. */
  git: string
  /** Exports GITHUB_TOKEN and GIT_TERMINAL_PROMPT. */
  env: string
}

export type GitPrepStatus = "pushed" | "local" | "skipped" | "failed"

export interface GitPrepResult {
  /** pushed: origin has HEAD and the WIP; local: snapshot made, nothing pushed; skipped/failed: see `reason`. */
  status: GitPrepStatus
  /** The stage folder holding `<task>/git.manifest` and `<task>/git.pack`; remove it when done. */
  stage: string | null
  head: string | null
  /** The checked-out branch (null when detached or unknown). */
  branch: string | null
  /** The WIP commit (worktree tree) and the index commit; null before a snapshot. */
  wip: string | null
  index: string | null
  /** What refs/boxyard/wip/<task> holds on origin after this run (null: no WIP ref there). */
  pushedWip: string | null
  /** Whether the work differs from HEAD (index or worktree). */
  dirty: boolean
  /** yes: git.pack is in the stage; none: nothing to pack; toobig: over packMaxBytes; failed; "-": not asked. */
  pack: "yes" | "none" | "toobig" | "failed" | "-"
  /** The branch push: yes, up-to-date, rejected (not a fast-forward; the WIP ref carries HEAD) or "-". */
  branchPush: string
  reason: string | null
}

/**
 * Snapshot a task's git work, push it (unless `push` is off) and stage the manifest and pack for the archive.
 * Prints one GIT_PREP_MARK line; always exits 0.
 */
export function gitPrepScript(o: GitPrepOptions): string {
  const id = o.taskId
  const ref = wipRef(id)
  const g = o.git
  const t = `"$bys"/${q(id)}`
  const branch = o.branch && o.branch !== o.baseBranch ? o.branch : ""
  const push = (args: string) => `$byto ${g} push -q --no-verify ${args}`
  return [
    o.env,
    `export GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0`,
    `bys=; bystatus=; bywhy=; byhead=-; bycur=-; byW=-; byI=-; bypw=-; bypack=-; bybp=-; bydirty=0`,
    `byout() { echo "${GIT_PREP_MARK} status=$bystatus stage=\${bys:--} head=$byhead branch=$bycur wip=$byW index=$byI pushed=$bypw dirty=$bydirty pack=$bypack branchpush=$bybp why=$(printf '%s' "$bywhy" | tail -c 600 | base64 | tr -d '\\n')"; }`,
    `byend() { bystatus=$1; bywhy=$2; byout; exit 0; }`,
    `byerr() { tail -c 400 "$bys/err" 2>/dev/null | tr '\\n' ' '; }`,
    `byto=; command -v timeout >/dev/null 2>&1 && byto="timeout 180"`,
    stageBaseScript(o.root),
    `bys="$bybase"/${q(gitStageName(id))}`,
    `rm -rf "$bys"; mkdir -p ${t}/objects 2>/dev/null || { bys=; byend failed "couldn't make a temp folder on /tmp or the work disk"; }`,
    `cd ${q(o.work)} 2>/dev/null || byend skipped "the task has no work folder"`,
    `[ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)" ] || byend skipped "work/ isn't a git repo"`,
    `bygd=$(git rev-parse --absolute-git-dir 2>/dev/null) || byend skipped "work/ isn't a git repo"`,
    // What a snapshot can't carry. These tasks keep the full archive.
    `for f in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do [ -e "$bygd/$f" ] && byend skipped "a merge, rebase or cherry-pick is in progress"; done`,
    `git ls-files -s 2>/dev/null | grep -q '^160000 ' && byend skipped "the repo has submodules"`,
    `grep -qs 'filter=lfs' .gitattributes && byend skipped "the repo uses Git LFS"`,
    `git ls-files -o --exclude-standard 2>/dev/null | grep -q '/$' && byend skipped "work/ holds another git repo"`,
    // Snapshot: new objects go to the stage, the repo's own (and, through its alternates, the mirror's) are read.
    `byi=$(git rev-parse --git-path index) && byobj=$(cd "$(git rev-parse --git-path objects)" && pwd -P) || byend failed "can't find the repo's index"`,
    `export GIT_OBJECT_DIRECTORY=${t}/objects GIT_ALTERNATE_OBJECT_DIRECTORIES="$byobj"`,
    `export GIT_AUTHOR_NAME=box-yard GIT_AUTHOR_EMAIL=box-yard@local GIT_COMMITTER_NAME=box-yard GIT_COMMITTER_EMAIL=box-yard@local GIT_AUTHOR_DATE=${q(SNAPSHOT_DATE)} GIT_COMMITTER_DATE=${q(SNAPSHOT_DATE)}`,
    `byhead=$(git rev-parse -q --verify 'HEAD^{commit}') || byhead=-`,
    `bycur=$(git symbolic-ref -q --short HEAD) || bycur=-`,
    `byht=$(git hash-object -t tree /dev/null); [ "$byhead" = - ] || byht=$(git rev-parse "$byhead^{tree}")`,
    // The index as it is (staged changes), then the index plus every change in the working tree.
    `rm -f "$bys/index.i" "$bys/index.w"; [ -f "$byi" ] && { cp "$byi" "$bys/index.i" && cp "$byi" "$bys/index.w" || byend failed "couldn't copy the index"; }`,
    `byIt=$(GIT_INDEX_FILE="$bys/index.i" git write-tree 2>"$bys/err") || byend failed "git write-tree: $(byerr)"`,
    `GIT_INDEX_FILE="$bys/index.w" git add -A 2>"$bys/err" || byend failed "git add: $(byerr)"`,
    `byWt=$(GIT_INDEX_FILE="$bys/index.w" git write-tree 2>"$bys/err") || byend failed "git write-tree: $(byerr)"`,
    `rm -f "$bys/index.i" "$bys/index.w"`,
    `[ "$byIt" = "$byht" ] && [ "$byWt" = "$byht" ] || bydirty=1`,
    // The branch first, so the commits on it don't count as extras below.
    branch
      ? [
          `if [ ${q(o.push ? "1" : "")} ] && bytip=$(git rev-parse -q --verify ${q(`refs/heads/${branch}^{commit}`)}); then`,
          `  if [ -z "$(git rev-list -n 1 "$bytip" --not --remotes 2>/dev/null)" ]; then bybp=up-to-date`,
          `  elif ${push(`origin ${q(`refs/heads/${branch}:refs/heads/${branch}`)}`)} 2>"$bys/err"; then bybp=yes`,
          `  elif grep -qiE 'non-fast-forward|fetch first|\\(rejected\\)' "$bys/err"; then bybp=rejected; bybpwhy="$(byerr)"`,
          `  else byend failed "git push: $(byerr)"; fi`,
          `fi`,
        ].join("\n")
      : ``,
    // Local branches and stash entries origin lacks ride along as extra parents of the WIP commit.
    `byx=$(git for-each-ref --format='%(objectname) %(refname)' refs/heads | while read -r s r; do`,
    `  [ "$r" = "refs/heads/$bycur" ] && continue; [ -n "$(git rev-list -n 1 "$s" --not --remotes 2>/dev/null)" ] && echo "$s $r"; done)`,
    `bystash=$(git rev-parse -q --verify refs/stash >/dev/null && git log -g --format='%H refs/stash' refs/stash 2>/dev/null | awk '{ a[NR] = $0 } END { for (i = NR; i > 0; i--) print a[i] }')`,
    `byx=$(printf '%s\\n%s\\n' "$byx" "$bystash" | sed '/^$/d')`,
    `byp=; [ "$byhead" = - ] || byp="-p $byhead"`,
    `byI=$(git commit-tree --no-gpg-sign $byp -m ${q(`box-yard: staged changes of ${id}`)} "$byIt" 2>"$bys/err") || byend failed "git commit-tree: $(byerr)"`,
    `byxp=$(printf '%s\\n' "$byx" | cut -d' ' -f1 | sed '/^$/d' | sort -u | grep -vx -e "$byhead" -e "$byI" | sed 's/^/-p /' | tr '\\n' ' ')`,
    `byW=$(git commit-tree --no-gpg-sign $byp -p "$byI" $byxp -m ${q(`box-yard: work in progress of ${id}`)} "$byWt" 2>"$bys/err") || byend failed "git commit-tree: $(byerr)"`,
    // The WIP ref is needed while anything here isn't on origin: changes, HEAD's commits, extras.
    `byneed=$bydirty; [ -n "$byx" ] && byneed=1`,
    `[ "$byhead" != - ] && [ -n "$(git rev-list -n 1 "$byhead" --not --remotes 2>/dev/null)" ] && byneed=1`,
    `bylast=${q(o.lastWip ?? "")}`,
    o.push
      ? [
          `if [ "$byneed" = 1 ]; then`,
          `  if ! ${push(`--force-with-lease=${q(ref)}:"$bylast" origin "$byW":${q(ref)}`)} >"$bys/out" 2>"$bys/err"; then`,
          // Someone (an older run whose result was lost) moved the ref: lease against what's there now, once.
          `    grep -qs 'stale info' "$bys/err" "$bys/out" || byend failed "git push of ${ref}: $(byerr)"`,
          `    bylast=$($byto ${g} ls-remote origin ${q(ref)} 2>/dev/null | cut -f1)`,
          `    ${push(`--force-with-lease=${q(ref)}:"$bylast" origin "$byW":${q(ref)}`)} 2>"$bys/err" || byend failed "git push of ${ref}: $(byerr)"`,
          `  fi`,
          `  bypw=$byW`,
          `elif [ -n "$bylast" ]; then`,
          // Clean and fully pushed: drop the WIP ref. If that fails it is still there; try again next time.
          `  ${push(`origin --delete ${q(ref)}`)} 2>/dev/null || bypw=$bylast`,
          `fi`,
        ].join("\n")
      : `bypw=-; [ -n "$bylast" ] && bypw=$bylast`,
    // The pack: everything the snapshot reaches that origin's base branch doesn't. A scratch repo filters out
    // objects that aren't here (a partial clone's), since it has no promisor remote to fetch them from.
    o.packMaxBytes > 0
      ? [
          `bybasis=$(git rev-parse -q --verify ${q(`refs/remotes/origin/${o.baseBranch}`)}) && bynot="--not $bybasis" || bynot=`,
          `byv="$bys/scratch.git"; bypack=failed`,
          `if git init -q --bare "$byv" 2>/dev/null; then`,
          // The WIP commit reaches HEAD, the index commit and the extras.
          `  git rev-list --objects --missing=allow-any "$byW" $bynot 2>/dev/null | cut -d' ' -f1 \\`,
          `    | git -C "$byv" cat-file --batch-check='%(objectname) %(objecttype)' 2>/dev/null | awk '$2 != "missing" { print $1 }' \\`,
          `    | git -C "$byv" pack-objects -q --stdout 2>/dev/null | head -c ${o.packMaxBytes + 1} > ${t}/${GIT_PACK} && bypack=yes`,
          `  bysz=$(wc -c < ${t}/${GIT_PACK} 2>/dev/null || echo 0)`,
          `  if [ "$bysz" -gt ${o.packMaxBytes} ]; then bypack=toobig; rm -f ${t}/${GIT_PACK}`,
          `  elif [ "$bysz" -le ${EMPTY_PACK_BYTES} ]; then [ "$bypack" = yes ] && bypack=none; rm -f ${t}/${GIT_PACK}; fi`,
          `fi`,
          `rm -rf "$byv"`,
        ].join("\n")
      : ``,
    // The manifest, for the restore. "wipref" only when origin has it.
    `{ echo "version 1"; echo "head $byhead"; echo "branch $bycur"; echo "dirty $bydirty"; echo "wip $byW"; echo "index $byI"`,
    `  [ "$bypw" = "$byW" ] && echo "wipref ${ref}"; printf '%s\\n' "$byx" | sed '/^$/d; s/^/extra /'; } > ${t}/${GIT_MANIFEST} || byend failed "couldn't write the manifest"`,
    `rm -rf ${t}/objects "$bys/err" "$bys/out"`,
    o.push ? `[ -n "$bybpwhy" ] && bybpwhy="origin rejected the branch push, so the WIP ref carries its commits: $bybpwhy"; byend pushed "$bybpwhy"` : `byend local ""`,
  ]
    .filter(Boolean)
    .join("\n")
}

/** Read gitPrepScript's result line. A missing line (the exec died) is a failure. */
export function parseGitPrep(stdout: string, stderr = ""): GitPrepResult {
  const line = stdout.split("\n").find((l) => l.startsWith(`${GIT_PREP_MARK} `))
  const empty: GitPrepResult = { status: "failed", stage: null, head: null, branch: null, wip: null, index: null, pushedWip: null, dirty: false, pack: "-", branchPush: "-", reason: null }
  if (!line) return { ...empty, reason: `the git snapshot didn't finish${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-2).join("; ").slice(-300)}` : ""}` }
  const f: Record<string, string> = {}
  for (const part of line.slice(GIT_PREP_MARK.length + 1).split(" ")) {
    const i = part.indexOf("=")
    if (i > 0) f[part.slice(0, i)] = part.slice(i + 1)
  }
  const val = (k: string) => (f[k] && f[k] !== "-" ? f[k]! : null)
  let why = ""
  try {
    why = Buffer.from(f.why ?? "", "base64").toString("utf8").trim()
  } catch {}
  const status = (["pushed", "local", "skipped", "failed"] as const).find((s) => s === f.status) ?? "failed"
  const pack = (["yes", "none", "toobig", "failed"] as const).find((s) => s === f.pack) ?? "-"
  const result: GitPrepResult = {
    status,
    stage: val("stage"),
    head: val("head"),
    branch: val("branch"),
    wip: val("wip"),
    index: val("index"),
    pushedWip: val("pushed"),
    dirty: f.dirty === "1",
    pack,
    branchPush: f.branchpush ?? "-",
    reason: why || null,
  }
  // No write access isn't a failure to fix: the archive keeps everything, quietly.
  if (status === "failed" && why && NO_WRITE.test(why)) return { ...result, status: "skipped", reason: `no write access to origin (${why.replace(/x-access-token:[^@\s]+/g, "x-access-token:***").slice(0, 200)})` }
  return { ...result, reason: result.reason?.replace(/x-access-token:[^@\s]+/g, "x-access-token:***") ?? null }
}

/** git push errors that mean the token can't write to the repo. */
const NO_WRITE = /permission to .* denied|\b403\b|authentication failed|could not read username|terminal prompts disabled|write access to repository not granted/i

export interface GitRestoreOptions {
  /** The task folder, holding the extracted archive. */
  dir: string
  taskId: string
  /** The project's base branch, hydrated in the mirror along with the task's branch. */
  baseBranch: string
  gitUserName: string
  gitUserEmail: string
  /** Clones work/ when the archive has no .git (a git-first or thin archive). Null: no mirror (no repo). */
  clone: { script: string; helper: string } | null
  /** `git` with the credential helper, and the env exports that reach GitHub. */
  git: string
  env: string
}

/**
 * After the archive is unpacked into the task folder: rebuild work/ from git.manifest (git-first and thin
 * archives), or check out the working tree of a partial archive (only .git was saved). A whole archive is left
 * alone. Prints `RESTORE_MARK git|partial|none|failed <b64 reason>`; on failure the caller removes the task folder.
 */
export function gitRestoreScript(o: GitRestoreOptions): string {
  const d = q(o.dir)
  const m = q(`${o.dir}/${GIT_MANIFEST}`)
  const g = o.git
  return [
    o.env,
    `export GIT_TERMINAL_PROMPT=0`,
    `byok() { echo "${RESTORE_MARK} $1 -"; exit 0; }`,
    `byno() { echo "${RESTORE_MARK} failed $(printf '%s' "$1" | tail -c 600 | base64 | tr -d '\\n')"; exit 0; }`,
    `byerr() { tail -c 400 "$byt/err" 2>/dev/null | tr '\\n' ' '; }`,
    `cd ${d} 2>/dev/null || byno "the task folder is missing"`,
    `mkdir -p work && byt=$(mktemp -d "\${TMPDIR:-/tmp}/boxyard-restore.XXXXXX" 2>/dev/null || { mkdir -p .boxyard-restore && echo "$PWD/.boxyard-restore"; }) || byno "couldn't make a temp folder"`,
    `trap 'rm -rf "$byt"' EXIT`,
    // A partial archive from before git-first (no manifest): .git, but no working files. Check out its WIP
    // snapshot (or HEAD) and put the archived index back.
    `if [ ! -f ${m} ]; then`,
    `  [ -d work/.git ] && [ -z "$(ls -A work | grep -vx .git)" ] || byok none`,
    `  cd work && byr=$(git rev-parse -q --verify refs/boxyard/wip || git rev-parse -q --verify HEAD) || byok none`,
    `  [ -f .git/index ] && mv .git/index "$byt/index"`,
    `  git read-tree -u --reset "$byr^{tree}" 2>"$byt/err" || byno "checking out the working tree failed: $(byerr)"`,
    `  [ -f "$byt/index" ] && mv "$byt/index" .git/index; git update-index -q --refresh >/dev/null 2>&1`,
    `  byok partial`,
    `fi`,
    `byf() { sed -n "s/^$1 //p" ${m} | head -n 1; }`,
    `byhead=$(byf head); bybranch=$(byf branch); bydirty=$(byf dirty); byW=$(byf wip); byI=$(byf index); byref=$(byf wipref)`,
    `bypartial=; [ -d work/.git ] && bypartial=1`,
    // No .git: clone next to work/ (it may hold the archive's ignored files) and move the clone's .git in.
    `if [ -z "$bypartial" ]; then`,
    o.clone
      ? [
          `  rm -rf .boxyard-clone`,
          `  { ${o.clone.script}\n  } >"$byt/err" 2>&1 || byno "git clone failed: $(byerr)"`,
          `  mv .boxyard-clone/.git work/.git && rm -rf .boxyard-clone || byno "couldn't move the clone into work/"`,
          `  git -C work config credential.helper ${q(o.clone.helper)}`,
        ].join("\n")
      : `  byno "the archive has no repo and the project has none to clone"`,
    `fi`,
    `cd work`,
    `git config user.name ${q(o.gitUserName)}; git config user.email ${q(o.gitUserEmail)}`,
    `[ -f ../${GIT_PACK} ] && { git index-pack --stdin < ../${GIT_PACK} >/dev/null 2>"$byt/err" || byno "git.pack is damaged: $(byerr)"; }`,
    // Does the repo have this commit and its tree? Asked of a scratch repo that borrows work/'s objects: it has
    // no promisor remote, so a missing commit isn't lazily fetched (with its whole history, in a partial clone).
    `byv="$byt/v.git"; git init -q --bare "$byv" && (cd .git/objects && pwd -P) > "$byv/objects/info/alternates" || byno "couldn't make a scratch repo"`,
    `byhas() { git -C "$byv" cat-file -e "$1^{tree}" 2>/dev/null; }`,
    `bywant=$(for c in "$byhead" "$byW" "$byI" $(sed -n 's/^extra \\([0-9a-f]*\\) .*/\\1/p' ${m}); do [ "$c" = - ] || [ -z "$c" ] || byhas "$c" || echo "$c"; done | sort -u)`,
    `if [ -n "$bywant" ]; then`,
    // One fetch per ref: a branch origin doesn't have would fail them all.
    `  [ "$bybranch" != - ] && ${g} fetch -q origin "+refs/heads/$bybranch:refs/remotes/origin/$bybranch" >/dev/null 2>&1`,
    `  [ -n "$byref" ] && ${g} fetch -q origin "+$byref:$byref" >/dev/null 2>&1`,
    `  bywant=$(for c in $bywant; do byhas "$c" || echo "$c"; done)`,
    `  [ -n "$bywant" ] && ${g} fetch -q origin $bywant >/dev/null 2>"$byt/err"`,
    `  bywant=$(for c in $bywant; do byhas "$c" || echo "$c"; done)`,
    // A clean snapshot was never pushed: HEAD's tree is the same thing.
    `  if [ "$bydirty" = 0 ]; then bywant=$(for c in $bywant; do [ "$c" = "$byW" ] || [ "$c" = "$byI" ] || echo "$c"; done); fi`,
    `  [ -z "$bywant" ] || byno "origin no longer has commit $(echo $bywant | cut -c1-12) and the archive doesn't either: $(byerr)"`,
    `fi`,
    `[ "$bydirty" = 0 ] && ! byhas "$byW" && byW=$byhead && byI=$byhead`,
    // HEAD: the branch at its commit (or detached), without touching files yet.
    `if [ "$bybranch" != - ]; then`,
    `  [ "$byhead" = - ] || git update-ref "refs/heads/$bybranch" "$byhead" 2>"$byt/err" || byno "couldn't set the branch: $(byerr)"`,
    `  git symbolic-ref HEAD "refs/heads/$bybranch"`,
    `  if git rev-parse -q --verify "refs/remotes/origin/$bybranch" >/dev/null; then git config "branch.$bybranch.remote" origin; git config "branch.$bybranch.merge" "refs/heads/$bybranch"; fi`,
    `elif [ "$byhead" != - ]; then git update-ref --no-deref HEAD "$byhead"; fi`,
    // Local branches and stash entries origin lacked (a partial archive kept them in .git already).
    `if [ -z "$bypartial" ]; then sed -n 's/^extra //p' ${m} | while read -r s r; do`,
    `  if [ "$r" = refs/stash ]; then git update-ref --create-reflog -m "$(git log -1 --format=%s "$s")" refs/stash "$s"; else git update-ref "$r" "$s"; fi`,
    `done; fi`,
    // The working tree from the WIP commit, then the index from the index commit (or the archived index).
    `if [ "$byW" != - ]; then`,
    `  [ -f .git/index ] && mv .git/index "$byt/index"`,
    `  git read-tree -u --reset "$byW^{tree}" 2>"$byt/err" || byno "checking out the working tree failed: $(byerr)"`,
    `  if [ -n "$bypartial" ] && [ -f "$byt/index" ]; then mv "$byt/index" .git/index`,
    `  elif [ "$byI" != - ]; then git read-tree "$byI^{tree}" 2>"$byt/err" || byno "restoring the index failed: $(byerr)"; fi`,
    `  git update-index -q --refresh >/dev/null 2>&1`,
    `fi`,
    `rm -f ../${GIT_PACK}`,
    `byok git`,
  ].join("\n")
}

/** Read gitRestoreScript's result line. */
export function parseGitRestore(stdout: string, stderr = ""): { ok: boolean; from: "git" | "partial" | null; reason: string | null } {
  const line = stdout.split("\n").find((l) => l.startsWith(`${RESTORE_MARK} `))
  if (!line) return { ok: false, from: null, reason: `the restore script didn't finish${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-2).join("; ").slice(-300)}` : ""}` }
  const [, state, b64] = line.split(" ")
  if (state === "git" || state === "partial") return { ok: true, from: state, reason: null }
  if (state === "none") return { ok: true, from: null, reason: null }
  let why = ""
  try {
    why = Buffer.from(b64 ?? "", "base64").toString("utf8").trim()
  } catch {}
  return { ok: false, from: null, reason: (why || "unknown error").replace(/x-access-token:[^@\s]+/g, "x-access-token:***") }
}

/** Delete a task's WIP ref on origin from its work/ (best effort). */
export function deleteWipScript(work: string, taskId: string, git: string, env: string): string {
  return `${env}\nexport GIT_TERMINAL_PROMPT=0\ncd ${q(work)} 2>/dev/null && ${git} push -q --no-verify origin --delete ${q(wipRef(taskId))} >/dev/null 2>&1; true`
}

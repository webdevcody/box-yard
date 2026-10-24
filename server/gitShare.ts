// Shared git objects on a worker box.
//
// Each box keeps one bare mirror per repo in .boxyard/repos/<name>.git, a partial clone (blob:none) unless the
// project turns that off. A task's work/ is a normal clone with its own branch, config and origin (GitHub), but
// it borrows the mirror's objects through .git/objects/info/alternates (`git clone --reference`, no
// --dissociate). So a task folder holds its working tree, its index and only the objects it made or fetched.
//
// Rules that keep that safe:
// - The mirror never prunes unreachable objects while a task folder borrows from it (gc.pruneExpire=never, and
//   the janitor only prunes a mirror nobody uses). A fetch that fails never deletes a mirror in use.
// - Archives stay self-contained: before tar, archive() packs the borrowed objects that GitHub no longer has
//   reachable (KEEP_PACK). The rest of the history comes back from a fresh mirror when the archive is restored.
// - Removing a task folder only drops that task's own objects: nothing in the mirror points at a task.

import { q } from "./providers/types.js"

/** Next to work/ in a task folder while it is being archived: borrowed objects only the mirror still had. */
export const KEEP_PACK = "git-keep.pack"
/** Echoed by the mirror sync when it re-created a mirror (its mode changed and no task used it). */
export const MIRROR_MARK = "boxyard-mirror="
/** Echoed after a restore: `ok`, or `broken` when HEAD's commit can't be read even with the mirror. */
export const GIT_MARK = "boxyard-git="
/** Refs a mirror gets from GitHub. Objects a task reaches from these can always be fetched again. */
const ORIGIN_REF_PREFIXES = "refs/heads refs/tags refs/pull"
/** A pack with no objects: 12-byte header + 20-byte checksum. */
const EMPTY_PACK_BYTES = 32

export interface MirrorSpec {
  /** The box's root folder (holds tasks/ and .boxyard/). */
  root: string
  /** The mirror's folder, `<root>/.boxyard/repos/<name>.git`. */
  mirror: string
  /** Clone URL (GitHub https; the token comes from the credential helper). */
  url: string
  /** Create the mirror as a partial clone (blob:none). */
  partial: boolean
  /** `git` with the credential helper and token, ready to take arguments. */
  git: string
}

export const mirrorObjects = (mirror: string) => `${mirror}/objects`

/** Shell test: some task folder on the box borrows this mirror's objects. */
export function mirrorInUseTest(root: string, mirrorVar: string) {
  return `grep -qsxF "${mirrorVar}/objects" ${q(root)}/tasks/*/work/.git/objects/info/alternates`
}

/** Shell test: the mirror is a partial clone. */
const isPartial = (m: string) => `[ -n "$(git -C "${m}" config --get remote.origin.partialclonefilter 2>/dev/null)" ]`

/**
 * Create or update a repo mirror. A mirror whose partial mode differs from the setting is re-created, but only
 * while no task folder borrows from it. Never fails the caller: without a mirror, the task clones from GitHub
 * alone. Runs under a per-mirror flock so two tasks starting on one box don't race.
 */
export function syncMirrorScript(s: MirrorSpec): string {
  const inUse = mirrorInUseTest(s.root, "$bym")
  const filter = s.partial ? " --filter=blob:none" : ""
  return [
    `bym=${q(s.mirror)}`,
    `mkdir -p "$(dirname "$bym")"`,
    `if [ -d "$bym" ]; then`,
    `  if ! git -C "$bym" rev-parse --git-dir >/dev/null 2>&1; then ${inUse} || rm -rf "$bym"`,
    `  elif ${s.partial ? "!" : ""} ${isPartial("$bym")} && ! ${inUse}; then rm -rf "$bym"; echo ${MIRROR_MARK}recreate; fi`,
    `fi`,
    // A fetch that fails (network, auth) leaves a mirror tasks borrow from alone; an unused one is cloned again.
    `if [ -d "$bym" ]; then ${s.git} -C "$bym" fetch -q --prune origin >/dev/null 2>&1 || { ${inUse} || rm -rf "$bym"; }; fi`,
    `if [ ! -d "$bym" ]; then ${s.git} clone -q --mirror${filter} ${q(s.url)} "$bym" >/dev/null 2>&1 || rm -rf "$bym"; fi`,
    // Tasks borrow objects the mirror may stop reaching (force-pushes, deleted branches): gc must not prune them.
    `if [ -d "$bym" ]; then git -C "$bym" config gc.pruneExpire never; git -C "$bym" config gc.cruftPacks true; fi`,
    `true`,
  ].join("\n")
}

/**
 * Fetch the blobs of these refs' trees into a partial mirror, in one batch, so every task checking them out
 * shares them instead of each lazily fetching its own copy. A full mirror already has them.
 */
export function hydrateMirrorScript(s: MirrorSpec, refs: string[]): string {
  const tips = refs.map((r) => `git -C "$bym" rev-parse -q --verify ${q(`${r}^{commit}`)}`).join("; ")
  return [
    `bym=${q(s.mirror)}`,
    `if [ -d "$bym" ] && ${isPartial("$bym")}; then`,
    `  bytips=$( { ${tips}; } 2>/dev/null | sort -u)`,
    `  bymiss=$(mktemp)`,
    `  [ -n "$bytips" ] && git -C "$bym" rev-list --objects --no-walk --missing=print $bytips 2>/dev/null | sed -n 's/^?//p' > "$bymiss"`,
    `  [ -s "$bymiss" ] && ${s.git} -C "$bym" -c fetch.negotiationAlgorithm=noop fetch -q origin --no-tags --no-write-fetch-head --recurse-submodules=no --filter=blob:none --stdin < "$bymiss" >/dev/null 2>&1`,
    `  rm -f "$bymiss"`,
    `fi`,
    `true`,
  ].join("\n")
}

/**
 * Clone a task's work/ against the mirror (run inside the task folder). It borrows the mirror's objects; it is
 * a partial clone itself when the mirror is (or, with no mirror, when the setting says so), so blobs nobody has
 * yet are fetched from GitHub on demand. The alternates file is rewritten with the mirror's path as Box Yard
 * spells it, so in-use checks can match it exactly.
 */
export function cloneTaskScript(s: MirrorSpec): string {
  const fallback = s.partial ? "--filter=blob:none" : ""
  return [
    `bym=${q(s.mirror)}`,
    `byf=${fallback ? q(fallback) : '""'}`,
    `if [ -d "$bym" ]; then byf=""; ${isPartial("$bym")} && byf=--filter=blob:none; fi`,
    `${s.git} clone -q --no-checkout $byf --reference-if-able "$bym" ${q(s.url)} work && { [ ! -f work/.git/objects/info/alternates ] || echo "$bym/objects" > work/.git/objects/info/alternates; }`,
  ].join("\n")
}

/** Run `body` while holding the mirror's lock (flock when the box has it). */
export function withMirrorLock(mirror: string, body: string): string {
  const lock = q(`${mirror}.lock`)
  return `mkdir -p ${q(mirror.replace(/\/[^/]+$/, ""))} && { command -v flock >/dev/null 2>&1 && flock -w 900 9; ${body}\n} 9>${lock}`
}

/**
 * Before tar: pack the objects the task reaches from its own refs (HEAD, branches, refs/boxyard/*, the stash)
 * that only the mirror has and that GitHub's refs no longer reach. Usually empty; a few commits after a
 * force-push or a deleted branch. The task's own objects are already in its .git, and everything else comes
 * from a fresh mirror on restore. Removes a stale pack when the task borrows nothing.
 */
export function keepPackScript(taskDir: string): string {
  const w = q(`${taskDir}/work`)
  const out = q(`${taskDir}/${KEEP_PACK}`)
  return [
    `rm -f ${out}`,
    `bya=${w}/.git/objects/info/alternates`,
    `if [ -f "$bya" ]; then`,
    `  byo=$(head -n 1 "$bya")`,
    `  byv=$(mktemp -d)`,
    // A plain repo that sees only the mirror's objects: asking it about a missing object never fetches.
    `  if [ -d "$byo" ] && git init -q --bare "$byv" && echo "$byo" > "$byv/objects/info/alternates"; then`,
    `    bytips=$(cd ${w} && { git rev-parse -q --verify HEAD; git for-each-ref --format='%(objectname)' refs/heads refs/boxyard refs/stash; } 2>/dev/null | sort -u)`,
    `    [ -n "$bytips" ] && git -C ${w} -c core.alternateRefsPrefixes=${q(ORIGIN_REF_PREFIXES)} rev-list --objects --missing=allow-any $bytips --not --alternate-refs 2>/dev/null \\`,
    `      | cut -d' ' -f1 | git -C "$byv" cat-file --batch-check='%(objectname) %(objecttype)' | awk '$2 != "missing" { print $1 }' \\`,
    `      | git -C "$byv" pack-objects -q --stdout > ${out}`,
    `    [ "$(wc -c < ${out} 2>/dev/null || echo 0)" -gt ${EMPTY_PACK_BYTES} ] || rm -f ${out}`,
    `  fi`,
    `  rm -rf "$byv"`,
    `fi`,
    `true`,
  ].join("\n")
}

/**
 * After a restore: point a borrowing work/ at this box's mirror (it may have been archived on another box), and
 * add the archived keep pack. Echoes GIT_MARK ok|broken when work/ has commits.
 */
export function relinkTaskScript(taskDir: string, mirror: string): string {
  const w = q(`${taskDir}/work`)
  const pack = q(`${taskDir}/${KEEP_PACK}`)
  return [
    `bya=${w}/.git/objects/info/alternates`,
    `if [ -f "$bya" ] && [ -d ${q(mirrorObjects(mirror))} ]; then echo ${q(mirrorObjects(mirror))} > "$bya"; fi`,
    `if [ -f ${pack} ]; then git -C ${w} index-pack -q --stdin < ${pack} >/dev/null 2>&1; rm -f ${pack}; fi`,
    // An unborn HEAD (no commits yet) is fine; a HEAD whose commit or tree can't be read is not.
    `byh=$(git -C ${w} rev-parse -q --verify HEAD 2>/dev/null)`,
    `if [ -n "$byh" ]; then git -C ${w} cat-file -e "$byh^{tree}" 2>/dev/null && echo ${GIT_MARK}ok || echo ${GIT_MARK}broken; fi`,
    `true`,
  ].join("\n")
}

/**
 * Janitor: gc every mirror. One that task folders borrow from is repacked without pruning anything (light: only
 * `gc --auto`); an unused one in `keep` is pruned fully; an unused one not in `keep` is removed. Prints one line
 * per mirror for the cleanup report.
 */
export function mirrorGcScript(root: string, keep: string[], light: boolean): string {
  const repos = q(`${root}/.boxyard/repos`)
  const auto = light ? " --auto" : ""
  return [
    `[ -d ${repos} ] || exit 0`,
    `for bym in ${repos}/*.git; do`,
    `  [ -e "$bym" ] || continue; b=$(basename "$bym")`,
    `  if ${mirrorInUseTest(root, "$bym")}; then`,
    `    n=$(grep -lsxF "$bym/objects" ${q(root)}/tasks/*/work/.git/objects/info/alternates | wc -l)`,
    `    git -C "$bym" -c gc.pruneExpire=never gc${auto} --quiet >/dev/null 2>&1${light ? "" : ` && echo "gc $b (kept unreachable objects: $n $( [ "$n" = 1 ] && echo task borrows || echo tasks borrow ) from it)"`}`,
    `  else case " ${keep.join(" ")} " in`,
    `    *" $b "*) ${light ? `git -C "$bym" gc --auto --quiet >/dev/null 2>&1` : `git -C "$bym" gc --prune=now --quiet >/dev/null 2>&1 && echo "gc $b"`};;`,
    `    *) rm -rf "$bym" "$bym.lock" && echo "removed $b";;`,
    `  esac; fi`,
    `done`,
    `true`,
  ].join("\n")
}

/** Remove the mirrors not in `keep` that no task folder borrows from (retention pass). */
export function pruneMirrorsScript(root: string, keep: string[]): string {
  const repos = q(`${root}/.boxyard/repos`)
  return `[ -d ${repos} ] || exit 0; for bym in ${repos}/*.git; do [ -e "$bym" ] || continue; b=$(basename "$bym"); case " ${keep.join(" ")} " in *" $b "*) ;; *) ${mirrorInUseTest(root, "$bym")} || rm -rf "$bym" "$bym.lock";; esac; done`
}

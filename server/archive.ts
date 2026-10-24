import { q } from "./providers/types.js"
import { KEEP_PACK } from "./gitShare.js"
import { GIT_MANIFEST, GIT_PACK, stageBaseScript } from "./gitFirst.js"

/**
 * Workspace archives stream off the box: tar writes to stdout, base64 makes it text the exec stream can carry, and
 * Box Yard decodes it into the archive file on its own disk. Nothing is written to the box's work disk, so a box
 * with 0 bytes free on /workspace can still be archived. (Before, the tarball went to a temp file first and the
 * too-big fallback committed into the repo, both of which need free space.)
 *
 * The script ends with one trailer line: the exit codes of the pipeline, the WIP snapshot's outcome and the tail of
 * stderr, so a failure says what went wrong ("tar: write error: No space left on device").
 */

/** First word of the trailer line. */
export const ARCHIVE_END = "@@boxyard-archive-end"
/** Commit message of the WIP snapshot on refs/boxyard/wip. */
const WIP_MESSAGE = "box-yard: wip snapshot"

export interface ArchiveScript {
  /** The box's tasks folder. */
  root: string
  taskId: string
  /** tar --exclude patterns. */
  excludes: string[]
  /** Archives larger than this aren't kept (the box stops sending after one byte more). */
  maxBytes: number
  /**
   * Too big whole: only the Claude session, the event log and git history, with uncommitted work saved as a commit
   * on refs/boxyard/wip. The commit's objects and the ref go to a temp dir in /tmp (the other disk on Upstash) and
   * into the archive from there; the repo itself isn't touched.
   */
  partial: boolean
  /**
   * Where archive() staged the task's git-keep.pack (server/gitShare.ts keepPackStage), on /tmp. When
   * `<keepStage>/<taskId>/git-keep.pack` exists, it goes into the archive as `<taskId>/git-keep.pack`.
   */
  keepStage?: string
  /**
   * Git-first (or thin) archive: git carries the repo, so only the task folder's other entries go in (the Claude
   * session, the log, runner state), with `<stage>/<taskId>/git.manifest` and `git.pack` from gitPrepScript
   * (server/gitFirst.ts) and, with `ignored`, the files git ignores in work/ outside the excluded build dirs.
   */
  git?: { stage: string; ignored: boolean }
}

/** The bash script that streams a task's archive to stdout. */
export function archiveScript(o: ArchiveScript): string {
  const id = q(o.taskId)
  const excludes = o.excludes.map((e) => `--exclude=${q(e)}`).join(" ")
  const lines = [
    "set -o pipefail",
    // Errors go to a temp file on /tmp; if even that can't be made they're dropped rather than mixed into the data.
    `err=$(mktemp /tmp/boxyard-archive-err.XXXXXX 2>/dev/null) || err=/dev/null`,
    `stage=; wip=-; st="2 0 0 0"`,
    `if cd ${q(o.root)} 2>>"$err"; then`,
    o.keepStage ? `  [ -f ${q(`${o.keepStage}/${o.taskId}/${KEEP_PACK}`)} ] && k=(-C ${q(o.keepStage)} ${q(`${o.taskId}/${KEEP_PACK}`)}) || k=()` : `  k=()`,
  ]
  if (o.git) {
    const stage = q(o.git.stage)
    lines.push(
      `  m=(); while IFS= read -r -d '' f; do m+=("$f"); done < <(find ${id} -mindepth 1 -maxdepth 1 ! -name work -print0 2>>"$err")`,
      `  g=(-C ${stage} ${q(`${o.taskId}/${GIT_MANIFEST}`)}); [ -f ${q(`${o.git.stage}/${o.taskId}/${GIT_PACK}`)} ] && g+=(${q(`${o.taskId}/${GIT_PACK}`)})`,
      `  i=(); il=${q(`${o.git.stage}/ignored.list`)}`,
      o.git.ignored
        ? `  if (cd ${id}/work 2>/dev/null && git ls-files -z -o -i --exclude-standard --directory 2>/dev/null) | while IFS= read -r -d '' f; do printf '%s\\0' ${id}/work/"$f"; done > "$il" 2>>"$err" && [ -s "$il" ]; then i=(--null -T "$il"); fi`
        : `  :`,
      // The excludes come first: they apply to the listed ignored folders too (node_modules/, dist/…).
      `  tar czf - ${excludes} "\${m[@]}" "\${i[@]}" "\${g[@]}" 2>>"$err" | head -c ${o.maxBytes + 1} | base64 | fold -w 76`,
    )
  } else if (o.partial) {
    lines.push(
      // Everything but the working files: the session, the log, runner state and work/.git.
      `  m=(); while IFS= read -r -d '' f; do m+=("$f"); done < <(find ${id} -mindepth 1 -maxdepth 1 ! -name work -print0 2>>"$err"); [ -e ${id}/work/.git ] && m+=(${id}/work/.git)`,
      `  if [ -e ${id}/work/.git ]; then`,
      // The index copy and the snapshot's objects go to whichever of /tmp and the work disk has more room.
      `    ${stageBaseScript(o.root.replace(/\/[^/]+\/?$/, "")).split("\n").join("; ")}`,
      `    stage=$(mktemp -d "$bybase"/boxyard-wip.XXXXXX 2>>"$err") && wip=$(cd ${id}/work && ${wipSnapshot(o.taskId)}) || wip=failed`,
      // No repo: without its files there would be nothing of the work left.
      `  else wip=nogit; fi`,
      `  [ -n "$stage" ] && [ -d "$stage"/${id} ] && x=(-C "$stage" ${id}) || x=()`,
      `  tar czf - ${excludes} "\${m[@]}" "\${x[@]}" "\${k[@]}" 2>>"$err" | head -c ${o.maxBytes + 1} | base64 | fold -w 76`,
    )
  } else {
    lines.push(`  tar czf - ${excludes} ${id} "\${k[@]}" 2>>"$err" | head -c ${o.maxBytes + 1} | base64 | fold -w 76`)
  }
  lines.push(
    `  st="\${PIPESTATUS[*]}"`,
    "fi",
    "echo",
    `echo "${ARCHIVE_END} $st $wip $(tail -c 600 "$err" 2>/dev/null | base64 | tr -d '\\n')"`,
    `[ "$err" = /dev/null ] || rm -f "$err"`,
    `[ -z "$stage" ] || rm -rf "$stage"`,
    "exit 0",
  )
  return lines.join("\n")
}

/**
 * Save uncommitted work as a commit without writing to the repo: a copy of the index and a new object dir live in
 * $stage (with the repo's objects as an alternate), and the ref is a file there that the archive carries into
 * work/.git. Prints the commit, or "clean" when there is nothing uncommitted; exits non-zero if it couldn't.
 */
function wipSnapshot(taskId: string): string {
  const g = `"$stage"/${q(taskId)}/work/.git`
  return [
    `s=$(git --no-optional-locks status --porcelain 2>>"$err") || exit 1`,
    `if [ -z "$s" ]; then echo clean; exit 0; fi`,
    `mkdir -p ${g}/objects ${g}/refs/boxyard 2>>"$err" || exit 1`,
    // Paths from git, not ./.git: a worktree's .git is a file, and objects may sit in a shared or alternate store.
    `i=$(git rev-parse --git-path index 2>>"$err") && o=$(cd "$(git rev-parse --git-path objects 2>>"$err")" && pwd) || exit 1`,
    `export GIT_INDEX_FILE="$stage/index" GIT_OBJECT_DIRECTORY=${g}/objects GIT_ALTERNATE_OBJECT_DIRECTORIES="$o"`,
    `{ cp "$i" "$GIT_INDEX_FILE" 2>/dev/null || git read-tree HEAD 2>/dev/null || true; }`,
    `git add -A 2>>"$err" || exit 1`,
    `t=$(git write-tree 2>>"$err") || exit 1`,
    `p=$(git rev-parse -q --verify HEAD) && p="-p $p" || p=`,
    `c=$(git -c user.name=box-yard -c user.email=box-yard@local commit-tree "$t" $p -m ${q(WIP_MESSAGE)} 2>>"$err") || exit 1`,
    `echo "$c" > ${g}/refs/boxyard/wip 2>>"$err" || exit 1`,
    `echo "$c"`,
  ].join("; ")
}

export interface ArchiveTrailer {
  tar: number
  head: number
  base64: number
  fold: number
  /** "-" (not tried), "clean", "failed", "nogit" (no repo to keep) or the WIP commit. */
  wip: string
  /** The end of stderr. */
  stderr: string
}

/** Turns the script's output back into archive bytes, line by line, as it arrives. */
export class ArchiveDecoder {
  bytes = 0
  trailer: ArchiveTrailer | null = null
  /** Output lines that were neither data nor the trailer (shell errors), for the error message. */
  noise: string[] = []
  private rest = ""

  constructor(private readonly sink: (data: Buffer) => void) {}

  push(chunk: string) {
    this.rest += chunk
    let i: number
    while ((i = this.rest.indexOf("\n")) >= 0) {
      const line = this.rest.slice(0, i)
      this.rest = this.rest.slice(i + 1)
      this.line(line.replace(/\r$/, ""))
    }
  }

  end() {
    if (this.rest) this.line(this.rest)
    this.rest = ""
  }

  private line(line: string) {
    if (!line) return
    if (line.startsWith(ARCHIVE_END)) {
      this.trailer = parseTrailer(line)
      return
    }
    if (!this.trailer && /^[A-Za-z0-9+/]+={0,2}$/.test(line)) {
      const data = Buffer.from(line, "base64")
      this.bytes += data.length
      this.sink(data)
      return
    }
    if (this.noise.length < 20) this.noise.push(line.slice(0, 300))
  }
}

function parseTrailer(line: string): ArchiveTrailer {
  const [, tar, head, base64, fold, wip, err] = line.split(" ")
  const code = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : 2)
  let stderr = ""
  try {
    stderr = err ? Buffer.from(err, "base64").toString("utf8") : ""
  } catch {}
  return { tar: code(tar), head: code(head), base64: code(base64), fold: code(fold), wip: wip ?? "-", stderr }
}

/** The last couple of meaningful lines of an error output, on one line. */
export function errorTail(text: string, max = 300): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  const tail = lines.slice(-2).join("; ")
  return tail.length > max ? `…${tail.slice(-max)}` : tail
}

export type ArchiveOutcome = { ok: true; bytes: number; wip: string } | { ok: false; tooBig: boolean; error: string }

/** Did the streamed archive come through whole? */
export function archiveOutcome(d: ArchiveDecoder, o: { maxBytes: number; partial: boolean; exitCode: number }): ArchiveOutcome {
  const t = d.trailer
  const detail = errorTail(t?.stderr || d.noise.join("\n"))
  if (!t) return { ok: false, tooBig: false, error: `the archive stream ended early (exit ${o.exitCode})${detail ? `: ${detail}` : ""}` }
  if (d.bytes > o.maxBytes) return { ok: false, tooBig: true, error: `workspace is too large to archive (over ${Math.round(o.maxBytes / 1e6)} MB compressed)` }
  // tar exits 1 when a file changed while it was read; the archive is still whole.
  if (t.tar > 1) return { ok: false, tooBig: false, error: detail || `tar exited with ${t.tar}` }
  if (t.head || t.base64 || t.fold) return { ok: false, tooBig: false, error: detail || `streaming the archive failed (exit ${t.head || t.base64 || t.fold})` }
  if (o.partial && t.wip === "nogit") return { ok: false, tooBig: false, error: "work/ has no git repo, so it can't be archived without its files" }
  if (o.partial && t.wip === "failed") return { ok: false, tooBig: false, error: `couldn't save uncommitted work on refs/boxyard/wip${detail ? `: ${detail}` : ""}` }
  if (!d.bytes) return { ok: false, tooBig: false, error: detail || "tar wrote nothing" }
  return { ok: true, bytes: d.bytes, wip: t.wip }
}

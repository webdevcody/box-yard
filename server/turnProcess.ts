import { q } from "./providers/types.js"

/**
 * A turn's process on its box (or this computer), told apart from whatever process gets its pid later.
 *
 * The runner (runner/box-runner.mjs turn) leads a process group of its own, and writes `run.json` and then `turn.pid`
 * in the task folder: its pid, its identity (the machine's boot plus the process's start time, by the same shell
 * lines as `by_boot`/`by_start` here), its turn id and where its events start in events.jsonl. A pid alone can't be
 * trusted once Box Yard restarts: after a reboot or a box resume another process may hold it, and Box Yard would wait
 * on that process forever, or stop it. A runner from before run records has only its pid, which is checked as before.
 * A turn.pid that isn't a plain pid (empty, 0, "-1": every process) is never signalled.
 */
export const TURN_SH = String.raw`by_boot() { cat /proc/sys/kernel/random/boot_id 2>/dev/null || sysctl -n kern.bootsessionuuid 2>/dev/null || true; }
by_start() { if [ -r "/proc/$1/stat" ]; then sed 's/.*) //' "/proc/$1/stat" | cut -d' ' -f20; else LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; fi; }
by_turn_alive() { p=$(cat "$1/turn.pid" 2>/dev/null); case "$p" in ''|0*|*[!0-9]*) return 1;; esac; kill -0 "$p" 2>/dev/null || return 1; grep -qF "\"pid\":$p,\"ident\":\"" "$1/run.json" 2>/dev/null || return 0; grep -qF "\"pid\":$p,\"ident\":\"$(by_boot)|$(by_start "$p")\"" "$1/run.json"; }
by_turn_kill() { if by_turn_alive "$1"; then kill -"$2" -- -"$p" 2>/dev/null || kill -"$2" "$p" 2>/dev/null; fi; true; }`

/**
 * Shell that stops the turn in task folder `dir` (its process group, else its pid) when it is still running there.
 * With `turnId`, only if that turn is still the one in the folder (turn.json), not a newer one.
 */
export function turnKillScript(dir: string, signal: "TERM" | "KILL" = "TERM", turnId?: string | null): string {
  const only = turnId ? `grep -qF ${q(`"turnId":${JSON.stringify(turnId)}`)} ${q(`${dir}/turn.json`)} && ` : ""
  return `${TURN_SH}\n${only}by_turn_kill ${q(dir)} ${signal}; true`
}

/** Shell that loops while the turn in task folder `dir` runs: `by_turn_alive` is defined for `body`. */
export function whileTurnRuns(dir: string, body: string): string {
  return `${TURN_SH}\nwhile by_turn_alive ${q(dir)}; do ${body}; done`
}

/** What run.json says about the turn that wrote it. */
export interface RunRecord {
  pid: number
  /** "<boot>|<start>" from by_boot/by_start, or null when the runner couldn't tell. */
  ident: string | null
  turnId: string | null
  startedAt: number | null
  /** Bytes of events.jsonl when the turn started: its first event is at or after this offset. */
  eventsOffset: number | null
}

export interface TurnProbe {
  /** The recorded process is running (same pid, boot and start time). */
  alive: boolean
  /** Its run record, or null for a runner from before run records (or one that never got going). */
  record: RunRecord | null
}

/** Shell whose output parseTurnProbe reads: whether the turn in `dir` runs, then its run.json. */
export function turnProbeScript(dir: string): string {
  return `${TURN_SH}\nif by_turn_alive ${q(dir)}; then echo alive; else echo dead; fi; cat ${q(`${dir}/run.json`)} 2>/dev/null; true`
}

export function parseTurnProbe(stdout: string): TurnProbe | null {
  const [first, ...rest] = stdout.split("\n")
  const state = first?.trim()
  if (state !== "alive" && state !== "dead") return null
  return { alive: state === "alive", record: parseRunRecord(rest.join("\n")) }
}

export function parseRunRecord(text: string): RunRecord | null {
  try {
    const r = JSON.parse(text) as Partial<RunRecord>
    if (typeof r?.pid !== "number") return null
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
    return {
      pid: r.pid,
      ident: typeof r.ident === "string" ? r.ident : null,
      turnId: typeof r.turnId === "string" ? r.turnId : null,
      startedAt: num(r.startedAt),
      eventsOffset: num(r.eventsOffset),
    }
  } catch {
    return null
  }
}

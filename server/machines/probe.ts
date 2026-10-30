// Test connection (MachineService.test): one script over SSH that reports what the machine has for agents. It reads
// only facts (OS, CPUs, memory, disk, where git, node, claude and codex are and their versions, whether claude is
// logged in) and makes Box Yard's work folder; it never prints a credential (`claude auth status` says only whether
// there is a login, and its JSON is reduced to that here).
import { q } from "../providers/types.js"
import type { MachineTest, MachineTool } from "../../shared/machines.js"

const TOOLS = ["git", "node", "claude", "codex"] as const
type ToolName = (typeof TOOLS)[number]

/** The oldest Node the runner (runner/box-runner.mjs) works with. */
export const MIN_NODE_MAJOR = 18

/** A work folder for the shell: `~/x` → "$HOME"/'x'. */
export const shellDir = (dir: string) => (dir.startsWith("~/") ? `"$HOME"/${q(dir.slice(2))}` : q(dir))

/**
 * The probe. Each fact is a `key=value` line after BOXYARD_PROBE, so whatever a profile prints can't be mistaken
 * for one. Tools a non-login shell can't find are looked for in the user's login shell too (nvm and the like
 * put node on PATH only there), with stdin closed and a time limit where `timeout` exists.
 */
export function probeScript(dir: string): string {
  return `
echo BOXYARD_PROBE
p() { printf '%s=%s\\n' "$1" "$2"; }
p uname "$(uname -srm 2>/dev/null)"
p hostname "$(hostname 2>/dev/null)"
p home "$HOME"
os=""
if [ -r /etc/os-release ]; then os=$(. /etc/os-release 2>/dev/null; printf '%s' "\${PRETTY_NAME:-$NAME}"); fi
if command -v sw_vers >/dev/null 2>&1; then os="macOS $(sw_vers -productVersion 2>/dev/null)"; fi
p osname "$os"
p cpus "$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)"
if [ -r /proc/meminfo ]; then p mem "$(awk '/^MemTotal:/ {printf "%.0f", $2 * 1024}' /proc/meminfo)"; else p mem "$(sysctl -n hw.memsize 2>/dev/null)"; fi
d=${shellDir(dir)}
if (umask 077 && mkdir -p "$d/.boxyard" "$d/tasks") 2>/dev/null; then
  p workdir "$(cd "$d" && pwd -P)"
  df -Pk "$d" 2>/dev/null | awk 'NR == 2 { printf "disk=%.0f %.0f\\n", $4 * 1024, $2 * 1024 }'
else
  p workdir_error "can't make $d"
fi
for t in tar base64 ps; do command -v "$t" >/dev/null 2>&1 || p missing "$t"; done
login=""
for t in ${TOOLS.join(" ")}; do command -v "$t" >/dev/null 2>&1 || login=1; done
if [ -n "$login" ] && [ -n "$SHELL" ] && [ -x "$SHELL" ]; then
  T=""; command -v timeout >/dev/null 2>&1 && T="timeout 20"
  $T "$SHELL" -lic 'command -v node; command -v claude; command -v git; command -v codex' </dev/null 2>/dev/null | while IFS= read -r l; do
    case "$l" in /*) p login "$l";; esac
  done
fi
`.trim()
}

/** The second half, once the login shell's folders are known: each tool's path and version, and claude's login. */
export function toolsScript(): string {
  return `
echo BOXYARD_PROBE
p() { printf '%s=%s\\n' "$1" "$2"; }
for t in ${TOOLS.join(" ")}; do
  w=$(command -v "$t" 2>/dev/null)
  if [ -n "$w" ]; then
    p "path_$t" "$w"
    p "version_$t" "$(DISABLE_AUTOUPDATER=1 "$w" --version </dev/null 2>/dev/null | head -n 1)"
  fi
done
if command -v claude >/dev/null 2>&1; then
  a=$(DISABLE_AUTOUPDATER=1 claude auth status </dev/null 2>/dev/null | tr -d '\\n' | grep -oE '"loggedIn"[[:space:]]*:[[:space:]]*(true|false)' | head -n 1)
  p claude_auth "$a"
fi
if [ "$(uname -s)" = Linux ] && grep -qs '^[^ ]* /dev/shm tmpfs' /proc/mounts && [ -w /dev/shm ]; then p shm "/dev/shm/boxyard-$(id -u)"; fi
`.trim()
}

/** The `key=value` lines after the marker; a key that repeats keeps every value. */
export function parseProbe(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const at = stdout.indexOf("BOXYARD_PROBE\n")
  if (at < 0) return out
  for (const line of stdout.slice(at + "BOXYARD_PROBE\n".length).split("\n")) {
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const k = line.slice(0, eq)
    if (!/^[a-z_]+$/.test(k)) continue
    out.set(k, [...(out.get(k) ?? []), line.slice(eq + 1).trim()])
  }
  return out
}

const one = (m: Map<string, string[]>, k: string) => m.get(k)?.[0] || null
const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null)
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/"

/** Folders the login shell found tools in that a plain shell's PATH doesn't have. */
export function loginDirs(first: Map<string, string[]>): string[] {
  const names = new Set<string>(TOOLS)
  const dirs = (first.get("login") ?? []).filter((p) => names.has(p.slice(p.lastIndexOf("/") + 1))).map(dirOf)
  return [...new Set(dirs)]
}

/** Node's major version from `v20.11.1`. */
export const nodeMajor = (version: string | null) => Number(/^v?(\d+)\./.exec(version ?? "")?.[1] ?? 0)

/** A MachineTest from the probe's two halves. */
export function testFromProbe(i: { first: Map<string, string[]>; tools: Map<string, string[]>; pathDirs: string[]; latencyMs: number; at: number }): MachineTest {
  const { first, tools } = i
  const tool = (t: ToolName): MachineTool => {
    const p = one(tools, `path_${t}`)
    return { found: Boolean(p), path: p, version: p ? one(tools, `version_${t}`) : null }
  }
  const all = { git: tool("git"), node: tool("node"), claude: tool("claude"), codex: tool("codex") }
  const disk = one(first, "disk")?.split(" ") ?? []
  const auth = one(tools, "claude_auth")
  const claudeLogin = !all.claude.found || !auth ? null : /true$/.test(auth)
  const problems: string[] = []
  const notes: string[] = []
  const workDir = one(first, "workdir")
  if (!workDir) problems.push(`Box Yard couldn't make its work folder (${one(first, "workdir_error") ?? "no reply"})`)
  if (!all.node.found) problems.push(`node isn't installed (Node ${MIN_NODE_MAJOR} or later runs Box Yard's runner)`)
  else if (nodeMajor(all.node.version) < MIN_NODE_MAJOR) problems.push(`node ${all.node.version} is too old (Node ${MIN_NODE_MAJOR} or later)`)
  if (!all.git.found) problems.push("git isn't installed")
  if (!all.claude.found) problems.push("claude (Claude Code) isn't installed: npm install -g @anthropic-ai/claude-code, or curl -fsSL https://claude.ai/install.sh | bash")
  const missing = first.get("missing") ?? []
  if (missing.length) problems.push(`${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} installed`)
  if (all.claude.found && claudeLogin === false) notes.push("claude isn't logged in on it: its tasks need a Claude key from Box Yard (Settings › Credentials or the project's identity), or run claude there once and /login")
  const free = num(disk[0] ?? null)
  if (free !== null && free < 2 * 1024 ** 3) notes.push("under 2 GB free in its work folder's disk")
  return {
    at: i.at,
    ok: true,
    error: null,
    latencyMs: i.latencyMs,
    os: one(first, "uname"),
    osName: one(first, "osname"),
    hostname: one(first, "hostname"),
    cpus: num(one(first, "cpus")),
    memoryBytes: num(one(first, "mem")),
    diskFreeBytes: free,
    diskTotalBytes: num(disk[1] ?? null),
    home: one(first, "home"),
    workDir,
    pathDirs: i.pathDirs,
    tools: all,
    claudeLogin,
    secretsDir: one(tools, "shm"),
    problems,
    notes,
  }
}

/** A failed test: it couldn't connect, or the probe didn't answer. */
export function failedTest(error: string, at: number, latencyMs: number | null = null): MachineTest {
  const none: MachineTool = { found: false, version: null, path: null }
  return {
    at,
    ok: false,
    error,
    latencyMs,
    os: null,
    osName: null,
    hostname: null,
    cpus: null,
    memoryBytes: null,
    diskFreeBytes: null,
    diskTotalBytes: null,
    home: null,
    workDir: null,
    pathDirs: [],
    tools: { git: none, node: none, claude: none, codex: none },
    claudeLogin: null,
    secretsDir: null,
    problems: [],
    notes: [],
  }
}

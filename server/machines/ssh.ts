// SSH to Cody's own machines (shared/machines.ts) with the system `ssh`. The rules that keep credentials safe live
// here, as pure builders the tests check:
// - every command goes to the machine on ssh's stdin, never in its argv: a command can carry a token (a clone's
//   GITHUB_TOKEN), and argv shows up in `ps` on both ends and in shell history;
// - a file's content (task.json holds the turn's credentials) is part of that stdin script too;
// - ssh runs with a bare environment (no Box Yard secret can ride along on a SendEnv), forwards nothing (no agent,
//   no X11, no ports) and never asks for a password (BatchMode);
// - the login key is a reference: ssh reads the key file itself, or asks the SSH agent.
import { spawn } from "node:child_process"
import fs from "node:fs"
import { q } from "../providers/types.js"

export interface SshEndpoint {
  host: string
  user: string
  port: number
}

/** How ssh logs in: a key file it reads itself (`-i`, the private key or, for an agent key, its public half). */
export interface SshAuth {
  identityFile: string | null
  /** Only that key (IdentitiesOnly), not every key the agent and ~/.ssh offer. */
  identitiesOnly: boolean
}

/** Host names, IPv4 and IPv6 addresses, ~/.ssh/config aliases. Never starts with "-", so it can't be an ssh option. */
export const SSH_HOST_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,252}|\[?[0-9A-Fa-f:.]{2,45}\]?)$/
export const SSH_USER_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/

export const SSH_CONNECT_TIMEOUT_S = 15

/**
 * The remote command for a script on stdin: the machine's login shell (bash, zsh, sh or fish all parse this the same)
 * starts bash, which reads the whole script before running it, so the script's commands see stdin at its end and
 * nothing a command reads can eat the rest of the script.
 */
export const REMOTE_SCRIPT = `bash -c 'eval "$(cat)"'`

/**
 * Where agents' tools are on a machine when a non-login shell's PATH lacks them: user-level installs (npm's prefix,
 * ~/.local/bin where Claude Code's installer puts `claude`, Volta, asdf), Homebrew, and the dirs the machine's test
 * found by asking its login shell (nvm and friends set PATH there), first.
 */
export function pathPreamble(found: string[] = []): string {
  const dirs = [...found, "$HOME/.local/bin", "$HOME/.npm-global/bin", "$HOME/.volta/bin", "$HOME/.asdf/shims", "$HOME/bin", "/opt/homebrew/bin", "/usr/local/bin"]
  // Each one quoted for the shell, but $HOME left to expand.
  const quoted = dirs.map((d) => (d.startsWith("$HOME/") ? `"$HOME"${q(d.slice("$HOME".length))}` : q(d)))
  return `export PATH=${quoted.join(":")}:"$PATH"`
}

/** The ssh arguments up to and including the destination; the remote command comes after. */
export function sshArgs(e: SshEndpoint, o: { auth: SshAuth; knownHosts: string; controlPath: string | null; connectTimeoutS?: number }): string[] {
  if (!SSH_HOST_RE.test(e.host)) throw new Error(`"${e.host}" isn't a host name or address`)
  if (!SSH_USER_RE.test(e.user)) throw new Error(`"${e.user}" isn't a user name`)
  const args = [
    "-p", String(e.port),
    "-l", e.user,
    "-o", "BatchMode=yes",
    // Trust on first use, in a known_hosts file of Box Yard's own: a changed host key stops every connection.
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${o.knownHosts}`,
    "-o", `ConnectTimeout=${o.connectTimeoutS ?? SSH_CONNECT_TIMEOUT_S}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-o", "LogLevel=ERROR",
    // Nothing of this computer's reaches the machine: no agent, no X11, no ports, no local commands.
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "PermitLocalCommand=no",
    "-o", "RequestTTY=no",
  ]
  if (o.auth.identityFile) args.push("-i", o.auth.identityFile)
  if (o.auth.identitiesOnly) args.push("-o", "IdentitiesOnly=yes")
  // One shared connection per machine, so Box Yard's many short commands don't each pay for a handshake.
  if (o.controlPath) args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${o.controlPath}`, "-o", "ControlPersist=300")
  else args.push("-o", "ControlMaster=no", "-o", "ControlPath=none")
  args.push(e.host)
  return args
}

/** The script exec sends: the PATH preamble, then the command. Never logged: it can hold a token. */
export function scriptFor(command: string, pathDirs: string[] = []): string {
  return `${pathPreamble(pathDirs)}\n${command}\n`
}

/**
 * A script that writes `content` to `file`, readable by the machine's user only, through a temp file so a reader never
 * sees half of it. The content travels inside the script (base64, so any bytes do), never in an argument.
 */
export function writeFileScript(file: string, content: string | Buffer): string {
  const b64 = (typeof content === "string" ? Buffer.from(content, "utf8") : content).toString("base64")
  const lines = b64.match(/.{1,76}/g) ?? []
  const dir = file.slice(0, file.lastIndexOf("/")) || "/"
  // `$$`: the shell's pid, so two writes of one file never share a temp file.
  const tmp = `${q(`${file}.tmp-`)}$$`
  return [
    "set -e",
    "umask 077",
    `mkdir -p ${q(dir)}`,
    `base64 --decode > ${tmp} <<'BOXYARD_B64_END'`,
    ...lines,
    "BOXYARD_B64_END",
    `mv -f ${tmp} ${q(file)}`,
  ].join("\n")
}

/** The remote command for a raw upload: stdin is the file. Only the path is in it (never secret). */
export function uploadCommand(destination: string): string {
  const dir = destination.slice(0, destination.lastIndexOf("/")) || "/"
  const script = `umask 077 && mkdir -p ${q(dir)} && cat > ${q(destination + ".part")} && mv -f ${q(destination + ".part")} ${q(destination)}`
  return `bash -c ${q(script)}`
}

/** The environment ssh itself runs with: enough to find the user's keys, config and agent, and nothing of Box Yard's. */
export function sshEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ["HOME", "USER", "LOGNAME", "PATH", "SSH_AUTH_SOCK", "LANG", "TMPDIR"]
  return Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]))
}

export interface SshRunOptions {
  /** The script (REMOTE_SCRIPT mode) or raw bytes for the remote command's stdin. */
  input?: string | Buffer | fs.ReadStream
  /** The remote command; REMOTE_SCRIPT unless set. */
  remote?: string
  onOutput?: (chunk: string) => void
  signal?: AbortSignal
  timeoutMs?: number
}

export interface SshRunResult {
  exitCode: number
  stdout: Buffer
  stderr: string
}

/** ssh's own failures (exit 255): it couldn't connect, log in, or the connection dropped. */
export const SSH_FAILED = 255

/** Run ssh with `args` (sshArgs), the remote command after them. Resolves with exit code 255 and ssh's stderr when it can't connect. */
export function runSsh(bin: string, args: string[], opts: SshRunOptions = {}): Promise<SshRunResult> {
  return new Promise((resolve) => {
    // An empty remote command: none at all (ssh -O stop).
    const remote = opts.remote ?? REMOTE_SCRIPT
    const child = spawn(bin, remote ? [...args, remote] : args, { stdio: ["pipe", "pipe", "pipe"], env: sshEnv() })
    const out: Buffer[] = []
    let stderr = ""
    let done = false
    const finish = (r: SshRunResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      resolve(r)
    }
    const onAbort = () => child.kill("SIGTERM")
    if (opts.signal?.aborted) onAbort()
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          stderr += `\n(timed out after ${Math.round(opts.timeoutMs! / 1000)} s)`
          child.kill("SIGKILL")
        }, opts.timeoutMs)
      : undefined
    child.stdout.on("data", (d: Buffer) => {
      if (opts.onOutput) opts.onOutput(d.toString("utf8"))
      else out.push(d)
    })
    child.stderr.on("data", (d: Buffer) => {
      if (opts.onOutput) opts.onOutput(d.toString("utf8"))
      else if (stderr.length < 64_000) stderr += d.toString("utf8")
    })
    child.on("error", (err) => finish({ exitCode: SSH_FAILED, stdout: Buffer.concat(out), stderr: stderr + err.message }))
    child.on("close", (code, signal) => finish({ exitCode: code ?? (signal ? SSH_FAILED : 1), stdout: Buffer.concat(out), stderr }))
    child.stdin.on("error", () => {})
    if (opts.input instanceof fs.ReadStream) opts.input.pipe(child.stdin)
    else child.stdin.end(opts.input ?? "")
  })
}

/** ssh's own error, shortened for a test result or a wait reason ("Permission denied (publickey)"). */
export function sshError(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^Warning: Permanently added/.test(l))
  const line = lines.find((l) => /denied|refused|timed out|resolve|No route|unreachable|Host key|REMOTE HOST IDENTIFICATION|closed|reset|not known|Could not/i.test(l)) ?? lines.at(-1) ?? "ssh failed"
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr)) return "its host key changed since Box Yard first connected (Forget host key in Settings › Machines if you expected that)"
  return line.replace(/^ssh: /, "").slice(0, 300)
}

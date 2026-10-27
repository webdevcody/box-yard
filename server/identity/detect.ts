import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { agentEnv } from "../providers/local.js"
import { BadRequestError, githubSlug } from "../store.js"
import {
  DEFAULT_IDENTITY_ID,
  GITHUB_OWNER_RE,
  type DetectedAccount,
  type DetectedAuthor,
  type DetectedSigning,
  type DetectedSshHost,
  type Identity,
  type IdentityDetection,
  type IdentityProposal,
  type IdentitySigningInput,
  type ProposedProject,
} from "../../shared/identities.js"
import { githubOrgs, githubRepoAccess, githubTokenInfo, githubUserKeys, githubVerifiedEmails, type GithubFetch, type RepoAccess } from "./github.js"
import { SshKeyError, fingerprintOfPublicKey, keyFileInfo, normalizePublicKey } from "./sshKeys.js"

// What this computer's gh, git and ssh already use, for detect_identities and import_detected_identity
// (docs/identities.md › Set up from this computer). It reads: gh's accounts (`gh auth status`, its token lines
// dropped), the global git config and the files its includeIf blocks name, the remotes of repos under those blocks'
// folders, ~/.ssh/config and public keys. A token or private key is read only to resolve a reference the server was
// asked to use (tokenFromRef, signingFromRef, and online detection's own GitHub calls), and is never in a result.

/** How detection reaches this computer. Tests point it at a fake home folder and a fake gh. */
export interface DetectOptions {
  home?: string
  env?: NodeJS.ProcessEnv
  github?: GithubFetch
  timeoutMs?: number
}

interface Ctx {
  home: string
  env: NodeJS.ProcessEnv
  github: GithubFetch
  timeoutMs: number
}

function ctx(o: DetectOptions): Ctx {
  const home = o.home ?? os.homedir()
  // Box Yard's own tokens (agentEnv) and gh's env tokens go: gh then reports the accounts it keeps itself.
  const env: NodeJS.ProcessEnv = { ...agentEnv(o.env ?? process.env), HOME: home, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" }
  for (const k of ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_DIR", "GIT_WORK_TREE"]) delete env[k]
  return { home, env, github: o.github ?? fetch, timeoutMs: o.timeoutMs ?? 15_000 }
}

interface Ran {
  ok: boolean
  missing: boolean
  stdout: string
  stderr: string
}

/** Run a program with no shell and nothing on stdin. Its output stays here: callers pick out what they need. */
function run(bin: string, args: string[], c: Ctx): Promise<Ran> {
  return new Promise((resolve) => {
    try {
      const child = execFile(bin, args, { cwd: os.tmpdir(), env: c.env, timeout: c.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
        resolve({ ok: !err, missing: (err as NodeJS.ErrnoException | null)?.code === "ENOENT", stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
      )
      child.stdin?.on("error", () => {})
      child.stdin?.end()
    } catch {
      resolve({ ok: false, missing: true, stdout: "", stderr: "" })
    }
  })
}

// ---------- parsers (pure) ----------

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
/** A token gh or git might print: never kept, even as a "storage" label. */
const TOKEN_SHAPE = /\b(gh[opsur]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/

export interface GhStatusAccount {
  host: string
  login: string
  active: boolean
  protocol: string | null
  scopes: string[] | null
  storage: string | null
  problem: string | null
}

/**
 * `gh auth status`, as text: one entry per account and host. Token lines are dropped before anything is read, so a
 * `--show-token` output (or a gh that prints the token) leaves nothing behind.
 */
export function parseGhAuthStatus(text: string): GhStatusAccount[] {
  const out: GhStatusAccount[] = []
  let cur: GhStatusAccount | null = null
  let oneAccountHost = false
  const scopesOf = (v: string) => (v.trim() === "none" ? [] : v.includes("'") ? [...v.matchAll(/'([^']+)'/g)].map((m) => m[1]!) : v.split(",").map((s) => s.trim()).filter(Boolean))
  for (const raw of text.replace(ANSI, "").split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line.trim() || /^\s*[-✓✔X!]?\s*Token:/i.test(line) || TOKEN_SHAPE.test(line)) continue
    if (!/^\s/.test(line)) {
      cur = null
      continue
    }
    let m = /^\s*\S+\s+Logged in to (\S+) (account|as) (\S+) \(([^)]*)\)/.exec(line)
    if (m) {
      // gh before 2.40 knew one account per host ("Logged in to github.com as octocat"): that one is active.
      oneAccountHost = m[2] === "as"
      cur = { host: m[1]!, login: m[3]!, active: oneAccountHost, protocol: null, scopes: null, storage: storageOf(m[4]!), problem: null }
      out.push(cur)
      continue
    }
    m = /^\s*\S+\s+(Failed to log in|Timeout trying to log in) to (\S+) (?:account|as) (\S+) \(([^)]*)\)/.exec(line)
    if (m) {
      const problem = m[1]!.startsWith("Timeout") ? "gh timed out checking its token" : "gh says its token is invalid: sign in again with `gh auth login`"
      cur = { host: m[2]!, login: m[3]!, active: false, protocol: null, scopes: null, storage: storageOf(m[4]!), problem }
      out.push(cur)
      continue
    }
    if (!cur) continue
    if ((m = /^\s*-\s*Active account:\s*(true|false)/i.exec(line))) cur.active = m[1]!.toLowerCase() === "true"
    else if ((m = /^\s*-\s*Git operations protocol:\s*(\S+)/i.exec(line))) cur.protocol = m[1]!
    else if ((m = /Git operations for \S+ configured to use (\S+) protocol/i.exec(line))) cur.protocol = m[1]!
    else if ((m = /Token scopes:\s*(.*)$/i.exec(line))) cur.scopes = scopesOf(m[1]!)
    else if ((m = /Missing required token scopes:\s*(.*)$/i.exec(line))) cur.problem ??= `its token lacks ${scopesOf(m[1]!).join(", ")}: run \`gh auth refresh -h ${cur.host}\``
  }
  return out
}

const storageOf = (s: string) => (TOKEN_SHAPE.test(s) ? null : s.trim() || null)

export interface GitConfigEntry {
  /** The file it's in ("" when git didn't say). */
  file: string
  /** As git lists it: section and name lower-case, a subsection as written ("includeif.gitdir:~/Work/.path"). */
  key: string
  value: string | null
}

/** `git config --list --null [--show-origin]`: "file:<path>\0key\nvalue\0" per entry ("key\0" for a bare key). */
export function parseGitConfigList(out: string, withOrigin = true): GitConfigEntry[] {
  const parts = out.split("\0")
  const entries: GitConfigEntry[] = []
  let i = 0
  while (i < parts.length) {
    let file = ""
    if (withOrigin) {
      const origin = parts[i++] ?? ""
      if (!origin && i >= parts.length) break
      file = origin.replace(/^file:/, "")
    }
    const kv = parts[i++]
    if (kv === undefined || (!kv && i >= parts.length)) break
    const nl = kv.indexOf("\n")
    entries.push({ file, key: nl < 0 ? kv : kv.slice(0, nl), value: nl < 0 ? null : kv.slice(nl + 1) })
  }
  return entries
}

/** Words of a command line, as a POSIX shell splits them (quotes and backslashes), without expanding anything. */
export function shellWords(cmd: string): string[] {
  const words: string[] = []
  let word: string | null = null
  let quote: '"' | "'" | null = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === "\\" && quote === '"' && i + 1 < cmd.length) word += cmd[++i]!
      else word += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      word ??= ""
    } else if (ch === "\\" && i + 1 < cmd.length) word = (word ?? "") + cmd[++i]!
    else if (/\s/.test(ch)) {
      if (word !== null) words.push(word)
      word = null
    } else word = (word ?? "") + ch
  }
  if (word !== null) words.push(word)
  return words
}

/** The key file a core.sshCommand (or GIT_SSH_COMMAND) logs in with: its -i, or -o IdentityFile=. */
export function sshCommandKey(cmd: string): string | null {
  const w = shellWords(cmd)
  for (let i = 0; i < w.length; i++) {
    if (w[i] === "-i") return w[i + 1] ?? null
    if (/^-i./.test(w[i]!)) return w[i]!.slice(2)
    const opt = w[i] === "-o" ? w[i + 1] : /^-o./.test(w[i]!) ? w[i]!.slice(2) : null
    const m = opt ? /^identityfile\s*[= ]\s*(.+)$/i.exec(opt) : null
    if (m) return m[1]!
  }
  return null
}

export interface SshConfigHost {
  patterns: string[]
  hostName: string | null
  identityFiles: string[]
  identityAgent: string | null
}

/**
 * ~/.ssh/config's Host blocks (lines before the first one are a "*" block). Match blocks are skipped and Include isn't
 * followed: this is evidence, not ssh's own resolution. As in ssh, the first HostName or IdentityAgent wins.
 */
export function parseSshConfig(text: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = []
  let cur: SshConfigHost | null = { patterns: ["*"], hostName: null, identityFiles: [], identityAgent: null }
  hosts.push(cur)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const value = shellWords(m[2]!.trim())
    if (key === "host") {
      cur = { patterns: value, hostName: null, identityFiles: [], identityAgent: null }
      hosts.push(cur)
    } else if (key === "match") cur = null
    else if (!cur) continue
    else if (key === "hostname") cur.hostName ??= value[0] ?? null
    else if (key === "identityfile" && value[0]) cur.identityFiles.push(value[0])
    else if (key === "identityagent") cur.identityAgent ??= value[0] ?? null
  }
  return hosts.filter((h) => h.patterns[0] !== "*" || h.hostName || h.identityFiles.length || h.identityAgent)
}

/** A Host block that reaches GitHub over SSH: its HostName is github.com, or it is github.com itself. */
const reachesGithub = (h: SshConfigHost) => /^(ssh\.)?github\.com$/i.test(h.hostName ?? "") || (!h.hostName && h.patterns.some((p) => p.toLowerCase() === "github.com"))

/** The GitHub owner of a remote URL (https, ssh://, scp-like git@host:owner/repo), with ssh aliases that reach GitHub. */
export function githubOwnerOf(url: string, aliases: ReadonlySet<string> = new Set()): string | null {
  const u = url.trim()
  let host: string | null = null
  let rest: string | null = null
  let m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u)
  if (m) [host, rest] = [m[1]!, m[2]!]
  else if ((m = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(u))) [host, rest] = [m[1]!, m[2]!]
  if (!host || !rest) return null
  if (!/^(www\.|ssh\.)?github\.com$/i.test(host) && !aliases.has(host.toLowerCase())) return null
  const owner = rest.split("/")[0] ?? ""
  return GITHUB_OWNER_RE.test(owner) ? owner.toLowerCase() : null
}

/** The remote URLs in a repo's .git/config, read as text (never run in the repo: its config could name programs). */
export function remoteUrls(configText: string): string[] {
  const urls: string[] = []
  let inRemote = false
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim()
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]/.exec(line)
    if (section) inRemote = section[1]!.toLowerCase() === "remote"
    else if (inRemote) {
      const m = /^url\s*=\s*(.+)$/i.exec(line)
      if (m) urls.push(m[1]!.replace(/^"(.*)"$/, "$1"))
    }
  }
  return urls
}

const gitBool = (v: string | undefined) => v !== undefined && /^(true|yes|on|1)$/i.test(v.trim() || "true")

// ---------- reading this computer ----------

/** ~/x and %d/x (ssh's home token) as a full path; anything else is left as it is. */
const expandHome = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") || p.startsWith("%d/") ? path.join(home, p.slice(2)) : p)
/** A path under the home folder as ~/…, for results. */
const tilde = (p: string, home: string) => (p === home ? "~" : p.startsWith(home + path.sep) ? `~/${p.slice(home.length + 1)}` : p)
const real = (p: string) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** The key files ssh uses when nothing names one. */
const DEFAULT_SSH_KEYS = ["id_rsa", "id_ecdsa", "id_ecdsa_sk", "id_ed25519", "id_ed25519_sk", "id_dsa"]

interface GitScope {
  /** "global" or the includeIf condition. */
  scope: string
  file: string
  values: Map<string, string>
}

interface ConfigRead {
  scopes: GitScope[]
  credentialHelpers: string[]
  /** -i keys of every core.sshCommand. */
  sshCommandKeys: string[]
  notes: string[]
}

/** The global git config (with its plain includes), and each includeIf block's file on top of it. */
async function readGitConfig(c: Ctx): Promise<ConfigRead> {
  const notes: string[] = []
  const g = await run("git", ["config", "--global", "--includes", "--list", "--null", "--show-origin"], c)
  if (g.missing) return { scopes: [], credentialHelpers: [], sshCommandKeys: [], notes: ["git isn't installed on this computer."] }
  const entries = g.ok ? parseGitConfigList(g.stdout) : []
  const global = new Map<string, string>()
  const blocks: { cond: string; file: string }[] = []
  const helpers = new Set<string>()
  const sshKeys: string[] = []
  const take = (into: Map<string, string>, e: GitConfigEntry) => {
    if (e.value === null) return
    if (/^(user\.(name|email|signingkey)|gpg\.(format|program)|gpg\.ssh\.(program|defaultkeycommand|allowedsignersfile)|commit\.gpgsign|core\.sshcommand)$/.test(e.key)) into.set(e.key, e.value)
    if (e.key === "core.sshcommand") {
      const k = sshCommandKey(e.value)
      if (k) sshKeys.push(expandHome(k, c.home))
    }
    // A helper's name only: an inline shell helper could hold a password.
    if (e.key === "credential.helper" || /^credential\..+\.helper$/.test(e.key)) {
      const name = e.value.trim()
      if (name) helpers.add(/^[\w./-]+$/.test(name) ? path.basename(name).replace(/^git-credential-/, "") : name.startsWith("!") && /^!\s*gh\s+auth\s+git-credential\s*$/.test(name) ? "gh" : "a shell command")
    }
  }
  for (const e of entries) {
    const m = /^includeif\.(.+)\.path$/.exec(e.key)
    if (m && e.value) {
      const p = expandHome(e.value, c.home)
      blocks.push({ cond: m[1]!, file: path.isAbsolute(p) ? p : path.join(path.dirname(e.file || c.home), p) })
    } else take(global, e)
  }
  const scopes: GitScope[] = []
  const globalFile = c.env.GIT_CONFIG_GLOBAL ?? (fs.existsSync(path.join(c.home, ".gitconfig")) ? path.join(c.home, ".gitconfig") : path.join(c.env.XDG_CONFIG_HOME ?? path.join(c.home, ".config"), "git", "config"))
  if (entries.length) scopes.push({ scope: "global", file: globalFile, values: global })
  for (const b of blocks) {
    if (!fs.existsSync(b.file)) {
      notes.push(`The includeIf "${b.cond}" block names ${tilde(b.file, c.home)}, which isn't there.`)
      continue
    }
    const r = await run("git", ["config", "--file", b.file, "--includes", "--list", "--null", "--show-origin"], c)
    const values = new Map(global)
    for (const e of r.ok ? parseGitConfigList(r.stdout) : []) take(values, e)
    scopes.push({ scope: b.cond, file: b.file, values })
  }
  return { scopes, credentialHelpers: [...helpers], sshCommandKeys: sshKeys, notes }
}

/** The folder a gitdir: condition covers, when it names one (a pattern without ~/, ./ or / matches anywhere). */
function gitdirRoot(cond: string, file: string, home: string): string | null {
  const m = /^gitdir(?:\/i)?:(.+)$/.exec(cond)
  if (!m) return null
  let p = m[1]!
  if (p.startsWith("~/")) p = path.join(home, p.slice(2))
  else if (p.startsWith("./")) p = path.join(path.dirname(file), p.slice(2))
  else if (!p.startsWith("/")) return null
  const fixed = p.split(/[*?[]/)[0]!
  const dir = fixed.endsWith("/") ? fixed : path.dirname(fixed)
  return dir.replace(/\/\.git\/?$/, "") || null
}

/** GitHub owners of the repos under a folder: up to three levels down, at most 400 folders looked at. */
async function ownersUnder(root: string, aliases: ReadonlySet<string>): Promise<string[]> {
  const owners = new Set<string>()
  const queue: [string, number][] = [[root, 0]]
  let looked = 0
  while (queue.length && looked < 400) {
    const [dir, depth] = queue.shift()!
    looked++
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    if (entries.some((e) => e.name === ".git" && e.isDirectory())) {
      const text = await fs.promises.readFile(path.join(dir, ".git", "config"), "utf8").catch(() => "")
      for (const url of remoteUrls(text)) {
        const o = githubOwnerOf(url, aliases)
        if (o) owners.add(o)
      }
      continue
    }
    if (depth >= 3) continue
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") queue.push([path.join(dir, e.name), depth + 1])
  }
  return [...owners].sort()
}

/** What a git scope signs with, if it signs. `loginKeys` are real paths of the keys this computer logs in with. */
async function signingOf(v: Map<string, string>, c: Ctx, loginKeys: ReadonlySet<string>): Promise<DetectedSigning | null> {
  const key = v.get("user.signingkey")?.trim() || null
  const signsByDefault = gitBool(v.get("commit.gpgsign"))
  if (!key && !signsByDefault) return null
  const fmt = (v.get("gpg.format") ?? "openpgp").toLowerCase()
  const program = v.get("gpg.ssh.program")?.trim() || null
  const s: DetectedSigning = {
    format: fmt === "ssh" ? "ssh" : fmt === "x509" ? "x509" : "openpgp",
    kind: null,
    ref: null,
    publicKey: null,
    fingerprint: null,
    program: program && path.basename(program) !== "ssh-keygen" ? expandHome(program, c.home) : null,
    signsByDefault,
    problem: null,
    warning: null,
  }
  if (s.format !== "ssh") return { ...s, program: null, problem: `It signs with ${s.format === "x509" ? "an X.509 certificate" : "GPG"}: Box Yard signs with SSH keys only so far.` }
  if (!key) return { ...s, problem: v.get("gpg.ssh.defaultkeycommand") ? "git picks the key with gpg.ssh.defaultKeyCommand: name it with user.signingkey so Box Yard knows which one." : "commit.gpgsign is on, but no user.signingkey names a key." }
  const agent = (publicKey: string): DetectedSigning => ({ ...s, kind: "agent", publicKey, fingerprint: fingerprintOfPublicKey(publicKey), ref: `agent:${fingerprintOfPublicKey(publicKey)}` })
  if (key.startsWith("key::")) {
    const pub = normalizePublicKey(key.slice(5))
    return pub ? agent(pub) : { ...s, problem: "user.signingkey isn't a public key Box Yard can read." }
  }
  const file = expandHome(key, c.home)
  if (!fs.existsSync(file)) return { ...s, problem: `user.signingkey names ${tilde(file, c.home)}, which isn't there.` }
  const head = readHead(file)
  if (!head.startsWith("-----BEGIN")) {
    // A public key file: git signs with its private half through the agent (or the program), unless that half is a
    // key file without a passphrase beside it, which Box Yard can keep.
    const pub = normalizePublicKey(fs.readFileSync(file, "utf8").slice(0, 16_000))
    if (!pub) return { ...s, problem: `${tilde(file, c.home)} isn't an SSH key.` }
    const priv = file.replace(/\.pub$/, "")
    if (!s.program && priv !== file && fs.existsSync(priv)) {
      const info = await keyFileInfo(priv).catch(() => null)
      if (info?.copyable && info.publicKey === pub) return fileKey(s, priv, info, c, loginKeys)
    }
    return agent(pub)
  }
  let info: Awaited<ReturnType<typeof keyFileInfo>>
  try {
    info = await keyFileInfo(file)
  } catch (err) {
    return { ...s, problem: err instanceof SshKeyError ? err.message : `ssh-keygen couldn't read ${tilde(file, c.home)}.` }
  }
  if (info.copyable) return fileKey(s, file, info, c, loginKeys)
  return { ...agent(info.publicKey), problem: s.program ? null : `${tilde(file, c.home)} has a passphrase: Box Yard can sign with it only through this computer's SSH agent (ssh-add it first), on this computer.` }
}

function fileKey(s: DetectedSigning, file: string, info: { publicKey: string; fingerprint: string }, c: Ctx, loginKeys: ReadonlySet<string>): DetectedSigning {
  const warning = loginKeys.has(real(file)) ? `${tilde(file, c.home)} is also a key this computer logs in to SSH servers with. A turn on an Upstash box would hold a copy of it: give the identity a signing key of its own.` : null
  return { ...s, kind: "file", ref: `file:${tilde(file, c.home)}`, publicKey: info.publicKey, fingerprint: info.fingerprint, warning }
}

/** The first bytes of a file: enough to tell a private key from a public one without reading the key. */
function readHead(file: string): string {
  try {
    const fd = fs.openSync(file, "r")
    try {
      const buf = Buffer.alloc(16)
      return buf.subarray(0, fs.readSync(fd, buf, 0, 16, 0)).toString("utf8")
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ""
  }
}

/** A key file's fingerprint, from its .pub (or ssh-keygen, for a key without a passphrase); null when neither says. */
async function keyFingerprint(file: string): Promise<string | null> {
  try {
    const pub = normalizePublicKey(fs.readFileSync(`${file}.pub`, "utf8"))
    if (pub) return fingerprintOfPublicKey(pub)
  } catch {}
  return (await keyFileInfo(file).catch(() => null))?.fingerprint ?? null
}

/** Real paths of the keys this computer logs in to SSH servers with: ~/.ssh/id_*, every IdentityFile and -i key. */
function loginKeySet(c: Ctx, ssh: SshConfigHost[], sshCommandKeys: string[]): Set<string> {
  const keys = new Set<string>()
  for (const k of DEFAULT_SSH_KEYS) if (fs.existsSync(path.join(c.home, ".ssh", k))) keys.add(real(path.join(c.home, ".ssh", k)))
  for (const f of ssh.flatMap((h) => h.identityFiles)) keys.add(real(expandHome(f, c.home)))
  for (const f of sshCommandKeys) keys.add(real(f))
  return keys
}

/** Everything detection reads from this computer, before GitHub is asked anything. */
export interface ComputerFacts {
  accounts: DetectedAccount[]
  authors: DetectedAuthor[]
  sshHosts: DetectedSshHost[]
  credentialHelpers: string[]
  /** Real paths of the keys this computer logs in to SSH servers with: ~/.ssh/id_*, IdentityFile and -i keys. */
  loginKeys: string[]
  notes: string[]
}

export const tokenRefOf = (host: string, login: string) => `gh:${host}:${login}`

/** Read gh, git and ssh. Nothing here needs a token or the network, except gh's own check of its tokens. */
export async function readComputer(o: DetectOptions = {}): Promise<ComputerFacts> {
  const c = ctx(o)
  const notes: string[] = []
  const [status, git, sshText] = await Promise.all([
    run("gh", ["auth", "status"], c),
    readGitConfig(c),
    fs.promises.readFile(path.join(c.home, ".ssh", "config"), "utf8").catch(() => ""),
  ])
  if (status.missing) notes.push("gh isn't installed on this computer, so no GitHub accounts were found: install it and run `gh auth login`, or paste tokens in Settings › Identities.")
  const accounts: DetectedAccount[] = parseGhAuthStatus(`${status.stdout}\n${status.stderr}`).map((a) => ({
    ...a,
    tokenRef: tokenRefOf(a.host, a.login),
    githubId: null,
    name: null,
    orgs: null,
    verifiedEmails: null,
    signingKeys: null,
    sshKeys: null,
  }))
  if (!status.missing && !accounts.length) notes.push("gh isn't signed in to any GitHub account here (`gh auth login` adds one; repeat it for each account).")
  notes.push(...git.notes)

  const ssh = parseSshConfig(sshText)
  const github = ssh.filter(reachesGithub)
  const aliases = new Set(github.flatMap((h) => h.patterns).filter((p) => !/[*?!]/.test(p)).map((p) => p.toLowerCase()))
  const loginKeys = loginKeySet(c, ssh, git.sshCommandKeys)

  const sshHosts: DetectedSshHost[] = []
  for (const h of github) {
    const keyFile = h.identityFiles[0] ? expandHome(h.identityFiles[0], c.home) : null
    for (const alias of h.patterns.filter((p) => !/[*?!]/.test(p))) {
      sshHosts.push({ alias, keyFile: keyFile && tilde(keyFile, c.home), keyFingerprint: keyFile ? await keyFingerprint(keyFile) : null, agent: h.identityAgent && tilde(expandHome(h.identityAgent, c.home), c.home) })
    }
  }

  const authors: DetectedAuthor[] = []
  for (const s of git.scopes) {
    const cmdKey = s.values.get("core.sshcommand") ? sshCommandKey(s.values.get("core.sshcommand")!) : null
    const sshKey = cmdKey ? expandHome(cmdKey, c.home) : null
    const root = gitdirRoot(s.scope, s.file, c.home)
    const hasconfig = /^hasconfig:remote\.\*\.url:(.+)$/.exec(s.scope)?.[1]
    const repoOwners = root ? await ownersUnder(root, aliases) : hasconfig ? [githubOwnerOf(hasconfig, aliases)].filter((x): x is string => Boolean(x)) : []
    authors.push({
      scope: s.scope.replace(new RegExp(`^(gitdir(?:/i)?:)${escapeRe(c.home)}/`), "$1~/"),
      file: tilde(s.file, c.home),
      name: s.values.get("user.name") ?? null,
      email: s.values.get("user.email") ?? null,
      signing: await signingOf(s.values, c, loginKeys),
      sshKey: sshKey && tilde(sshKey, c.home),
      sshKeyFingerprint: sshKey ? await keyFingerprint(sshKey) : null,
      repoOwners,
    })
  }
  return { accounts, authors, sshHosts, credentialHelpers: git.credentialHelpers, loginKeys: [...loginKeys], notes }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// ---------- asking GitHub (online) ----------

/** A project as detection maps it. */
export interface DetectProject {
  id: string
  name: string
  repo: string | null
  identityId: string
}

/** Push access per login, then per project id. */
export type PushMap = Map<string, Map<string, RepoAccess["kind"]>>

/**
 * Fill each account in from GitHub with its own token (read from gh on the server, used for these calls only): id,
 * name, orgs, verified emails, its public SSH keys, and what it may do with each project's repo.
 */
async function askGithub(facts: ComputerFacts, projects: DetectProject[], c: Ctx): Promise<{ push: PushMap; notes: string[] }> {
  const push: PushMap = new Map()
  const notes: string[] = []
  const slugs = projects.flatMap((p) => {
    const slug = githubSlug(p.repo)
    return slug ? [{ id: p.id, slug }] : []
  })
  for (const a of facts.accounts) {
    if (a.host !== "github.com" || a.problem) continue
    let token: string
    try {
      token = (await tokenFromGh(a.host, a.login, c)).token
    } catch {
      a.problem = "gh has no token for it that Box Yard can read"
      continue
    }
    try {
      const info = await githubTokenInfo(token, c.github)
      if (info.login.toLowerCase() !== a.login.toLowerCase()) {
        a.problem = `gh's token for it is ${info.login}'s`
        continue
      }
      Object.assign(a, { githubId: info.id, name: info.name, scopes: info.scopes ?? a.scopes })
    } catch (err) {
      a.problem = err instanceof Error ? err.message : "GitHub didn't accept its token"
      continue
    }
    const [orgs, emails, signing, keys] = await Promise.all([
      githubOrgs(token, c.github),
      githubVerifiedEmails(token, c.github),
      githubUserKeys(token, a.login, "ssh_signing_keys", c.github),
      githubUserKeys(token, a.login, "keys", c.github),
    ])
    const fps = (ks: string[] | null) => ks?.flatMap((k) => (normalizePublicKey(k) ? [fingerprintOfPublicKey(k)] : [])) ?? null
    Object.assign(a, { orgs, verifiedEmails: emails, signingKeys: fps(signing), sshKeys: fps(keys) })
    const access = new Map<string, RepoAccess["kind"]>()
    await mapLimit(slugs, 4, async (s) => access.set(s.id, (await githubRepoAccess(token, s.slug, c.github)).kind))
    push.set(a.login.toLowerCase(), access)
  }
  if (!slugs.length && projects.length) notes.push("No project has a GitHub repo yet, so none was checked for push access.")
  return { push, notes }
}

async function mapLimit<T>(items: T[], n: number, fn: (x: T) => Promise<unknown>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!)
  }))
}

// ---------- proposals (pure) ----------

export interface ProposalInput {
  facts: ComputerFacts
  online: boolean
  push: PushMap | null
  projects: DetectProject[]
  identities: Pick<Identity, "id" | "name" | "isDefault" | "githubLogin">[]
  /** The login the Default identity's token is: undefined when it's gh's (its active account), null when unknown. */
  defaultLogin?: string | null
}

/**
 * One proposal per github.com account gh has, with the author and signing key that go with it and the projects it
 * should serve. An includeIf block goes with an account when its email is one of the account's verified emails, its
 * SSH key is one of the account's, or its repos belong to the account or its orgs. A project goes to the account that
 * can push to it (online) or whose owners include its repo's owner; when the Default identity's account can, it stays.
 */
export function proposeIdentities(i: ProposalInput): Pick<IdentityDetection, "proposals" | "unmatched" | "notes"> {
  const notes: string[] = []
  const accounts = i.facts.accounts.filter((a) => a.host === "github.com")
  for (const a of i.facts.accounts) if (a.host !== "github.com") notes.push(`gh is also signed in to ${a.host} (${a.login}): Box Yard's identities are for github.com only, so it isn't proposed.`)
  const global = i.facts.authors.find((a) => a.scope === "global") ?? null
  const blocks = i.facts.authors.filter((a) => a.scope !== "global")
  const defaultLogin = (i.defaultLogin === undefined ? accounts.find((a) => a.active)?.login : i.defaultLogin)?.toLowerCase() ?? null
  const identityName = (id: string) => i.identities.find((x) => x.id === id)?.name ?? "Default"

  const why = (a: DetectedAccount, b: DetectedAuthor): string[] => {
    const r: string[] = []
    const login = a.login.toLowerCase()
    if (b.email && a.verifiedEmails?.includes(b.email.toLowerCase())) r.push(`its email ${b.email} is one of ${a.login}'s verified emails`)
    if (b.sshKeyFingerprint && a.sshKeys?.includes(b.sshKeyFingerprint)) r.push(`its SSH key ${b.sshKey} is one of ${a.login}'s on GitHub`)
    if (b.signing?.fingerprint && a.signingKeys?.includes(b.signing.fingerprint)) r.push(`its signing key is one of ${a.login}'s on GitHub`)
    if (b.repoOwners.includes(login)) r.push(`repos under it belong to ${a.login}`)
    const orgs = b.repoOwners.filter((o) => a.orgs?.some((x) => x.toLowerCase() === o))
    if (orgs.length) r.push(`repos under it belong to ${orgs.join(", ")}, ${orgs.length === 1 ? "an org" : "orgs"} of ${a.login}`)
    return r
  }

  const proposals: IdentityProposal[] = accounts.map((a) => {
    const login = a.login.toLowerCase()
    const evidence: string[] = [`gh is signed in to ${a.login} (${a.storage ?? "gh"})${a.active ? ", its active account" : ""}`]
    if (a.problem) evidence.push(`but ${a.problem}`)
    const owners = new Set<string>([login, ...(a.orgs ?? []).map((o) => o.toLowerCase())])
    if (a.orgs?.length) evidence.push(`member of ${a.orgs.join(", ")}`)
    let author: IdentityProposal["author"] = null
    let signing: DetectedSigning | null = null
    const matched = blocks.map((b) => ({ b, r: why(a, b) })).filter((x) => x.r.length).sort((x, y) => y.r.length - x.r.length)[0]
    if (matched) {
      const b = matched.b
      evidence.push(`git's includeIf "${b.scope}" block: ${matched.r.join("; ")}`)
      if (b.name && b.email) author = { name: b.name, email: b.email, from: `includeIf "${b.scope}" (${b.file})` }
      signing = b.signing
      for (const o of b.repoOwners) owners.add(o)
    } else if (a.active && global) {
      if (global.name && global.email) author = { name: global.name, email: global.email, from: `the global git config (${global.file})` }
      signing = global.signing
    }
    if (author && a.verifiedEmails) {
      const own = a.verifiedEmails.includes(author.email.toLowerCase()) || (a.githubId !== null && author.email.toLowerCase() === `${a.githubId}+${login}@users.noreply.github.com`)
      evidence.push(own ? `${author.email} is verified on ${a.login}` : `${author.email} isn't one of ${a.login}'s verified emails: GitHub won't link its commits to the account`)
    }
    if (signing?.fingerprint && a.signingKeys) evidence.push(a.signingKeys.includes(signing.fingerprint) ? `the signing key ${signing.fingerprint} is on GitHub as ${a.login}'s signing key` : `the signing key ${signing.fingerprint} isn't one of ${a.login}'s signing keys on GitHub yet: add it (Settings › SSH and GPG keys › New, type Signing Key) or commits show Unverified`)
    const existing = i.identities.find((x) => !x.isDefault && x.githubLogin?.toLowerCase() === login) ?? null
    return {
      name: existing?.name ?? a.login,
      login: a.login,
      host: a.host,
      tokenRef: a.tokenRef,
      owners: [...owners],
      author,
      signing,
      projects: [],
      isDefaultToday: login === defaultLogin,
      existing: existing && { id: existing.id, name: existing.name },
      evidence,
    }
  })

  const unmatched: ProposedProject[] = []
  for (const p of i.projects) {
    const slug = githubSlug(p.repo)
    const base = { id: p.id, name: p.name, repo: p.repo ?? "", currentIdentity: identityName(p.identityId) }
    if (!slug) {
      unmatched.push({ ...base, why: "it has no GitHub repo" })
      continue
    }
    const owner = slug.split("/")[0]!.toLowerCase()
    // Online, the accounts that may push to the repo; offline (or when GitHub answered for none), the ones it belongs to.
    const asked = i.push && proposals.some((x) => i.push!.has(x.login.toLowerCase()))
    const cands = asked ? proposals.filter((x) => i.push!.get(x.login.toLowerCase())?.get(p.id) === "push") : proposals.filter((x) => x.owners.includes(owner))
    const owning = cands.filter((x) => x.owners.includes(owner))
    const pick =
      cands.find((x) => x.existing?.id === p.identityId) ??
      cands.find((x) => x.isDefaultToday && p.identityId === DEFAULT_IDENTITY_ID) ??
      (cands.length === 1 ? cands[0] : owning.length === 1 ? owning[0] : undefined)
    if (!pick) {
      unmatched.push({
        ...base,
        why: cands.length ? `${cands.map((x) => x.login).join(" and ")} could each serve ${slug}: pick one` : asked ? `no account here can push to ${slug}` : `no account here is or belongs to ${owner}${i.online ? "" : " (detect online to check orgs and push access)"}`,
      })
      continue
    }
    const reason = asked ? `${pick.login} can push to ${slug}` : owner === pick.login.toLowerCase() ? `${slug} is ${pick.login}'s` : `${slug} belongs to ${owner}, one of ${pick.login}'s owners`
    pick.projects.push({ ...base, why: reason })
  }
  for (const x of proposals) {
    if (x.isDefaultToday) x.evidence.push("the Default identity's token is this account, so its projects can stay on Default")
    const ownerOnly = x.owners.filter((o) => o !== x.login.toLowerCase())
    if (!x.projects.length && !x.isDefaultToday) x.evidence.push(`no project here is ${ownerOnly.length ? `${x.login}'s or ${ownerOnly.join(", ")}'s` : `${x.login}'s`} yet`)
  }
  if (!i.online) notes.push("Detected offline: GitHub wasn't asked, so orgs, verified emails, keys and push access aren't known. Detect online for a sharper match.")
  const loose = blocks.filter((b) => !proposals.some((x) => x.author?.from.startsWith(`includeIf "${b.scope}"`)))
  for (const b of loose) {
    notes.push(`git's includeIf "${b.scope}" block${b.email ? ` (author ${b.email})` : ""}${b.repoOwners.length ? ` for ${b.repoOwners.join(", ")}` : ""} matches no gh account here${i.online ? "" : " yet: GitHub wasn't asked, and its emails and keys are what tie a block to an account. Detect online first"}. If it's another GitHub account, sign in to it with \`gh auth login\` and detect again, or paste a token for it in Settings › Identities.`)
  }
  return { proposals, unmatched, notes }
}

// ---------- the detector: detection, and references resolved on the server ----------

/** gh's token for one account. Server-side only: callers use it and drop it, and errors never carry it. */
async function tokenFromGh(host: string, login: string, c: Ctx): Promise<{ host: string; login: string; token: string }> {
  const r = await run("gh", ["auth", "token", "--hostname", host, "--user", login], c)
  if (r.missing) throw new BadRequestError("gh isn't installed on this computer, so a gh: reference can't be read. Paste the token in Settings › Identities instead.")
  const token = r.stdout.trim().split(/\r?\n/)[0] ?? ""
  if (!r.ok || !/^[\x21-\x7e]{8,2000}$/.test(token)) throw new BadRequestError(`gh isn't signed in to ${login} on ${host} here (gh auth status lists the accounts it has). Sign in with: gh auth login --hostname ${host}`)
  return { host, login, token }
}

/** "gh:octocat" or "gh:github.com:octocat". */
export function parseTokenRef(ref: string): { host: string; login: string } | null {
  const m = /^gh:(?:([a-z0-9.-]+):)?([A-Za-z0-9-]{1,39})$/i.exec(ref.trim())
  return m && GITHUB_OWNER_RE.test(m[2]!) ? { host: (m[1] ?? "github.com").toLowerCase(), login: m[2]! } : null
}

/** A signing reference resolved: what to save, and whether the key is one this computer also logs in with. */
export interface ResolvedSigning {
  input: IdentitySigningInput
  /** A file key this computer also logs in to SSH servers with (detection's warning). */
  loginKey: boolean
  /** The path, for messages ("~/.ssh/acme_signing"), or the fingerprint for an agent key. */
  label: string
}

export class IdentityDetector {
  private last: IdentityDetection | null = null

  constructor(private readonly o: DetectOptions = {}) {}

  /** Read this computer (and GitHub, when online) and propose identities for `projects`. */
  async detect(i: { projects: DetectProject[]; identities: ProposalInput["identities"]; online: boolean; defaultLogin?: ProposalInput["defaultLogin"] }): Promise<IdentityDetection> {
    const c = ctx(this.o)
    const facts = await readComputer(this.o)
    const asked = i.online ? await askGithub(facts, i.projects, c) : null
    const p = proposeIdentities({ facts, online: i.online, push: asked?.push ?? null, projects: i.projects, identities: i.identities, defaultLogin: i.defaultLogin })
    const detection: IdentityDetection = {
      at: Date.now(),
      online: i.online,
      accounts: facts.accounts,
      authors: facts.authors,
      sshHosts: facts.sshHosts,
      credentialHelpers: facts.credentialHelpers,
      proposals: p.proposals,
      unmatched: p.unmatched,
      notes: [...facts.notes, ...(asked?.notes ?? []), ...p.notes],
    }
    this.last = detection
    return detection
  }

  /** The last detection, when it's recent: import_detected_identity starts from it. */
  recent(maxAgeMs = 30 * 60_000): IdentityDetection | null {
    return this.last && Date.now() - this.last.at < maxAgeMs ? this.last : null
  }

  /** A gh: reference's token, read from gh now. */
  async tokenFromRef(ref: string): Promise<{ host: string; login: string; token: string }> {
    const r = parseTokenRef(ref)
    if (!r) throw new BadRequestError(`That isn't a token reference: one looks like gh:octocat, an account gh is signed in to here (detect_identities lists them). A token itself goes in Settings › Identities, never through a chat.`)
    if (r.host !== "github.com") throw new BadRequestError("Identities are for github.com accounts only.")
    return tokenFromGh(r.host, r.login, ctx(this.o))
  }

  /**
   * A signing reference: "file:<path>" (a key file without a passphrase, in ~/.ssh or named by a git config here as
   * user.signingkey; Box Yard then keeps a copy) or "agent:<SHA256:… | public key>" (a key this computer's SSH agent or
   * 1Password holds; found among the git configs' signing keys, ~/.ssh/*.pub and `ssh-add -L`).
   */
  async signingFromRef(ref: string, o: { program?: string | null; requireSigned?: boolean } = {}): Promise<ResolvedSigning> {
    const c = ctx(this.o)
    const m = /^(file|agent):(.+)$/.exec(ref.trim())
    if (!m) throw new BadRequestError(`That isn't a signing key reference: use file:~/.ssh/<key> (a key file without a passphrase) or agent:<fingerprint> (a key in this computer's SSH agent or 1Password). A key itself goes in Settings › Identities, never through a chat.`)
    const facts = await readGitConfig(c)
    const signingKeys = facts.scopes.flatMap((s) => {
      const k = s.values.get("user.signingkey")?.trim()
      return k && !k.startsWith("key::") ? [real(expandHome(k, c.home))] : []
    })
    if (m[1] === "file") {
      const file = path.resolve(expandHome(m[2]!.trim(), c.home))
      if (!fs.existsSync(file)) throw new BadRequestError(`There's no key file at ${tilde(file, c.home)}.`)
      const at = real(file)
      const sshDir = real(path.join(c.home, ".ssh"))
      if (!at.startsWith(sshDir + path.sep) && !signingKeys.includes(at)) throw new BadRequestError(`Box Yard reads key files only from ~/.ssh, or the one a git config here names as user.signingkey, and ${tilde(file, c.home)} is neither. Paste the key in Settings › Identities instead.`)
      const stat = fs.statSync(at)
      if (!stat.isFile() || stat.size > 16_000) throw new BadRequestError(`${tilde(file, c.home)} isn't an SSH private key.`)
      if (!readHead(at).startsWith("-----BEGIN")) throw new BadRequestError(`${tilde(file, c.home)} isn't an SSH private key${file.endsWith(".pub") ? `: for a key only your SSH agent holds, use agent:<its fingerprint>` : ""}.`)
      const sshText = await fs.promises.readFile(path.join(c.home, ".ssh", "config"), "utf8").catch(() => "")
      const loginKeys = loginKeySet(c, parseSshConfig(sshText), facts.sshCommandKeys)
      return { input: { kind: "file", privateKey: fs.readFileSync(at, "utf8"), requireSigned: o.requireSigned }, loginKey: loginKeys.has(at), label: tilde(file, c.home) }
    }
    const want = m[2]!.trim()
    let publicKey = normalizePublicKey(want)
    let program = o.program ?? null
    if (!publicKey) {
      if (!/^SHA256:[A-Za-z0-9+/]{20,}$/.test(want)) throw new BadRequestError("An agent: reference names the key's fingerprint (SHA256:…) or its public key (ssh-ed25519 AAAA…).")
      for (const s of facts.scopes) {
        const sig = await signingOf(s.values, c, new Set())
        if (sig?.fingerprint === want && sig.publicKey) {
          publicKey = sig.publicKey
          program ??= sig.program
          break
        }
      }
      publicKey ??= (await this.publicKeysHere(c)).find((k) => fingerprintOfPublicKey(k) === want) ?? null
      if (!publicKey) throw new BadRequestError(`No key with fingerprint ${want} is in a git config here, in ~/.ssh/*.pub or in this computer's SSH agent (ssh-add -L).`)
    }
    return { input: { kind: "agent", publicKey, program, requireSigned: o.requireSigned }, loginKey: false, label: fingerprintOfPublicKey(publicKey) }
  }

  /** Public keys this computer has: ~/.ssh/*.pub and the SSH agent's (`ssh-add -L` prints public keys only). */
  private async publicKeysHere(c: Ctx): Promise<string[]> {
    const dir = path.join(c.home, ".ssh")
    const files = await fs.promises.readdir(dir).catch(() => [] as string[])
    const keys = files.filter((f) => f.endsWith(".pub")).flatMap((f) => {
      try {
        const k = normalizePublicKey(fs.readFileSync(path.join(dir, f), "utf8"))
        return k ? [k] : []
      } catch {
        return []
      }
    })
    const agent = await run("ssh-add", ["-L"], c)
    if (agent.ok) for (const line of agent.stdout.split(/\r?\n/)) {
      const k = normalizePublicKey(line)
      if (k) keys.push(k)
    }
    return keys
  }

}

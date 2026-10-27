/**
 * `./yard password`: put a strong random BOXYARD_PASSWORD in .env and print it once.
 *
 *   ./yard password           write a new one (asks before replacing the one already there)
 *   ./yard password --yes     replace it without asking
 *   ./yard password check     does the one in .env pass? (exit 0 pass, 1 fail, 2 not set; never prints it)
 *
 * `--env <file>` picks another .env, and `--user <name>` (repeatable) also refuses that username, for a deploy whose
 * server runs as another user. The rules are in server/password.ts.
 */
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { generatePassword, GENERATED_PASSWORD_LENGTH, machineUsername, MIN_PASSWORD_LENGTH, passwordProblems, type PasswordContext } from "../server/password.js"

export type Io = {
  out: (line: string) => void
  err: (line: string) => void
  /** Ask a yes/no question; false when nobody can answer. */
  confirm: (question: string) => Promise<boolean>
}

const LINE = /^\s*(?:export\s+)?BOXYARD_PASSWORD\s*=(.*)$/

/** BOXYARD_PASSWORD as the server reads .env (the first uncommented line, quotes stripped); "" when unset or empty. */
export function envPassword(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw)
    if (!m) continue
    const value = m[1]!.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1)
    return value
  }
  return ""
}

/** `text` with BOXYARD_PASSWORD set to `password`: its line replaced in place, or a new one at the end. */
export function withEnvPassword(text: string, password: string): string {
  const lines = text.split("\n")
  const i = lines.findIndex((l) => LINE.test(l.replace(/\r$/, "")))
  const line = `BOXYARD_PASSWORD=${password}`
  if (i >= 0) {
    lines[i] = line + (lines[i]!.endsWith("\r") ? "\r" : "")
    return lines.join("\n")
  }
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`
}

/** Write a new password into `envFile` (made from `exampleFile` if missing). Returns the exit code. */
export async function writePassword(opts: { envFile: string; exampleFile?: string; yes?: boolean; io: Io } & PasswordContext): Promise<number> {
  const { envFile, io } = opts
  const exists = fs.existsSync(envFile)
  const text = exists ? fs.readFileSync(envFile, "utf8") : opts.exampleFile && fs.existsSync(opts.exampleFile) ? fs.readFileSync(opts.exampleFile, "utf8") : ""
  if (envPassword(text) && !opts.yes) {
    const replace = await io.confirm(`${path.basename(envFile)} already has a BOXYARD_PASSWORD. Replace it? Devices logged in with it will have to log in again. [y/N] `)
    if (!replace) {
      io.err(`Kept the BOXYARD_PASSWORD already in ${envFile}. (Run with --yes to replace it without asking.)`)
      return 1
    }
  }
  const password = generatePassword(opts)
  fs.writeFileSync(envFile, withEnvPassword(text, password), { mode: 0o600 })
  io.out(`New BOXYARD_PASSWORD (${GENERATED_PASSWORD_LENGTH} random characters) written to ${envFile}:`)
  io.out("")
  io.out(`  ${password}`)
  io.out("")
  io.out("Save it in your password manager now: it isn't shown again. Restart Box Yard to use it.")
  return 0
}

/** Check the password in `envFile` against the rules, without printing it. Returns the exit code. */
export function checkPassword(opts: { envFile: string; io: Io } & PasswordContext): number {
  const { envFile, io } = opts
  const password = fs.existsSync(envFile) ? envPassword(fs.readFileSync(envFile, "utf8")) : ""
  if (!password) {
    io.err(`No BOXYARD_PASSWORD in ${envFile}. Run ./yard password to set a strong one.`)
    return 2
  }
  const problems = passwordProblems(password, opts)
  if (!problems.length) {
    io.out(`✓ The BOXYARD_PASSWORD in ${envFile} passes (${MIN_PASSWORD_LENGTH}+ characters, not common, not trivial).`)
    return 0
  }
  io.err(`✗ The BOXYARD_PASSWORD in ${envFile} is too weak, so Box Yard won't start with it:`)
  for (const p of problems) io.err(`  - ${p}`)
  io.err("Run ./yard password to replace it with a strong random one.")
  return 1
}

async function main(argv: string[]) {
  const flag = (name: string) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv.splice(i, 2)[1] : undefined
  }
  const envFile = path.resolve(flag("--env") ?? ".env")
  const usernames = [machineUsername()]
  for (let user = flag("--user"); user !== undefined; user = flag("--user")) usernames.push(user)
  const yes = argv.includes("--yes") || argv.includes("-y")
  const io: Io = {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    confirm: async (q) => {
      if (!process.stdin.isTTY) return false
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      try {
        return /^y(es)?$/i.test((await rl.question(q)).trim())
      } finally {
        rl.close()
      }
    },
  }
  if (argv[0] === "check") return checkPassword({ envFile, io, usernames })
  const code = await writePassword({ envFile, exampleFile: path.join(path.dirname(envFile), ".env.example"), yes, io, usernames })
  if (code === 0 && process.env.BOXYARD_PASSWORD) {
    io.err("! BOXYARD_PASSWORD is also set in your shell, and that one wins over .env: unset it before restarting.")
  }
  return code
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}

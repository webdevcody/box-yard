// How Box Yard logs in to an SSH machine (shared/machines.ts MachineKeyRef). A key is only ever named: ssh reads a
// key file itself, or asks this computer's SSH agent. Box Yard reads a key file's first line (to see it's a private
// key, the same check as identity signing keys) and never copies it; for an agent key it keeps only the public half,
// which tells ssh which of the agent's keys to use.
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fingerprintOfPublicKey, normalizePublicKey } from "../identity/sshKeys.js"
import { BadRequestError } from "../store.js"
import { KEY_REF_HELP, parseKeyRef, type MachineKeyRef } from "../../shared/machines.js"
import type { SshAuth } from "./ssh.js"

export interface MachineKeysOptions {
  /** This computer's home (tests: a temp folder). */
  home?: string
  /** Where the public halves of agent keys are kept (`<dataDir>/machines`). */
  dir: string
  /** The SSH agent's public keys (`ssh-add -L`); tests stand in for it. */
  agentKeys?: () => Promise<string[]>
  /** SSH_AUTH_SOCK as ssh will see it. */
  agentSocket?: () => string | undefined
}

const expandHome = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p)
const tilde = (p: string, home: string) => (p === home ? "~" : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p)
const real = (p: string) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function readHead(file: string): string {
  const fd = fs.openSync(file, "r")
  try {
    const buf = Buffer.alloc(64)
    const n = fs.readSync(fd, buf, 0, 64, 0)
    return buf.subarray(0, n).toString("utf8")
  } finally {
    fs.closeSync(fd)
  }
}

export class MachineKeys {
  constructor(private readonly o: MachineKeysOptions) {}

  private get home() {
    return this.o.home ?? os.homedir()
  }

  private agentSocket() {
    return this.o.agentSocket ? this.o.agentSocket() : process.env.SSH_AUTH_SOCK
  }

  private agentKeys(): Promise<string[]> {
    if (this.o.agentKeys) return this.o.agentKeys()
    return new Promise((resolve) => {
      execFile("ssh-add", ["-L"], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve([])
        resolve(String(stdout).split(/\r?\n/).flatMap((l) => normalizePublicKey(l) ?? []))
      })
    })
  }

  /** A reference as typed, checked: the key file is a private key in ~/.ssh, the agent is there and holds that key. */
  async check(ref: unknown): Promise<MachineKeyRef> {
    const parsed = parseKeyRef(ref)
    if (!parsed) throw new BadRequestError(`That isn't an SSH key reference. Use ${KEY_REF_HELP}`)
    await this.resolve(parsed, null)
    return parsed
  }

  /**
   * The ssh options for a reference. `machineId` names the public-key file an agent key gets (null: only check).
   * Throws with a message that names the file, never its content.
   */
  async resolve(ref: MachineKeyRef, machineId: string | null): Promise<SshAuth> {
    if (ref === "default") return { identityFile: null, identitiesOnly: false }
    if (ref === "agent") {
      if (!this.agentSocket()) throw new BadRequestError("Box Yard has no SSH agent to ask: SSH_AUTH_SOCK isn't set where it runs. Start Box Yard from a shell with your agent, or use file:~/.ssh/<key>.")
      return { identityFile: null, identitiesOnly: false }
    }
    if (ref.startsWith("file:")) {
      const home = this.home
      const file = path.resolve(expandHome(ref.slice("file:".length).trim(), home))
      if (!fs.existsSync(file)) throw new BadRequestError(`There's no key file at ${tilde(file, home)}.`)
      const at = real(file)
      const sshDir = real(path.join(home, ".ssh"))
      if (!at.startsWith(sshDir + path.sep)) throw new BadRequestError(`Box Yard uses key files only from ~/.ssh, and ${tilde(file, home)} isn't there.`)
      const stat = fs.statSync(at)
      if (!stat.isFile() || stat.size > 16_000 || !readHead(at).startsWith("-----BEGIN")) {
        throw new BadRequestError(`${tilde(file, home)} isn't an SSH private key${file.endsWith(".pub") ? ": name the private key (without .pub), or use agent:<fingerprint> for a key your SSH agent holds" : ""}.`)
      }
      return { identityFile: at, identitiesOnly: true }
    }
    // agent:SHA256:…: that key of the agent's. ssh picks it by its public half (-i key.pub with IdentitiesOnly).
    const want = ref.slice("agent:".length)
    if (!this.agentSocket()) throw new BadRequestError("Box Yard has no SSH agent to ask: SSH_AUTH_SOCK isn't set where it runs.")
    const key = (await this.agentKeys()).find((k) => fingerprintOfPublicKey(k) === want)
    if (!key) throw new BadRequestError(`This computer's SSH agent has no key with fingerprint ${want} (ssh-add -l lists them).`)
    if (!machineId) return { identityFile: null, identitiesOnly: true }
    fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 })
    const pub = path.join(this.o.dir, `${machineId.replace(/[^\w-]/g, "")}.pub`)
    fs.writeFileSync(pub, `${key}\n`, { mode: 0o600 })
    return { identityFile: pub, identitiesOnly: true }
  }

  /** The public-key file an agent key got, when the machine goes. */
  forget(machineId: string) {
    fs.rmSync(path.join(this.o.dir, `${machineId.replace(/[^\w-]/g, "")}.pub`), { force: true })
  }
}

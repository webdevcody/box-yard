import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// SSH signing keys for identities (docs/identities.md): what a key is, read with this computer's ssh-keygen. A
// private key only ever touches disk in a 0700 temp folder that is removed before these return, and nothing
// ssh-keygen prints is passed on, so no error can carry a key.

/** The key types git can sign with, as an OpenSSH public key starts. */
const PUBLIC_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}$/

export class SshKeyError extends Error {}

export interface SshKeyInfo {
  /** "ssh-ed25519 AAAA…", without the comment (it can name a person or a computer). */
  publicKey: string
  /** "SHA256:…", as `ssh-keygen -l` and GitHub show it. */
  fingerprint: string
}

/** An OpenSSH public key's type and base64, or null when it isn't one. */
export function normalizePublicKey(text: string): string | null {
  const [type, data] = text.trim().split(/\s+/)
  const key = `${type ?? ""} ${data ?? ""}`
  return PUBLIC_KEY_RE.test(key) ? key : null
}

/** A private key without a passphrase: its public key and fingerprint. */
export async function privateKeyInfo(privateKey: string): Promise<SshKeyInfo> {
  if (!/^-----BEGIN (OPENSSH|RSA|EC) PRIVATE KEY-----/.test(privateKey.trim())) {
    throw new SshKeyError("That isn't an SSH private key: paste the whole file, from -----BEGIN OPENSSH PRIVATE KEY----- to its END line.")
  }
  return withTemp(async (dir) => {
    const file = path.join(dir, "key")
    // ssh-keygen wants the file to end with a newline, and to be readable by its owner only.
    fs.writeFileSync(file, `${privateKey.trim()}\n`, { mode: 0o600 })
    let pub: string
    try {
      // -P "": a key with a passphrase fails here instead of asking for it.
      pub = await keygen(["-y", "-P", "", "-f", file])
    } catch (err) {
      if (err instanceof SshKeyError) throw err
      const text = String((err as { stderr?: string }).stderr ?? "")
      if (/passphrase/i.test(text)) {
        throw new SshKeyError("That key has a passphrase, so Box Yard can't sign with it unattended. Make a signing key without one for this identity (ssh-keygen -t ed25519 -N \"\" -f <file>), or sign with your SSH agent instead (kind \"agent\").")
      }
      throw new SshKeyError("ssh-keygen couldn't read that private key.")
    }
    const publicKey = normalizePublicKey(pub)
    if (!publicKey) throw new SshKeyError("git can't sign with that kind of key: use an ed25519, ECDSA or RSA key.")
    return { publicKey, fingerprint: await fingerprintOf(publicKey, dir) }
  })
}

/** A public key's fingerprint, for a key only an SSH agent (or 1Password) holds. */
export async function publicKeyInfo(text: string): Promise<SshKeyInfo> {
  const publicKey = normalizePublicKey(text)
  if (!publicKey) throw new SshKeyError("That isn't an SSH public key: it looks like ssh-ed25519 AAAA… (the .pub file, or `ssh-add -L`).")
  return withTemp(async (dir) => ({ publicKey, fingerprint: await fingerprintOf(publicKey, dir) }))
}

async function fingerprintOf(publicKey: string, dir: string): Promise<string> {
  const file = path.join(dir, "key.pub")
  fs.writeFileSync(file, `${publicKey}\n`)
  let out: string
  try {
    out = await keygen(["-l", "-E", "sha256", "-f", file])
  } catch (err) {
    if (err instanceof SshKeyError) throw err
    throw new SshKeyError("ssh-keygen couldn't read that public key.")
  }
  const fp = /\bSHA256:[A-Za-z0-9+/]+/.exec(out)?.[0]
  if (!fp) throw new SshKeyError("ssh-keygen didn't give that key a fingerprint.")
  return fp
}

function keygen(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ssh-keygen", args, { timeout: 15_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }, (err, stdout, stderr) => {
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") reject(new SshKeyError("This computer has no ssh-keygen, so Box Yard can't read SSH keys. Install OpenSSH, then try again."))
      else if (err) reject(Object.assign(err, { stderr }))
      else resolve(stdout)
    })
  })
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boxyard-key-"))
  fs.chmodSync(dir, 0o700)
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

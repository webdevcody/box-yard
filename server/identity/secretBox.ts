import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/**
 * Encryption at rest for identity secrets (GitHub tokens, Claude logins, signing keys): AES-256-GCM, stored as
 * `v1:<iv>:<tag>:<data>` (base64). The key is BOXYARD_SECRET_KEY when it's set, else a random 32 bytes in
 * `<data dir>/secret.key` (0600), made on first use. It's never in the database, so a copy of box-yard.sqlite (or a
 * backup of it alone) holds no usable token. Losing the key file loses the secrets, not the identities: they show as
 * "needs a new token".
 */
export class SecretBox {
  private key: Buffer | null = null

  constructor(private readonly o: { dataDir: string; envKey?: string }) {}

  get keyFile(): string {
    return path.join(this.o.dataDir, "secret.key")
  }

  private getKey(): Buffer {
    if (this.key) return this.key
    const env = this.o.envKey?.trim()
    if (env) {
      // 32 bytes as hex or base64 are used as they are; any other passphrase is hashed to 32 bytes.
      if (/^[0-9a-f]{64}$/i.test(env)) this.key = Buffer.from(env, "hex")
      else if (/^[A-Za-z0-9+/]{43}=$/.test(env)) this.key = Buffer.from(env, "base64")
      else this.key = createHash("sha256").update(env).digest()
      return this.key
    }
    try {
      const raw = Buffer.from(fs.readFileSync(this.keyFile, "utf8").trim(), "base64")
      if (raw.length !== 32) throw new Error(`${this.keyFile} isn't a Box Yard secret key (32 bytes, base64)`)
      this.key = raw
      return raw
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
    fs.mkdirSync(this.o.dataDir, { recursive: true })
    const fresh = randomBytes(32)
    try {
      // wx: two servers starting at once can't each write a different key.
      fs.writeFileSync(this.keyFile, fresh.toString("base64") + "\n", { mode: 0o600, flag: "wx" })
      this.key = fresh
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      this.key = null
      return this.getKey()
    }
    return this.key
  }

  seal(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.getKey(), iv)
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":")
  }

  /** The secret, or null when it can't be read (another key, a damaged value). */
  open(sealed: string): string | null {
    const [v, iv, tag, data] = sealed.split(":")
    if (v !== "v1" || !iv || !tag || data === undefined) return null
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.getKey(), Buffer.from(iv, "base64"))
      decipher.setAuthTag(Buffer.from(tag, "base64"))
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8")
    } catch {
      return null
    }
  }
}

/** A token's fingerprint: sha256, first 12 hex. Tells two tokens apart; can't be turned back into one. */
export const tokenFingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12)

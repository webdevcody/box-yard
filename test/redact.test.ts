import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { openDb } from "../server/db.js"
import { redactPrivateKeys } from "../server/redact.js"
import { Store } from "../server/store.js"
import { tmpDir } from "./helpers.js"

// A private key an agent prints (cat ~/.ssh/id_ed25519, a clipped tool output) never reaches a transcript, whether
// or not it's one Box Yard knows (docs/identities.md).

/** A throwaway key, as `cat` prints it. */
function privateKey() {
  const file = path.join(tmpDir("redact-key-"), "key")
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", file])
  return fs.readFileSync(file, "utf8")
}

describe("redactPrivateKeys", () => {
  const key = privateKey()
  const body = key.split("\n")[1]!

  it("replaces a whole key block, and keeps the text around it", () => {
    const out = redactPrivateKeys(`Here it is:\n${key}\nDone.`)
    expect(out).toBe("Here it is:\n[redacted private key]\n\nDone.")
    expect(redactPrivateKeys("-----BEGIN RSA PRIVATE KEY-----\nMIIEpA==\n-----END RSA PRIVATE KEY-----")).toBe("[redacted private key]")
    expect(redactPrivateKeys("-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIF\n-----END ENCRYPTED PRIVATE KEY-----")).toBe("[redacted private key]")
  })

  it("replaces a key cut off before its END line, up to the first character a key can't hold", () => {
    const cut = key.slice(0, key.length / 2)
    const out = redactPrivateKeys(`${cut}… (output clipped). Next step`)
    expect(out).toBe("[redacted private key]… (output clipped). Next step")
    expect(out).not.toContain(body.slice(0, 16))
  })

  it("works on JSON text: the key's escaped line breaks go with it, the quotes stay", () => {
    const json = JSON.stringify({ stdout: `${key}`, cut: key.slice(0, 120), after: "ok" })
    const out = redactPrivateKeys(json)
    expect(JSON.parse(out)).toEqual({ stdout: "[redacted private key]\n", cut: "[redacted private key]", after: "ok" })
  })

  it("leaves a public key and prose about keys alone", () => {
    const text = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB test and a PRIVATE KEY----- mention"
    expect(redactPrivateKeys(text)).toBe(text)
  })
})

describe("Store transcripts", () => {
  it("keep no private key an agent prints, in content or meta, and keep Cody's own messages as written", () => {
    const key = privateKey()
    const s = new Store(openDb(tmpDir()))
    const p = s.createProject({ name: "x" })
    const t = s.createTask({ projectId: p.id, title: "t", prompt: "p" })
    // A cut-off key followed by an escaped quote: redacting the meta's JSON text would have broken it.
    s.addTaskMessage(t.id, "tool", `cat key\n${key}`, { output: key, nested: [{ text: `${key.slice(0, 90)}\\"quoted\\"` }], n: 1 })
    s.addTaskMessage(t.id, "user", `my key: ${key}`)
    const [tool, user] = s.listTaskMessages(t.id)
    expect(tool!.content).toBe("cat key\n[redacted private key]\n")
    expect(tool!.meta).toEqual({ output: "[redacted private key]\n", nested: [{ text: '[redacted private key]\\"quoted\\"' }], n: 1 })
    expect(user!.content).toBe(`my key: ${key}`)
  })
})

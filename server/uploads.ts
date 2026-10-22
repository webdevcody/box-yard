import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { mimeFor, safeFilename } from "./artifacts.js"
import { BadRequestError } from "./store.js"
import type { Attachment } from "../shared/types.js"

export const uploadsDir = (dataDir: string) => path.join(dataDir, "uploads")

const ID = /^up_[a-f0-9]{12}$/

/** A stored upload: what clients see, plus where it lives on this server's disk. */
export type StoredUpload = Attachment & { path: string }

/**
 * Files Cody attaches to chat and task messages. Each upload gets its own
 * folder, `<dir>/<id>/<filename>`, so the id is the only index we need.
 */
export class Uploads {
  constructor(
    readonly dir: string,
    readonly maxBytes: number,
  ) {
    fs.mkdirSync(dir, { recursive: true })
  }

  save(name: string, data: Buffer): StoredUpload {
    if (!data.length) throw new BadRequestError(`"${name}" is empty.`)
    if (data.length > this.maxBytes) throw tooLarge(name, this.maxBytes)
    const filename = safeFilename(name)
    const id = `up_${randomBytes(6).toString("hex")}`
    fs.mkdirSync(path.join(this.dir, id), { recursive: true })
    const file = path.join(this.dir, id, filename)
    fs.writeFileSync(file, data)
    return { id, name: filename, size: data.length, mime: mimeFor(filename), path: file }
  }

  get(id: string): StoredUpload | null {
    if (!ID.test(id)) return null
    const folder = path.join(this.dir, id)
    let names: string[]
    try {
      names = fs.readdirSync(folder)
    } catch {
      return null
    }
    const name = names[0]
    if (!name) return null
    const file = path.join(folder, name)
    return { id, name, size: fs.statSync(file).size, mime: mimeFor(name), path: file }
  }

  /** An upload id, or the absolute path of an uploaded file (as the orchestrator sees it). */
  resolve(ref: string): StoredUpload {
    const trimmed = ref.trim()
    let id = trimmed
    if (path.isAbsolute(trimmed)) {
      const rel = path.relative(this.dir, path.resolve(trimmed))
      id = rel.split(path.sep)[0] ?? ""
      if (rel.startsWith("..") || rel.split(path.sep).length !== 2) id = ""
    }
    const found = this.get(id)
    if (!found) throw new BadRequestError(`"${ref}" is not an uploaded file. Use an attachment id (up_…) or path from the chat message.`)
    return found
  }

  resolveAll(refs: string[] | undefined): StoredUpload[] {
    return [...new Set(refs ?? [])].map((r) => this.resolve(r))
  }
}

export function tooLarge(name: string, maxBytes: number) {
  const err = new BadRequestError(`"${name}" is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB upload limit.`)
  err.status = 413
  return err
}

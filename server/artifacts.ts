import fs from "node:fs"
import path from "node:path"
import type { Artifact } from "../shared/types.js"
import type { Store } from "./store.js"

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
}

export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

export function mimeFor(filename: string) {
  return MIME[path.extname(filename).toLowerCase()] ?? "application/octet-stream"
}

/** Keep a filename safe to use on disk and in a URL. */
export function safeFilename(name: string) {
  const base = path.basename(name).replace(/[^\w.\- ]+/g, "_").trim()
  return base.slice(0, 120) || "file"
}

/** Stores files agents (or the orchestrator) publish, and serves them. */
export class Artifacts {
  constructor(
    private readonly store: Store,
    private readonly dir: string,
  ) {
    fs.mkdirSync(dir, { recursive: true })
  }

  save(input: { title: string; filename: string; data: Buffer; projectId: string | null; taskId: string | null }): Artifact {
    if (input.data.length > MAX_ARTIFACT_BYTES) throw new Error("Artifact is larger than 25 MB")
    const filename = safeFilename(input.filename)
    const folder = path.join(this.dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(folder, { recursive: true })
    const file = path.join(folder, filename)
    fs.writeFileSync(file, input.data)
    return this.store.addArtifact({
      projectId: input.projectId,
      taskId: input.taskId,
      title: input.title.trim() || filename,
      filename,
      mime: mimeFor(filename),
      size: input.data.length,
      path: file,
    })
  }
}

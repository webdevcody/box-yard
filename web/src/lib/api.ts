import type { Attachment } from "../../../shared/types"

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** fetch() for the Box Yard API: JSON in, JSON out, readable errors. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
    })
  } catch {
    throw new ApiError("Can't reach the Box Yard server. Is it running?", 0)
  }
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`
    if (res.status === 401) window.dispatchEvent(new Event("box-yard:unauthorized"))
    throw new ApiError(message, res.status)
  }
  return data as T
}

/** Upload one file (raw body) and get back its id to attach to a message. */
export async function uploadFile(file: File): Promise<Attachment> {
  let res: Response
  try {
    res = await fetch(`/api/uploads?name=${encodeURIComponent(file.name || "pasted-file")}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
      credentials: "same-origin",
    })
  } catch {
    throw new ApiError("Can't reach the Box Yard server. Is it running?", 0)
  }
  const data = (await res.json().catch(() => null)) as (Attachment & { error?: string }) | null
  if (!res.ok || !data) {
    if (res.status === 401) window.dispatchEvent(new Event("box-yard:unauthorized"))
    throw new ApiError(data?.error ?? `Upload failed (${res.status})`, res.status)
  }
  return data
}

/** Ids the server accepts from the client, so optimistic rows keep their id. */
export function clientId(prefix: "prj" | "task" | "chat" | "sch") {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12)}`
}

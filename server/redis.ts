import { retry } from "./util/retry.js"

/** Minimal Upstash Redis REST client (the same protocol the worker runner uses). */
export class Redis {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async cmd<T = unknown>(...args: (string | number)[]): Promise<T> {
    return retry(async () => {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args.map(String)),
        signal: AbortSignal.timeout(15_000),
      })
      const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string }
      if (!res.ok || body.error) {
        throw Object.assign(new Error(`redis ${args[0]}: ${body.error ?? res.status}`), { status: res.status })
      }
      return body.result as T
    })
  }

  async pipeline(commands: (string | number)[][]): Promise<unknown[]> {
    if (!commands.length) return []
    return retry(async () => {
      const res = await fetch(`${this.url.replace(/\/$/, "")}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(commands.map((c) => c.map(String))),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw Object.assign(new Error(`redis pipeline: ${res.status}`), { status: res.status })
      const body = (await res.json()) as { result?: unknown; error?: string }[]
      return body.map((r) => (r.error ? new Error(r.error) : r.result))
    })
  }
}

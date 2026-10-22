const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** True for errors worth retrying: network hiccups, 408, 429 and 5xx. */
export function isTransient(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; code?: string; message?: string; name?: string }
  const status = e?.statusCode ?? e?.status
  if (typeof status === "number") return status === 408 || status === 429 || status >= 500
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return true
  const msg = String(e?.message ?? "")
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network/i.test(
    `${e?.code ?? ""} ${msg}`,
  )
}

/** Retry `fn` with exponential backoff on transient errors. */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4
  const base = opts.baseMs ?? 500
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isTransient(err) || i === attempts - 1) break
      await sleep(base * 2 ** i + Math.floor(Math.random() * 200))
    }
  }
  throw lastErr
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

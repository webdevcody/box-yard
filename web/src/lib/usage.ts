export function money(n: number | null | undefined, digits = 2) {
  const v = Number(n ?? 0)
  if (v > 0 && v < 0.01) return "<$0.01"
  return `$${v.toFixed(digits)}`
}

export function compactTokens(n: number | null | undefined) {
  const v = Number(n ?? 0)
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}m`
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 100_000 ? 0 : 1)}k`
  return String(Math.round(v))
}

export function hours(ms: number | null | undefined) {
  return `${((ms ?? 0) / 3_600_000).toFixed(2)}h`
}

export function bytes(n: number | null | undefined) {
  if (!n) return "unknown"
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

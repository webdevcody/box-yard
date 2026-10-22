// A small 5-field cron parser with time zone support. Shared by the server
// (to schedule runs) and the web app (to preview the next runs in the form).
//
//   ┌ minute (0-59)
//   │ ┌ hour (0-23)
//   │ │ ┌ day of month (1-31)
//   │ │ │ ┌ month (1-12 or jan-dec)
//   │ │ │ │ ┌ day of week (0-7 or sun-sat; 0 and 7 are Sunday)
//   * * * * *
//
// Supports lists (1,15), ranges (1-5), steps (*/15, 10-50/10) and the macros
// @hourly, @daily (@midnight), @weekly, @monthly, @yearly (@annually).
// Like Vixie cron, when both day fields are restricted a day matches if either does.

export interface Cron {
  source: string
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  daysRestricted: boolean
  weekdaysRestricted: boolean
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

export class CronError extends Error {
  status = 400
}

function parseField(text: string, min: number, max: number, names: string[] | null, nameOffset: number, label: string): Set<number> {
  const out = new Set<number>()
  const value = (s: string) => {
    const lower = s.toLowerCase()
    if (names) {
      const i = names.indexOf(lower)
      if (i >= 0) return i + nameOffset
    }
    if (!/^\d+$/.test(s)) throw new CronError(`Bad ${label} "${s}"`)
    const n = Number(s)
    if (n < min || n > max) throw new CronError(`${label} ${n} is out of range (${min}-${max})`)
    return n
  }
  for (const part of text.split(",")) {
    if (!part) throw new CronError(`Empty item in ${label}`)
    const [range, stepText] = part.split("/") as [string, string | undefined]
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new CronError(`Bad step "${stepText}" in ${label}`)
    let lo: number
    let hi: number
    if (range === "*") {
      lo = min
      hi = max
    } else if (range.includes("-")) {
      const [a, b] = range.split("-") as [string, string]
      lo = value(a)
      hi = value(b)
      if (lo > hi) throw new CronError(`Range ${range} in ${label} goes backwards`)
    } else {
      lo = value(range)
      hi = stepText === undefined ? lo : max
    }
    for (let n = lo; n <= hi; n += step) out.add(n)
  }
  return out
}

export function parseCron(expr: string): Cron {
  const source = expr.trim().replace(/\s+/g, " ")
  const expanded = MACROS[source.toLowerCase()] ?? source
  const fields = expanded.split(" ")
  if (fields.length !== 5) throw new CronError(`A cron expression has 5 fields (minute hour day month weekday); got ${fields.length}`)
  const [mi, h, d, mo, wd] = fields as [string, string, string, string, string]
  const weekdays = parseField(wd, 0, 7, DAY_NAMES, 0, "weekday")
  if (weekdays.has(7)) {
    weekdays.delete(7)
    weekdays.add(0)
  }
  return {
    source,
    minutes: parseField(mi, 0, 59, null, 0, "minute"),
    hours: parseField(h, 0, 23, null, 0, "hour"),
    days: parseField(d, 1, 31, null, 0, "day of month"),
    months: parseField(mo, 1, 12, MONTH_NAMES, 1, "month"),
    weekdays,
    daysRestricted: d !== "*" && !d.startsWith("*/"),
    weekdaysRestricted: wd !== "*" && !wd.startsWith("*/"),
  }
}

/** The expression with macros expanded to 5 fields (for services that only take plain cron). */
export function expandCron(expr: string): string {
  const source = parseCron(expr).source
  return MACROS[source.toLowerCase()] ?? source
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

interface Parts {
  minute: number
  hour: number
  day: number
  month: number
  weekday: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function partsIn(ts: number, tz: string): Parts {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
    })
    formatters.set(tz, f)
  }
  const p: Partial<Parts> = {}
  for (const part of f.formatToParts(ts)) {
    if (part.type === "minute") p.minute = Number(part.value)
    else if (part.type === "hour") p.hour = Number(part.value)
    else if (part.type === "day") p.day = Number(part.value)
    else if (part.type === "month") p.month = Number(part.value)
    else if (part.type === "weekday") p.weekday = DAY_NAMES.indexOf(part.value.toLowerCase().slice(0, 3))
  }
  return p as Parts
}

function dayMatches(c: Cron, p: Parts) {
  if (!c.months.has(p.month)) return false
  const dom = c.days.has(p.day)
  const dow = c.weekdays.has(p.weekday)
  if (c.daysRestricted && c.weekdaysRestricted) return dom || dow
  return dom && dow
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * The first time strictly after `after` (ms) that matches, evaluated in time
 * zone `tz`. Returns null if nothing matches in the next five years (e.g. Feb 30).
 */
export function nextRun(cron: Cron | string, after: number, tz = "UTC"): number | null {
  const c = typeof cron === "string" ? parseCron(cron) : cron
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE
  const limit = after + 5 * 366 * 24 * HOUR
  while (t <= limit) {
    const p = partsIn(t, tz)
    // Skip to the next local hour whenever the day or hour can't match.
    // (Hour steps stay correct across DST changes; whole-day jumps would not.)
    if (!dayMatches(c, p) || !c.hours.has(p.hour)) {
      t += (60 - p.minute) * MINUTE
      continue
    }
    if (c.minutes.has(p.minute)) return t
    t += MINUTE
  }
  return null
}

/** The next `count` run times after `after`. */
export function nextRuns(cron: Cron | string, after: number, tz = "UTC", count = 5): number[] {
  const c = typeof cron === "string" ? parseCron(cron) : cron
  const out: number[] = []
  let t = after
  while (out.length < count) {
    const n = nextRun(c, t, tz)
    if (n === null) break
    out.push(n)
    t = n
  }
  return out
}

const pad = (n: number) => String(n).padStart(2, "0")
const only = (s: Set<number>) => (s.size === 1 ? [...s][0]! : null)
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** A short plain-English reading of common cron shapes; falls back to the expression. */
export function describeCron(expr: string): string {
  let c: Cron
  try {
    c = parseCron(expr)
  } catch (err) {
    return (err as Error).message
  }
  const fields = (MACROS[c.source.toLowerCase()] ?? c.source).split(" ")
  const [mi, h, d, mo, wd] = fields as [string, string, string, string, string]
  const minute = only(c.minutes)
  const hour = only(c.hours)
  const everyStep = (f: string) => f.match(/^\*\/(\d+)$/)?.[1]

  if (mi === "*" && h === "*" && d === "*" && mo === "*" && wd === "*") return "Every minute"
  if (everyStep(mi) && h === "*" && d === "*" && mo === "*" && wd === "*") return `Every ${everyStep(mi)} minutes`
  if (minute !== null && h === "*" && d === "*" && mo === "*" && wd === "*") return minute === 0 ? "Every hour" : `Every hour at :${pad(minute)}`
  if (minute !== null && everyStep(h) && d === "*" && mo === "*" && wd === "*") return `Every ${everyStep(h)} hours at :${pad(minute)}`
  if (minute === null || hour === null) return c.source
  const at = `at ${pad(hour)}:${pad(minute)}`
  if (d === "*" && mo === "*" && wd === "*") return `Every day ${at}`
  if (d === "*" && mo === "*") {
    const days = [...c.weekdays].sort()
    if (days.join() === "1,2,3,4,5") return `Weekdays ${at}`
    if (days.join() === "0,6") return `Weekends ${at}`
    return `Every ${days.map((x) => WEEKDAY_LABELS[x]).join(", ")} ${at}`
  }
  const day = only(c.days)
  if (day !== null && mo === "*" && wd === "*") return `Monthly on day ${day} ${at}`
  const month = only(c.months)
  if (day !== null && month !== null && wd === "*") return `Every year on ${MONTH_LABELS[month - 1]} ${day} ${at}`
  return c.source
}

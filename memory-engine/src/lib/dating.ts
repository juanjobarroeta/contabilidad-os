/**
 * Uncertain dating.
 *
 * The whole trick of this archive is that most of it is "sometime in 2014". A
 * single nullable date forces false precision, and false precision is what
 * makes you stop logging. So every episode carries a `precision` and a closed
 * span: a year-precision episode is the band January 1 – December 31, not a
 * point on January 1.
 *
 * Nothing here touches the database. It is the one piece of logic worth
 * testing in isolation, because every surface built later reads dates through
 * it.
 */

export type Precision = 'day' | 'month' | 'season' | 'year' | 'unknown'

/**
 * Meteorological seasons, northern hemisphere. A season is named for the year
 * it *ends* in, which is the usual reading of "the winter of 2014" — December
 * 2013 through February 2014. Every label this module renders spells the range
 * out, so nobody has to remember which convention was chosen.
 */
export type Season = 'winter' | 'spring' | 'summer' | 'autumn'

export type Dating =
  | { precision: 'day'; year: number; month: number; day: number }
  | { precision: 'month'; year: number; month: number }
  | { precision: 'season'; year: number; season: Season }
  | { precision: 'year'; year: number }
  | { precision: 'unknown' }

export interface Span {
  occurredAt: Date | null
  occurredEnd: Date | null
}

/** Coarse first: reading a year should feel like zooming in, not shuffling. */
export const PRECISION_ORDER: Record<Precision, number> = {
  year: 0,
  season: 1,
  month: 2,
  day: 3,
  unknown: 4,
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

const SEASON_LABEL: Record<Season, string> = {
  winter: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  autumn: 'Autumn',
}

/** UTC midnight, which is how Postgres `date` columns round-trip through Prisma. */
export function utcDate(year: number, month: number, day: number): Date {
  const d = new Date(Date.UTC(2000, 0, 1))
  d.setUTCFullYear(year, month - 1, day)
  return d
}

/** Day 0 of the next month is the last day of this one, leap years included. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * A season's span. Winter is the awkward one: it starts in the previous
 * calendar year, so `seasonSpan(2014, 'winter')` is Dec 1 2013 – Feb 28 2014.
 */
export function seasonSpan(year: number, season: Season): { start: Date; end: Date } {
  switch (season) {
    case 'winter':
      return { start: utcDate(year - 1, 12, 1), end: utcDate(year, 2, lastDayOfMonth(year, 2)) }
    case 'spring':
      return { start: utcDate(year, 3, 1), end: utcDate(year, 5, 31) }
    case 'summer':
      return { start: utcDate(year, 6, 1), end: utcDate(year, 8, 31) }
    case 'autumn':
      return { start: utcDate(year, 9, 1), end: utcDate(year, 11, 30) }
  }
}

/**
 * The dating contract, in code. The same rules live as CHECK constraints on
 * `episodes`, so a row that skips this function still cannot lie about its own
 * precision.
 */
export function spanFor(dating: Dating): Span {
  switch (dating.precision) {
    case 'unknown':
      return { occurredAt: null, occurredEnd: null }
    case 'year':
      return { occurredAt: utcDate(dating.year, 1, 1), occurredEnd: utcDate(dating.year, 12, 31) }
    case 'season': {
      const { start, end } = seasonSpan(dating.year, dating.season)
      return { occurredAt: start, occurredEnd: end }
    }
    case 'month':
      return {
        occurredAt: utcDate(dating.year, dating.month, 1),
        occurredEnd: utcDate(dating.year, dating.month, lastDayOfMonth(dating.year, dating.month)),
      }
    case 'day': {
      const at = utcDate(dating.year, dating.month, dating.day)
      return { occurredAt: at, occurredEnd: at }
    }
  }
}

/**
 * Which year an episode files under.
 *
 * Taken from the MIDDLE of the span, not its start. Winter 2014 begins in
 * December 2013; filing it under 2013 would put it a scroll away from the
 * three months it actually belongs to. The midpoint puts every other precision
 * exactly where the naive answer would.
 */
export function bucketYear(span: Span): number | null {
  if (!span.occurredAt || !span.occurredEnd) return null
  const mid = new Date((span.occurredAt.getTime() + span.occurredEnd.getTime()) / 2)
  return mid.getUTCFullYear()
}

/** Inclusive width of the span, in days. `null` when the episode is undated. */
export function spanDays(span: Span): number | null {
  if (!span.occurredAt || !span.occurredEnd) return null
  const ms = span.occurredEnd.getTime() - span.occurredAt.getTime()
  return Math.round(ms / 86_400_000) + 1
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

/** `2014-07-12`, or null for an undated episode. Used by the markdown export. */
export function isoDate(d: Date | null): string | null {
  return d ? iso(d) : null
}

/**
 * How a date reads to a human. Coarse precisions never render as a bare day,
 * because a band shown as a point is exactly the false precision this whole
 * model exists to avoid.
 */
export function labelFor(precision: Precision, span: Span): string {
  if (precision === 'unknown' || !span.occurredAt || !span.occurredEnd) {
    return 'Undated'
  }
  const startYear = span.occurredAt.getUTCFullYear()
  const startMonth = span.occurredAt.getUTCMonth()

  switch (precision) {
    case 'day':
      return `${MONTH_NAMES[startMonth]} ${span.occurredAt.getUTCDate()}, ${startYear}`
    case 'month':
      return `${MONTH_NAMES[startMonth]} ${startYear}`
    case 'year':
      return String(startYear)
    case 'season': {
      const year = bucketYear(span)!
      const season = seasonFromSpan(span)
      const endMonth = span.occurredEnd.getUTCMonth()
      const range = `${MONTH_NAMES[startMonth].slice(0, 3)} ${startYear} – ${MONTH_NAMES[endMonth].slice(0, 3)} ${span.occurredEnd.getUTCFullYear()}`
      return season ? `${SEASON_LABEL[season]} ${year} (${range})` : range
    }
  }
}

/** Recovers the season from a stored span, so labels survive a round-trip. */
export function seasonFromSpan(span: Span): Season | null {
  if (!span.occurredAt) return null
  switch (span.occurredAt.getUTCMonth() + 1) {
    case 12: return 'winter'
    case 3: return 'spring'
    case 6: return 'summer'
    case 9: return 'autumn'
    default: return null
  }
}

/** A confidence of 3 reads as "◆◆◆◇◇" — faster than a number to scan in a list. */
export function confidenceGlyphs(confidence: number | null): string {
  if (confidence === null) return ''
  return '◆'.repeat(confidence) + '◇'.repeat(5 - confidence)
}

export const SEASONS: readonly Season[] = ['winter', 'spring', 'summer', 'autumn']
export const PRECISIONS: readonly Precision[] = ['day', 'month', 'season', 'year', 'unknown']

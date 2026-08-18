import { describe, expect, it } from 'vitest'
import {
  bucketYear,
  confidenceGlyphs,
  isoDate,
  labelFor,
  seasonFromSpan,
  seasonSpan,
  spanDays,
  spanFor,
  utcDate,
} from '../src/lib/dating'

const at = (span: { occurredAt: Date | null }) => isoDate(span.occurredAt)
const end = (span: { occurredEnd: Date | null }) => isoDate(span.occurredEnd)

describe('spanFor', () => {
  it('turns a year into the whole year, not a point on January 1', () => {
    const span = spanFor({ precision: 'year', year: 2014 })
    expect(at(span)).toBe('2014-01-01')
    expect(end(span)).toBe('2014-12-31')
    expect(spanDays(span)).toBe(365)
  })

  it('closes a month on its real last day', () => {
    expect(end(spanFor({ precision: 'month', year: 2016, month: 2 }))).toBe('2016-02-29')
    expect(end(spanFor({ precision: 'month', year: 2015, month: 2 }))).toBe('2015-02-28')
    expect(end(spanFor({ precision: 'month', year: 2014, month: 4 }))).toBe('2014-04-30')
  })

  it('collapses a day to a single point', () => {
    const span = spanFor({ precision: 'day', year: 2014, month: 7, day: 12 })
    expect(at(span)).toBe('2014-07-12')
    expect(end(span)).toBe('2014-07-12')
    expect(spanDays(span)).toBe(1)
  })

  it('leaves an unplaceable episode with no span at all', () => {
    expect(spanFor({ precision: 'unknown' })).toEqual({ occurredAt: null, occurredEnd: null })
    expect(spanDays({ occurredAt: null, occurredEnd: null })).toBeNull()
  })
})

describe('seasons', () => {
  it('names a winter for the year it ends in', () => {
    const winter = seasonSpan(2014, 'winter')
    expect(isoDate(winter.start)).toBe('2013-12-01')
    expect(isoDate(winter.end)).toBe('2014-02-28')
  })

  it('carries a leap day into winter', () => {
    expect(isoDate(seasonSpan(2016, 'winter').end)).toBe('2016-02-29')
  })

  it('places the other three inside their own year', () => {
    expect(isoDate(seasonSpan(2014, 'spring').start)).toBe('2014-03-01')
    expect(isoDate(seasonSpan(2014, 'summer').end)).toBe('2014-08-31')
    expect(isoDate(seasonSpan(2014, 'autumn').end)).toBe('2014-11-30')
  })

  it('recovers the season from a stored span', () => {
    for (const season of ['winter', 'spring', 'summer', 'autumn'] as const) {
      const { start, end: finish } = seasonSpan(2014, season)
      expect(seasonFromSpan({ occurredAt: start, occurredEnd: finish })).toBe(season)
    }
  })
})

describe('bucketYear', () => {
  it('files a winter under the year it is named for, not the December it starts in', () => {
    expect(bucketYear(spanFor({ precision: 'season', year: 2014, season: 'winter' }))).toBe(2014)
  })

  it('agrees with the obvious answer for every other precision', () => {
    expect(bucketYear(spanFor({ precision: 'year', year: 2014 }))).toBe(2014)
    expect(bucketYear(spanFor({ precision: 'month', year: 2014, month: 1 }))).toBe(2014)
    expect(bucketYear(spanFor({ precision: 'month', year: 2014, month: 12 }))).toBe(2014)
    expect(bucketYear(spanFor({ precision: 'day', year: 2014, month: 12, day: 31 }))).toBe(2014)
    expect(bucketYear(spanFor({ precision: 'season', year: 2014, season: 'summer' }))).toBe(2014)
  })

  it('has no year for an undated episode', () => {
    expect(bucketYear({ occurredAt: null, occurredEnd: null })).toBeNull()
  })
})

describe('labelFor', () => {
  it('never renders a band as a single day', () => {
    expect(labelFor('year', spanFor({ precision: 'year', year: 2014 }))).toBe('2014')
    expect(labelFor('month', spanFor({ precision: 'month', year: 2014, month: 7 }))).toBe('July 2014')
    expect(labelFor('day', spanFor({ precision: 'day', year: 2014, month: 7, day: 12 }))).toBe(
      'July 12, 2014',
    )
  })

  it('spells out a season so the convention never has to be remembered', () => {
    expect(labelFor('season', spanFor({ precision: 'season', year: 2014, season: 'winter' }))).toBe(
      'Winter 2014 (Dec 2013 – Feb 2014)',
    )
    expect(labelFor('season', spanFor({ precision: 'season', year: 2014, season: 'summer' }))).toBe(
      'Summer 2014 (Jun 2014 – Aug 2014)',
    )
  })

  it('says so when it cannot place an episode', () => {
    expect(labelFor('unknown', { occurredAt: null, occurredEnd: null })).toBe('Undated')
  })
})

describe('utcDate', () => {
  it('stays at UTC midnight, which is how a Postgres date round-trips', () => {
    expect(utcDate(2014, 7, 12).toISOString()).toBe('2014-07-12T00:00:00.000Z')
  })
})

describe('confidenceGlyphs', () => {
  it('reads as a five-slot meter', () => {
    expect(confidenceGlyphs(1)).toBe('◆◇◇◇◇')
    expect(confidenceGlyphs(5)).toBe('◆◆◆◆◆')
    expect(confidenceGlyphs(null)).toBe('')
  })
})

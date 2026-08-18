import { describe, expect, it } from 'vitest'
import {
  buildEpisode,
  episodeInputSchema,
  fieldsFromForm,
  EpisodeInputError,
} from '../src/lib/episode-input'
import { isoDate } from '../src/lib/dating'

const NOW = new Date('2026-08-18T12:00:00Z')

const parse = (raw: Record<string, unknown>) => {
  const result = episodeInputSchema.safeParse(raw)
  if (!result.success) throw new Error(result.error.issues[0].message)
  return result.data
}

describe('episodeInputSchema', () => {
  it('accepts a fully dated episode', () => {
    const draft = buildEpisode(
      parse({ precision: 'day', body: 'saw the sea', date: '2014-07-12', confidence: '4' }),
      NOW,
    )
    expect(draft).toMatchObject({ precision: 'day', confidence: 4, body: 'saw the sea' })
    expect(isoDate(draft.occurredAt)).toBe('2014-07-12')
    expect(isoDate(draft.occurredEnd)).toBe('2014-07-12')
  })

  it('trims the body and refuses an empty one', () => {
    expect(buildEpisode(parse({ precision: 'unknown', body: '  something  ' }), NOW).body).toBe(
      'something',
    )
    expect(() => parse({ precision: 'unknown', body: '   ' })).toThrow(/needs text/)
  })

  it('asks for no confidence when the episode cannot be placed', () => {
    const draft = buildEpisode(parse({ precision: 'unknown', body: 'a room, no year' }), NOW)
    expect(draft).toMatchObject({ occurredAt: null, occurredEnd: null, confidence: null })
  })

  it('will not take a date without a confidence', () => {
    expect(() => parse({ precision: 'year', body: 'x', year: '2014' })).toThrow(/1–5/)
  })

  it('holds confidence to the 1–5 scale', () => {
    expect(() => parse({ precision: 'year', body: 'x', year: '2014', confidence: '0' })).toThrow()
    expect(() => parse({ precision: 'year', body: 'x', year: '2014', confidence: '6' })).toThrow()
  })
})

describe('buildEpisode', () => {
  it('rejects a day that does not exist instead of rolling it into March', () => {
    expect(() =>
      buildEpisode(
        parse({ precision: 'day', body: 'x', date: '2014-02-31', confidence: '3' }),
        NOW,
      ),
    ).toThrow(EpisodeInputError)
  })

  it('refuses an episode that starts in the future', () => {
    expect(() =>
      buildEpisode(
        parse({ precision: 'day', body: 'x', date: '2026-08-19', confidence: '5' }),
        NOW,
      ),
    ).toThrow(/already happened/)
  })

  it('allows today, and a span still open at its far end', () => {
    expect(() =>
      buildEpisode(parse({ precision: 'day', body: 'x', date: '2026-08-18', confidence: '5' }), NOW),
    ).not.toThrow()

    // The current year runs to December 31; that end is in the future and that
    // is fine — you are living inside the band.
    const running = buildEpisode(parse({ precision: 'year', body: 'x', year: '2026', confidence: '5' }), NOW)
    expect(isoDate(running.occurredEnd)).toBe('2026-12-31')
  })

  it('derives a season span from a year and a season alone', () => {
    const draft = buildEpisode(
      parse({ precision: 'season', body: 'x', year: '2014', season: 'winter', confidence: '2' }),
      NOW,
    )
    expect(isoDate(draft.occurredAt)).toBe('2013-12-01')
    expect(isoDate(draft.occurredEnd)).toBe('2014-02-28')
  })
})

describe('fieldsFromForm', () => {
  it('drops blanks so a hidden field from another precision cannot leak in', () => {
    const form = new FormData()
    form.set('precision', 'year')
    form.set('body', 'x')
    form.set('year', '2014')
    form.set('confidence', '3')
    form.set('date', '')
    expect(fieldsFromForm(form)).toEqual({
      precision: 'year',
      body: 'x',
      year: '2014',
      confidence: '3',
    })
  })
})

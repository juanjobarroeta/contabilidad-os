import { describe, expect, it } from 'vitest'
import { groupByYear, type EpisodeRow } from '../src/lib/episodes'
import { bucketYear, spanFor, type Precision } from '../src/lib/dating'

let seq = 0

function episode(precision: Precision, span: { occurredAt: Date | null; occurredEnd: Date | null }, body = 'x'): EpisodeRow {
  seq += 1
  return {
    id: `id-${seq}`,
    body,
    precision,
    confidence: precision === 'unknown' ? null : 3,
    createdAt: new Date(Date.UTC(2026, 0, seq)),
    source: 'typed',
    ...span,
  }
}

const yearOf = (row: EpisodeRow) =>
  bucketYear({ occurredAt: row.occurredAt, occurredEnd: row.occurredEnd })

describe('groupByYear', () => {
  it('runs newest year first and leaves the undated at the end', () => {
    const rows = [
      episode('year', spanFor({ precision: 'year', year: 2014 })),
      episode('unknown', spanFor({ precision: 'unknown' })),
      episode('year', spanFor({ precision: 'year', year: 2021 })),
      episode('year', spanFor({ precision: 'year', year: 1998 })),
    ]
    expect(groupByYear(rows, yearOf).map((group) => group.year)).toEqual([2021, 2014, 1998, null])
  })

  it('opens a year with its coarse bands and narrows down', () => {
    const rows = [
      episode('day', spanFor({ precision: 'day', year: 2014, month: 7, day: 12 }), 'the twelfth'),
      episode('year', spanFor({ precision: 'year', year: 2014 }), 'the year'),
      episode('month', spanFor({ precision: 'month', year: 2014, month: 3 }), 'march'),
      episode('season', spanFor({ precision: 'season', year: 2014, season: 'summer' }), 'the summer'),
    ]
    const [group] = groupByYear(rows, yearOf)
    expect(group.episodes.map((row) => row.body)).toEqual([
      'the year',
      'the summer',
      'march',
      'the twelfth',
    ])
  })

  it('sorts equal precisions chronologically, then by when they were written', () => {
    const rows = [
      episode('day', spanFor({ precision: 'day', year: 2014, month: 9, day: 1 }), 'september'),
      episode('day', spanFor({ precision: 'day', year: 2014, month: 1, day: 3 }), 'january'),
      episode('day', spanFor({ precision: 'day', year: 2014, month: 1, day: 3 }), 'january, again'),
    ]
    const [group] = groupByYear(rows, yearOf)
    expect(group.episodes.map((row) => row.body)).toEqual(['january', 'january, again', 'september'])
  })

  it('keeps a winter with the year it is named for', () => {
    const rows = [
      episode('season', spanFor({ precision: 'season', year: 2014, season: 'winter' }), 'that winter'),
      episode('day', spanFor({ precision: 'day', year: 2013, month: 6, day: 1 }), 'june 2013'),
    ]
    const groups = groupByYear(rows, yearOf)
    expect(groups.map((group) => group.year)).toEqual([2014, 2013])
    expect(groups[0].episodes[0].body).toBe('that winter')
  })

  it('has nothing to group when there is nothing', () => {
    expect(groupByYear([], yearOf)).toEqual([])
  })
})

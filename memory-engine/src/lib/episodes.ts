/**
 * Reads and the single write.
 *
 * There is no update and no delete here, and there will not be one. That is
 * not discipline on the caller's part — the database refuses both — but the
 * absence should be visible in the code too.
 */

import { prisma } from './db'
import { PRECISION_ORDER, type Precision } from './dating'
import type { EpisodeDraft } from './episode-input'

export type EpisodeSource = 'typed' | 'photo_prompt' | 'import'

export interface EpisodeRow {
  id: string
  body: string
  occurredAt: Date | null
  occurredEnd: Date | null
  precision: Precision
  confidence: number | null
  createdAt: Date
  source: EpisodeSource
}

export interface YearGroup {
  /** `null` is the undated group, which always sorts last. */
  year: number | null
  episodes: EpisodeRow[]
}

export async function createEpisode(
  draft: EpisodeDraft,
  source: EpisodeSource = 'typed',
): Promise<EpisodeRow> {
  return prisma.episode.create({
    data: {
      body: draft.body,
      precision: draft.precision,
      confidence: draft.confidence,
      occurredAt: draft.occurredAt,
      occurredEnd: draft.occurredEnd,
      source,
    },
  }) as Promise<EpisodeRow>
}

export async function listEpisodes(): Promise<EpisodeRow[]> {
  return prisma.episode.findMany({
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
  }) as Promise<EpisodeRow[]>
}

export async function countEpisodes(): Promise<number> {
  return prisma.episode.count()
}

/**
 * Groups for the reading surface. Pure, so the ordering rules are testable
 * without a database.
 *
 * Years run newest first — you write about last month more often than about
 * 1998. Inside a year, coarse bands come before precise ones, so opening 2014
 * reads as "here is the year, here is the summer, here is the twelfth of July"
 * rather than as a list with a whole-year entry wedged between two mornings.
 */
export function groupByYear(
  rows: EpisodeRow[],
  yearOf: (row: EpisodeRow) => number | null,
): YearGroup[] {
  const buckets = new Map<number | null, EpisodeRow[]>()
  for (const row of rows) {
    const year = yearOf(row)
    const bucket = buckets.get(year)
    if (bucket) bucket.push(row)
    else buckets.set(year, [row])
  }

  const groups: YearGroup[] = [...buckets.entries()].map(([year, episodes]) => ({
    year,
    episodes: [...episodes].sort(compareWithinYear),
  }))

  return groups.sort((a, b) => {
    if (a.year === null) return 1
    if (b.year === null) return -1
    return b.year - a.year
  })
}

function compareWithinYear(a: EpisodeRow, b: EpisodeRow): number {
  const byPrecision = PRECISION_ORDER[a.precision] - PRECISION_ORDER[b.precision]
  if (byPrecision !== 0) return byPrecision

  const at = a.occurredAt?.getTime() ?? 0
  const bt = b.occurredAt?.getTime() ?? 0
  if (at !== bt) return at - bt

  return a.createdAt.getTime() - b.createdAt.getTime()
}

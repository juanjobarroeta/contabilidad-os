/**
 * Validation for the one thing Phase 1 writes: an episode.
 *
 * The form hands over strings; this turns them into a row, or into an error a
 * person can read. It never produces a partially-dated episode — the span is
 * always derived from the precision, never typed by hand.
 */

import { z } from 'zod'
import { spanFor, type Dating, type Precision, type Span } from './dating'

const yearField = z.coerce.number().int().min(1900).max(2200)
const confidenceField = z.coerce
  .number({ invalid_type_error: 'Confidence is 1–5.' })
  .int()
  .min(1, 'Confidence is 1–5.')
  .max(5, 'Confidence is 1–5.')

const bodyField = z
  .string()
  .trim()
  .min(1, 'An episode needs text. What happened?')
  .max(20_000, 'That is longer than an episode; split it into several.')

export const episodeInputSchema = z.discriminatedUnion('precision', [
  z.object({
    precision: z.literal('day'),
    body: bodyField,
    confidence: confidenceField,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a real date.'),
  }),
  z.object({
    precision: z.literal('month'),
    body: bodyField,
    confidence: confidenceField,
    year: yearField,
    month: z.coerce.number().int().min(1).max(12),
  }),
  z.object({
    precision: z.literal('season'),
    body: bodyField,
    confidence: confidenceField,
    year: yearField,
    season: z.enum(['winter', 'spring', 'summer', 'autumn']),
  }),
  z.object({
    precision: z.literal('year'),
    body: bodyField,
    confidence: confidenceField,
    year: yearField,
  }),
  z.object({
    // Undated on purpose: you know it happened, you cannot place it. Asking
    // for a confidence here would be asking how sure you are of nothing.
    precision: z.literal('unknown'),
    body: bodyField,
  }),
])

export type EpisodeInput = z.infer<typeof episodeInputSchema>

export interface EpisodeDraft extends Span {
  body: string
  precision: Precision
  confidence: number | null
}

function datingOf(input: EpisodeInput): Dating {
  switch (input.precision) {
    case 'day': {
      const [year, month, day] = input.date.split('-').map(Number)
      return { precision: 'day', year, month, day }
    }
    case 'month':
      return { precision: 'month', year: input.year, month: input.month }
    case 'season':
      return { precision: 'season', year: input.year, season: input.season }
    case 'year':
      return { precision: 'year', year: input.year }
    case 'unknown':
      return { precision: 'unknown' }
  }
}

export class EpisodeInputError extends Error {}

/**
 * Parsed input to a row. `now` is injectable so the future-dating rule is
 * testable rather than a thing that quietly changes behaviour at midnight.
 */
export function buildEpisode(input: EpisodeInput, now: Date = new Date()): EpisodeDraft {
  const dating = datingOf(input)
  const span = spanFor(dating)

  if (input.precision === 'day' && span.occurredAt) {
    // '2014-02-31' survives the regex; Date rolls it into March. Catch the roll.
    const [year, month, day] = input.date.split('-').map(Number)
    const rolled =
      span.occurredAt.getUTCFullYear() !== year ||
      span.occurredAt.getUTCMonth() + 1 !== month ||
      span.occurredAt.getUTCDate() !== day
    if (rolled) throw new EpisodeInputError(`${input.date} is not a real date.`)
  }

  // Everything in an autobiographical archive has already happened. A span may
  // still be open at its far end — the current year, a season underway — so
  // only the START has to be in the past.
  if (span.occurredAt) {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    if (span.occurredAt.getTime() > today.getTime()) {
      throw new EpisodeInputError('That starts in the future. This archive is for what already happened.')
    }
  }

  return {
    body: input.body,
    precision: input.precision,
    confidence: input.precision === 'unknown' ? null : input.confidence,
    ...span,
  }
}

/** Pulls the fields the form actually submitted, dropping the empty ones. */
export function fieldsFromForm(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value
  }
  return out
}

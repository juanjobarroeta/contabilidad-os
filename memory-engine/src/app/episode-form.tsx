'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { composeEpisode, type ComposeState } from './actions'
import { PRECISIONS, SEASONS, type Precision } from '@/lib/dating'

const PRECISION_LABEL: Record<Precision, string> = {
  day: 'a day',
  month: 'a month',
  season: 'a season',
  year: 'a year',
  unknown: "can't place it",
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function EpisodeForm({ thisYear }: { thisYear: number }) {
  const [state, action, pending] = useActionState<ComposeState, FormData>(composeEpisode, {})
  const [precision, setPrecision] = useState<Precision>('day')
  const formRef = useRef<HTMLFormElement>(null)

  // Clear the box only once the episode is actually in the database. A failed
  // save must never take the text with it.
  useEffect(() => {
    if (state.savedAt) formRef.current?.reset()
  }, [state.savedAt])

  return (
    <form className="compose" action={action} ref={formRef}>
      <textarea
        name="body"
        placeholder="What happened? First person, as you remember it."
        aria-label="Episode"
      />

      <div className="row">
        <div className="field">
          <label htmlFor="precision">I know it to</label>
          <select
            id="precision"
            name="precision"
            value={precision}
            onChange={(event) => setPrecision(event.target.value as Precision)}
          >
            {PRECISIONS.map((option) => (
              <option key={option} value={option}>
                {PRECISION_LABEL[option]}
              </option>
            ))}
          </select>
        </div>

        {precision === 'day' && (
          <div className="field">
            <label htmlFor="date">Date</label>
            <input id="date" name="date" type="date" defaultValue="" />
          </div>
        )}

        {precision === 'month' && (
          <div className="field">
            <label htmlFor="month">Month</label>
            <select id="month" name="month" defaultValue="1">
              {MONTHS.map((name, index) => (
                <option key={name} value={index + 1}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        )}

        {precision === 'season' && (
          <div className="field">
            <label htmlFor="season">Season</label>
            <select id="season" name="season" defaultValue="summer">
              {SEASONS.map((season) => (
                <option key={season} value={season}>
                  {season}
                </option>
              ))}
            </select>
          </div>
        )}

        {precision !== 'day' && precision !== 'unknown' && (
          <div className="field">
            <label htmlFor="year">Year</label>
            <input
              id="year"
              name="year"
              type="number"
              min={1900}
              max={thisYear}
              defaultValue={thisYear}
            />
          </div>
        )}

        {precision !== 'unknown' && (
          <div className="field">
            <label htmlFor="confidence">Sure of the date</label>
            <select id="confidence" name="confidence" defaultValue="4">
              <option value="5">5 — certain</option>
              <option value="4">4</option>
              <option value="3">3 — roughly</option>
              <option value="2">2</option>
              <option value="1">1 — a guess</option>
            </select>
          </div>
        )}

        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Write it down'}
        </button>
      </div>

      {state.error ? (
        <p className="error">{state.error}</p>
      ) : (
        <p className="hint">
          Once written, an episode is never edited or deleted. A correction is a
          new episode.
        </p>
      )}
    </form>
  )
}

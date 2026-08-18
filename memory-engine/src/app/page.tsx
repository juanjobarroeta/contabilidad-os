import { EpisodeForm } from './episode-form'
import { groupByYear, listEpisodes, type EpisodeRow } from '@/lib/episodes'
import { bucketYear, confidenceGlyphs, labelFor } from '@/lib/dating'

// The archive changes only when you write to it, and you are the only writer.
export const dynamic = 'force-dynamic'

const yearOf = (row: EpisodeRow) =>
  bucketYear({ occurredAt: row.occurredAt, occurredEnd: row.occurredEnd })

export default async function Page() {
  const episodes = await listEpisodes()
  const groups = groupByYear(episodes, yearOf)
  const thisYear = new Date().getUTCFullYear()

  return (
    <main>
      <h1>Memory Engine</h1>
      <p className="subtitle">
        {episodes.length === 0
          ? 'Empty. Thirty episodes by hand is enough to tell whether the model is right.'
          : `${episodes.length} episode${episodes.length === 1 ? '' : 's'}.`}
      </p>

      <EpisodeForm thisYear={thisYear} />

      {groups.length === 0 && (
        <p className="empty">Nothing yet.</p>
      )}

      {groups.map((group) => (
        <section className="year" key={group.year ?? 'undated'}>
          <h2>{group.year ?? 'UNDATED'}</h2>
          {group.episodes.map((episode) => (
            <article className="episode" key={episode.id}>
              <div className="when">
                <span className="band" data-precision={episode.precision} aria-hidden="true" />
                <span>
                  {labelFor(episode.precision, {
                    occurredAt: episode.occurredAt,
                    occurredEnd: episode.occurredEnd,
                  })}
                </span>
                {episode.confidence !== null && (
                  <span className="confidence" title={`Confidence ${episode.confidence} of 5`}>
                    {confidenceGlyphs(episode.confidence)}
                  </span>
                )}
              </div>
              <p className="body">{episode.body}</p>
            </article>
          ))}
        </section>
      ))}
    </main>
  )
}

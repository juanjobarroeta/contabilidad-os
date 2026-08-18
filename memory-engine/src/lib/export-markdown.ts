/**
 * Markdown export.
 *
 * §7 of the outline calls this non-negotiable and calls it early, and the
 * reason is worth restating: the realistic way to lose this archive is not a
 * disk failure, it is a schema migration in year four. Plain files in year
 * folders survive Postgres, survive Prisma, survive this repository.
 *
 * Everything the schema can hold is rendered, not only what Phase 1 writes, so
 * the exporter does not quietly start dropping data the day entities and
 * annotations get populated.
 */

import { bucketYear, isoDate, labelFor, type Precision } from './dating'

export interface ExportEntity {
  role: string
  kind: string
  canonicalName: string
}

export interface ExportAnnotation {
  namespace: string
  author: string
  writtenAt: Date
  body: string
  supersedes: string | null
}

export interface ExportMedia {
  path: string
  exifTakenAt: Date | null
}

export interface ExportEpisode {
  id: string
  body: string
  occurredAt: Date | null
  occurredEnd: Date | null
  precision: Precision
  confidence: number | null
  createdAt: Date
  source: string
  entities: ExportEntity[]
  annotations: ExportAnnotation[]
  media: ExportMedia[]
}

export interface ExportedFile {
  path: string
  contents: string
}

/** Double-quoted YAML scalar — safe for names with colons, quotes, newlines. */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/** `undated` keeps unplaceable episodes visible instead of hiding them at 1970. */
export function exportFolder(episode: ExportEpisode): string {
  const year = bucketYear({ occurredAt: episode.occurredAt, occurredEnd: episode.occurredEnd })
  return year === null ? 'undated' : String(year)
}

/**
 * File names sort chronologically inside a year and carry the precision, so a
 * whole-year episode is never mistaken for something that happened on
 * January 1st — the same confusion the schema exists to prevent.
 */
export function exportFileName(episode: ExportEpisode): string {
  const stamp = isoDate(episode.occurredAt) ?? isoDate(episode.createdAt)!
  return `${stamp}--${episode.precision}--${episode.id.slice(0, 8)}.md`
}

export function exportPath(episode: ExportEpisode): string {
  return `${exportFolder(episode)}/${exportFileName(episode)}`
}

export function renderEpisode(episode: ExportEpisode): ExportedFile {
  const span = { occurredAt: episode.occurredAt, occurredEnd: episode.occurredEnd }
  const lines: string[] = ['---']

  lines.push(`id: ${episode.id}`)
  lines.push(`occurred_at: ${isoDate(episode.occurredAt) ?? '~'}`)
  lines.push(`occurred_end: ${isoDate(episode.occurredEnd) ?? '~'}`)
  lines.push(`precision: ${episode.precision}`)
  lines.push(`confidence: ${episode.confidence ?? '~'}`)
  lines.push(`source: ${episode.source}`)
  lines.push(`created_at: ${episode.createdAt.toISOString()}`)

  if (episode.entities.length > 0) {
    lines.push('entities:')
    for (const entity of episode.entities) {
      lines.push(`  - name: ${yamlString(entity.canonicalName)}`)
      lines.push(`    kind: ${entity.kind}`)
      lines.push(`    role: ${entity.role}`)
    }
  }

  if (episode.media.length > 0) {
    lines.push('media:')
    for (const item of episode.media) {
      lines.push(`  - path: ${yamlString(item.path)}`)
      if (item.exifTakenAt) lines.push(`    exif_taken_at: ${item.exifTakenAt.toISOString()}`)
    }
  }

  lines.push('---', '')
  lines.push(`# ${labelFor(episode.precision, span)}`, '')
  lines.push(episode.body.trimEnd(), '')

  if (episode.annotations.length > 0) {
    // Ordered oldest first: the point of keeping every layer is being able to
    // read the drift, and drift only reads forward.
    const ordered = [...episode.annotations].sort(
      (a, b) => a.writtenAt.getTime() - b.writtenAt.getTime(),
    )
    for (const annotation of ordered) {
      const supersedes = annotation.supersedes ? `, supersedes ${annotation.supersedes.slice(0, 8)}` : ''
      lines.push('---', '')
      lines.push(
        `## ${annotation.namespace} — ${isoDate(annotation.writtenAt)} (${annotation.author}${supersedes})`,
        '',
      )
      lines.push(annotation.body.trimEnd(), '')
    }
  }

  return { path: exportPath(episode), contents: lines.join('\n') }
}

/** One file listing everything, so the export is browsable without a tool. */
export function renderIndex(episodes: ExportEpisode[], exportedAt: Date): ExportedFile {
  const byFolder = new Map<string, ExportEpisode[]>()
  for (const episode of episodes) {
    const folder = exportFolder(episode)
    const bucket = byFolder.get(folder)
    if (bucket) bucket.push(episode)
    else byFolder.set(folder, [episode])
  }

  const folders = [...byFolder.keys()].sort((a, b) => {
    if (a === 'undated') return 1
    if (b === 'undated') return -1
    return Number(b) - Number(a)
  })

  const lines = [
    '# Archive',
    '',
    `${episodes.length} episode${episodes.length === 1 ? '' : 's'}, exported ${exportedAt.toISOString()}.`,
    '',
    'Plain files, one per episode, grouped by year. Nothing here needs this',
    'repository, a database, or a running server to be read.',
    '',
  ]

  for (const folder of folders) {
    const inFolder = [...byFolder.get(folder)!].sort((a, b) => {
      const at = a.occurredAt?.getTime() ?? a.createdAt.getTime()
      const bt = b.occurredAt?.getTime() ?? b.createdAt.getTime()
      return at - bt
    })
    lines.push(`## ${folder === 'undated' ? 'Undated' : folder}`, '')
    for (const episode of inFolder) {
      const span = { occurredAt: episode.occurredAt, occurredEnd: episode.occurredEnd }
      const firstLine = episode.body.trim().split('\n')[0]
      const excerpt = firstLine.length > 90 ? `${firstLine.slice(0, 89)}…` : firstLine
      lines.push(`- [${labelFor(episode.precision, span)}](${exportPath(episode)}) — ${excerpt}`)
    }
    lines.push('')
  }

  return { path: 'README.md', contents: lines.join('\n') }
}

export function renderExport(episodes: ExportEpisode[], exportedAt: Date): ExportedFile[] {
  return [renderIndex(episodes, exportedAt), ...episodes.map(renderEpisode)]
}

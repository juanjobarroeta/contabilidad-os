/**
 * Dumps the whole archive to plain markdown.
 *
 *   npm run export                 -> ./export (or $MEMORY_EXPORT_DIR)
 *   npm run export -- ../backup    -> anywhere you like
 *
 * Safe to run repeatedly: it writes the current state of every episode over
 * whatever was there before. It never reads back into the database, so a
 * corrupted export can only cost you the export.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { renderExport, type ExportEpisode } from '../src/lib/export-markdown'

const prisma = new PrismaClient()

async function main() {
  const target = resolve(process.argv[2] ?? process.env.MEMORY_EXPORT_DIR ?? './export')

  const rows = await prisma.episode.findMany({
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    include: {
      entities: { include: { entity: true } },
      annotations: true,
      media: true,
    },
  })

  const episodes: ExportEpisode[] = rows.map((row) => ({
    id: row.id,
    body: row.body,
    occurredAt: row.occurredAt,
    occurredEnd: row.occurredEnd,
    precision: row.precision,
    confidence: row.confidence,
    createdAt: row.createdAt,
    source: row.source,
    entities: row.entities.map((link) => ({
      role: link.role,
      kind: link.entity.kind,
      canonicalName: link.entity.canonicalName,
    })),
    annotations: row.annotations.map((annotation) => ({
      namespace: annotation.namespace,
      author: annotation.author,
      writtenAt: annotation.writtenAt,
      body: annotation.body,
      supersedes: annotation.supersedes,
    })),
    media: row.media.map((item) => ({ path: item.path, exifTakenAt: item.exifTakenAt })),
  }))

  const files = renderExport(episodes, new Date())

  for (const file of files) {
    const path = join(target, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.contents, 'utf8')
  }

  console.log(`${episodes.length} episodes -> ${files.length} files in ${target}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
